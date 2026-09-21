package v1

import (
	"bytes"
	"context"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/pkg/errors"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/usememos/memos/internal/httpgetter"
	"github.com/usememos/memos/internal/pdfexport"
	"github.com/usememos/memos/internal/storage/s3"
	v1pb "github.com/usememos/memos/proto/gen/api/v1"
	storepb "github.com/usememos/memos/proto/gen/store"
	"github.com/usememos/memos/store"
)

// ExportMemoPdf generates a PDF after applying the normal memo and attachment permissions.
func (s *APIV1Service) ExportMemoPdf(ctx context.Context, request *v1pb.ExportMemoPdfRequest) (*v1pb.ExportMemoPdfResponse, error) {
	memo, err := s.GetMemo(ctx, &v1pb.GetMemoRequest{Name: request.Name})
	if err != nil {
		return nil, err
	}
	return s.renderMemoPDF(ctx, memo, request.Origin, nil)
}

// ExportSharedMemoPdf preserves the existing share grant without granting access to other memos.
func (s *APIV1Service) ExportSharedMemoPdf(ctx context.Context, request *v1pb.ExportSharedMemoPdfRequest) (*v1pb.ExportMemoPdfResponse, error) {
	memo, err := s.GetSharedMemo(ctx, &v1pb.GetSharedMemoRequest{ShareToken: request.ShareToken})
	if err != nil {
		return nil, err
	}
	allowed := make(map[string]bool, len(memo.Attachments))
	for _, attachment := range memo.Attachments {
		allowed[strings.TrimPrefix(attachment.Name, AttachmentNamePrefix)] = true
	}
	return s.renderMemoPDF(ctx, memo, request.Origin, allowed)
}

func (s *APIV1Service) renderMemoPDF(ctx context.Context, memo *v1pb.Memo, browserOrigin string, sharedAttachments map[string]bool) (*v1pb.ExportMemoPdfResponse, error) {
	origin := s.Profile.InstanceURL
	if origin == "" {
		if parsed, err := url.Parse(browserOrigin); err == nil && (parsed.Scheme == "http" || parsed.Scheme == "https") && parsed.Host != "" {
			origin = parsed.Scheme + "://" + parsed.Host
		}
	}
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	if s.pdfSemaphore != nil {
		if err := s.pdfSemaphore.Acquire(ctx, 1); err != nil {
			return nil, status.Error(codes.DeadlineExceeded, "PDF 生成等待超时")
		}
		defer s.pdfSemaphore.Release(1)
	}
	body, err := pdfexport.Prepare(memo.Content, origin, func(src string) ([]byte, error) { return s.pdfImage(ctx, src, sharedAttachments) })
	if err != nil {
		return nil, status.Errorf(codes.FailedPrecondition, "无法导出完整 PDF：%v", err)
	}
	title := memo.GetProperty().GetTitle()
	if title == "" {
		title = strings.TrimPrefix(memo.Name, MemoNamePrefix)
	}
	data, err := pdfexport.Render(ctx, body, title)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "%v", err)
	}
	return &v1pb.ExportMemoPdfResponse{Content: data}, nil
}

func (s *APIV1Service) pdfImage(ctx context.Context, src string, sharedAttachments map[string]bool) ([]byte, error) {
	target, err := url.Parse(src)
	if err != nil {
		return nil, err
	}
	origin, _ := url.Parse(s.Profile.InstanceURL)
	local := target.Host == "" || (origin != nil && origin.Host != "" && target.Host == origin.Host)
	if local && strings.HasPrefix(target.Path, "/file/attachments/") {
		parts := strings.Split(strings.TrimPrefix(target.Path, "/file/attachments/"), "/")
		if len(parts) != 2 || parts[0] == "" {
			return nil, errors.New("附件地址无效")
		}
		attachment, err := s.Store.GetAttachment(ctx, &store.FindAttachment{UID: &parts[0], GetBlob: true})
		if err != nil {
			return nil, err
		}
		if attachment == nil {
			return nil, errors.New("附件不存在")
		}
		if sharedAttachments != nil {
			if !sharedAttachments[attachment.UID] {
				return nil, status.Error(codes.PermissionDenied, "附件不属于分享笔记")
			}
		} else if err := s.checkAttachmentAccess(ctx, attachment); err != nil {
			return nil, err
		}
		switch attachment.StorageType {
		case storepb.AttachmentStorageType_LOCAL:
			path := filepath.FromSlash(attachment.Reference)
			if !filepath.IsAbs(path) {
				path = filepath.Join(s.Profile.Data, path)
			}
			file, err := os.Open(path)
			if err != nil {
				return nil, errors.New("附件文件读取失败")
			}
			defer file.Close()
			return pdfexport.ReadImage(file)
		case storepb.AttachmentStorageType_S3:
			object := attachment.Payload.GetS3Object()
			if object == nil || object.S3Config == nil || object.Key == "" {
				return nil, errors.New("附件存储配置缺失")
			}
			client, err := s3.NewClient(ctx, object.S3Config)
			if err != nil {
				return nil, errors.New("附件存储连接失败")
			}
			stream, err := client.GetObjectStream(ctx, object.Key)
			if err != nil {
				return nil, errors.New("附件读取失败")
			}
			defer stream.Close()
			return pdfexport.ReadImage(stream)
		case storepb.AttachmentStorageType_EXTERNAL:
			return httpgetter.GetPDFImage(ctx, attachment.Reference)
		default:
			return pdfexport.ReadImage(bytes.NewReader(attachment.Blob))
		}
	}
	return httpgetter.GetPDFImage(ctx, src)
}

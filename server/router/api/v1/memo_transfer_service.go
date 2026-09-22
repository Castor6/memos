package v1

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/pkg/errors"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/encoding/protojson"

	"github.com/usememos/memos/internal/memoexport"
	"github.com/usememos/memos/internal/storage/s3"
	v1pb "github.com/usememos/memos/proto/gen/api/v1"
	storepb "github.com/usememos/memos/proto/gen/store"
	"github.com/usememos/memos/store"
)

const (
	maxMemoArchiveBytes         = 128 << 20
	maxMemoArchiveExpandedBytes = 512 << 20
	maxMemoArchiveMemos         = 10000
	maxMemoArchiveEntries       = 100000
	maxMemoArchiveDuration      = 5 * time.Minute
)

type archiveBuffer struct{ bytes.Buffer }

func (b *archiveBuffer) Write(p []byte) (int, error) {
	if len(p) > maxMemoArchiveBytes-b.Len() {
		return 0, status.Error(codes.ResourceExhausted, "ZIP exceeds 128 MiB")
	}
	return b.Buffer.Write(p)
}

func (s *APIV1Service) archiveUser(ctx context.Context) (*store.User, error) {
	user, err := s.fetchCurrentUser(ctx)
	if err != nil {
		return nil, status.Error(codes.Internal, "failed to get user")
	}
	if user == nil {
		return nil, status.Error(codes.Unauthenticated, "authentication required")
	}
	return user, nil
}

func (s *APIV1Service) acquireArchive(ctx context.Context) (func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if s.archiveSemaphore == nil {
		return func() {}, nil
	}
	if !s.archiveSemaphore.TryAcquire(1) {
		return nil, status.Error(codes.ResourceExhausted, "another archive operation is running; retry later")
	}
	return func() { s.archiveSemaphore.Release(1) }, nil
}

// ExportMemoArchive exports only the authenticated owner's records across personal spaces.
func (s *APIV1Service) ExportMemoArchive(ctx context.Context, _ *v1pb.ExportMemoArchiveRequest) (*v1pb.ExportMemoArchiveResponse, error) {
	user, err := s.archiveUser(ctx)
	if err != nil {
		return nil, err
	}
	release, err := s.acquireArchive(ctx)
	if err != nil {
		return nil, err
	}
	defer release()
	ctx, cancel := context.WithTimeout(store.WithoutSpace(ctx), maxMemoArchiveDuration)
	defer cancel()
	limit := maxMemoArchiveMemos + 1
	memos, err := s.Store.ListMemos(ctx, &store.FindMemo{CreatorID: &user.ID, Limit: &limit, OrderByTimeAsc: true})
	if err != nil {
		return nil, status.Error(codes.Internal, "failed to list memos")
	}
	if len(memos) > maxMemoArchiveMemos {
		return nil, status.Error(codes.ResourceExhausted, "archive exceeds 10000 memos")
	}
	setting, err := s.GetUserSetting(ctx, &v1pb.GetUserSettingRequest{Name: "users/" + user.Username + "/settings/GENERAL"})
	if err != nil {
		return nil, err
	}
	spaces := setting.GetGeneralSetting().GetSpaces()
	owned := make(map[int32]*store.Memo, len(memos))
	ownedUID := make(map[string]bool, len(memos))
	for _, memo := range memos {
		owned[memo.ID] = memo
		ownedUID[memo.UID] = true
	}
	var output archiveBuffer
	now := time.Now()
	w := memoexport.NewWriter(&output, now)
	response := &v1pb.ExportMemoArchiveResponse{Filename: "memos-" + now.UTC().Format("20060102-150405") + ".zip"}
	var expanded int64
	for _, memo := range memos {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		record := &memoexport.Memo{
			UID: memo.UID, Creator: user.Username, CreateTime: memoexport.FormatTime(memo.CreatedTs),
			UpdateTime: memoexport.FormatTime(memo.UpdatedTs), State: string(memo.RowStatus), Visibility: string(memo.Visibility),
			Pinned: memo.Pinned, Tags: memo.Payload.GetTags(),
			Castor: &memoexport.PersonalMemo{Version: 1, Space: memo.Space, IsTodo: memo.IsTodo, ExplicitTags: memo.Payload.GetExplicitTags()},
		}
		if loc := memo.Payload.GetLocation(); loc != nil {
			record.Location = &memoexport.Location{Placeholder: loc.Placeholder, Latitude: loc.Latitude, Longitude: loc.Longitude}
		}
		if memo.Space != "" {
			record.Space = &memoexport.Space{UID: memo.Space, Title: spaces[memo.Space]}
		}
		if memo.ParentUID != nil {
			if ownedUID[*memo.ParentUID] {
				record.Parent = *memo.ParentUID
			} else {
				record.Visibility = "PRIVATE"
				response.Warnings = append(response.Warnings, memo.UID+": parent belongs outside this export; comment will import as a private note")
			}
		}
		relations, err := s.Store.ListMemoRelations(ctx, &store.FindMemoRelation{MemoID: &memo.ID})
		if err != nil {
			return nil, status.Error(codes.Internal, "failed to list memo relations")
		}
		for _, relation := range relations {
			if relation.Type != store.MemoRelationReference {
				continue
			}
			if target := owned[relation.RelatedMemoID]; target != nil {
				record.Relations = append(record.Relations, memoexport.Relation{Type: memoexport.RelationReference, Memo: target.UID})
			} else {
				response.Warnings = append(response.Warnings, memo.UID+": reference outside this export was omitted")
			}
		}
		attachmentLimit := maxMemoArchiveEntries + 1
		attachments, err := s.Store.ListAttachments(ctx, &store.FindAttachment{MemoID: &memo.ID, Limit: &attachmentLimit})
		if err != nil {
			return nil, status.Error(codes.Internal, "failed to list attachments")
		}
		if int(response.AttachmentCount)+len(attachments)+2*len(memos)+1 > maxMemoArchiveEntries {
			return nil, status.Error(codes.ResourceExhausted, "too many archive entries")
		}
		for _, attachment := range attachments {
			if attachment.CreatorID != user.ID {
				return nil, status.Error(codes.PermissionDenied, "memo contains an attachment owned by another user")
			}
			item := memoexport.Attachment{UID: attachment.UID, Filename: attachment.Filename, Type: attachment.Type, Size: attachment.Size, CreateTime: memoexport.FormatTime(attachment.CreatedTs)}
			if motion := convertAttachmentFromStore(attachment).MotionMedia; motion != nil {
				item.MotionMedia, err = protojson.Marshal(motion)
				if err != nil {
					return nil, err
				}
			}
			if attachment.StorageType == storepb.AttachmentStorageType_EXTERNAL {
				item.ExternalLink = attachment.Reference
				response.Warnings = append(response.Warnings, attachment.UID+": external attachment is stored as a link; remote bytes are not included")
			} else {
				if attachment.Size < 0 || attachment.Size > maxMemoArchiveBytes || expanded+attachment.Size > maxMemoArchiveExpandedBytes {
					return nil, status.Error(codes.ResourceExhausted, "attachments exceed archive size limits")
				}
				source, err := s.openArchiveAttachment(ctx, attachment)
				if err != nil {
					return nil, status.Errorf(codes.FailedPrecondition, "attachment %s cannot be read", attachment.UID)
				}
				item.Path = memoexport.AttachmentPath(attachment.UID, attachment.Filename)
				item.SHA256, item.Size, err = w.WriteAttachment(item.Path, io.LimitReader(source, attachment.Size+1))
				closeErr := source.Close()
				if err != nil {
					return nil, errors.Wrap(err, "failed to export attachment")
				}
				if closeErr != nil || item.Size != attachment.Size {
					return nil, status.Errorf(codes.FailedPrecondition, "attachment %s size changed during export", attachment.UID)
				}
				expanded += item.Size
			}
			record.Attachments = append(record.Attachments, item)
			response.AttachmentCount++
		}
		expanded += int64(len(memo.Content))
		if expanded > maxMemoArchiveExpandedBytes {
			return nil, status.Error(codes.ResourceExhausted, "expanded archive exceeds 512 MiB")
		}
		if err := w.WriteMemo(record, []byte(memo.Content)); err != nil {
			return nil, errors.Wrap(err, "failed to export memo")
		}
		response.MemoCount++
	}
	manifest := &memoexport.Manifest{Generator: memoexport.Generator{Name: "Castor6/memos", Version: s.Profile.Version}, ExportTime: memoexport.FormatTime(now.Unix()), Scope: memoexport.Scope{Kind: memoexport.ScopeKindUser, User: &memoexport.ScopeUser{Username: user.Username}}, Counts: &memoexport.Counts{Memos: int(response.MemoCount), Attachments: int(response.AttachmentCount)}, Castor: &memoexport.PersonalSpaces{Version: 1, Spaces: spaces}}
	if err := w.WriteManifest(manifest); err != nil {
		return nil, err
	}
	if err := w.Close(); err != nil {
		return nil, err
	}
	response.Content = output.Bytes()
	return response, nil
}

func (s *APIV1Service) openArchiveAttachment(ctx context.Context, attachment *store.Attachment) (io.ReadCloser, error) {
	switch attachment.StorageType {
	case storepb.AttachmentStorageType_LOCAL:
		path := filepath.FromSlash(attachment.Reference)
		if !filepath.IsAbs(path) {
			path = filepath.Join(s.Profile.Data, path)
		}
		return os.Open(path)
	case storepb.AttachmentStorageType_S3:
		object := attachment.Payload.GetS3Object()
		if object == nil || object.S3Config == nil || object.Key == "" {
			return nil, errors.New("S3 metadata is missing")
		}
		client, err := s3.NewClient(ctx, object.S3Config)
		if err != nil {
			return nil, err
		}
		return client.GetObjectStream(ctx, object.Key)
	default:
		stored, err := s.Store.GetAttachment(ctx, &store.FindAttachment{UID: &attachment.UID, CreatorID: &attachment.CreatorID, GetBlob: true})
		if err != nil {
			return nil, err
		}
		if stored == nil {
			return nil, errors.New("attachment disappeared")
		}
		return io.NopCloser(bytes.NewReader(stored.Blob)), nil
	}
}

func archiveItemError(uid string, err error) string {
	return fmt.Sprintf("%s: %s", uid, status.Convert(err).Message())
}

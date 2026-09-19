package v1

import (
	"context"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/fieldmaskpb"

	"github.com/usememos/memos/internal/wechatkf"
	v1pb "github.com/usememos/memos/proto/gen/api/v1"
	"github.com/usememos/memos/server/auth"
	"github.com/usememos/memos/store"
)

// NewWeChatKFNotes binds internal clipping to a configured owner/space. This is
// not an RPC and must only be constructed from trusted integration settings;
// callback fields must never select the Memos owner. No PAT is needed.
func (s *APIV1Service) NewWeChatKFNotes(ownerID int32, space string) wechatkf.Notes {
	return &wechatKFNotes{service: s, ownerID: ownerID, space: space}
}

type wechatKFNotes struct {
	service *APIV1Service
	ownerID int32
	space   string
}

func (n *wechatKFNotes) context(ctx context.Context) (context.Context, error) {
	user, err := n.service.Store.GetUser(ctx, &store.FindUser{ID: &n.ownerID})
	if err != nil {
		return nil, clipStoreError(err)
	}
	if user == nil || user.RowStatus != store.Normal {
		return nil, clipPolicyError("绑定的 Memos 用户不存在或已停用")
	}
	ctx = store.WithSpace(auth.SetUserInContext(ctx, user, ""), n.space)
	if _, err = n.service.validateSelectedSpace(ctx, n.ownerID); err != nil {
		return nil, clipStoreError(err)
	}
	return ctx, nil
}
func clipPolicyError(reason string) error {
	return &wechatkf.Failure{Stage: "Memos 校验", Reason: reason}
}
func clipStoreError(err error) error {
	if err == nil {
		return nil
	}
	// gRPC details may contain raw database errors or paths: only expose the code.
	return &wechatkf.Failure{Stage: "Memos 保存", Reason: "业务操作失败，代码 " + status.Code(err).String()}
}
func (n *wechatKFNotes) memo(ctx context.Context, uid string) (*store.Memo, error) {
	memo, err := n.service.Store.GetMemo(ctx, &store.FindMemo{UID: &uid})
	if err != nil {
		return nil, clipStoreError(err)
	}
	if memo != nil && (memo.CreatorID != n.ownerID || memo.Space != n.space || memo.Visibility != store.Private || memo.RowStatus != store.Normal || memo.IsTodo || memo.ParentUID != nil) {
		return nil, clipPolicyError("已有笔记的归属、可见性或状态不符")
	}
	return memo, nil
}
func (n *wechatKFNotes) Ensure(ctx context.Context, uid string, clip wechatkf.Clip) error {
	ctx, err := n.context(ctx)
	if err != nil {
		return err
	}
	memo, err := n.memo(ctx, uid)
	if err != nil || memo != nil {
		return err
	}
	_, err = n.service.CreateMemo(ctx, &v1pb.CreateMemoRequest{MemoId: uid, Memo: &v1pb.Memo{Content: clip.Content, Visibility: v1pb.Visibility_PRIVATE, ExplicitTags: true, Tags: clip.Tags}})
	return clipStoreError(err)
}
func (n *wechatKFNotes) Attach(ctx context.Context, uid, attachmentID, mediaID, kind string, download wechatkf.Download) (string, error) {
	ctx, err := n.context(ctx)
	if err != nil {
		return "", err
	}
	memo, err := n.memo(ctx, uid)
	if err != nil {
		return "", err
	}
	if memo == nil {
		return "", clipPolicyError("所属笔记不存在")
	}
	attachment, err := n.service.Store.GetAttachment(ctx, &store.FindAttachment{UID: &attachmentID})
	if err != nil {
		return "", clipStoreError(err)
	}
	if attachment != nil {
		if attachment.CreatorID != n.ownerID || attachment.Space != n.space || attachment.MemoID == nil || *attachment.MemoID != memo.ID {
			return "", clipPolicyError("已有附件归属不符")
		}
		return wechatkf.AttachmentReference("attachments/"+attachment.UID, attachment.Filename, kind), nil
	}
	if download == nil {
		return "", clipPolicyError("未配置微信素材下载")
	}
	media, err := download(ctx, mediaID)
	if err != nil {
		return "", err
	}
	filename := wechatkf.SafeFilename(media.Filename)
	if filename == "" {
		ext := map[string]string{"image": ".img", "voice": ".amr", "video": ".mp4", "file": ".bin"}[kind]
		filename = attachmentID + ext
	}
	name := "memos/" + uid
	created, err := n.service.CreateAttachment(ctx, &v1pb.CreateAttachmentRequest{AttachmentId: attachmentID, Attachment: &v1pb.Attachment{Filename: filename, Type: media.Type, Content: media.Data, Memo: &name}})
	if err != nil {
		return "", clipStoreError(err)
	}
	return wechatkf.AttachmentReference(created.Name, created.Filename, kind), nil
}
func (n *wechatKFNotes) Finish(ctx context.Context, uid string, clip wechatkf.Clip) error {
	ctx, err := n.context(ctx)
	if err != nil {
		return err
	}
	memo, err := n.memo(ctx, uid)
	if err != nil {
		return err
	}
	if memo == nil {
		return clipStoreError(status.Error(codes.NotFound, "memo missing"))
	}
	_, err = n.service.UpdateMemo(ctx, &v1pb.UpdateMemoRequest{Memo: &v1pb.Memo{Name: "memos/" + uid, Content: clip.Content, Visibility: v1pb.Visibility_PRIVATE, ExplicitTags: true, Tags: clip.Tags}, UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"content", "visibility", "tags"}}})
	return clipStoreError(err)
}

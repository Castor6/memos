package test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/fieldmaskpb"

	v1pb "github.com/usememos/memos/proto/gen/api/v1"
	storepb "github.com/usememos/memos/proto/gen/store"
	"github.com/usememos/memos/store"
)

func TestPersonalSpacesAndIndependentTodos(t *testing.T) {
	ts := NewTestService(t)
	defer ts.Cleanup()
	ctx := context.Background()
	user, err := ts.CreateRegularUser(ctx, "spaces")
	require.NoError(t, err)
	ctx = ts.CreateUserContext(ctx, user.ID)
	personal := store.WithSpace(ctx, "")
	company := store.WithSpace(ctx, "company")
	_, err = ts.Store.UpsertUserSetting(ctx, &storepb.UserSetting{UserId: user.ID, Key: storepb.UserSetting_GENERAL, Value: &storepb.UserSetting_General{General: &storepb.GeneralUserSetting{Spaces: map[string]string{"company": "公司"}}}})
	require.NoError(t, err)
	makeMemo := func(ctx context.Context, content string, todo bool) *v1pb.Memo {
		memo, err := ts.Service.CreateMemo(ctx, &v1pb.CreateMemoRequest{Memo: &v1pb.Memo{Content: content, Visibility: v1pb.Visibility_PRIVATE, IsTodo: todo, ExplicitTags: true, Tags: []string{"项目"}}})
		require.NoError(t, err)
		return memo
	}
	note := makeMemo(personal, "共同搜索词 #不应该成为标签", false)
	companyNote := makeMemo(company, "共同搜索词 公司", false)
	todo := makeMemo(company, "- [ ] 吃饭\n- [x] 打扫", true)
	require.Equal(t, "company", companyNote.Space)
	require.Equal(t, []string{"项目"}, note.Tags)
	for _, scoped := range []context.Context{personal, company} {
		result, err := ts.Service.ListMemos(scoped, &v1pb.ListMemosRequest{Filter: `content.contains("共同搜索词")`})
		require.NoError(t, err)
		require.Len(t, result.Memos, 1)
	}
	todos, err := ts.Service.ListMemos(company, &v1pb.ListMemosRequest{IsTodo: true})
	require.NoError(t, err)
	require.Len(t, todos.Memos, 1)
	require.Equal(t, todo.Name, todos.Memos[0].Name)
	_, err = ts.Service.GetMemo(personal, &v1pb.GetMemoRequest{Name: companyNote.Name})
	require.Equal(t, codes.NotFound, status.Code(err))
	_, err = ts.Service.UpdateMemo(personal, &v1pb.UpdateMemoRequest{Memo: &v1pb.Memo{Name: companyNote.Name, Content: "错误修改"}, UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"content"}}})
	require.Equal(t, codes.NotFound, status.Code(err))
	_, err = ts.Service.DeleteMemo(personal, &v1pb.DeleteMemoRequest{Name: companyNote.Name})
	require.Equal(t, codes.NotFound, status.Code(err))
	updated, err := ts.Service.UpdateMemo(company, &v1pb.UpdateMemoRequest{Memo: &v1pb.Memo{Name: companyNote.Name, Content: "正文 #不会覆盖独立标签"}, UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"content"}}})
	require.NoError(t, err)
	require.Equal(t, []string{"项目"}, updated.Tags)
	require.Equal(t, "company", updated.Space)
	relation := &v1pb.MemoRelation{RelatedMemo: &v1pb.MemoRelation_Memo{Name: note.Name}, Type: v1pb.MemoRelation_REFERENCE}
	before, err := ts.Store.ListMemos(company, &store.FindMemo{})
	require.NoError(t, err)
	_, err = ts.Service.CreateMemo(company, &v1pb.CreateMemoRequest{Memo: &v1pb.Memo{Content: "不可跨空间引用", Relations: []*v1pb.MemoRelation{relation}}})
	require.Equal(t, codes.InvalidArgument, status.Code(err))
	after, err := ts.Store.ListMemos(company, &store.FindMemo{})
	require.NoError(t, err)
	require.Len(t, after, len(before), "failed reference validation must not leave a new memo")
	relation.RelatedMemo.Name = companyNote.Name
	_, err = ts.Service.SetMemoRelations(company, &v1pb.SetMemoRelationsRequest{Name: todo.Name, Relations: []*v1pb.MemoRelation{relation}})
	require.Equal(t, codes.InvalidArgument, status.Code(err))
	_, err = ts.Service.CreateMemo(store.WithSpace(ctx, "unknown"), &v1pb.CreateMemoRequest{Memo: &v1pb.Memo{Content: "unknown"}})
	require.Equal(t, codes.InvalidArgument, status.Code(err))
	attachment, err := ts.Store.CreateAttachment(company, &store.Attachment{UID: "space-file", CreatorID: user.ID, Filename: "sample.txt", Type: "text/plain", Payload: &storepb.AttachmentPayload{}})
	require.NoError(t, err)
	found, err := ts.Store.GetAttachment(personal, &store.FindAttachment{ID: &attachment.ID})
	require.NoError(t, err)
	require.Nil(t, found)
	_, err = ts.Service.CreateMemo(personal, &v1pb.CreateMemoRequest{Memo: &v1pb.Memo{Content: "跨空间文件", Attachments: []*v1pb.Attachment{{Name: "attachments/space-file"}}}})
	require.Equal(t, codes.NotFound, status.Code(err))
}

func TestPersonalPreferencesAndTagMetadata(t *testing.T) {
	ts := NewTestService(t)
	defer ts.Cleanup()
	ctx := context.Background()
	user, err := ts.CreateRegularUser(ctx, "preferences")
	require.NoError(t, err)
	ctx = ts.CreateUserContext(ctx, user.ID)
	personal := store.WithSpace(ctx, "")
	company := store.WithSpace(ctx, "company")
	generalName := "users/" + user.Username + "/settings/GENERAL"
	setting, err := ts.Service.UpdateUserSetting(personal, &v1pb.UpdateUserSettingRequest{
		Setting:    &v1pb.UserSetting{Name: generalName, Value: &v1pb.UserSetting_GeneralSetting_{GeneralSetting: &v1pb.UserSetting_GeneralSetting{Spaces: map[string]string{"company": "公司"}, EnterToSave: true, CommonWords: []string{"tactus", "browserrig", "会议"}, PreviewCharacters: 120}}},
		UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"spaces", "enter_to_save", "common_words", "preview_characters"}},
	})
	require.NoError(t, err)
	require.Equal(t, int32(120), setting.GetGeneralSetting().PreviewCharacters)
	fetched, err := ts.Service.GetUserSetting(company, &v1pb.GetUserSettingRequest{Name: generalName})
	require.NoError(t, err)
	require.True(t, fetched.GetGeneralSetting().EnterToSave)
	require.Equal(t, []string{"tactus", "browserrig", "会议"}, fetched.GetGeneralSetting().CommonWords)
	tagName := "users/" + user.Username + "/settings/TAGS"
	for _, item := range []struct {
		ctx   context.Context
		emoji string
	}{{personal, "🏠"}, {company, "💼"}} {
		_, err := ts.Service.UpdateUserSetting(item.ctx, &v1pb.UpdateUserSettingRequest{
			Setting:    &v1pb.UserSetting{Name: tagName, Value: &v1pb.UserSetting_TagsSetting_{TagsSetting: &v1pb.UserSetting_TagsSetting{Tags: map[string]*v1pb.UserSetting_TagMetadata{"项目": {Emoji: item.emoji}}}}},
			UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"tags"}},
		})
		require.NoError(t, err)
	}
	for _, item := range []struct {
		ctx   context.Context
		emoji string
	}{{personal, "🏠"}, {company, "💼"}} {
		tags, err := ts.Service.GetUserSetting(item.ctx, &v1pb.GetUserSettingRequest{Name: tagName})
		require.NoError(t, err)
		require.Len(t, tags.GetTagsSetting().Tags, 1)
		require.Equal(t, item.emoji, tags.GetTagsSetting().Tags["项目"].Emoji)
	}
}

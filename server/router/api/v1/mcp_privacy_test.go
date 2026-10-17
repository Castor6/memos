package v1

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/fieldmaskpb"

	"github.com/usememos/memos/internal/mcpaccess"
	v1pb "github.com/usememos/memos/proto/gen/api/v1"
	storepb "github.com/usememos/memos/proto/gen/store"
	"github.com/usememos/memos/store"
)

func TestMCPPrivacyBoundaries(t *testing.T) {
	svc := newIntegrationService(t)
	ctx := context.Background()
	user, err := svc.Store.CreateUser(ctx, &store.User{Username: "privacy", Role: store.RoleAdmin})
	require.NoError(t, err)
	app := userCtx(ctx, user.ID)
	mcp := mcpaccess.WithRequest(app)
	hidden, err := svc.CreateMemo(app, &v1pb.CreateMemoRequest{Memo: &v1pb.Memo{Content: "secret phrase", McpHidden: true, Visibility: v1pb.Visibility_PUBLIC}})
	require.NoError(t, err)
	comment, err := svc.CreateMemoComment(app, &v1pb.CreateMemoCommentRequest{Name: hidden.Name, Comment: &v1pb.Memo{Content: "secret child"}})
	require.NoError(t, err)
	for _, name := range []string{hidden.Name, comment.Name} {
		_, err = svc.GetMemo(mcp, &v1pb.GetMemoRequest{Name: name})
		require.Equal(t, codes.NotFound, status.Code(err))
		_, err = svc.UpdateMemo(mcp, &v1pb.UpdateMemoRequest{Memo: &v1pb.Memo{Name: name, Content: "overwrite"}, UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"content"}}})
		require.Equal(t, codes.NotFound, status.Code(err))
		_, err = svc.DeleteMemo(mcp, &v1pb.DeleteMemoRequest{Name: name})
		require.Equal(t, codes.NotFound, status.Code(err))
		_, err = svc.ListMemoRelations(mcp, &v1pb.ListMemoRelationsRequest{Name: name})
		require.Equal(t, codes.NotFound, status.Code(err))
		_, err = svc.ListMemoReactions(mcp, &v1pb.ListMemoReactionsRequest{Name: name})
		require.Equal(t, codes.NotFound, status.Code(err))
		_, err = svc.ListMemoAttachments(mcp, &v1pb.ListMemoAttachmentsRequest{Name: name})
		require.Equal(t, codes.NotFound, status.Code(err))
		_, err = svc.GetMemo(app, &v1pb.GetMemoRequest{Name: name})
		require.NoError(t, err)
	}
	reaction, err := svc.UpsertMemoReaction(app, &v1pb.UpsertMemoReactionRequest{Name: hidden.Name, Reaction: &v1pb.Reaction{ContentId: hidden.Name, ReactionType: "👍"}})
	require.NoError(t, err)
	_, err = svc.DeleteMemoReaction(mcp, &v1pb.DeleteMemoReactionRequest{Name: reaction.Name})
	require.Equal(t, codes.NotFound, status.Code(err))
	reactions, err := svc.ListMemoReactions(app, &v1pb.ListMemoReactionsRequest{Name: hidden.Name})
	require.NoError(t, err)
	require.Len(t, reactions.Reactions, 1)
	_, err = svc.CreateMemo(mcp, &v1pb.CreateMemoRequest{Memo: &v1pb.Memo{Content: "new", McpHidden: true}})
	require.Equal(t, codes.PermissionDenied, status.Code(err))
	normal, err := svc.CreateMemo(app, &v1pb.CreateMemoRequest{Memo: &v1pb.Memo{Content: "visible"}})
	require.NoError(t, err)
	_, err = svc.UpdateMemo(mcp, &v1pb.UpdateMemoRequest{Memo: &v1pb.Memo{Name: normal.Name}, UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"mcp_hidden"}}})
	require.Equal(t, codes.PermissionDenied, status.Code(err))
	list, err := svc.ListMemos(mcp, &v1pb.ListMemosRequest{PageSize: 1})
	require.NoError(t, err)
	require.Len(t, list.Memos, 1)
	require.Equal(t, normal.Name, list.Memos[0].Name)
}

func TestMCPPrivacyCachedReferencesAndPagination(t *testing.T) {
	svc := newIntegrationService(t)
	ctx := context.Background()
	user, err := svc.Store.CreateUser(ctx, &store.User{Username: "references", Role: store.RoleAdmin})
	require.NoError(t, err)
	app := userCtx(ctx, user.ID)
	mcp := mcpaccess.WithRequest(app)
	hidden, err := svc.CreateMemo(app, &v1pb.CreateMemoRequest{Memo: &v1pb.Memo{Content: "cached secret", McpHidden: true}})
	require.NoError(t, err)
	visible, err := svc.CreateMemo(app, &v1pb.CreateMemoRequest{Memo: &v1pb.Memo{Content: "visible text"}})
	require.NoError(t, err)
	source, err := svc.CreateMemo(app, &v1pb.CreateMemoRequest{Memo: &v1pb.Memo{Content: "visible text\n\n![cached secret](</" + hidden.Name + "> \"memos:reference\")"}})
	require.NoError(t, err)
	got, err := svc.GetMemo(mcp, &v1pb.GetMemoRequest{Name: source.Name})
	require.NoError(t, err)
	require.NotContains(t, got.Content, "cached secret")
	require.NotContains(t, got.Snippet, "cached secret")
	require.NotContains(t, got.Content, hidden.Name)
	require.Contains(t, got.Content, "visible text")
	_, err = svc.UpdateMemo(mcp, &v1pb.UpdateMemoRequest{Memo: &v1pb.Memo{Name: source.Name, Content: got.Content}, UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"content"}}})
	require.Equal(t, codes.FailedPrecondition, status.Code(err))
	actual, err := svc.GetMemo(app, &v1pb.GetMemoRequest{Name: source.Name})
	require.NoError(t, err)
	require.Contains(t, actual.Content, "cached secret")
	list, err := svc.ListMemos(mcp, &v1pb.ListMemosRequest{PageSize: 1, Filter: `content.contains("visible")`})
	require.NoError(t, err)
	require.Len(t, list.Memos, 1)
	require.Equal(t, visible.Name, list.Memos[0].Name)
	require.Empty(t, list.NextPageToken)
	list, err = svc.ListMemos(mcp, &v1pb.ListMemosRequest{PageSize: 1, Filter: `content.contains("cached secret")`})
	require.NoError(t, err)
	require.Empty(t, list.Memos)
}

func TestMCPPrivacyAttachmentsAndIndependentComments(t *testing.T) {
	svc := newIntegrationService(t)
	ctx := context.Background()
	user, err := svc.Store.CreateUser(ctx, &store.User{Username: "files", Role: store.RoleAdmin})
	require.NoError(t, err)
	app := userCtx(ctx, user.ID)
	mcp := mcpaccess.WithRequest(app)
	parent, err := svc.CreateMemo(app, &v1pb.CreateMemoRequest{Memo: &v1pb.Memo{Content: "visible parent"}})
	require.NoError(t, err)
	child, err := svc.CreateMemoComment(app, &v1pb.CreateMemoCommentRequest{Name: parent.Name, Comment: &v1pb.Memo{Content: "hidden child", McpHidden: true}})
	require.NoError(t, err)
	uid, err := ExtractMemoUIDFromName(child.Name)
	require.NoError(t, err)
	raw, err := svc.Store.GetMemo(ctx, &store.FindMemo{UID: &uid})
	require.NoError(t, err)
	_, err = svc.Store.CreateAttachment(ctx, &store.Attachment{UID: "hidden-file", CreatorID: user.ID, MemoID: &raw.ID, Filename: "secret.txt", Type: "text/plain"})
	require.NoError(t, err)
	_, err = svc.GetAttachment(mcp, &v1pb.GetAttachmentRequest{Name: "attachments/hidden-file"})
	require.Equal(t, codes.NotFound, status.Code(err))
	_, err = svc.DeleteAttachment(mcp, &v1pb.DeleteAttachmentRequest{Name: "attachments/hidden-file"})
	require.Equal(t, codes.NotFound, status.Code(err))
	_, err = svc.SetMemoAttachments(mcp, &v1pb.SetMemoAttachmentsRequest{Name: parent.Name, Attachments: []*v1pb.Attachment{{Name: "attachments/hidden-file"}}})
	require.Equal(t, codes.NotFound, status.Code(err))
	files, err := svc.ListAttachments(mcp, &v1pb.ListAttachmentsRequest{PageSize: 1})
	require.NoError(t, err)
	require.Empty(t, files.Attachments)
	comments, err := svc.ListMemoComments(mcp, &v1pb.ListMemoCommentsRequest{Name: parent.Name, PageSize: 1})
	require.NoError(t, err)
	require.Empty(t, comments.Memos)
	_, err = svc.DeleteMemo(mcp, &v1pb.DeleteMemoRequest{Name: parent.Name})
	require.Equal(t, codes.FailedPrecondition, status.Code(err))
	_, err = svc.GetAttachment(app, &v1pb.GetAttachmentRequest{Name: "attachments/hidden-file"})
	require.NoError(t, err)
}

func TestMCPPrivacyCrossSpaceReference(t *testing.T) {
	svc := newIntegrationService(t)
	ctx := context.Background()
	user, err := svc.Store.CreateUser(ctx, &store.User{Username: "spaces", Role: store.RoleAdmin})
	require.NoError(t, err)
	_, err = svc.Store.CreateMemo(ctx, &store.Memo{UID: "secret-other-space", CreatorID: user.ID, Space: "other", Visibility: store.Private, Content: "private", MCPHidden: true})
	require.NoError(t, err)
	scoped := mcpaccess.WithRequest(store.WithSpace(userCtx(ctx, user.ID), "default"))
	sanitized, changed, err := svc.sanitizeMCPMemo(scoped, &store.Memo{Content: "![secret cross-space title](</memos/secret-other-space> \"memos:reference\")"})
	require.NoError(t, err)
	require.True(t, changed)
	require.NotContains(t, sanitized.Content, "secret cross-space title")
	captured, changed, err := svc.sanitizeMCPMemo(scoped, &store.Memo{Content: "safe current body", Payload: &storepb.MemoPayload{Capture: &storepb.MemoCapture{Comment: "![cached private title](</memos/secret-other-space> \"memos:reference\")"}}})
	require.NoError(t, err)
	require.True(t, changed)
	require.Equal(t, "safe current body", captured.Content)
	require.Nil(t, captured.Payload.Capture)

}

func TestMCPPrivacyNestedComment(t *testing.T) {
	s := newIntegrationService(t)
	ctx := context.Background()
	u, e := s.Store.CreateUser(ctx, &store.User{Username: "reviewnested", Role: store.RoleAdmin})
	require.NoError(t, e)
	app := userCtx(ctx, u.ID)
	mcp := mcpaccess.WithRequest(app)
	root, e := s.CreateMemo(app, &v1pb.CreateMemoRequest{Memo: &v1pb.Memo{Content: "root", McpHidden: true}})
	require.NoError(t, e)
	child, e := s.CreateMemoComment(app, &v1pb.CreateMemoCommentRequest{Name: root.Name, Comment: &v1pb.Memo{Content: "child"}})
	require.NoError(t, e)
	grand, e := s.CreateMemoComment(app, &v1pb.CreateMemoCommentRequest{Name: child.Name, Comment: &v1pb.Memo{Content: "grand secret"}})
	require.NoError(t, e)
	_, e = s.UpdateMemo(mcp, &v1pb.UpdateMemoRequest{Memo: &v1pb.Memo{Name: grand.Name, Content: "MCP overwrote protected descendant"}, UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"content"}}})
	require.Equal(t, codes.NotFound, status.Code(e))
}
func TestMCPPrivacyTransitiveReference(t *testing.T) {
	s := newIntegrationService(t)
	ctx := context.Background()
	u, e := s.Store.CreateUser(ctx, &store.User{Username: "reviewchain", Role: store.RoleAdmin})
	require.NoError(t, e)
	app := userCtx(ctx, u.ID)
	mcp := mcpaccess.WithRequest(app)
	a, e := s.CreateMemo(app, &v1pb.CreateMemoRequest{Memo: &v1pb.Memo{Content: "cached secret"}})
	require.NoError(t, e)
	b, e := s.CreateMemo(app, &v1pb.CreateMemoRequest{Memo: &v1pb.Memo{Content: "![" + a.Snippet + "](</" + a.Name + "> \"memos:reference\")"}})
	require.NoError(t, e)
	require.Contains(t, b.Snippet, "cached secret")
	c, e := s.CreateMemo(app, &v1pb.CreateMemoRequest{Memo: &v1pb.Memo{Content: "![" + b.Snippet + "](</" + b.Name + "> \"memos:reference\")"}})
	require.NoError(t, e)
	_, e = s.UpdateMemo(app, &v1pb.UpdateMemoRequest{Memo: &v1pb.Memo{Name: a.Name, McpHidden: true}, UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"mcp_hidden"}}})
	require.NoError(t, e)
	got, e := s.GetMemo(mcp, &v1pb.GetMemoRequest{Name: c.Name})
	require.NoError(t, e)
	require.NotContains(t, got.Content, "cached secret")
}

func TestMCPPrivacyDeleteProtectsIncomingRelations(t *testing.T) {
	svc := newIntegrationService(t)
	ctx := context.Background()
	user, err := svc.Store.CreateUser(ctx, &store.User{Username: "incoming", Role: store.RoleAdmin})
	require.NoError(t, err)
	app := userCtx(ctx, user.ID)
	mcp := mcpaccess.WithRequest(app)
	visible, err := svc.CreateMemo(app, &v1pb.CreateMemoRequest{Memo: &v1pb.Memo{Content: "visible"}})
	require.NoError(t, err)
	hidden, err := svc.CreateMemo(app, &v1pb.CreateMemoRequest{Memo: &v1pb.Memo{
		Content:   "private reference owner",
		McpHidden: true,
		Relations: []*v1pb.MemoRelation{{
			Type:        v1pb.MemoRelation_REFERENCE,
			RelatedMemo: &v1pb.MemoRelation_Memo{Name: visible.Name},
		}},
	}})
	require.NoError(t, err)
	_, err = svc.DeleteMemo(mcp, &v1pb.DeleteMemoRequest{Name: visible.Name})
	require.Equal(t, codes.FailedPrecondition, status.Code(err))
	relations, err := svc.ListMemoRelations(app, &v1pb.ListMemoRelationsRequest{Name: hidden.Name})
	require.NoError(t, err)
	require.Len(t, relations.Relations, 1)
}

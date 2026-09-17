package test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/types/known/fieldmaskpb"

	v1pb "github.com/usememos/memos/proto/gen/api/v1"
)

func TestShortcutTodoScopePersists(t *testing.T) {
	ctx := context.Background()
	ts := NewTestService(t)
	defer ts.Cleanup()
	user, err := ts.CreateHostUser(ctx, "shortcut-scope")
	require.NoError(t, err)
	ctx = ts.CreateUserContext(ctx, user.ID)
	parent := "users/" + user.Username
	for _, todo := range []bool{false, true} {
		created, err := ts.Service.CreateShortcut(ctx, &v1pb.CreateShortcutRequest{
			Parent: parent, Shortcut: &v1pb.Shortcut{Title: "同名捷径", Filter: "pinned", IsTodo: todo},
		})
		require.NoError(t, err)
		require.Equal(t, todo, created.IsTodo)
		got, err := ts.Service.GetShortcut(ctx, &v1pb.GetShortcutRequest{Name: created.Name})
		require.NoError(t, err)
		require.Equal(t, todo, got.IsTodo)
		got.Title = "更新名称"
		updated, err := ts.Service.UpdateShortcut(ctx, &v1pb.UpdateShortcutRequest{
			Shortcut: got, UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"title"}},
		})
		require.NoError(t, err)
		require.Equal(t, todo, updated.IsTodo)
	}
	listed, err := ts.Service.ListShortcuts(ctx, &v1pb.ListShortcutsRequest{Parent: parent})
	require.NoError(t, err)
	require.Len(t, listed.Shortcuts, 2)
	require.False(t, listed.Shortcuts[0].IsTodo)
	require.True(t, listed.Shortcuts[1].IsTodo)
}

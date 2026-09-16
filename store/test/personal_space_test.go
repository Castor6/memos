package test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	storepb "github.com/usememos/memos/proto/gen/store"
	"github.com/usememos/memos/store"
)

func TestPersonalSpaceQueries(t *testing.T) {
	ctx := context.Background()
	db := NewTestingStore(ctx, t)
	defer db.Close()
	user, err := db.CreateUser(ctx, &store.User{Username: "spaces", Role: store.RoleUser})
	require.NoError(t, err)
	personal, company := store.WithSpace(ctx, ""), store.WithSpace(ctx, "company")
	for _, test := range []struct {
		ctx  context.Context
		uid  string
		todo bool
	}{{personal, "personal-note", false}, {company, "company-note", false}, {company, "company-todo", true}} {
		_, err = db.CreateMemo(test.ctx, &store.Memo{UID: test.uid, CreatorID: user.ID, Visibility: store.Private, Content: "共同搜索词", Payload: &storepb.MemoPayload{IsTodo: test.todo, ExplicitTags: true, Tags: []string{"项目"}}})
		require.NoError(t, err)
	}
	notesOnly := false
	todoOnly := true
	notes, err := db.ListMemos(company, &store.FindMemo{IsTodo: &notesOnly})
	require.NoError(t, err)
	require.Len(t, notes, 1)
	require.Equal(t, "company-note", notes[0].UID)
	todos, err := db.ListMemos(company, &store.FindMemo{IsTodo: &todoOnly})
	require.NoError(t, err)
	require.Len(t, todos, 1)
	require.Equal(t, "company-todo", todos[0].UID)
	personalNotes, err := db.ListMemos(personal, &store.FindMemo{})
	require.NoError(t, err)
	require.Len(t, personalNotes, 1)
	// Explicit filters cannot override the request's selected space.
	other := "company"
	personalNotes, err = db.ListMemos(personal, &store.FindMemo{Space: &other})
	require.NoError(t, err)
	require.Len(t, personalNotes, 1)
	require.Equal(t, "personal-note", personalNotes[0].UID)
	for _, scoped := range []context.Context{personal, company} {
		_, err = db.CreateAttachment(scoped, &store.Attachment{UID: map[bool]string{true: "company-file", false: "personal-file"}[scoped == company], CreatorID: user.ID, Filename: "sample.txt", Type: "text/plain"})
		require.NoError(t, err)
	}
	attachments, err := db.ListAttachments(company, &store.FindAttachment{})
	require.NoError(t, err)
	require.Len(t, attachments, 1)
	require.Equal(t, "company-file", attachments[0].UID)
	allNotes, err := db.ListMemos(ctx, &store.FindMemo{})
	require.NoError(t, err)
	require.Len(t, allNotes, 3, "background processing still sees every space")
}

package test

import (
	"context"
	"embed"
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	storepb "github.com/usememos/memos/proto/gen/store"
	"github.com/usememos/memos/store"
	"github.com/usememos/memos/store/db"
)

//go:embed testdata/pre_personal_indexes/*.sql
var prePersonalIndexSchemas embed.FS

func TestPersonalSpaceMigration(t *testing.T) {
	ctx := context.Background()
	driver := getDriverFromEnv()
	profile := getTestingProfileForDriver(t, driver)
	backend, err := db.NewDBDriver(profile)
	require.NoError(t, err)
	ts := store.New(backend, profile)
	defer ts.Close()
	schema, err := prePersonalIndexSchemas.ReadFile("testdata/pre_personal_indexes/" + driver + ".sql")
	require.NoError(t, err)
	_, err = backend.GetDB().ExecContext(ctx, string(schema))
	require.NoError(t, err)
	_, err = ts.UpsertInstanceSetting(ctx, &storepb.InstanceSetting{Key: storepb.InstanceSettingKey_BASIC, Value: &storepb.InstanceSetting_BasicSetting{BasicSetting: &storepb.InstanceBasicSetting{SchemaVersion: "0.30.1"}}})
	require.NoError(t, err)
	user, err := ts.CreateUser(ctx, &store.User{Username: "migration-owner", Role: store.RoleUser})
	require.NoError(t, err)
	// Simulate both production records and records created by this PR's JSON prototype.
	for i, payload := range []string{`{"tags":["旧标签"]}`, `{"space":"company","isTodo":true,"explicitTags":true,"tags":["项目A"],"property":{"hasTaskList":true}}`} {
		query := "INSERT INTO memo (uid, creator_id, content, visibility, payload) VALUES (?, ?, ?, ?, ?)"
		if driver == "postgres" {
			query = "INSERT INTO memo (uid, creator_id, content, visibility, payload) VALUES ($1,$2,$3,$4,$5)"
		}
		_, err = backend.GetDB().ExecContext(ctx, query, fmt.Sprintf("legacy-%d", i), user.ID, "- [ ] 保留正文", "PRIVATE", payload)
		require.NoError(t, err)
	}
	query := "INSERT INTO attachment (uid, creator_id, filename, payload, blob) VALUES (?, ?, ?, ?, ?)"
	if driver == "postgres" {
		query = "INSERT INTO attachment (uid, creator_id, filename, payload, blob) VALUES ($1,$2,$3,$4,$5)"
	}
	_, err = backend.GetDB().ExecContext(ctx, query, "legacy-file", user.ID, "保留附件.txt", `{"space":"company"}`, []byte("original-file-content"))
	require.NoError(t, err)
	_, err = backend.GetDB().ExecContext(ctx, "INSERT INTO memo_relation (memo_id, related_memo_id, type) SELECT a.id,b.id,'REFERENCE' FROM memo a CROSS JOIN memo b WHERE a.uid='legacy-1' AND b.uid='legacy-0'")
	require.NoError(t, err)
	require.NoError(t, ts.Migrate(ctx))
	require.NoError(t, ts.Migrate(ctx), "restart must not replay migration")
	memos, err := ts.ListMemos(ctx, &store.FindMemo{})
	require.NoError(t, err)
	require.Len(t, memos, 2)
	for _, memo := range memos {
		require.Equal(t, "- [ ] 保留正文", memo.Content)
		if memo.UID == "legacy-0" {
			require.Empty(t, memo.Space)
			require.False(t, memo.IsTodo)
			require.Equal(t, []string{"旧标签"}, memo.Payload.Tags)
		} else {
			require.Equal(t, "company", memo.Space)
			require.True(t, memo.IsTodo)
			require.True(t, memo.Payload.ExplicitTags)
			require.Equal(t, []string{"项目A"}, memo.Payload.Tags)
		}
	}
	files, err := ts.ListAttachments(store.WithSpace(ctx, "company"), &store.FindAttachment{GetBlob: true})
	require.NoError(t, err)
	require.Len(t, files, 1)
	require.Equal(t, "保留附件.txt", files[0].Filename)
	require.Equal(t, "company", files[0].Space)
	require.Equal(t, []byte("original-file-content"), files[0].Blob)
	relations, err := ts.ListMemoRelations(ctx, &store.FindMemoRelation{})
	require.NoError(t, err)
	require.Len(t, relations, 1)
	query = "SELECT payload FROM memo UNION ALL SELECT payload FROM attachment"
	if driver == "postgres" {
		query = "SELECT payload::text FROM memo UNION ALL SELECT payload FROM attachment"
	}
	rows, err := backend.GetDB().QueryContext(ctx, query)
	require.NoError(t, err)
	defer rows.Close()
	for rows.Next() {
		var payload string
		require.NoError(t, rows.Scan(&payload))
		require.NotContains(t, payload, `"space"`)
		require.NotContains(t, payload, `"isTodo"`)
	}
	require.NoError(t, rows.Err())
	rows.Close()
	assertPersonalIndexes(t, ts, driver)
	// Updating other payload properties must never change the promoted columns.
	companyMemos, err := ts.ListMemos(store.WithSpace(ctx, "company"), &store.FindMemo{})
	require.NoError(t, err)
	require.Len(t, companyMemos, 1)
	require.NoError(t, ts.UpdateMemo(ctx, &store.UpdateMemo{ID: companyMemos[0].ID, Payload: &storepb.MemoPayload{Tags: []string{"新标签"}, ExplicitTags: true}}))
	companyMemos, err = ts.ListMemos(store.WithSpace(ctx, "company"), &store.FindMemo{})
	require.NoError(t, err)
	require.Len(t, companyMemos, 1)
	require.True(t, companyMemos[0].IsTodo)
}

func assertPersonalIndexes(t *testing.T, ts *store.Store, driver string) {
	t.Helper()
	query := "SELECT name FROM sqlite_master WHERE type = 'index'"
	if driver == "mysql" {
		query = "SELECT DISTINCT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()"
	}
	if driver == "postgres" {
		query = "SELECT indexname FROM pg_indexes WHERE schemaname = 'public'"
	}
	rows, err := ts.GetDriver().GetDB().Query(query)
	require.NoError(t, err)
	defer rows.Close()
	var names []string
	for rows.Next() {
		var name string
		require.NoError(t, rows.Scan(&name))
		names = append(names, name)
	}
	require.NoError(t, rows.Err())
	for _, name := range strings.Fields("idx_memo_space_created idx_memo_space_updated idx_memo_space_pinned_created idx_memo_space_pinned_updated idx_attachment_space_updated idx_attachment_memo_space idx_memo_relation_target") {
		require.Contains(t, names, name)
	}
}

func TestPersonalSpaceFreshIndexes(t *testing.T) {
	ts := NewTestingStore(context.Background(), t)
	defer ts.Close()
	assertPersonalIndexes(t, ts, getDriverFromEnv())
}

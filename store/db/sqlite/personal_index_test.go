package sqlite

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/usememos/memos/internal/profile"
	"github.com/usememos/memos/store"
)

func TestPersonalContentQueryPlans(t *testing.T) {
	ctx := context.Background()
	backend, err := NewDB(&profile.Profile{DSN: filepath.Join(t.TempDir(), "plans.db")})
	require.NoError(t, err)
	defer backend.Close()
	d, ok := backend.(*DB)
	require.True(t, ok)
	schema, err := os.ReadFile("../../migration/sqlite/LATEST.sql")
	require.NoError(t, err)
	_, err = d.db.ExecContext(ctx, string(schema))
	require.NoError(t, err)
	// Vary owner, space, type, pinning and both timestamps independently.
	_, err = d.db.ExecContext(ctx, `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10000)
 INSERT INTO memo (uid,creator_id,space,is_todo,pinned,created_ts,updated_ts,content)
 SELECT 'memo-'||i, i%5, 'space-'||((i/5)%10), (i/50)%2, (i/100)%2, 1700000000+i, 1700000000+(i*7919)%10000, '正文' FROM n`)
	require.NoError(t, err)
	var spaces int
	require.NoError(t, d.db.QueryRow("SELECT COUNT(DISTINCT space) FROM memo").Scan(&spaces))
	require.Equal(t, 10, spaces)
	_, err = d.db.ExecContext(ctx, `INSERT INTO attachment(uid,creator_id,space,memo_id,updated_ts) SELECT uid,creator_id,space,id,updated_ts FROM memo;
 INSERT INTO memo_relation(memo_id,related_memo_id,type) SELECT id,(id%10000)+1,'REFERENCE' FROM memo;
 ANALYZE;`)
	require.NoError(t, err)
	plan := func(query string, args ...any) string {
		rows, err := d.db.QueryContext(ctx, "EXPLAIN QUERY PLAN "+query, args...)
		require.NoError(t, err)
		defer rows.Close()
		var steps []string
		for rows.Next() {
			var id, parent, unused int
			var detail string
			require.NoError(t, rows.Scan(&id, &parent, &unused, &detail))
			steps = append(steps, detail)
		}
		require.NoError(t, rows.Err())
		return strings.Join(steps, "\n")
	}
	owner, space, todo, state, limit := int32(1), "space-2", false, store.Normal, 30
	for _, updated := range []bool{false, true} {
		for _, pinned := range []bool{false, true} {
			t.Run(fmt.Sprintf("memo_updated_%t_pinned_%t", updated, pinned), func(t *testing.T) {
				find := &store.FindMemo{CreatorID: &owner, Space: &space, IsTodo: &todo, RowStatus: &state, OrderByPinned: pinned, OrderByUpdatedTs: updated, ExcludeComments: true, Limit: &limit}
				query, args, err := buildMemoQuery(ctx, find)
				require.NoError(t, err)
				result := plan(query, args...)
				index := "idx_memo_space_"
				if pinned {
					index += "pinned_"
				}
				if updated {
					index += "updated"
				} else {
					index += "created"
				}
				require.Contains(t, result, index)
				require.NotContains(t, result, "USE TEMP B-TREE")
				require.NotContains(t, result, "SCAN memo")
				t.Log(result)
			})
		}
	}
	for _, byMemo := range []bool{false, true} {
		t.Run(fmt.Sprintf("attachment_by_memo_%t", byMemo), func(t *testing.T) {
			find := &store.FindAttachment{CreatorID: &owner, Space: &space, Limit: &limit}
			index := "idx_attachment_space_updated"
			if byMemo {
				find.CreatorID = nil
				find.MemoID = &owner
				index = "idx_attachment_memo_space"
			}
			query, args, err := buildAttachmentQuery(ctx, find)
			require.NoError(t, err)
			result := plan(query, args...)
			require.Contains(t, result, index)
			require.NotContains(t, result, "SCAN attachment")
			if !byMemo {
				require.NotContains(t, result, "USE TEMP B-TREE")
			}
			t.Log(result)
		})
	}
	result := plan("SELECT memo_id,related_memo_id,type FROM memo_relation WHERE related_memo_id=? AND type=?", 1, "REFERENCE")
	require.Contains(t, result, "idx_memo_relation_target")
	require.NotContains(t, result, "SCAN memo_relation")
}

package test

import (
	"archive/zip"
	"bytes"
	"context"
	"fmt"
	"io/fs"
	"maps"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/usememos/memos/internal/memoexport"
	v1pb "github.com/usememos/memos/proto/gen/api/v1"
	storepb "github.com/usememos/memos/proto/gen/store"
	"github.com/usememos/memos/store"
)

func archiveRegressionAssertEmpty(t *testing.T, ts *TestService, ctx context.Context, user *store.User) {
	t.Helper()
	ctx = store.WithoutSpace(ctx)
	memos, err := ts.Store.ListMemos(ctx, &store.FindMemo{CreatorID: &user.ID})
	require.NoError(t, err)
	require.Empty(t, memos, "failed imports must not leave memo UIDs that a retry would skip")
	attachments, err := ts.Store.ListAttachments(ctx, &store.FindAttachment{CreatorID: &user.ID})
	require.NoError(t, err)
	require.Empty(t, attachments, "failed imports must remove attachments in every personal space")
	var relations int
	require.NoError(t, ts.Store.GetDriver().GetDB().QueryRowContext(ctx, "SELECT COUNT(*) FROM memo_relation").Scan(&relations))
	require.Zero(t, relations, "rollback must not leave dangling references or parent relations")
	assets := filepath.Join(ts.Store.GetDataDir(), "assets")
	if _, err := os.Stat(assets); os.IsNotExist(err) {
		return
	}
	require.NoError(t, filepath.WalkDir(assets, func(path string, entry fs.DirEntry, err error) error {
		require.NoError(t, err)
		require.True(t, entry.IsDir(), "failed imports must remove stored files: %s", path)
		return nil
	}))
}

func TestMemoArchiveRegressionRollbackAndRetry(t *testing.T) {
	_, _, exported := archiveFixture(t)
	for _, test := range []struct {
		name    string
		trigger string
	}{
		{"attachment_binding", `CREATE TRIGGER archive_regression_failure BEFORE UPDATE OF memo_id ON attachment
WHEN NEW.memo_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'injected attachment binding failure'); END`},
		{"final_state", `CREATE TRIGGER archive_regression_failure BEFORE UPDATE OF row_status ON memo
WHEN NEW.uid = 'archive-todo' BEGIN SELECT RAISE(ABORT, 'injected final state failure'); END`},
		{"comment_relation", `CREATE TRIGGER archive_regression_failure BEFORE INSERT ON memo_relation
WHEN NEW.type = 'COMMENT' BEGIN SELECT RAISE(ABORT, 'injected comment relation failure'); END`},
	} {
		t.Run(test.name, func(t *testing.T) {
			destination, ctx, user := archiveDestination(t)
			_, err := destination.Store.UpsertUserSetting(ctx, &storepb.UserSetting{UserId: user.ID, Key: storepb.UserSetting_GENERAL, Value: &storepb.UserSetting_General{General: &storepb.GeneralUserSetting{Spaces: map[string]string{"company": "公司"}}}})
			require.NoError(t, err)
			// The selected space differs from the imported attachment's space.
			ctx = store.WithSpace(ctx, "company")
			db := destination.Store.GetDriver().GetDB()
			_, err = db.ExecContext(ctx, test.trigger)
			require.NoError(t, err)
			failed, err := destination.Service.ImportMemoArchive(ctx, &v1pb.ImportMemoArchiveRequest{Content: exported.Content})
			require.NoError(t, err)
			require.NotEmpty(t, failed.Errors)
			require.Zero(t, failed.Imported)
			require.Zero(t, failed.Attachments)
			archiveRegressionAssertEmpty(t, destination, ctx, user)
			_, err = db.ExecContext(ctx, "DROP TRIGGER archive_regression_failure")
			require.NoError(t, err)
			retried, err := destination.Service.ImportMemoArchive(ctx, &v1pb.ImportMemoArchiveRequest{Content: exported.Content})
			require.NoError(t, err)
			require.Empty(t, retried.Errors)
			require.EqualValues(t, 4, retried.Imported)
			require.EqualValues(t, 1, retried.Attachments)
			require.Zero(t, retried.Skipped)
			comment, err := destination.Service.GetMemo(store.WithSpace(ctx, ""), &v1pb.GetMemoRequest{Name: "memos/archive-comment"})
			require.NoError(t, err)
			require.Equal(t, "memos/archive-note", comment.GetParent())
			todo, err := destination.Service.GetMemo(ctx, &v1pb.GetMemoRequest{Name: "memos/archive-todo"})
			require.NoError(t, err)
			require.Equal(t, v1pb.State_ARCHIVED, todo.State)
			require.True(t, todo.Pinned)
		})
	}
}

func archiveRegressionManifest() *memoexport.Manifest {
	return &memoexport.Manifest{Generator: memoexport.Generator{Name: "regression", Version: "1"}, ExportTime: memoexport.FormatTime(1700000000), Scope: memoexport.Scope{Kind: memoexport.ScopeKindUser, User: &memoexport.ScopeUser{Username: "regression"}}}
}

func archiveRegressionMemo(uid string) *memoexport.Memo {
	return &memoexport.Memo{UID: uid, Creator: "regression", CreateTime: memoexport.FormatTime(1700000000), UpdateTime: memoexport.FormatTime(1700000000), State: "NORMAL", Visibility: "PRIVATE"}
}

func TestMemoArchiveRegressionArchivedPublicNeverExposed(t *testing.T) {
	var output bytes.Buffer
	w := memoexport.NewWriter(&output, time.Unix(1700000000, 0))
	record := archiveRegressionMemo("archived-public")
	record.State, record.Visibility = "ARCHIVED", "PUBLIC"
	require.NoError(t, w.WriteMemo(record, []byte("archived secret")))
	require.NoError(t, w.WriteManifest(archiveRegressionManifest()))
	require.NoError(t, w.Close())
	destination, ctx, _ := archiveDestination(t)
	db := destination.Store.GetDriver().GetDB()
	_, err := db.ExecContext(ctx, `CREATE TABLE archive_regression_exposure (visibility TEXT, row_status TEXT)`)
	require.NoError(t, err)
	for _, operation := range []string{"INSERT", "UPDATE"} {
		_, err = db.ExecContext(ctx, fmt.Sprintf(`CREATE TRIGGER archive_regression_exposure_%s AFTER %s ON memo
WHEN NEW.uid = 'archived-public' AND NEW.visibility != 'PRIVATE' AND NEW.row_status != 'ARCHIVED'
BEGIN INSERT INTO archive_regression_exposure VALUES (NEW.visibility, NEW.row_status); END`, operation, operation))
		require.NoError(t, err)
	}
	result, err := destination.Service.ImportMemoArchive(ctx, &v1pb.ImportMemoArchiveRequest{Content: output.Bytes()})
	require.NoError(t, err)
	require.Empty(t, result.Errors)
	require.EqualValues(t, 1, result.Imported)
	var exposedWrites int
	require.NoError(t, db.QueryRowContext(ctx, "SELECT COUNT(*) FROM archive_regression_exposure").Scan(&exposedWrites))
	require.Zero(t, exposedWrites, "archived notes must never be committed as normal public notes")
	ownerView, err := destination.Service.GetMemo(ctx, &v1pb.GetMemoRequest{Name: "memos/archived-public"})
	require.NoError(t, err)
	require.Equal(t, v1pb.State_ARCHIVED, ownerView.State)
	require.Equal(t, v1pb.Visibility_PUBLIC, ownerView.Visibility)
	other, err := destination.CreateRegularUser(context.Background(), "archive-outsider")
	require.NoError(t, err)
	for _, reader := range []context.Context{context.Background(), destination.CreateUserContext(context.Background(), other.ID)} {
		_, err := destination.Service.GetMemo(reader, &v1pb.GetMemoRequest{Name: "memos/archived-public"})
		require.Equal(t, codes.NotFound, status.Code(err))
	}
}

func TestMemoArchiveRegressionSharedEntryLogicalBudget(t *testing.T) {
	var output bytes.Buffer
	w := memoexport.NewWriter(&output, time.Unix(1700000000, 0))
	path := memoexport.AttachmentPath("shared-entry", "shared.bin")
	digest, size, err := w.WriteAttachment(path, bytes.NewReader(bytes.Repeat([]byte{'x'}, 24<<20)))
	require.NoError(t, err)
	record := archiveRegressionMemo("amplification-note")
	for i := 0; i < 22; i++ {
		record.Attachments = append(record.Attachments, memoexport.Attachment{UID: fmt.Sprintf("alias-file-%d", i), Filename: "shared.bin", Type: "application/octet-stream", Size: size, SHA256: digest, Path: path, CreateTime: record.CreateTime})
	}
	require.NoError(t, w.WriteMemo(record, []byte("shared archive entry")))
	require.NoError(t, w.WriteManifest(archiveRegressionManifest()))
	require.NoError(t, w.Close())
	reader, err := zip.NewReader(bytes.NewReader(output.Bytes()), int64(output.Len()))
	require.NoError(t, err)
	var physicalBytes uint64
	for _, entry := range reader.File {
		physicalBytes += entry.UncompressedSize64
	}
	require.Less(t, physicalBytes, uint64(25<<20))
	destination, ctx, user := archiveDestination(t)
	_, err = destination.Service.ImportMemoArchive(ctx, &v1pb.ImportMemoArchiveRequest{Content: output.Bytes()})
	require.Equal(t, codes.ResourceExhausted, status.Code(err), "unexpected rejection: %v", err)
	require.Contains(t, status.Convert(err).Message(), "512 MiB")
	archiveRegressionAssertEmpty(t, destination, ctx, user)
}

func TestMemoArchiveRegressionSpaceCollisionRepeat(t *testing.T) {
	_, _, exported := archiveFixture(t)
	for _, initialCount := range []int{1, 98} {
		t.Run(fmt.Sprintf("initial_spaces_%d", initialCount), func(t *testing.T) {
			destination, ctx, user := archiveDestination(t)
			initial := map[string]string{"company": "原有公司"}
			for i := 1; i < initialCount; i++ {
				initial[fmt.Sprintf("existing-space-%d", i)] = fmt.Sprintf("已有空间 %d", i)
			}
			_, err := destination.Store.UpsertUserSetting(ctx, &storepb.UserSetting{UserId: user.ID, Key: storepb.UserSetting_GENERAL, Value: &storepb.UserSetting_General{General: &storepb.GeneralUserSetting{Spaces: initial}}})
			require.NoError(t, err)
			first, err := destination.Service.ImportMemoArchive(ctx, &v1pb.ImportMemoArchiveRequest{Content: exported.Content})
			require.NoError(t, err)
			require.Empty(t, first.Errors)
			require.EqualValues(t, 4, first.Imported)
			setting, err := destination.Store.GetUserSetting(ctx, &store.FindUserSetting{UserID: &user.ID, Key: storepb.UserSetting_GENERAL})
			require.NoError(t, err)
			spaces := maps.Clone(setting.GetGeneral().Spaces)
			require.Len(t, spaces, initialCount+2)
			for i := 0; i < 2; i++ {
				repeated, err := destination.Service.ImportMemoArchive(ctx, &v1pb.ImportMemoArchiveRequest{Content: exported.Content})
				require.NoError(t, err)
				require.Empty(t, repeated.Errors)
				require.Zero(t, repeated.Imported)
				require.EqualValues(t, 4, repeated.Skipped)
				setting, err := destination.Store.GetUserSetting(ctx, &store.FindUserSetting{UserID: &user.ID, Key: storepb.UserSetting_GENERAL})
				require.NoError(t, err)
				require.Equal(t, spaces, setting.GetGeneral().Spaces, "repeating a collided archive must not create empty spaces")
			}
		})
	}
}

func TestMemoArchiveRegressionFailedCollisionRetryReusesSpace(t *testing.T) {
	_, _, exported := archiveFixture(t)
	destination, ctx, user := archiveDestination(t)
	_, err := destination.Store.UpsertUserSetting(ctx, &storepb.UserSetting{UserId: user.ID, Key: storepb.UserSetting_GENERAL, Value: &storepb.UserSetting_General{General: &storepb.GeneralUserSetting{Spaces: map[string]string{"company": "原有公司"}}}})
	require.NoError(t, err)
	db := destination.Store.GetDriver().GetDB()
	_, err = db.ExecContext(ctx, `CREATE TRIGGER archive_regression_failure BEFORE UPDATE OF row_status ON memo
WHEN NEW.uid = 'archive-todo' BEGIN SELECT RAISE(ABORT, 'injected final state failure'); END`)
	require.NoError(t, err)
	var previousSpaces map[string]string
	for i := 0; i < 2; i++ {
		failed, err := destination.Service.ImportMemoArchive(ctx, &v1pb.ImportMemoArchiveRequest{Content: exported.Content})
		require.NoError(t, err)
		require.NotEmpty(t, failed.Errors)
		require.Zero(t, failed.Imported)
		require.Zero(t, failed.Attachments)
		archiveRegressionAssertEmpty(t, destination, ctx, user)
		setting, err := destination.Store.GetUserSetting(ctx, &store.FindUserSetting{UserID: &user.ID, Key: storepb.UserSetting_GENERAL})
		require.NoError(t, err)
		if previousSpaces != nil {
			require.Equal(t, previousSpaces, setting.GetGeneral().Spaces, "retrying a failed import must reuse its empty collision space")
		}
		previousSpaces = maps.Clone(setting.GetGeneral().Spaces)
	}
	_, err = db.ExecContext(ctx, "DROP TRIGGER archive_regression_failure")
	require.NoError(t, err)
	retried, err := destination.Service.ImportMemoArchive(ctx, &v1pb.ImportMemoArchiveRequest{Content: exported.Content})
	require.NoError(t, err)
	require.Empty(t, retried.Errors)
	require.EqualValues(t, 4, retried.Imported)
	require.EqualValues(t, 1, retried.Attachments)
	setting, err := destination.Store.GetUserSetting(ctx, &store.FindUserSetting{UserID: &user.ID, Key: storepb.UserSetting_GENERAL})
	require.NoError(t, err)
	require.Equal(t, previousSpaces, setting.GetGeneral().Spaces)
}

func TestMemoArchiveRegressionCompressibleAttachmentsRoundTrip(t *testing.T) {
	source, ctx, _ := archiveDestination(t)
	content := bytes.Repeat([]byte{0}, 24<<20)
	var attachments []*v1pb.Attachment
	for i := 0; i < 3; i++ {
		attachment, err := source.Service.CreateAttachment(ctx, &v1pb.CreateAttachmentRequest{AttachmentId: fmt.Sprintf("compressible-%d", i), Attachment: &v1pb.Attachment{Filename: fmt.Sprintf("zeros-%d.bin", i), Type: "application/octet-stream", Content: content}})
		require.NoError(t, err)
		attachments = append(attachments, attachment)
	}
	_, err := source.Service.CreateMemo(ctx, &v1pb.CreateMemoRequest{MemoId: "compressible-note", Memo: &v1pb.Memo{Content: "compressible backups", Visibility: v1pb.Visibility_PRIVATE, Attachments: attachments}})
	require.NoError(t, err)
	exported, err := source.Service.ExportMemoArchive(ctx, &v1pb.ExportMemoArchiveRequest{})
	require.NoError(t, err)
	archive, err := memoexport.Read(bytes.NewReader(exported.Content), int64(len(exported.Content)))
	require.NoError(t, err, "a successful export must be accepted by the same archive reader")
	require.Len(t, archive.Memos, 1)
	destination, destinationCtx, _ := archiveDestination(t)
	result, err := destination.Service.ImportMemoArchive(destinationCtx, &v1pb.ImportMemoArchiveRequest{Content: exported.Content})
	require.NoError(t, err)
	require.Empty(t, result.Errors)
	require.EqualValues(t, 1, result.Imported)
	require.EqualValues(t, 3, result.Attachments)
	for i := 0; i < 3; i++ {
		uid := fmt.Sprintf("compressible-%d", i)
		attachment, err := destination.Store.GetAttachment(destinationCtx, &store.FindAttachment{UID: &uid, GetBlob: true})
		require.NoError(t, err)
		require.NotNil(t, attachment)
		actual, err := destination.Service.GetAttachmentBlob(attachment)
		require.NoError(t, err)
		require.Equal(t, content, actual)
	}
}

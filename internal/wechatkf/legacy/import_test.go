package legacy

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestReadLegacySnapshot(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.db")
	db, err := sql.Open("sqlite", path)
	require.NoError(t, err)
	_, err = db.Exec(`CREATE TABLE sync(kf TEXT,cursor TEXT); INSERT INTO sync VALUES('kf','cursor');
 CREATE TABLE jobs(id TEXT,payload TEXT,state TEXT,attempts INT,next_at REAL,error TEXT,memo TEXT);
 INSERT INTO jobs VALUES('saved',NULL,'done',0,0,NULL,'memos/wkf-existing');
 CREATE TABLE replies(id TEXT,user TEXT,content TEXT,state TEXT,attempts INT,next_at REAL,created REAL,error TEXT);
 INSERT INTO replies VALUES('sent','owner','文字保存成功','sent',1,0,1700000000.5,NULL);
 CREATE TABLE reply_windows(user TEXT,latest REAL,used INT);INSERT INTO reply_windows VALUES('owner',1700000000,1);
 CREATE TABLE events(id TEXT,event_type TEXT,payload TEXT,received_at REAL);
 INSERT INTO events VALUES('event','enter_session','{"event":{"welcome_code":"private-capability","external_userid":"owner"}}',1700000000);`)
	require.NoError(t, err)
	require.NoError(t, db.Close())
	before, err := os.ReadFile(path)
	require.NoError(t, err)
	snapshot, err := Read(context.Background(), path, "kf")
	require.NoError(t, err)
	require.Equal(t, "cursor", snapshot.Cursor)
	require.Len(t, snapshot.Jobs, 1)
	require.Equal(t, "wkf-existing", snapshot.Jobs[0].Memo)
	require.Equal(t, "sent", snapshot.Replies[0].State)
	require.Equal(t, int64(1700000000), snapshot.Replies[0].CreatedAt)
	require.NotContains(t, snapshot.Events[0].Payload, "private-capability")
	after, err := os.ReadFile(path)
	require.NoError(t, err)
	require.Equal(t, sha256.Sum256(before), sha256.Sum256(after))
	_, err = Read(context.Background(), path, "wrong-kf")
	require.Error(t, err)
}
func TestLegacyConfigOmitsMemosToken(t *testing.T) {
	path := filepath.Join(t.TempDir(), "service.env")
	require.NoError(t, os.WriteFile(path, []byte("WECHAT_CORP_ID=corp\nWECHAT_KF_ID=kf\nWECHAT_SECRET=test-secret\nWECHAT_CALLBACK_TOKEN=testToken\nWECHAT_ENCODING_AES_KEY=test-key\nWECHAT_ALLOWED_USERS=owner\nMEMOS_TOKEN=obsolete-private-token\nDEFAULT_TAGS=标签\n"), 0600))
	config, err := Configuration(path)
	require.NoError(t, err)
	require.False(t, config.Enabled)
	require.Equal(t, []string{"标签"}, config.DefaultTags)
	require.Equal(t, "test-secret", config.Secret)
}

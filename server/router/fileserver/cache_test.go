package fileserver

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/labstack/echo/v5"
	"github.com/stretchr/testify/require"

	storepb "github.com/usememos/memos/proto/gen/store"
	"github.com/usememos/memos/server/auth"
	"github.com/usememos/memos/store"
)

func TestAttachmentImageCacheAndConditionalPermissions(t *testing.T) {
	ctx := context.Background()
	_, fs, testStore, cleanup := newShareAttachmentTestServices(ctx, t)
	t.Cleanup(cleanup)
	owner, err := testStore.CreateUser(ctx, &store.User{Username: "image-cache-owner", Role: store.RoleUser})
	require.NoError(t, err)
	memo, err := testStore.CreateMemo(ctx, &store.Memo{UID: "image-cache-memo", CreatorID: owner.ID, Visibility: store.Public, Content: "image"})
	require.NoError(t, err)
	imageData, err := base64.StdEncoding.DecodeString(strings.SplitN(makePNGDataURI(t), ",", 2)[1])
	require.NoError(t, err)
	filePath := filepath.Join(fs.Profile.Data, "cached.png")
	require.NoError(t, os.WriteFile(filePath, imageData, 0600))
	modified := time.Now().Add(-time.Hour).Truncate(time.Second)
	require.NoError(t, os.Chtimes(filePath, modified, modified))
	attachment, err := testStore.CreateAttachment(ctx, &store.Attachment{
		UID: "image-cache-file", CreatorID: owner.ID, MemoID: &memo.ID, Filename: "cached.png", Type: "image/png",
		StorageType: storepb.AttachmentStorageType_LOCAL, Reference: "cached.png", Size: int64(len(imageData)),
	})
	require.NoError(t, err)
	e := echo.New()
	fs.RegisterRoutes(e)
	url := "/file/attachments/" + attachment.UID + "/cached.png"
	request := func(url string, headers map[string]string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, url, nil)
		for name, value := range headers {
			req.Header.Set(name, value)
		}
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)
		return rec
	}

	initial := request(url, nil)
	require.Equal(t, http.StatusOK, initial.Code)
	require.Equal(t, "private, max-age=2592000, must-revalidate", initial.Header().Get("Cache-Control"))
	require.Equal(t, imageData, initial.Body.Bytes())
	lastModified := initial.Header().Get("Last-Modified")
	require.NotEmpty(t, lastModified)

	ranged := request(url, map[string]string{"Range": "bytes=0-7"})
	require.Equal(t, http.StatusPartialContent, ranged.Code)
	require.Equal(t, initial.Header().Get("Cache-Control"), ranged.Header().Get("Cache-Control"))
	require.Equal(t, imageData[:8], ranged.Body.Bytes())

	conditional := map[string]string{"If-Modified-Since": lastModified}
	unchanged := request(url, conditional)
	require.Equal(t, http.StatusNotModified, unchanged.Code)
	require.Empty(t, unchanged.Body.Bytes())
	require.Empty(t, unchanged.Header().Get("Content-Type"))
	require.Equal(t, initial.Header().Get("Cache-Control"), unchanged.Header().Get("Cache-Control"))

	invalidRange := request(url, map[string]string{"Range": "bytes=999999-"})
	require.Equal(t, http.StatusRequestedRangeNotSatisfiable, invalidRange.Code)
	require.Equal(t, "private, no-store", invalidRange.Header().Get("Cache-Control"))

	// Permission checks must still run before a conditional response is returned.
	visibility := store.Private
	require.NoError(t, testStore.UpdateMemo(ctx, &store.UpdateMemo{ID: memo.ID, Visibility: &visibility}))
	unauthorized := request(url, conditional)
	require.Equal(t, http.StatusUnauthorized, unauthorized.Code)
	require.Equal(t, "private, no-store", unauthorized.Header().Get("Cache-Control"))
	ownerToken, _, err := auth.GenerateAccessTokenV2(owner.ID, owner.Username, string(owner.Role), string(store.Normal), []byte("test-secret"))
	require.NoError(t, err)
	ownerUnchanged := request(url, map[string]string{"If-Modified-Since": lastModified, "Authorization": "Bearer " + ownerToken})
	require.Equal(t, http.StatusNotModified, ownerUnchanged.Code)
	require.Equal(t, initial.Header().Get("Cache-Control"), ownerUnchanged.Header().Get("Cache-Control"))
	other, err := testStore.CreateUser(ctx, &store.User{Username: "image-cache-other", Role: store.RoleUser})
	require.NoError(t, err)
	otherToken, _, err := auth.GenerateAccessTokenV2(other.ID, other.Username, string(other.Role), string(store.Normal), []byte("test-secret"))
	require.NoError(t, err)
	forbidden := request(url, map[string]string{"If-Modified-Since": lastModified, "Authorization": "Bearer " + otherToken})
	require.Equal(t, http.StatusForbidden, forbidden.Code)
	require.Equal(t, "private, no-store", forbidden.Header().Get("Cache-Control"))

	share, err := testStore.CreateMemoShare(ctx, &store.MemoShare{UID: "image-cache-share", CreatorID: owner.ID, MemoID: memo.ID})
	require.NoError(t, err)
	shareURL := url + "?share_token=" + share.UID
	shared := request(shareURL, nil)
	require.Equal(t, http.StatusOK, shared.Code)
	require.Equal(t, "private, no-store", shared.Header().Get("Cache-Control"))
	sharedUnchanged := request(shareURL, conditional)
	require.Equal(t, http.StatusNotModified, sharedUnchanged.Code)
	require.Equal(t, "private, no-store", sharedUnchanged.Header().Get("Cache-Control"))
	require.NoError(t, testStore.DeleteMemoShare(ctx, &store.DeleteMemoShare{ID: &share.ID}))
	revoked := request(shareURL, conditional)
	require.Equal(t, http.StatusUnauthorized, revoked.Code)
	require.Equal(t, "private, no-store", revoked.Header().Get("Cache-Control"))

	visibility = store.Public
	require.NoError(t, testStore.UpdateMemo(ctx, &store.UpdateMemo{ID: memo.ID, Visibility: &visibility}))
	require.NoError(t, os.Remove(filePath))
	missingFile := request(url, nil)
	require.Equal(t, http.StatusNotFound, missingFile.Code)
	require.Equal(t, "private, no-store", missingFile.Header().Get("Cache-Control"))
	missingAttachment := request("/file/attachments/unknown/cached.png", nil)
	require.Equal(t, http.StatusNotFound, missingAttachment.Code)
	require.Equal(t, "private, no-store", missingAttachment.Header().Get("Cache-Control"))

	// Storage failures returned to Echo must not retain the image success policy.
	brokenS3, err := testStore.CreateAttachment(ctx, &store.Attachment{
		UID: "broken-s3-image", CreatorID: owner.ID, MemoID: &memo.ID, Filename: "cached.png", Type: "image/png",
		StorageType: storepb.AttachmentStorageType_S3,
	})
	require.NoError(t, err)
	storageError := request("/file/attachments/"+brokenS3.UID+"/cached.png", nil)
	require.Equal(t, http.StatusInternalServerError, storageError.Code)
	require.Equal(t, "private, no-store", storageError.Header().Get("Cache-Control"))
}

func TestAttachmentCachePolicyForBlobAndThumbnail(t *testing.T) {
	ctx := context.Background()
	_, fs, testStore, cleanup := newShareAttachmentTestServices(ctx, t)
	t.Cleanup(cleanup)
	owner, err := testStore.CreateUser(ctx, &store.User{Username: "blob-cache-owner", Role: store.RoleUser})
	require.NoError(t, err)
	memo, err := testStore.CreateMemo(ctx, &store.Memo{UID: "blob-cache-memo", CreatorID: owner.ID, Visibility: store.Public, Content: "files"})
	require.NoError(t, err)
	imageData, err := base64.StdEncoding.DecodeString(strings.SplitN(makePNGDataURI(t), ",", 2)[1])
	require.NoError(t, err)
	e := echo.New()
	fs.RegisterRoutes(e)
	for _, tt := range []struct {
		name, mime, query, cache string
	}{
		{"image", "image/png", "", "private, max-age=2592000, must-revalidate"},
		{"thumbnail", "image/png", "?thumbnail=true", "private, max-age=2592000, must-revalidate"},
		{"document", "application/pdf", "", "private, no-store"},
		{"download", "text/plain", "", "private, no-store"},
		{"video", "video/mp4", "", "private, no-store"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			attachment, err := testStore.CreateAttachment(ctx, &store.Attachment{
				UID: "blob-cache-" + tt.name, CreatorID: owner.ID, MemoID: &memo.ID, Filename: tt.name, Type: tt.mime, Blob: imageData,
			})
			require.NoError(t, err)
			rec := httptest.NewRecorder()
			e.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/file/attachments/"+attachment.UID+"/"+tt.name+tt.query, nil))
			require.Equal(t, http.StatusOK, rec.Code)
			require.Equal(t, tt.cache, rec.Header().Get("Cache-Control"))
			require.NotEmpty(t, rec.Body.Bytes())
		})
	}
}

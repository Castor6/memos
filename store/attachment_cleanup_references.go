package store

import (
	"context"
	"net/url"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/pkg/errors"
	"google.golang.org/protobuf/encoding/protojson"

	storepb "github.com/usememos/memos/proto/gen/store"
)

type attachmentStorageIdentity struct {
	kind     storepb.AttachmentStorageType
	location string
	bucket   string
	key      string
}

func (s *Store) attachmentStorageIdentity(attachment *Attachment, setting *storepb.InstanceStorageSetting) (attachmentStorageIdentity, error) {
	identity := attachmentStorageIdentity{kind: attachment.StorageType}
	switch attachment.StorageType {
	case storepb.AttachmentStorageType_LOCAL:
		path := filepath.FromSlash(attachment.Reference)
		if !filepath.IsAbs(path) {
			path = filepath.Join(s.profile.Data, path)
		}
		absolute, err := filepath.Abs(path)
		if err != nil {
			return identity, err
		}
		if resolved, err := filepath.EvalSymlinks(absolute); err == nil {
			absolute = resolved
		}
		if runtime.GOOS == "windows" {
			absolute = strings.ToLower(absolute)
		}
		identity.location = absolute
	case storepb.AttachmentStorageType_S3:
		object := attachment.Payload.GetS3Object()
		if object == nil {
			return identity, errors.New("S3 object is missing")
		}
		config := object.S3Config
		if config == nil && setting != nil {
			config = setting.S3Config
		}
		if config == nil {
			return identity, errors.New("S3 cleanup configuration is missing")
		}
		endpoint, err := url.Parse(config.Endpoint)
		if err != nil {
			return identity, err
		}
		endpoint.Scheme = strings.ToLower(endpoint.Scheme)
		endpoint.Host = strings.ToLower(endpoint.Host)
		if endpoint.Scheme == "https" && endpoint.Port() == "443" {
			endpoint.Host = strings.TrimSuffix(endpoint.Host, ":443")
		}
		if endpoint.Scheme == "http" && endpoint.Port() == "80" {
			endpoint.Host = strings.TrimSuffix(endpoint.Host, ":80")
		}
		identity.location = strings.TrimRight(endpoint.String(), "/")
		identity.bucket, identity.key = config.Bucket, object.Key
	default:
		// Database and external attachments do not own separately deleted objects.
		return identity, nil
	}
	return identity, nil
}

func (s *Store) liveCleanupReferences(ctx context.Context, jobs []attachmentCleanupJob) (map[attachmentStorageIdentity]bool, map[string]bool, error) {
	wanted := map[attachmentStorageIdentity]bool{}
	wantedUIDs := map[string]bool{}
	uids, keys := []string{}, []string{}
	hasLocal := false
	for _, job := range jobs {
		if job.decodeError != nil {
			continue
		}
		uids = append(uids, job.attachment.UID)
		wantedUIDs[job.attachment.UID] = true
		if job.identity.kind == storepb.AttachmentStorageType_LOCAL {
			hasLocal = true
		}
		if job.identity.kind == storepb.AttachmentStorageType_S3 {
			keys = append(keys, job.identity.key)
		}
		wanted[job.identity] = true
	}
	references, activeUIDs := map[attachmentStorageIdentity]bool{}, map[string]bool{}
	if len(uids) == 0 {
		return references, activeUIDs, nil
	}
	where, args := []string{}, []any{}
	addIn := func(column string, values []string) {
		placeholders := make([]string, len(values))
		for i, value := range values {
			placeholders[i] = "?"
			args = append(args, value)
		}
		where = append(where, column+" IN ("+strings.Join(placeholders, ",")+")")
	}
	addIn("uid", uids)
	if hasLocal {
		// Legacy local references can use absolute, relative or symlink paths. Inspect
		// only local references once per pending batch so aliases protect the same file.
		where = append(where, "storage_type='LOCAL'")
	}
	var setting *storepb.InstanceStorageSetting
	if len(keys) > 0 {
		var err error
		setting, err = s.GetInstanceStorageSetting(ctx)
		if err != nil {
			return nil, nil, err
		}
		keyExpression := "COALESCE(json_extract(payload, '$.s3Object.key'), json_extract(payload, '$.s3_object.key'))"
		if s.profile.Driver == "mysql" {
			keyExpression = "COALESCE(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.s3Object.key')), JSON_UNQUOTE(JSON_EXTRACT(payload, '$.s3_object.key')))"
		}
		if s.profile.Driver == "postgres" {
			keyExpression = "COALESCE(payload::jsonb->'s3Object'->>'key', payload::jsonb->'s3_object'->>'key')"
		}
		addIn(keyExpression, keys)
		where[len(where)-1] = "(storage_type='S3' AND " + where[len(where)-1] + ")"
	}
	rows, err := s.driver.GetDB().QueryContext(ctx, s.memoSQL("SELECT uid, storage_type, reference, payload FROM attachment WHERE "+strings.Join(where, " OR ")), args...)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	for rows.Next() {
		attachment := &Attachment{}
		var storageType string
		var payload []byte
		if err := rows.Scan(&attachment.UID, &storageType, &attachment.Reference, &payload); err != nil {
			return nil, nil, err
		}
		if wantedUIDs[attachment.UID] {
			activeUIDs[attachment.UID] = true
		}
		attachment.StorageType = storepb.AttachmentStorageType(storepb.AttachmentStorageType_value[storageType])
		if attachment.StorageType != storepb.AttachmentStorageType_LOCAL && attachment.StorageType != storepb.AttachmentStorageType_S3 {
			continue
		}
		if attachment.StorageType == storepb.AttachmentStorageType_LOCAL && !hasLocal {
			continue
		}
		if attachment.StorageType == storepb.AttachmentStorageType_S3 && len(keys) == 0 {
			continue
		}
		if attachment.StorageType == storepb.AttachmentStorageType_S3 {
			attachment.Payload = &storepb.AttachmentPayload{}
			if err := (protojson.UnmarshalOptions{DiscardUnknown: true}).Unmarshal(payload, attachment.Payload); err != nil {
				return nil, nil, err
			}
		}
		identity, err := s.attachmentStorageIdentity(attachment, setting)
		if err != nil {
			return nil, nil, err
		}
		if wanted[identity] {
			references[identity] = true
		}
	}
	return references, activeUIDs, rows.Err()
}

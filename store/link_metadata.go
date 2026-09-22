package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"

	"github.com/pkg/errors"
)

// LinkMetadata is a permanent snapshot of a successfully fetched link.
type LinkMetadata struct{ URL, Title, Description, Image string }

func linkKey(url string) string { sum := sha256.Sum256([]byte(url)); return hex.EncodeToString(sum[:]) }

// GetLinkMetadata reads a snapshot; a missing URL returns nil.
func (s *Store) GetLinkMetadata(ctx context.Context, url string) (*LinkMetadata, error) {
	value := &LinkMetadata{}
	query := "SELECT url, title, description, image FROM link_metadata WHERE url_hash = ?"
	if s.profile.Driver == "postgres" {
		query = "SELECT url, title, description, image FROM link_metadata WHERE url_hash = $1"
	}
	err := s.driver.GetDB().QueryRowContext(ctx, query, linkKey(url)).Scan(&value.URL, &value.Title, &value.Description, &value.Image)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return value, err
}

// SaveLinkMetadata keeps the first successful snapshot, including across restarts.
func (s *Store) SaveLinkMetadata(ctx context.Context, value *LinkMetadata) error {
	tx, err := s.driver.GetDB().BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := saveLinkMetadata(ctx, tx, s.profile.Driver, value); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, linkMetadataSQL(s.profile.Driver, "DELETE FROM link_metadata_job WHERE url_hash = ?"), linkKey(value.URL)); err != nil {
		return err
	}
	return tx.Commit()
}

func saveLinkMetadata(ctx context.Context, db linkMetadataExecutor, dialect string, value *LinkMetadata) error {
	query := "INSERT INTO link_metadata (url_hash,url,title,description,image) VALUES (?,?,?,?,?) ON CONFLICT(url_hash) DO NOTHING"
	if dialect == "mysql" {
		query = "INSERT INTO link_metadata (url_hash,url,title,description,image) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE url_hash=url_hash"
	}
	_, err := db.ExecContext(ctx, linkMetadataSQL(dialect, query), linkKey(value.URL), value.URL, value.Title, value.Description, value.Image)
	return err
}

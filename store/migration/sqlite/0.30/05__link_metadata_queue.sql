CREATE TABLE link_metadata_job (
  url_hash VARCHAR(64) PRIMARY KEY,
  url TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_ts BIGINT NOT NULL DEFAULT 0,
  next_attempt_ts BIGINT NOT NULL DEFAULT 0,
  lease_until BIGINT NOT NULL DEFAULT 0,
  lease_token VARCHAR(64) NOT NULL DEFAULT ''
);
CREATE INDEX idx_link_metadata_job_due ON link_metadata_job (expires_ts, next_attempt_ts, url_hash);

CREATE TABLE link_metadata_backfill (
  id INTEGER PRIMARY KEY,
  cursor_id BIGINT NOT NULL DEFAULT 0,
  upper_id BIGINT NOT NULL DEFAULT 0,
  initialized INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0
);
INSERT INTO link_metadata_backfill (id) VALUES (1);

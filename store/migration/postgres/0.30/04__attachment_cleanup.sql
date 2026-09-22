CREATE TABLE attachment_cleanup (
  attachment_id INTEGER PRIMARY KEY,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX idx_attachment_cleanup_due ON attachment_cleanup (next_at, attachment_id);

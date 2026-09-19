-- Durable state for the built-in, single-account WeChat KF integration.
CREATE TABLE wechat_kf_config (
  id INTEGER PRIMARY KEY,
  value TEXT NOT NULL,
  revision BIGINT NOT NULL DEFAULT 0,
  lease_owner VARCHAR(64) NOT NULL DEFAULT '',
  lease_until BIGINT NOT NULL DEFAULT 0
);
INSERT INTO wechat_kf_config(id, value) VALUES (1, '');
CREATE TABLE wechat_kf_sync (
  id INTEGER PRIMARY KEY,
  sync_cursor TEXT NOT NULL,
  token TEXT NOT NULL,
  token_time BIGINT NOT NULL DEFAULT 0,
  generation BIGINT NOT NULL DEFAULT 0,
  next_at BIGINT NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL
);
INSERT INTO wechat_kf_sync(id, sync_cursor, token, last_error) VALUES (1, '', '', '');
CREATE TABLE wechat_kf_jobs (
  id VARCHAR(191) PRIMARY KEY,
  payload TEXT,
  kind VARCHAR(64) NOT NULL,
  user_id VARCHAR(191) NOT NULL,
  state VARCHAR(24) NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at BIGINT NOT NULL DEFAULT 0,
  error TEXT NOT NULL,
  memo TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX wechat_kf_jobs_due ON wechat_kf_jobs(state, next_at);
CREATE TABLE wechat_kf_windows (
  user_id VARCHAR(191) PRIMARY KEY,
  latest BIGINT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE wechat_kf_replies (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(191) NOT NULL,
  content TEXT NOT NULL,
  state VARCHAR(24) NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  error TEXT NOT NULL
);
CREATE INDEX wechat_kf_replies_due ON wechat_kf_replies(state, next_at);
CREATE TABLE wechat_kf_events (
  id VARCHAR(191) PRIMARY KEY,
  event_type VARCHAR(64) NOT NULL,
  payload TEXT NOT NULL,
  received_at BIGINT NOT NULL
);
CREATE INDEX wechat_kf_events_retention ON wechat_kf_events(received_at);

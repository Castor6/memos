-- system_setting
CREATE TABLE system_setting (
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  UNIQUE(name)
);

-- user
CREATE TABLE user (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_ts BIGINT NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_ts BIGINT NOT NULL DEFAULT (strftime('%s', 'now')),
  row_status TEXT NOT NULL CHECK (row_status IN ('NORMAL', 'ARCHIVED')) DEFAULT 'NORMAL',
  username TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'USER',
  email TEXT NOT NULL DEFAULT '',
  nickname TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  avatar_url TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT ''
);

-- user_setting
CREATE TABLE user_setting (
  user_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  UNIQUE(user_id, key)
);

-- memo
CREATE TABLE memo (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL UNIQUE,
  creator_id INTEGER NOT NULL,
  created_ts BIGINT NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_ts BIGINT NOT NULL DEFAULT (strftime('%s', 'now')),
  row_status TEXT NOT NULL CHECK (row_status IN ('NORMAL', 'ARCHIVED')) DEFAULT 'NORMAL',
  content TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL CHECK (visibility IN ('PUBLIC', 'PROTECTED', 'PRIVATE')) DEFAULT 'PRIVATE',
  pinned INTEGER NOT NULL CHECK (pinned IN (0, 1)) DEFAULT 0,
  space TEXT NOT NULL DEFAULT '',
  is_todo INTEGER NOT NULL DEFAULT 0 CHECK (is_todo IN (0, 1)),
  payload TEXT NOT NULL DEFAULT '{}'
);

-- memo_relation
CREATE TABLE memo_relation (
  memo_id INTEGER NOT NULL,
  related_memo_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  UNIQUE(memo_id, related_memo_id, type)
);

-- attachment
CREATE TABLE attachment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL UNIQUE,
  creator_id INTEGER NOT NULL,
  created_ts BIGINT NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_ts BIGINT NOT NULL DEFAULT (strftime('%s', 'now')),
  filename TEXT NOT NULL DEFAULT '',
  blob BLOB DEFAULT NULL,
  type TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  memo_id INTEGER,
  storage_type TEXT NOT NULL DEFAULT '',
  reference TEXT NOT NULL DEFAULT '',
  space TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}'
);

-- idp
CREATE TABLE idp (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  identifier_filter TEXT NOT NULL DEFAULT '',
  config TEXT NOT NULL DEFAULT '{}'
);

-- inbox
CREATE TABLE inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_ts BIGINT NOT NULL DEFAULT (strftime('%s', 'now')),
  sender_id INTEGER NOT NULL,
  receiver_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '{}'
);

-- reaction
CREATE TABLE reaction (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_ts BIGINT NOT NULL DEFAULT (strftime('%s', 'now')),
  creator_id INTEGER NOT NULL,
  content_id TEXT NOT NULL,
  reaction_type TEXT NOT NULL,
  UNIQUE(creator_id, content_id, reaction_type)
);

-- memo_share
CREATE TABLE memo_share (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  uid        TEXT    NOT NULL UNIQUE,
  memo_id    INTEGER NOT NULL,
  creator_id INTEGER NOT NULL,
  created_ts BIGINT  NOT NULL DEFAULT (strftime('%s', 'now')),
  expires_ts BIGINT  DEFAULT NULL,
  FOREIGN KEY (memo_id) REFERENCES memo(id) ON DELETE CASCADE
);

CREATE INDEX idx_memo_share_memo_id ON memo_share(memo_id);

-- user_identity
CREATE TABLE user_identity (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  provider   TEXT    NOT NULL,
  extern_uid TEXT    NOT NULL,
  created_ts BIGINT  NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_ts BIGINT  NOT NULL DEFAULT (strftime('%s', 'now')),
  UNIQUE (provider, extern_uid),
  UNIQUE (user_id, provider)
);

CREATE INDEX idx_user_identity_user_id ON user_identity(user_id);

-- Personal content query indexes.
CREATE INDEX idx_memo_space_created ON memo (creator_id, space, row_status, is_todo, created_ts DESC, id DESC);
CREATE INDEX idx_memo_space_updated ON memo (creator_id, space, row_status, is_todo, updated_ts DESC, id DESC);
CREATE INDEX idx_memo_space_pinned_created ON memo (creator_id, space, row_status, is_todo, pinned DESC, created_ts DESC, id DESC);
CREATE INDEX idx_memo_space_pinned_updated ON memo (creator_id, space, row_status, is_todo, pinned DESC, updated_ts DESC, id DESC);
CREATE INDEX idx_attachment_space_updated ON attachment (creator_id, space, updated_ts DESC);
CREATE INDEX idx_attachment_memo_space ON attachment (memo_id, space);
CREATE INDEX idx_memo_relation_target ON memo_relation (related_memo_id, type, memo_id);

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

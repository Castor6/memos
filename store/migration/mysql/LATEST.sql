-- system_setting
CREATE TABLE `system_setting` (
  `name` VARCHAR(256) NOT NULL PRIMARY KEY,
  `value` LONGTEXT NOT NULL,
  `description` TEXT NOT NULL
);

-- user
CREATE TABLE `user` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `created_ts` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_ts` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `row_status` VARCHAR(256) NOT NULL DEFAULT 'NORMAL',
  `username` VARCHAR(256) NOT NULL UNIQUE,
  `role` VARCHAR(256) NOT NULL DEFAULT 'USER',
  `email` VARCHAR(256) NOT NULL DEFAULT '',
  `nickname` VARCHAR(256) NOT NULL DEFAULT '',
  `password_hash` VARCHAR(256) NOT NULL,
  `avatar_url` LONGTEXT NOT NULL,
  `description` VARCHAR(256) NOT NULL DEFAULT ''
);

-- user_setting
CREATE TABLE `user_setting` (
  `user_id` INT NOT NULL,
  `key` VARCHAR(256) NOT NULL,
  `value` LONGTEXT NOT NULL,
  UNIQUE(`user_id`,`key`)
);

-- memo
CREATE TABLE `memo` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `uid` VARCHAR(256) NOT NULL UNIQUE,
  `creator_id` INT NOT NULL,
  `created_ts` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_ts` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `row_status` VARCHAR(256) NOT NULL DEFAULT 'NORMAL',
  `content` TEXT NOT NULL,
  `visibility` VARCHAR(256) NOT NULL DEFAULT 'PRIVATE',
  `pinned` BOOLEAN NOT NULL DEFAULT FALSE,
  space VARCHAR(256) COLLATE utf8mb4_bin NOT NULL DEFAULT '',
  is_todo BOOLEAN NOT NULL DEFAULT FALSE,
  `payload` JSON NOT NULL
);

-- memo_relation
CREATE TABLE `memo_relation` (
  `memo_id` INT NOT NULL,
  `related_memo_id` INT NOT NULL,
  `type` VARCHAR(256) NOT NULL,
  UNIQUE(`memo_id`,`related_memo_id`,`type`)
);

-- attachment
CREATE TABLE `attachment` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `uid` VARCHAR(256) NOT NULL UNIQUE,
  `creator_id` INT NOT NULL,
  `created_ts` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_ts` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `filename` TEXT NOT NULL,
  `blob` MEDIUMBLOB,
  `type` VARCHAR(256) NOT NULL DEFAULT '',
  `size` INT NOT NULL DEFAULT '0',
  `memo_id` INT DEFAULT NULL,
  `storage_type` VARCHAR(256) NOT NULL DEFAULT '',
  `reference` TEXT NOT NULL DEFAULT (''),
  space VARCHAR(256) COLLATE utf8mb4_bin NOT NULL DEFAULT '',
  `payload` TEXT NOT NULL
);

-- idp
CREATE TABLE `idp` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `uid` VARCHAR(256) NOT NULL UNIQUE,
  `name` TEXT NOT NULL,
  `type` TEXT NOT NULL,
  `identifier_filter` VARCHAR(256) NOT NULL DEFAULT '',
  `config` TEXT NOT NULL
);

-- inbox
CREATE TABLE `inbox` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `created_ts` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `sender_id` INT NOT NULL,
  `receiver_id` INT NOT NULL,
  `status` TEXT NOT NULL,
  `message` TEXT NOT NULL
);

-- reaction
CREATE TABLE `reaction` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `created_ts` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `creator_id` INT NOT NULL,
  `content_id` VARCHAR(256) NOT NULL,
  `reaction_type` VARCHAR(256) NOT NULL,
  UNIQUE(`creator_id`,`content_id`,`reaction_type`)  
);

-- memo_share
CREATE TABLE `memo_share` (
  `id`         INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `uid`        VARCHAR(255) NOT NULL UNIQUE,
  `memo_id`    INT          NOT NULL,
  `creator_id` INT          NOT NULL,
  `created_ts` BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
  `expires_ts` BIGINT       DEFAULT NULL,
  FOREIGN KEY (`memo_id`) REFERENCES `memo`(`id`) ON DELETE CASCADE
);

CREATE INDEX `idx_memo_share_memo_id` ON `memo_share`(`memo_id`);

-- user_identity
CREATE TABLE `user_identity` (
  `id`         INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `user_id`    INT          NOT NULL,
  `provider`   VARCHAR(256) NOT NULL,
  `extern_uid` VARCHAR(256) NOT NULL,
  `created_ts` BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
  `updated_ts` BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
  UNIQUE (`provider`, `extern_uid`),
  UNIQUE (`user_id`, `provider`)
);

CREATE INDEX `idx_user_identity_user_id` ON `user_identity`(`user_id`);

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
INSERT INTO wechat_kf_config(id, value) VALUES (1, '');
CREATE TABLE wechat_kf_sync (
  id INTEGER PRIMARY KEY,
  sync_cursor TEXT NOT NULL,
  token TEXT NOT NULL,
  token_time BIGINT NOT NULL DEFAULT 0,
  generation BIGINT NOT NULL DEFAULT 0,
  next_at BIGINT NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
INSERT INTO wechat_kf_sync(id, sync_cursor, token, last_error) VALUES (1, '', '', '');
CREATE TABLE wechat_kf_jobs (
  id VARCHAR(191) PRIMARY KEY,
  payload LONGTEXT,
  kind VARCHAR(64) NOT NULL,
  user_id VARCHAR(191) NOT NULL,
  state VARCHAR(24) NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at BIGINT NOT NULL DEFAULT 0,
  error TEXT NOT NULL,
  memo TEXT NOT NULL,
  created_at BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE INDEX wechat_kf_jobs_due ON wechat_kf_jobs(state, next_at);
CREATE TABLE wechat_kf_windows (
  user_id VARCHAR(191) PRIMARY KEY,
  latest BIGINT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE wechat_kf_replies (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(191) NOT NULL,
  content TEXT NOT NULL,
  state VARCHAR(24) NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  error TEXT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE INDEX wechat_kf_replies_due ON wechat_kf_replies(state, next_at);
CREATE TABLE wechat_kf_events (
  id VARCHAR(191) PRIMARY KEY,
  event_type VARCHAR(64) NOT NULL,
  payload LONGTEXT NOT NULL,
  received_at BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE INDEX wechat_kf_events_retention ON wechat_kf_events(received_at);

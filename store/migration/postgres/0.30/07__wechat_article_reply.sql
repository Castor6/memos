-- Persist article replies until delivery reaches a terminal state.
ALTER TABLE wechat_kf_replies ADD COLUMN kind VARCHAR(16) NOT NULL DEFAULT 'text';
ALTER TABLE wechat_kf_replies ADD COLUMN filename VARCHAR(255) NOT NULL DEFAULT '';
ALTER TABLE wechat_kf_replies ADD COLUMN file_content TEXT NULL;
ALTER TABLE wechat_kf_replies ADD COLUMN required INTEGER NOT NULL DEFAULT 0;

-- Persist core query dimensions as columns; preserve pre-release JSON data.
ALTER TABLE memo ADD COLUMN space TEXT NOT NULL DEFAULT '';
ALTER TABLE memo ADD COLUMN is_todo BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE attachment ADD COLUMN space TEXT NOT NULL DEFAULT '';

UPDATE memo SET space = COALESCE(payload->>'space', ''), is_todo = COALESCE((payload->>'isTodo')::boolean, false), payload = payload - 'space' - 'isTodo';
UPDATE attachment SET space = COALESCE(payload::jsonb->>'space', ''), payload = (payload::jsonb - 'space')::text;

CREATE INDEX idx_memo_space_created ON memo (creator_id, space, row_status, is_todo, created_ts DESC, id DESC);
CREATE INDEX idx_memo_space_updated ON memo (creator_id, space, row_status, is_todo, updated_ts DESC, id DESC);
CREATE INDEX idx_memo_space_pinned_created ON memo (creator_id, space, row_status, is_todo, pinned DESC, created_ts DESC, id DESC);
CREATE INDEX idx_memo_space_pinned_updated ON memo (creator_id, space, row_status, is_todo, pinned DESC, updated_ts DESC, id DESC);
CREATE INDEX idx_attachment_space_updated ON attachment (creator_id, space, updated_ts DESC);
CREATE INDEX idx_attachment_memo_space ON attachment (memo_id, space);
CREATE INDEX idx_memo_relation_target ON memo_relation (related_memo_id, type, memo_id);

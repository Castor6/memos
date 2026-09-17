-- Persist core query dimensions as columns; preserve pre-release JSON data.
ALTER TABLE memo ADD COLUMN space TEXT NOT NULL DEFAULT '';
ALTER TABLE memo ADD COLUMN is_todo INTEGER NOT NULL DEFAULT 0 CHECK (is_todo IN (0, 1));
ALTER TABLE attachment ADD COLUMN space TEXT NOT NULL DEFAULT '';

UPDATE memo SET space = COALESCE(json_extract(payload, '$.space'), ''), is_todo = COALESCE(json_extract(payload, '$.isTodo'), 0), payload = json_remove(payload, '$.space', '$.isTodo');
UPDATE attachment SET space = COALESCE(json_extract(payload, '$.space'), ''), payload = json_remove(payload, '$.space');

CREATE INDEX idx_memo_space_created ON memo (creator_id, space, row_status, is_todo, created_ts DESC, id DESC);
CREATE INDEX idx_memo_space_updated ON memo (creator_id, space, row_status, is_todo, updated_ts DESC, id DESC);
CREATE INDEX idx_memo_space_pinned_created ON memo (creator_id, space, row_status, is_todo, pinned DESC, created_ts DESC, id DESC);
CREATE INDEX idx_memo_space_pinned_updated ON memo (creator_id, space, row_status, is_todo, pinned DESC, updated_ts DESC, id DESC);
CREATE INDEX idx_attachment_space_updated ON attachment (creator_id, space, updated_ts DESC);
CREATE INDEX idx_attachment_memo_space ON attachment (memo_id, space);
CREATE INDEX idx_memo_relation_target ON memo_relation (related_memo_id, type, memo_id);

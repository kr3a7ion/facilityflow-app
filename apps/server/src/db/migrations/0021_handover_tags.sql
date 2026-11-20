-- Who a handover is addressed to, and whether they have seen it.
--
-- "shift" is somebody on the incoming shift; "attention" is anybody else the writer wants to
-- read it — the supervisor about a tank, the storekeeper about a part. Each one is told,
-- and the writer can see who has opened it and who has not.
CREATE TABLE handover_tags (
  handover_id  TEXT NOT NULL REFERENCES shift_handovers(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id),
  reason       TEXT NOT NULL CHECK (reason IN ('shift','attention')),
  seen_at      TEXT,
  PRIMARY KEY (handover_id, user_id)
);
CREATE INDEX idx_handover_tags_user ON handover_tags(user_id, seen_at);

-- Set when the "nobody has acknowledged this" alert has gone out, so it goes out once.
ALTER TABLE shift_handovers ADD COLUMN reminded_at TEXT;

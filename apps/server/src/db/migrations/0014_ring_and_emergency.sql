-- Reaching a person, and reaching everybody.
--
-- The system could already tell somebody a job was theirs. It could not do the two things
-- a supervisor actually does when something is wrong: get one person's attention right
-- now, and tell the whole department at once.
--
-- Both are recorded rather than fired and forgotten, because the question afterwards is
-- never "did somebody try" — it is "who heard it".

INSERT OR IGNORE INTO permissions (code, module, description) VALUES
  -- Ringing somebody is an interruption you are accountable for. A permission and an
  -- audit trail, not a button on everybody's screen.
  ('alerts.ring',      'core', 'Ring another person''s device'),
  ('alerts.emergency', 'core', 'Raise an emergency alert to everybody');

-- A team lead may ring their own people; the rest of the chain may ring anybody. Scope is
-- read by the handler exactly as it is for jobs.
INSERT OR IGNORE INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, 'alerts.ring', 'team' FROM roles r WHERE r.key = 'team_lead';

INSERT OR IGNORE INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, 'alerts.ring', 'all' FROM roles r
 WHERE r.key IN ('admin', 'hod', 'supervisor');

INSERT OR IGNORE INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, 'alerts.emergency', 'all' FROM roles r
 WHERE r.key IN ('admin', 'hod', 'supervisor');

-- ---- ringing one device ----------------------------------------------------------
CREATE TABLE ring_log (
  id              TEXT PRIMARY KEY,
  property_id     TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  rung_by         TEXT NOT NULL REFERENCES users(id),
  rung_user       TEXT NOT NULL REFERENCES users(id),
  reason          TEXT,
  at              TEXT NOT NULL,
  acknowledged_at TEXT,
  -- How many devices were listening when it went out. Zero is the finding: it means
  -- nothing rang, however many times the button was pressed.
  reached         INTEGER NOT NULL DEFAULT 0,
  -- Nobody rings themselves, and the check is in the schema so no route can forget it.
  CHECK (rung_by <> rung_user)
);

CREATE INDEX idx_ring_log_user ON ring_log(rung_user, at DESC);
CREATE INDEX idx_ring_log_property ON ring_log(property_id, at DESC);

CREATE TRIGGER ring_log_no_delete BEFORE DELETE ON ring_log
BEGIN
  SELECT RAISE(ABORT, 'The ring log is a permanent record and cannot be deleted.');
END;

-- ---- the emergency alert ---------------------------------------------------------
CREATE TABLE emergency_alerts (
  id              TEXT PRIMARY KEY,
  property_id     TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  raised_by       TEXT NOT NULL REFERENCES users(id),
  category        TEXT NOT NULL
                  CHECK (category IN ('fire','power','water','security','medical','other')),
  message         TEXT NOT NULL,
  location_id     TEXT REFERENCES locations(id),
  created_at      TEXT NOT NULL,
  -- An alert that is never stood down is an alert nobody trusts the next time.
  stood_down_at   TEXT,
  stood_down_by   TEXT REFERENCES users(id),
  stand_down_note TEXT
);

CREATE INDEX idx_emergency_open ON emergency_alerts(property_id, stood_down_at, created_at DESC);

-- One row per person per alert. This table is the point of the feature: in a real
-- incident the question is never "did I send it", it is "who has seen it".
CREATE TABLE emergency_acks (
  alert_id TEXT NOT NULL REFERENCES emergency_alerts(id) ON DELETE CASCADE,
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at       TEXT NOT NULL,
  -- 'browser' or 'phone', so the shape of who is reachable how is visible afterwards.
  via      TEXT,
  PRIMARY KEY (alert_id, user_id)
);

-- Append-only, like every other record this department could be asked to produce.
-- A deletion is refused outright; an update is refused except for the stand-down, which
-- is the one legitimate later change to an alert.
CREATE TRIGGER emergency_alerts_no_delete BEFORE DELETE ON emergency_alerts
BEGIN
  SELECT RAISE(ABORT, 'An emergency alert is a permanent record and cannot be deleted.');
END;

CREATE TRIGGER emergency_alerts_no_rewrite
BEFORE UPDATE OF id, property_id, raised_by, category, message, location_id, created_at
ON emergency_alerts
BEGIN
  SELECT RAISE(ABORT, 'An emergency alert cannot be edited after it is raised. Stand it down instead.');
END;

CREATE TRIGGER emergency_acks_no_delete BEFORE DELETE ON emergency_acks
BEGIN
  SELECT RAISE(ABORT, 'Acknowledgements are a permanent record and cannot be deleted.');
END;

CREATE TRIGGER emergency_acks_no_update BEFORE UPDATE ON emergency_acks
BEGIN
  SELECT RAISE(ABORT, 'An acknowledgement cannot be changed once it is given.');
END;

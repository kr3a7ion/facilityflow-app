-- The device that covers the shift.
--
-- Everything else in the alerting chain belongs to one person: their browser, their
-- phone, their notification sound. That works right up until the person it belongs to is
-- the problem — an iPhone, which cannot run the alert app at all; a handset whose
-- manufacturer froze the background service; a technician who left their phone in a van.
--
-- The duty device is the floor under all of that. One screen, in the plant room or at the
-- desk, signed in and left on, that rings for the department's unanswered work rather
-- than one person's. It does not replace anybody's phone; it means the department is
-- never relying on a single handset behaving.

INSERT OR IGNORE INTO permissions (code, module, description) VALUES
  -- Marking a screen as the one that covers the shift is an operational decision, not an
  -- administrative one — a supervisor setting up a tablet should not need an admin.
  ('duty.device.manage', 'core', 'Mark a screen as the duty device');

INSERT OR IGNORE INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, 'duty.device.manage', 'all' FROM roles r
 WHERE r.key IN ('admin', 'hod', 'supervisor', 'team_lead');

CREATE TABLE duty_devices (
  id           TEXT PRIMARY KEY,
  property_id  TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  -- The same identifier the browser already generates for its alert settings, so one
  -- screen is one row whichever of the two features is looking at it.
  device_id    TEXT NOT NULL,
  label        TEXT NOT NULL,
  claimed_by   TEXT REFERENCES users(id),
  claimed_at   TEXT NOT NULL,
  -- Written every time the screen checks in. The whole value of this table is being able
  -- to see that the plant room screen stopped checking in two hours ago.
  last_seen_at TEXT,
  -- Which account is signed in on it right now, so a supervisor can see the shift screen
  -- is logged in as somebody who can actually accept work.
  last_user_id TEXT REFERENCES users(id),
  is_active    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  UNIQUE (property_id, device_id)
);

CREATE INDEX idx_duty_property ON duty_devices(property_id, is_active, last_seen_at DESC);

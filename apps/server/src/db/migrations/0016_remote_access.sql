-- Getting in from outside the property.
--
-- Decided with the department on 1 October 2026: a Cloudflare Tunnel with Cloudflare
-- Access in front of it, and a remote session may assign and approve rather than only
-- look. That is the useful choice and the sharper one, so the boundary is drawn here in
-- the permission table rather than left to the screens.
--
-- Nothing about the property network changes. The department keeps working on
-- http://192.168.x.x:4700 exactly as it does now; this is a second way in, off by
-- default, that somebody has to deliberately open.

INSERT OR IGNORE INTO permissions (code, module, description) VALUES
  -- Two codes, not one. Getting in and changing something are different rights, and the
  -- worst case of a lost phone depends entirely on keeping them apart.
  ('remote.access', 'core', 'Sign in from outside the property network'),
  ('remote.write',  'core', 'Change things while signed in from outside');

-- The people who travel and are expected to act while away.
INSERT OR IGNORE INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, 'remote.access', 'all' FROM roles r
 WHERE r.key IN ('admin', 'hod', 'supervisor');

INSERT OR IGNORE INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, 'remote.write', 'all' FROM roles r
 WHERE r.key IN ('admin', 'hod', 'supervisor');

-- ---- remote access is a mode, not a state ----------------------------------------
-- One row per property. Off until somebody turns it on, and the row says who and when, so
-- "was the door open last Tuesday" is a question with an answer.
CREATE TABLE remote_access_state (
  property_id  TEXT PRIMARY KEY REFERENCES properties(id) ON DELETE CASCADE,
  enabled      INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  -- What the tunnel publishes, so the Host PC screen can show it and nobody has to go
  -- hunting in a config file for the address they are meant to open.
  public_host  TEXT,
  -- Minutes of inactivity before a remote session is dropped. Deliberately shorter than a
  -- session on the property network, where the risk is somebody walking past a screen
  -- rather than a laptop left in a hotel lobby.
  idle_minutes INTEGER NOT NULL DEFAULT 20 CHECK (idle_minutes BETWEEN 5 AND 240),
  changed_by   TEXT REFERENCES users(id),
  changed_at   TEXT,
  created_at   TEXT NOT NULL
);

INSERT OR IGNORE INTO remote_access_state (property_id, enabled, created_at)
SELECT p.id, 0, p.created_at FROM properties p;

-- Where a session came in from, so an approval can always be placed on site or off it.
ALTER TABLE sessions ADD COLUMN origin TEXT NOT NULL DEFAULT 'lan';
ALTER TABLE audit_log ADD COLUMN origin TEXT NOT NULL DEFAULT 'lan';

CREATE INDEX idx_audit_origin ON audit_log(property_id, origin, at DESC);

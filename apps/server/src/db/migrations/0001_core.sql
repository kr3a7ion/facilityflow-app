-- FacilityFlow 0001 — core: property scoping, identity, permissions, audit.
-- Applied in a transaction by the migration runner. Never edit an applied migration.

-- One row per property. Present from day one even though there is exactly one:
-- adding property_id later is a migration across forty tables.
CREATE TABLE properties (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  short_name   TEXT NOT NULL,
  address      TEXT,
  city         TEXT,
  country      TEXT NOT NULL DEFAULT 'NG',
  timezone     TEXT NOT NULL DEFAULT 'Africa/Lagos',
  currency     TEXT NOT NULL DEFAULT 'NGN',
  logo_path    TEXT,
  is_active    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- Key/value reference data. Everything the department can change without a release.
CREATE TABLE settings (
  property_id  TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  key          TEXT NOT NULL,
  value_json   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  updated_by   TEXT,
  PRIMARY KEY (property_id, key)
);

-- Per-year human-facing reference sequences: WO-2026-0417, PTW-2026-018.
CREATE TABLE ref_sequences (
  property_id  TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  prefix       TEXT NOT NULL,
  year         INTEGER NOT NULL,
  next_value   INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (property_id, prefix, year)
);

-- Permission catalogue. Codes are checked in one middleware, never role names in handlers.
CREATE TABLE permissions (
  code         TEXT PRIMARY KEY,
  module       TEXT NOT NULL,
  description  TEXT NOT NULL
);

CREATE TABLE roles (
  id           TEXT PRIMARY KEY,
  property_id  TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  key          TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT,
  is_system    INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1)),
  created_at   TEXT NOT NULL,
  UNIQUE (property_id, key)
);

CREATE TABLE role_permissions (
  role_id         TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_code TEXT NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  scope           TEXT NOT NULL DEFAULT 'all' CHECK (scope IN ('own','team','all')),
  PRIMARY KEY (role_id, permission_code)
);

CREATE TABLE users (
  id                   TEXT PRIMARY KEY,
  property_id          TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  staff_id             TEXT,
  username             TEXT NOT NULL,
  display_name         TEXT NOT NULL,
  password_hash        TEXT NOT NULL,
  role_id              TEXT NOT NULL REFERENCES roles(id),
  is_active            INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  must_change_password INTEGER NOT NULL DEFAULT 1 CHECK (must_change_password IN (0,1)),
  last_login_at        TEXT,
  failed_attempts      INTEGER NOT NULL DEFAULT 0,
  locked_until         TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  UNIQUE (property_id, username)
);
CREATE INDEX idx_users_role ON users(role_id);
CREATE INDEX idx_users_staff ON users(staff_id);

-- Server-side sessions, not JWT: a technician who leaves is revoked instantly.
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ip           TEXT,
  user_agent   TEXT,
  revoked_at   TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

-- Append-only. No UPDATE, no DELETE, ever. Enforced by triggers below.
CREATE TABLE audit_log (
  id           TEXT PRIMARY KEY,
  property_id  TEXT NOT NULL,
  at           TEXT NOT NULL,
  user_id      TEXT,
  actor_name   TEXT,
  action       TEXT NOT NULL,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT,
  before_json  TEXT,
  after_json   TEXT,
  ip           TEXT
);
CREATE INDEX idx_audit_at ON audit_log(property_id, at);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

CREATE TABLE notifications (
  id           TEXT PRIMARY KEY,
  property_id  TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  title        TEXT NOT NULL,
  body         TEXT,
  entity_type  TEXT,
  entity_id    TEXT,
  created_at   TEXT NOT NULL,
  read_at      TEXT
);
CREATE INDEX idx_notif_user ON notifications(user_id, read_at);

-- Files live on disk beside the database; only the pointer lives here.
CREATE TABLE attachments (
  id           TEXT PRIMARY KEY,
  property_id  TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  filename     TEXT NOT NULL,
  mime         TEXT NOT NULL,
  bytes        INTEGER NOT NULL,
  sha256       TEXT NOT NULL,
  rel_path     TEXT NOT NULL,
  uploaded_by  TEXT REFERENCES users(id),
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_attach_entity ON attachments(entity_type, entity_id);

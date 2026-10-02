-- FacilityFlow 0002 — people, shifts and places.
-- Shifts are availability only: no clock-in, no late minutes, no overtime, no leave
-- entitlement, no holiday calendar. The roster answers one question the job board
-- needs — who is on the floor right now.

CREATE TABLE teams (
  id                  TEXT PRIMARY KEY,
  property_id         TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  default_trade       TEXT,
  team_lead_staff_id  TEXT,
  supervisor_staff_id TEXT,
  is_active           INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (property_id, name)
);

CREATE TABLE staff (
  id              TEXT PRIMARY KEY,
  property_id     TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  staff_no        TEXT,
  first_name      TEXT NOT NULL,
  last_name       TEXT NOT NULL,
  phone           TEXT,
  trade           TEXT,
  team_id         TEXT REFERENCES teams(id),
  employment_type TEXT CHECK (employment_type IN ('permanent','contract','casual','vendor')),
  hire_date       TEXT,
  photo_path      TEXT,
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (property_id, staff_no)
);
CREATE INDEX idx_staff_team ON staff(team_id);
CREATE INDEX idx_staff_active ON staff(property_id, is_active);

-- Any number of patterns, any times. Nothing about morning/afternoon/night is
-- baked into the schema or the UI.
CREATE TABLE shift_patterns (
  id               TEXT PRIMARY KEY,
  property_id      TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  start_time       TEXT NOT NULL,                       -- HH:MM local
  end_time         TEXT NOT NULL,                       -- HH:MM local
  crosses_midnight INTEGER NOT NULL DEFAULT 0 CHECK (crosses_midnight IN (0,1)),
  weekdays         TEXT NOT NULL DEFAULT '1234567',     -- ISO weekday digits this pattern runs
  colour           TEXT,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  is_active        INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (property_id, name)
);

-- One row per staff member per day. The UNIQUE constraint alone prevents double booking.
CREATE TABLE roster_entries (
  id                 TEXT PRIMARY KEY,
  property_id        TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  staff_id           TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  work_date          TEXT NOT NULL,                     -- YYYY-MM-DD
  shift_pattern_id   TEXT REFERENCES shift_patterns(id),
  status             TEXT NOT NULL DEFAULT 'scheduled'
                     CHECK (status IN ('scheduled','off','swapped','present','absent')),
  swap_with_staff_id TEXT REFERENCES staff(id),
  published_at       TEXT,
  marked_by          TEXT REFERENCES users(id),
  marked_at          TEXT,
  note               TEXT,
  created_by         TEXT REFERENCES users(id),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE (staff_id, work_date),
  CHECK (status = 'off' OR shift_pattern_id IS NOT NULL)
);
CREATE INDEX idx_roster_date ON roster_entries(property_id, work_date, status);

-- Why someone is not here. One flat table, no approval workflow.
CREATE TABLE absences (
  id          TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  staff_id    TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  work_date   TEXT NOT NULL,
  reason      TEXT NOT NULL CHECK (reason IN ('sick','off','permission','training','unexplained','other')),
  note        TEXT,
  marked_by   TEXT REFERENCES users(id),
  marked_at   TEXT NOT NULL,
  UNIQUE (staff_id, work_date)
);

CREATE TABLE shift_handovers (
  id                    TEXT PRIMARY KEY,
  property_id           TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  at                    TEXT NOT NULL,
  from_shift_pattern_id TEXT REFERENCES shift_patterns(id),
  to_shift_pattern_id   TEXT REFERENCES shift_patterns(id),
  from_staff_id         TEXT REFERENCES staff(id),
  to_staff_id           TEXT REFERENCES staff(id),
  plant_state_json      TEXT,       -- system-filled snapshot, confirmed by the outgoing shift
  carried_jobs_json     TEXT,       -- open and held jobs at handover
  notes                 TEXT,       -- what the system cannot know
  open_permits          TEXT,
  keys_held             TEXT,
  status                TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','acknowledged')),
  acknowledged_by       TEXT REFERENCES users(id),
  acknowledged_at       TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE INDEX idx_handover_at ON shift_handovers(property_id, at);

-- Self-referencing tree: site -> block -> floor -> unit / plant room.
CREATE TABLE locations (
  id          TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  parent_id   TEXT REFERENCES locations(id),
  type        TEXT NOT NULL CHECK (type IN ('site','block','floor','apartment','common_area','plant_room','external')),
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (property_id, code)
);
CREATE INDEX idx_loc_parent ON locations(parent_id);
CREATE INDEX idx_loc_type ON locations(property_id, type);

-- The apartment IS a location; this table adds the residential attributes.
-- Occupant data is kept to the minimum needed for access. Occupant records belong
-- to front office; duplicating them here creates a liability this department does not need.
CREATE TABLE apartments (
  id                  TEXT PRIMARY KEY,
  property_id         TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  location_id         TEXT NOT NULL UNIQUE REFERENCES locations(id) ON DELETE CASCADE,
  unit_no             TEXT NOT NULL,
  block               TEXT,
  floor               TEXT,
  unit_type           TEXT,
  status              TEXT NOT NULL DEFAULT 'vacant_ready'
                      CHECK (status IN ('occupied','vacant_ready','vacant_dirty','under_maintenance','out_of_service')),
  occupant_ref        TEXT,
  occupant_phone      TEXT,
  handover_date       TEXT,
  last_inspection_at  TEXT,
  next_inspection_due TEXT,
  notes               TEXT,
  is_active           INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (property_id, unit_no)
);
CREATE INDEX idx_apt_status ON apartments(property_id, status);

-- Provenance of the unit list: typed in, CSV, or read once from the Day Book database.
CREATE TABLE apartment_imports (
  id           TEXT PRIMARY KEY,
  property_id  TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  source       TEXT NOT NULL CHECK (source IN ('manual','csv','keyplate')),
  source_ref   TEXT,
  imported_at  TEXT NOT NULL,
  imported_by  TEXT REFERENCES users(id),
  row_count    INTEGER NOT NULL DEFAULT 0,
  mapping_json TEXT,
  notes        TEXT
);

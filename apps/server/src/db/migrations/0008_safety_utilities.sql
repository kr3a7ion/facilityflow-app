-- FacilityFlow 0008 — permits, incidents and utility meters.

CREATE TABLE permits (
  id               TEXT PRIMARY KEY,
  property_id      TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  ref              TEXT NOT NULL,
  type             TEXT NOT NULL CHECK (type IN ('hot_work','electrical_isolation','height','confined_space','excavation')),
  wo_id            TEXT REFERENCES work_orders(id),
  location_id      TEXT REFERENCES locations(id),
  requested_by     TEXT NOT NULL REFERENCES users(id),
  issued_by        TEXT REFERENCES users(id),
  valid_from       TEXT NOT NULL,
  valid_to         TEXT NOT NULL,
  precautions_json TEXT,
  status           TEXT NOT NULL DEFAULT 'requested'
                   CHECK (status IN ('requested','issued','closed','cancelled','expired')),
  closed_by        TEXT REFERENCES users(id),
  closed_at        TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (property_id, ref),
  CHECK (valid_to > valid_from),
  -- The person who asks for a permit is not the person who issues it.
  CHECK (issued_by IS NULL OR issued_by <> requested_by)
);
CREATE INDEX idx_permit_state ON permits(property_id, status, valid_to);

CREATE TABLE isolation_points (
  id                TEXT PRIMARY KEY,
  permit_id         TEXT NOT NULL REFERENCES permits(id) ON DELETE CASCADE,
  asset_id          TEXT REFERENCES assets(id),
  point_description TEXT NOT NULL,
  lock_tag_no       TEXT,
  isolated_by       TEXT REFERENCES users(id),
  isolated_at       TEXT,
  restored_by       TEXT REFERENCES users(id),
  restored_at       TEXT
);

-- Injury records are sensitive employee data: read access is limited to the HOD and
-- safety roles by permission, not by convention.
CREATE TABLE incidents (
  id                TEXT PRIMARY KEY,
  property_id       TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  ref               TEXT NOT NULL,
  occurred_at       TEXT NOT NULL,
  type              TEXT NOT NULL CHECK (type IN ('injury','near_miss','property_damage','fire','spill')),
  location_id       TEXT REFERENCES locations(id),
  description       TEXT NOT NULL,
  severity          TEXT NOT NULL DEFAULT 'minor' CHECK (severity IN ('minor','moderate','major','critical')),
  immediate_action  TEXT,
  root_cause        TEXT,
  corrective_wo_id  TEXT REFERENCES work_orders(id),
  reported_by       TEXT REFERENCES users(id),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (property_id, ref)
);

CREATE TABLE toolbox_talks (
  id            TEXT PRIMARY KEY,
  property_id   TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  held_at       TEXT NOT NULL,
  topic         TEXT NOT NULL,
  conducted_by  TEXT REFERENCES users(id),
  attendee_json TEXT,
  notes         TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE meters (
  id                TEXT PRIMARY KEY,
  property_id       TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  type              TEXT NOT NULL CHECK (type IN ('electricity','water','gas')),
  serial            TEXT NOT NULL,
  location_id       TEXT REFERENCES locations(id),
  apartment_id      TEXT REFERENCES apartments(id),
  multiplier        REAL NOT NULL DEFAULT 1,
  unit              TEXT NOT NULL DEFAULT 'kWh',
  reading_frequency TEXT NOT NULL DEFAULT 'monthly'
                    CHECK (reading_frequency IN ('daily','weekly','monthly')),
  is_active         INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (property_id, serial)
);

CREATE TABLE meter_readings (
  id           TEXT PRIMARY KEY,
  meter_id     TEXT NOT NULL REFERENCES meters(id) ON DELETE CASCADE,
  read_at      TEXT NOT NULL,
  reading      REAL NOT NULL CHECK (reading >= 0),
  consumption  REAL,
  read_by      TEXT REFERENCES users(id),
  is_estimated INTEGER NOT NULL DEFAULT 0 CHECK (is_estimated IN (0,1)),
  anomaly      INTEGER NOT NULL DEFAULT 0 CHECK (anomaly IN (0,1)),
  note         TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_reading_meter ON meter_readings(meter_id, read_at);

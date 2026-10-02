-- FacilityFlow 0003 — the asset register.
-- Jobs attach to a THING, not just a room. Without this you can never answer
-- "what has this chiller cost us this year" or "repair or replace?".

CREATE TABLE asset_categories (
  id                           TEXT PRIMARY KEY,
  property_id                  TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name                         TEXT NOT NULL,
  default_trade                TEXT,
  default_criticality          INTEGER NOT NULL DEFAULT 2 CHECK (default_criticality BETWEEN 1 AND 3),
  default_checklist_template_id TEXT,
  created_at                   TEXT NOT NULL,
  updated_at                   TEXT NOT NULL,
  UNIQUE (property_id, name)
);

CREATE TABLE assets (
  id                    TEXT PRIMARY KEY,
  property_id           TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  asset_tag             TEXT NOT NULL,          -- printed as a QR sticker
  name                  TEXT NOT NULL,
  category_id           TEXT REFERENCES asset_categories(id),
  parent_asset_id       TEXT REFERENCES assets(id),
  location_id           TEXT REFERENCES locations(id),
  apartment_id          TEXT REFERENCES apartments(id),
  manufacturer          TEXT,
  model                 TEXT,
  serial_no             TEXT,
  capacity              TEXT,                   -- free text: "250 kVA", "1.5 HP"
  install_date          TEXT,
  commissioned_at       TEXT,
  warranty_expiry       TEXT,
  vendor_id             TEXT,
  contract_id           TEXT,
  status                TEXT NOT NULL DEFAULT 'in_service'
                        CHECK (status IN ('in_service','standby','faulty','under_repair','decommissioned')),
  criticality           INTEGER NOT NULL DEFAULT 2 CHECK (criticality BETWEEN 1 AND 3),
  meter_type            TEXT NOT NULL DEFAULT 'none' CHECK (meter_type IN ('none','hours','kwh','both')),
  current_meter         REAL,
  current_meter_at      TEXT,
  replacement_cost_kobo INTEGER,
  notes                 TEXT,
  is_active             INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE (property_id, asset_tag)
);
CREATE INDEX idx_asset_loc ON assets(location_id);
CREATE INDEX idx_asset_apt ON assets(apartment_id);
CREATE INDEX idx_asset_cat ON assets(category_id);
CREATE INDEX idx_asset_status ON assets(property_id, status);
CREATE INDEX idx_asset_parent ON assets(parent_asset_id);

CREATE TABLE asset_meter_readings (
  id         TEXT PRIMARY KEY,
  asset_id   TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  read_at    TEXT NOT NULL,
  reading    REAL NOT NULL,
  unit       TEXT NOT NULL DEFAULT 'hours' CHECK (unit IN ('hours','kwh')),
  source     TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','run_log','ppm')),
  read_by    TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_meter_asset ON asset_meter_readings(asset_id, read_at);

CREATE TABLE asset_transfers (
  id               TEXT PRIMARY KEY,
  asset_id         TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  from_location_id TEXT REFERENCES locations(id),
  to_location_id   TEXT REFERENCES locations(id),
  moved_at         TEXT NOT NULL,
  moved_by         TEXT REFERENCES users(id),
  reason           TEXT
);

-- Which units hold which equipment.
CREATE TABLE apartment_appliances (
  apartment_id TEXT NOT NULL REFERENCES apartments(id) ON DELETE CASCADE,
  asset_id     TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  PRIMARY KEY (apartment_id, asset_id)
);

-- FacilityFlow 0006 — generators and diesel.
-- Gensets are rows in `assets` with a generator category; this adds what a genset
-- needs beyond a generic asset. Recording deliveries and dips is bookkeeping —
-- reconciling them is the product.

CREATE TABLE genset_profiles (
  asset_id                TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  kva_rating              REAL NOT NULL,
  expected_lph_at_50pct   REAL,
  expected_lph_at_75pct   REAL,
  expected_lph_at_100pct  REAL,
  service_interval_hours  REAL,
  last_service_hours      REAL,
  next_service_hours      REAL,
  day_tank_id             TEXT,
  deviation_threshold_pct REAL NOT NULL DEFAULT 10,
  consecutive_deviations  INTEGER NOT NULL DEFAULT 0,
  updated_at              TEXT NOT NULL
);

CREATE TABLE fuel_tanks (
  id               TEXT PRIMARY KEY,
  property_id      TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  location_id      TEXT REFERENCES locations(id),
  kind             TEXT NOT NULL CHECK (kind IN ('bulk','day_tank','drum')),
  capacity_l       REAL NOT NULL CHECK (capacity_l > 0),
  min_level_l      REAL NOT NULL DEFAULT 0,
  -- Dip in millimetres to litres for this tank's geometry. A horizontal cylinder is
  -- not linear; treating it as linear is a standing 5-8% error.
  dip_chart_json   TEXT,
  current_level_l  REAL,
  current_level_at TEXT,
  is_active        INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (property_id, name)
);

CREATE TABLE fuel_dips (
  id               TEXT PRIMARY KEY,
  tank_id          TEXT NOT NULL REFERENCES fuel_tanks(id) ON DELETE CASCADE,
  taken_at         TEXT NOT NULL,
  shift_pattern_id TEXT REFERENCES shift_patterns(id),
  dip_mm           REAL,
  litres           REAL NOT NULL CHECK (litres >= 0),
  taken_by         TEXT REFERENCES users(id),
  note             TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX idx_dip_tank ON fuel_dips(tank_id, taken_at);

CREATE TABLE fuel_deliveries (
  id               TEXT PRIMARY KEY,
  property_id      TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  ref              TEXT NOT NULL,
  tank_id          TEXT NOT NULL REFERENCES fuel_tanks(id),
  delivered_at     TEXT NOT NULL,
  vendor_id        TEXT,
  waybill_no       TEXT,
  truck_reg        TEXT,
  driver_name      TEXT,
  ordered_l        REAL,
  invoiced_l       REAL NOT NULL CHECK (invoiced_l > 0),
  dip_before_l     REAL NOT NULL CHECK (dip_before_l >= 0),
  dip_after_l      REAL NOT NULL CHECK (dip_after_l >= 0),
  received_l       REAL NOT NULL,               -- dip_after - dip_before
  variance_l       REAL NOT NULL,               -- received - invoiced
  variance_pct     REAL NOT NULL,
  flagged          INTEGER NOT NULL DEFAULT 0 CHECK (flagged IN (0,1)),
  unit_price_kobo  INTEGER NOT NULL DEFAULT 0,  -- price moves constantly: per delivery,
  total_kobo       INTEGER NOT NULL DEFAULT 0,  -- never a setting
  received_by      TEXT NOT NULL REFERENCES users(id),
  witnessed_by     TEXT NOT NULL REFERENCES users(id),
  attachment_id    TEXT REFERENCES attachments(id),
  notes            TEXT,
  created_at       TEXT NOT NULL,
  UNIQUE (property_id, ref),
  -- The control: the person who receives is never the person who signs it off.
  CHECK (received_by <> witnessed_by),
  CHECK (dip_after_l >= dip_before_l)
);
CREATE INDEX idx_del_tank ON fuel_deliveries(tank_id, delivered_at);

CREATE TABLE fuel_issues (
  id            TEXT PRIMARY KEY,
  tank_id       TEXT NOT NULL REFERENCES fuel_tanks(id),
  to_asset_id   TEXT REFERENCES assets(id),
  to_tank_id    TEXT REFERENCES fuel_tanks(id),
  issued_at     TEXT NOT NULL,
  quantity_l    REAL NOT NULL CHECK (quantity_l > 0),
  method        TEXT NOT NULL DEFAULT 'pump' CHECK (method IN ('pump','manual','auto_topup')),
  meter_before  REAL,
  meter_after   REAL,
  issued_by     TEXT REFERENCES users(id),
  note          TEXT,
  created_at    TEXT NOT NULL,
  CHECK (to_asset_id IS NOT NULL OR to_tank_id IS NOT NULL)
);
CREATE INDEX idx_issue_tank ON fuel_issues(tank_id, issued_at);

CREATE TABLE power_outages (
  id            TEXT PRIMARY KEY,
  property_id   TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  source        TEXT NOT NULL DEFAULT 'utility'
                CHECK (source IN ('utility','planned','internal_fault')),
  affected_json TEXT,
  notes         TEXT,
  logged_by     TEXT REFERENCES users(id),
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_outage_at ON power_outages(property_id, started_at);

CREATE TABLE generator_runs (
  id              TEXT PRIMARY KEY,
  property_id     TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  genset_asset_id TEXT NOT NULL REFERENCES assets(id),
  outage_id       TEXT REFERENCES power_outages(id),
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  -- From the engine hour meter, not the clock. If they disagree the meter wins and
  -- the disagreement is itself a finding.
  hours_start     REAL NOT NULL,
  hours_end       REAL,
  run_hours       REAL,
  reason          TEXT NOT NULL DEFAULT 'utility_outage'
                  CHECK (reason IN ('utility_outage','weekly_test','load_test','maintenance','load_shedding')),
  fuel_start_l    REAL,
  fuel_end_l      REAL,
  fuel_topup_l    REAL NOT NULL DEFAULT 0,
  fuel_used_l     REAL,
  actual_lph      REAL,
  expected_lph    REAL,
  deviation_pct   REAL,
  avg_load_kw     REAL,
  kwh_generated   REAL,
  logged_by       TEXT REFERENCES users(id),
  notes           TEXT,
  created_at      TEXT NOT NULL,
  CHECK (hours_end IS NULL OR hours_end >= hours_start)
);
CREATE INDEX idx_run_genset ON generator_runs(genset_asset_id, started_at);

CREATE TABLE fuel_reconciliations (
  id                 TEXT PRIMARY KEY,
  property_id        TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  tank_id            TEXT NOT NULL REFERENCES fuel_tanks(id),
  period_start       TEXT NOT NULL,
  period_end         TEXT NOT NULL,
  opening_l          REAL NOT NULL,
  deliveries_l       REAL NOT NULL,
  issues_l           REAL NOT NULL,
  computed_closing_l REAL NOT NULL,
  dipped_closing_l   REAL NOT NULL,
  variance_l         REAL NOT NULL,
  variance_pct       REAL NOT NULL,
  status             TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','flagged','explained')),
  explanation        TEXT,
  explained_by       TEXT REFERENCES users(id),
  explained_at       TEXT,
  created_by         TEXT REFERENCES users(id),
  created_at         TEXT NOT NULL,
  UNIQUE (tank_id, period_start, period_end)
);

-- FacilityFlow 0005 — preventive maintenance.
-- What turns a log book into a maintenance system. PPM compliance % is the single
-- KPI the department is judged on.

CREATE TABLE checklist_templates (
  id                TEXT PRIMARY KEY,
  property_id       TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  asset_category_id TEXT REFERENCES asset_categories(id),
  version           INTEGER NOT NULL DEFAULT 1,
  is_active         INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (property_id, name, version)
);

CREATE TABLE checklist_items (
  id               TEXT PRIMARY KEY,
  template_id      TEXT NOT NULL REFERENCES checklist_templates(id) ON DELETE CASCADE,
  seq              INTEGER NOT NULL,
  task             TEXT NOT NULL,
  expected_value   TEXT,
  requires_reading INTEGER NOT NULL DEFAULT 0 CHECK (requires_reading IN (0,1)),
  requires_photo   INTEGER NOT NULL DEFAULT 0 CHECK (requires_photo IN (0,1)),
  is_critical      INTEGER NOT NULL DEFAULT 0 CHECK (is_critical IN (0,1))
);
CREATE INDEX idx_cli_tpl ON checklist_items(template_id, seq);

CREATE TABLE ppm_schedules (
  id                    TEXT PRIMARY KEY,
  property_id           TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  scope_type            TEXT NOT NULL CHECK (scope_type IN ('asset','category','location')),
  asset_id              TEXT REFERENCES assets(id),
  asset_category_id     TEXT REFERENCES asset_categories(id),
  location_id           TEXT REFERENCES locations(id),
  trigger_type          TEXT NOT NULL CHECK (trigger_type IN ('calendar','meter')),
  interval_value        REAL NOT NULL CHECK (interval_value > 0),
  interval_unit         TEXT NOT NULL CHECK (interval_unit IN ('day','week','month','year','hours','kwh')),
  lead_days             INTEGER NOT NULL DEFAULT 0,
  checklist_template_id TEXT REFERENCES checklist_templates(id),
  default_team_id       TEXT REFERENCES teams(id),
  default_trade         TEXT,
  priority              TEXT NOT NULL DEFAULT 'P4' CHECK (priority IN ('P1','P2','P3','P4')),
  estimated_minutes     INTEGER,
  last_completed_at     TEXT,
  last_meter_at_completion REAL,
  next_due_at           TEXT,
  next_due_meter        REAL,
  auto_generate         INTEGER NOT NULL DEFAULT 1 CHECK (auto_generate IN (0,1)),
  is_active             INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  -- A schedule must say what it applies to.
  CHECK ((scope_type = 'asset'    AND asset_id IS NOT NULL)
      OR (scope_type = 'category' AND asset_category_id IS NOT NULL)
      OR (scope_type = 'location' AND location_id IS NOT NULL)),
  -- Calendar schedules need a date; meter schedules need a meter figure.
  CHECK ((trigger_type = 'calendar' AND interval_unit IN ('day','week','month','year'))
      OR (trigger_type = 'meter'    AND interval_unit IN ('hours','kwh')))
);
CREATE INDEX idx_ppm_due ON ppm_schedules(property_id, is_active, next_due_at);

CREATE TABLE work_order_checklist_results (
  id            TEXT PRIMARY KEY,
  wo_id         TEXT NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  item_id       TEXT NOT NULL REFERENCES checklist_items(id),
  result        TEXT NOT NULL CHECK (result IN ('pass','fail','na')),
  value         TEXT,
  note          TEXT,
  attachment_id TEXT REFERENCES attachments(id),
  recorded_by   TEXT REFERENCES users(id),
  recorded_at   TEXT NOT NULL,
  UNIQUE (wo_id, item_id)
);

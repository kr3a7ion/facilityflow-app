-- FacilityFlow 0004 — work orders. The centre of the system.

-- Fault intake from other departments. Housekeeping and front office see most faults first.
CREATE TABLE job_requests (
  id               TEXT PRIMARY KEY,
  property_id      TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  ref              TEXT NOT NULL,
  reported_by      TEXT REFERENCES users(id),
  reporter_name    TEXT,
  channel          TEXT NOT NULL DEFAULT 'portal'
                   CHECK (channel IN ('portal','phone','walk_in','inspection','ppm')),
  location_id      TEXT REFERENCES locations(id),
  apartment_id     TEXT REFERENCES apartments(id),
  asset_id         TEXT REFERENCES assets(id),
  description      TEXT NOT NULL,
  urgency          TEXT NOT NULL DEFAULT 'normal' CHECK (urgency IN ('emergency','high','normal','low')),
  status           TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','converted','rejected')),
  converted_wo_id  TEXT,
  rejected_reason  TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (property_id, ref)
);
CREATE INDEX idx_req_status ON job_requests(property_id, status);

CREATE TABLE work_orders (
  id                  TEXT PRIMARY KEY,
  property_id         TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  ref                 TEXT NOT NULL,
  source              TEXT NOT NULL DEFAULT 'reactive'
                      CHECK (source IN ('reactive','ppm','inspection','project')),
  request_id          TEXT REFERENCES job_requests(id),
  ppm_schedule_id     TEXT,
  title               TEXT NOT NULL,
  description         TEXT,
  trade               TEXT,
  priority            TEXT NOT NULL DEFAULT 'P3' CHECK (priority IN ('P1','P2','P3','P4')),
  asset_id            TEXT REFERENCES assets(id),
  location_id         TEXT REFERENCES locations(id),
  apartment_id        TEXT REFERENCES apartments(id),
  status              TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('draft','open','assigned','accepted','in_progress','on_hold',
                                        'completed','verified','closed','cancelled')),
  hold_reason         TEXT CHECK (hold_reason IS NULL OR hold_reason IN
                        ('awaiting_parts','awaiting_access','awaiting_vendor','awaiting_approval')),
  held_at             TEXT,
  held_minutes_total  INTEGER NOT NULL DEFAULT 0,   -- excluded from SLA: a tech is not
                                                    -- penalised for a store with no filters
  assigned_team_id    TEXT REFERENCES teams(id),
  assigned_to_staff_id TEXT REFERENCES staff(id),
  assigned_by         TEXT REFERENCES users(id),
  assigned_at         TEXT,
  reported_at         TEXT NOT NULL,
  respond_by          TEXT,
  due_at              TEXT,
  responded_at        TEXT,
  started_at          TEXT,
  completed_at        TEXT,
  completed_by        TEXT REFERENCES users(id),
  verified_by         TEXT REFERENCES users(id),
  verified_at         TEXT,
  closed_at           TEXT,
  cancelled_reason    TEXT,
  reopened_count      INTEGER NOT NULL DEFAULT 0,
  escalation_level    INTEGER NOT NULL DEFAULT 0,
  failure_cause       TEXT,
  resolution_notes    TEXT,
  downtime_minutes    INTEGER,
  labour_minutes      INTEGER NOT NULL DEFAULT 0,
  cost_labour_kobo    INTEGER NOT NULL DEFAULT 0,
  cost_parts_kobo     INTEGER NOT NULL DEFAULT 0,
  cost_vendor_kobo    INTEGER NOT NULL DEFAULT 0,
  costs_frozen        INTEGER NOT NULL DEFAULT 0 CHECK (costs_frozen IN (0,1)),
  charge_to           TEXT NOT NULL DEFAULT 'house'
                      CHECK (charge_to IN ('house','owner','tenant','department')),
  cost_centre_id      TEXT,
  created_by          TEXT REFERENCES users(id),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (property_id, ref),
  -- A job attached to nothing cannot be reported on.
  CHECK (asset_id IS NOT NULL OR location_id IS NOT NULL OR apartment_id IS NOT NULL),
  -- Segregation of duties, enforced by the database and not only by the service layer.
  CHECK (verified_by IS NULL OR completed_by IS NULL OR verified_by <> completed_by)
);
CREATE INDEX idx_wo_board ON work_orders(property_id, status, due_at);
CREATE INDEX idx_wo_assignee ON work_orders(assigned_to_staff_id, status);
CREATE INDEX idx_wo_asset ON work_orders(asset_id, completed_at);
CREATE INDEX idx_wo_apt ON work_orders(apartment_id, completed_at);
CREATE INDEX idx_wo_team ON work_orders(assigned_team_id, status);

-- Append-only. Printing this list IS the job history.
CREATE TABLE work_order_events (
  id           TEXT PRIMARY KEY,
  wo_id        TEXT NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  at           TEXT NOT NULL,
  actor_id     TEXT REFERENCES users(id),
  actor_name   TEXT,
  event_type   TEXT NOT NULL,
  from_status  TEXT,
  to_status    TEXT,
  note         TEXT,
  meta_json    TEXT
);
CREATE INDEX idx_woe_wo ON work_order_events(wo_id, at);
CREATE TRIGGER wo_events_no_update BEFORE UPDATE ON work_order_events
BEGIN SELECT RAISE(ABORT, 'work_order_events is append-only'); END;
CREATE TRIGGER wo_events_no_delete BEFORE DELETE ON work_order_events
BEGIN SELECT RAISE(ABORT, 'work_order_events is append-only'); END;

CREATE TABLE work_order_assignees (
  wo_id        TEXT NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  staff_id     TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  role_on_job  TEXT,
  PRIMARY KEY (wo_id, staff_id)
);

CREATE TABLE work_order_labour (
  id          TEXT PRIMARY KEY,
  wo_id       TEXT NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  staff_id    TEXT NOT NULL REFERENCES staff(id),
  started_at  TEXT,
  minutes     INTEGER NOT NULL CHECK (minutes > 0),
  rate_kobo   INTEGER NOT NULL DEFAULT 0,
  cost_kobo   INTEGER NOT NULL DEFAULT 0,
  logged_by   TEXT REFERENCES users(id),
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_wol_wo ON work_order_labour(wo_id);

CREATE TABLE work_order_parts (
  id                TEXT PRIMARY KEY,
  wo_id             TEXT NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  item_id           TEXT,
  description       TEXT NOT NULL,
  qty               REAL NOT NULL CHECK (qty > 0),
  unit_cost_kobo    INTEGER NOT NULL DEFAULT 0,
  total_kobo        INTEGER NOT NULL DEFAULT 0,
  stock_movement_id TEXT,
  issued_by         TEXT REFERENCES users(id),
  issued_at         TEXT NOT NULL
);
CREATE INDEX idx_wop_wo ON work_order_parts(wo_id);

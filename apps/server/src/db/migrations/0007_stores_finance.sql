-- FacilityFlow 0007 — stores, vendors and departmental finance.
-- Finance stops at the department boundary: no accounting integration, no supplier
-- ledger, no PO/GRN/invoice chain. Requisition -> approval -> purchase record.

CREATE TABLE stock_items (
  id             TEXT PRIMARY KEY,
  property_id    TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  code           TEXT NOT NULL,
  name           TEXT NOT NULL,
  category       TEXT,
  unit           TEXT NOT NULL DEFAULT 'pcs',
  bin_location   TEXT,
  min_level      REAL NOT NULL DEFAULT 0,
  reorder_qty    REAL NOT NULL DEFAULT 0,
  avg_cost_kobo  INTEGER NOT NULL DEFAULT 0,
  current_qty    REAL NOT NULL DEFAULT 0,   -- cached sum of stock_movements
  is_active      INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (property_id, code)
);
CREATE INDEX idx_item_low ON stock_items(property_id, is_active);

-- Append-only ledger; current_qty is derived from it and can always be recomputed.
CREATE TABLE stock_movements (
  id             TEXT PRIMARY KEY,
  property_id    TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  item_id        TEXT NOT NULL REFERENCES stock_items(id),
  at             TEXT NOT NULL,
  type           TEXT NOT NULL CHECK (type IN ('receipt','issue','return','adjustment','transfer','count')),
  qty_delta      REAL NOT NULL,
  balance_after  REAL NOT NULL,
  wo_id          TEXT REFERENCES work_orders(id),
  ref            TEXT,
  unit_cost_kobo INTEGER NOT NULL DEFAULT 0,
  done_by        TEXT REFERENCES users(id),
  approved_by    TEXT REFERENCES users(id),
  note           TEXT
);
CREATE INDEX idx_mv_item ON stock_movements(item_id, at);
CREATE INDEX idx_mv_wo ON stock_movements(wo_id);
CREATE TRIGGER stock_mv_no_update BEFORE UPDATE ON stock_movements
BEGIN SELECT RAISE(ABORT, 'stock_movements is append-only'); END;
CREATE TRIGGER stock_mv_no_delete BEFORE DELETE ON stock_movements
BEGIN SELECT RAISE(ABORT, 'stock_movements is append-only'); END;

CREATE TABLE requisitions (
  id            TEXT PRIMARY KEY,
  property_id   TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  ref           TEXT NOT NULL,
  raised_by     TEXT NOT NULL REFERENCES users(id),
  purpose       TEXT,
  wo_id         TEXT REFERENCES work_orders(id),
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('draft','pending','approved','rejected','purchased','received')),
  estimated_kobo INTEGER NOT NULL DEFAULT 0,
  approver_id   TEXT REFERENCES users(id),
  decided_at    TEXT,
  decision_note TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (property_id, ref),
  -- The person who raises a requisition never approves it.
  CHECK (approver_id IS NULL OR approver_id <> raised_by)
);
CREATE INDEX idx_req_state ON requisitions(property_id, status);

CREATE TABLE requisition_items (
  id             TEXT PRIMARY KEY,
  requisition_id TEXT NOT NULL REFERENCES requisitions(id) ON DELETE CASCADE,
  item_id        TEXT REFERENCES stock_items(id),
  description    TEXT NOT NULL,
  qty            REAL NOT NULL CHECK (qty > 0),
  estimated_kobo INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE stock_counts (
  id          TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  counted_at  TEXT NOT NULL,
  counted_by  TEXT REFERENCES users(id),
  verified_by TEXT REFERENCES users(id),
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','posted')),
  note        TEXT
);

CREATE TABLE stock_count_lines (
  id          TEXT PRIMARY KEY,
  count_id    TEXT NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
  item_id     TEXT NOT NULL REFERENCES stock_items(id),
  system_qty  REAL NOT NULL,
  counted_qty REAL NOT NULL,
  variance    REAL NOT NULL,
  reason      TEXT
);

CREATE TABLE vendors (
  id             TEXT PRIMARY KEY,
  property_id    TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  category       TEXT,
  contact_person TEXT,
  phone          TEXT,
  email          TEXT,
  address        TEXT,
  rating         INTEGER CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  is_active      INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (property_id, name)
);

CREATE TABLE contracts (
  id                     TEXT PRIMARY KEY,
  property_id            TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  vendor_id              TEXT NOT NULL REFERENCES vendors(id),
  title                  TEXT NOT NULL,
  type                   TEXT NOT NULL CHECK (type IN ('AMC','service','supply')),
  start_date             TEXT NOT NULL,
  end_date               TEXT NOT NULL,
  value_kobo             INTEGER NOT NULL DEFAULT 0,
  renewal_reminder_days  INTEGER NOT NULL DEFAULT 60,
  scope                  TEXT,
  attachment_id          TEXT REFERENCES attachments(id),
  is_active              INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  CHECK (end_date > start_date)
);
CREATE INDEX idx_contract_expiry ON contracts(property_id, end_date);

CREATE TABLE cost_centres (
  id          TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  parent_id   TEXT REFERENCES cost_centres(id),
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at  TEXT NOT NULL,
  UNIQUE (property_id, code)
);

CREATE TABLE budgets (
  id             TEXT PRIMARY KEY,
  property_id    TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  fiscal_year    INTEGER NOT NULL,
  period_month   INTEGER NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  cost_centre_id TEXT NOT NULL REFERENCES cost_centres(id),
  amount_kobo    INTEGER NOT NULL DEFAULT 0,
  approved_by    TEXT REFERENCES users(id),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (cost_centre_id, fiscal_year, period_month)
);

CREATE TABLE purchases (
  id                  TEXT PRIMARY KEY,
  property_id         TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  ref                 TEXT NOT NULL,
  requisition_id      TEXT REFERENCES requisitions(id),
  vendor_id           TEXT REFERENCES vendors(id),
  purchased_at        TEXT NOT NULL,
  description         TEXT NOT NULL,
  amount_kobo         INTEGER NOT NULL CHECK (amount_kobo >= 0),
  wo_id               TEXT REFERENCES work_orders(id),
  cost_centre_id      TEXT REFERENCES cost_centres(id),
  receipt_attachment_id TEXT REFERENCES attachments(id),
  recorded_by         TEXT REFERENCES users(id),
  approved_by         TEXT REFERENCES users(id),
  created_at          TEXT NOT NULL,
  UNIQUE (property_id, ref)
);
CREATE INDEX idx_purchase_cc ON purchases(cost_centre_id, purchased_at);

CREATE TABLE expenses (
  id                  TEXT PRIMARY KEY,
  property_id         TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  spent_at            TEXT NOT NULL,
  cost_centre_id      TEXT NOT NULL REFERENCES cost_centres(id),
  category            TEXT,
  amount_kobo         INTEGER NOT NULL CHECK (amount_kobo >= 0),
  vendor_id           TEXT REFERENCES vendors(id),
  wo_id               TEXT REFERENCES work_orders(id),
  description         TEXT NOT NULL,
  payment_method      TEXT,
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('draft','pending','approved','paid','rejected')),
  raised_by           TEXT NOT NULL REFERENCES users(id),
  approved_by         TEXT REFERENCES users(id),
  approved_at         TEXT,
  receipt_attachment_id TEXT REFERENCES attachments(id),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  CHECK (approved_by IS NULL OR approved_by <> raised_by)
);
CREATE INDEX idx_exp_cc ON expenses(cost_centre_id, spent_at);

-- A naira threshold table, not an if-statement.
CREATE TABLE approval_rules (
  id             TEXT PRIMARY KEY,
  property_id    TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  cost_centre_id TEXT REFERENCES cost_centres(id),
  min_kobo       INTEGER NOT NULL DEFAULT 0,
  max_kobo       INTEGER,
  required_role  TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

-- Notional internal rates for costing jobs, not payroll. Versioned so old jobs keep
-- the rate they were costed at.
CREATE TABLE labour_rates (
  id               TEXT PRIMARY KEY,
  property_id      TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  trade            TEXT NOT NULL,
  effective_from   TEXT NOT NULL,
  hourly_rate_kobo INTEGER NOT NULL CHECK (hourly_rate_kobo >= 0),
  created_at       TEXT NOT NULL,
  UNIQUE (property_id, trade, effective_from)
);

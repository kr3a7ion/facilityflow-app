-- @foreign_keys: off
--
-- Unit numbers are only unique within a block, and a unit has a name.
--
-- The table was built on `UNIQUE (property_id, unit_no)`, which assumes a unit number is
-- unique across a whole property. It is not. On the real property this was written for,
-- `003`, `004`, `005` and `006` each appear five times — once in the main building and
-- once in each of the studio wings — and `1` and `2` appear four times. Importing the
-- department's actual unit list would have rejected 14 of 114 rows, and the ones it kept
-- would have been the wrong ones.
--
-- Two columns are missing as well. Staff do not say "unit 004", they say "Seville" — the
-- name is how a job gets found and how a technician knows where they are going. And
-- bedroom count is the single most useful thing to have when sizing work.
--
-- SQLite cannot drop a table constraint, so the table is rebuilt: new table, copy, drop,
-- rename. Every id is preserved, so every work order, asset and inspection that points at
-- an apartment still points at the same apartment. Foreign keys are off for exactly this
-- migration (see the marker above) because dropping a parent table fires its children's
-- ON DELETE CASCADE, and the runner re-checks every reference before it commits.

CREATE TABLE apartments_new (
  id                  TEXT PRIMARY KEY,
  property_id         TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  location_id         TEXT NOT NULL UNIQUE REFERENCES locations(id) ON DELETE CASCADE,
  unit_no             TEXT NOT NULL,
  block               TEXT,
  floor               TEXT,
  unit_type           TEXT,
  -- What the staff actually call it: Seville, Kyoto. Optional, because plenty of
  -- properties number their units and stop there.
  name                TEXT,
  -- A plain count. Studios are 0, which is a real answer and not a missing one.
  bedrooms            INTEGER CHECK (bedrooms IS NULL OR bedrooms >= 0),
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
  -- The fix. A block of NULL still behaves as a single namespace, which is correct for a
  -- property that has one building and does not use blocks at all.
  UNIQUE (property_id, block, unit_no)
);

INSERT INTO apartments_new (
  id, property_id, location_id, unit_no, block, floor, unit_type, name, bedrooms,
  status, occupant_ref, occupant_phone, handover_date, last_inspection_at,
  next_inspection_due, notes, is_active, created_at, updated_at
)
SELECT
  id, property_id, location_id, unit_no, block, floor, unit_type, NULL, NULL,
  status, occupant_ref, occupant_phone, handover_date, last_inspection_at,
  next_inspection_due, notes, is_active, created_at, updated_at
FROM apartments;

DROP TABLE apartments;
ALTER TABLE apartments_new RENAME TO apartments;

CREATE INDEX idx_apt_status ON apartments(property_id, status);
-- Lists and pickers read in block then unit order, and the import looks a unit up by
-- exactly this pair on every row.
CREATE INDEX idx_apt_block_unit ON apartments(property_id, block, unit_no);
-- Searching by the name staff use is the whole reason the column exists.
CREATE INDEX idx_apt_name ON apartments(property_id, name);

-- The generator logbook.
--
-- Every plant room already has one: a hardback book by the door where whoever is on
-- shift writes the hour meter, the diesel in the day tank, what the temperature gauge
-- said and whether anything sounded wrong. It is the earliest warning the department
-- gets — a set does not usually fail without first running ten degrees hotter or
-- dropping oil pressure for a week — and it is the first thing to go missing when the
-- book fills up, gets rained on, or the person who kept it leaves.
--
-- This is that book. Deliberately not `generator_runs`: a run is an event with a start
-- and an end and a fuel burn, recorded when the set is stopped. A log entry is a set of
-- readings taken at a moment, while the machine is running in front of you, and there
-- are several a day. Conflating them would mean either logging readings you cannot take
-- or losing the ones you can.
--
-- Nothing here is mandatory beyond the meter. A property with no oil-pressure gauge, or
-- a technician who cannot safely reach the battery while the set is loaded, records what
-- they can see; a form that refuses to save without a figure is a form that teaches
-- people to invent figures.

CREATE TABLE genset_log_entries (
  id                TEXT PRIMARY KEY,
  property_id       TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  genset_asset_id   TEXT NOT NULL REFERENCES assets(id),
  taken_at          TEXT NOT NULL,
  -- The local date, stored alongside the timestamp so "did anyone log the sets today"
  -- is one index lookup rather than a timezone calculation over every row.
  work_date         TEXT NOT NULL,
  -- running: readings taken with the set under load. stopped: the daily walk-round of a
  -- set that did not run, which is still worth recording — that is when you find the
  -- leak, the flat battery and the empty day tank, before the outage rather than during.
  state             TEXT NOT NULL DEFAULT 'running' CHECK (state IN ('running','stopped')),

  hours_meter       REAL,

  -- Diesel as the person sees it: the day-tank gauge, and the bulk tank if they dipped
  -- it on the same round. Litres where the tank is calibrated, percent where it is a
  -- sight glass with no chart.
  day_tank_l        REAL,
  day_tank_pct      REAL,

  -- The gauges on the panel. Celsius and bar, because that is what is printed on them.
  coolant_temp_c    REAL,
  oil_pressure_bar  REAL,
  battery_volts     REAL,

  -- The output side. Three phases because that is what the building is fed from.
  volts_l1          REAL,
  volts_l2          REAL,
  volts_l3          REAL,
  amps_l1           REAL,
  amps_l2           REAL,
  amps_l3           REAL,
  frequency_hz      REAL,
  load_kw           REAL,

  -- What the person noticed that no gauge shows: the knocking, the black smoke, the
  -- smell of coolant. The single most valuable column in the table.
  remarks           TEXT,
  -- Set when any reading fell outside the limits for this set at the time it was taken,
  -- so a month of entries can be scanned for trouble without recomputing every row
  -- against limits that may since have changed.
  out_of_range      TEXT,

  logged_by         TEXT NOT NULL REFERENCES users(id),
  created_at        TEXT NOT NULL
);

CREATE INDEX idx_genset_log_asset ON genset_log_entries(genset_asset_id, taken_at DESC);
CREATE INDEX idx_genset_log_date ON genset_log_entries(property_id, work_date);

-- A log entry is a reading taken at a time. Correcting one by overwriting it would
-- destroy the only evidence of what the machine was doing, so entries are append-only
-- like the audit log and the stock ledger: a wrong entry is superseded by a new one and
-- explained in its remarks.
CREATE TRIGGER genset_log_no_update BEFORE UPDATE ON genset_log_entries
BEGIN SELECT RAISE(ABORT, 'genset_log_entries is append-only'); END;
CREATE TRIGGER genset_log_no_delete BEFORE DELETE ON genset_log_entries
BEGIN SELECT RAISE(ABORT, 'genset_log_entries is append-only'); END;

-- What "normal" is, per set.
--
-- Without this a temperature is a number nobody can act on. The defaults are the ordinary
-- operating window for a water-cooled diesel set on a 400V/50Hz three-phase supply, and
-- every one of them is editable, because a property with 60Hz plant or an air-cooled set
-- would otherwise be told it is in trouble every single day until it stopped reading the
-- warnings at all.
ALTER TABLE genset_profiles ADD COLUMN coolant_temp_max_c   REAL NOT NULL DEFAULT 95;
ALTER TABLE genset_profiles ADD COLUMN coolant_temp_min_c   REAL NOT NULL DEFAULT 70;
ALTER TABLE genset_profiles ADD COLUMN oil_pressure_min_bar REAL NOT NULL DEFAULT 2;
ALTER TABLE genset_profiles ADD COLUMN battery_volts_min    REAL NOT NULL DEFAULT 24;
ALTER TABLE genset_profiles ADD COLUMN nominal_volts        REAL NOT NULL DEFAULT 400;
ALTER TABLE genset_profiles ADD COLUMN nominal_hz           REAL NOT NULL DEFAULT 50;
ALTER TABLE genset_profiles ADD COLUMN day_tank_min_l       REAL;

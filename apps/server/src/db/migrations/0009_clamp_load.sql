-- FacilityFlow 0009 — clamp readings and building load.
--
-- The department already walks to the switchroom with a clamp meter and reads amps on
-- each phase, on the utility incomer and on whichever set is running. Those numbers go
-- on a paper log and are never turned into anything. This table turns them into the one
-- figure that decides an operational question every outage: how much load is the
-- building actually carrying right now, and therefore which generator should be started.
--
-- Starting a 250 kVA set on a 40 kW load is not a small mistake. Below roughly a third
-- of rating a diesel runs cold, unburnt fuel glazes the bores and wet-stacks the exhaust,
-- and the repair costs more than the diesel ever saved. The clamp reading is the only
-- thing on site that can tell you before you turn the key.

CREATE TABLE power_sources (
  id              TEXT PRIMARY KEY,
  property_id     TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  -- utility: the incoming supply. genset: a set's output breaker. feeder: anything
  -- downstream — a block, a chiller, the laundry. A feeder is diagnostic only.
  kind            TEXT NOT NULL CHECK (kind IN ('utility','genset','feeder')),
  genset_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
  phases          INTEGER NOT NULL DEFAULT 3 CHECK (phases IN (1,3)),
  -- Line-to-line for a three-phase source (415 V here), line-to-neutral for single phase.
  nominal_volts   REAL NOT NULL DEFAULT 415 CHECK (nominal_volts > 0),
  -- Site default when nobody has a power-factor meter in hand. 0.8 is the conventional
  -- assumption for a mixed hotel load and is what genset ratings are quoted against.
  default_pf      REAL NOT NULL DEFAULT 0.8 CHECK (default_pf > 0 AND default_pf <= 1),
  -- Clamping a CT secondary instead of the cable: reading x ratio = real amps.
  ct_ratio        REAL NOT NULL DEFAULT 1 CHECK (ct_ratio > 0),
  breaker_amps    REAL,
  -- Only an incomer counts toward the building total. Summing a feeder with the incomer
  -- that supplies it counts the same amps twice.
  is_incomer      INTEGER NOT NULL DEFAULT 1 CHECK (is_incomer IN (0,1)),
  sort_order      INTEGER NOT NULL DEFAULT 0,
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (property_id, name)
);
CREATE INDEX idx_psrc_prop ON power_sources(property_id, is_active, sort_order);

CREATE TABLE clamp_readings (
  id            TEXT PRIMARY KEY,
  property_id   TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  source_id     TEXT NOT NULL REFERENCES power_sources(id) ON DELETE CASCADE,
  taken_at      TEXT NOT NULL,
  -- As read off the clamp, before the CT ratio. Keeping the raw reading means a wrong
  -- ratio in the source profile is a correctable mistake rather than lost data.
  l1_amps       REAL NOT NULL CHECK (l1_amps >= 0),
  l2_amps       REAL CHECK (l2_amps IS NULL OR l2_amps >= 0),
  l3_amps       REAL CHECK (l3_amps IS NULL OR l3_amps >= 0),
  neutral_amps  REAL CHECK (neutral_amps IS NULL OR neutral_amps >= 0),
  volts         REAL NOT NULL CHECK (volts > 0),
  power_factor  REAL NOT NULL CHECK (power_factor > 0 AND power_factor <= 1),
  ct_ratio      REAL NOT NULL DEFAULT 1 CHECK (ct_ratio > 0),
  -- Derived at the moment of recording and stored, not computed on read. Change the
  -- source's nominal voltage next year and last quarter's kW must not silently move.
  avg_amps      REAL NOT NULL,
  max_amps      REAL NOT NULL,
  imbalance_pct REAL,
  kva           REAL NOT NULL,
  kw            REAL NOT NULL,
  taken_by      TEXT REFERENCES users(id),
  note          TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_clamp_source ON clamp_readings(source_id, taken_at DESC);
CREATE INDEX idx_clamp_prop   ON clamp_readings(property_id, taken_at DESC);

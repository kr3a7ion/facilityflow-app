-- Who is told what, how loudly, and the changeover between mains and generator.
--
-- 1. Every notification now carries how loud it should be. Until now the browser guessed
--    from the wording ("does the body start with P1?") and from two kind names that
--    nothing ever sent, so an escalation — the most urgent message in the system — played
--    the same polite chime as a stock reminder.
ALTER TABLE notifications ADD COLUMN level TEXT
  CHECK (level IS NULL OR level IN ('quiet', 'chime', 'good', 'urgent'));

-- 2. Whether a generator is running right now, as opposed to whether it is available.
--    `assets.status` says a set is in service, on standby or faulty — its availability.
--    It was being shown as "Running" whenever it was in service, mains on or not.
ALTER TABLE genset_profiles ADD COLUMN running_since TEXT;

-- 3. The changeover log: mains failed, mains back, a set started, stopped or tripped.
--    Recorded as it happens from the Power screen, so the people who need to know are
--    told at the moment it happens rather than when somebody writes up the run later.
CREATE TABLE power_switch_log (
  id               TEXT PRIMARY KEY,
  property_id      TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  at               TEXT NOT NULL,
  event            TEXT NOT NULL CHECK (event IN
                     ('mains_off', 'mains_on', 'genset_start', 'genset_stop', 'genset_fault')),
  genset_asset_id  TEXT REFERENCES assets(id),
  outage_id        TEXT REFERENCES power_outages(id),
  -- For a stop: how long it had been running, so the run can be written up from it.
  ran_minutes      INTEGER,
  note             TEXT,
  logged_by        TEXT REFERENCES users(id),
  created_at       TEXT NOT NULL
);
CREATE INDEX idx_switch_log ON power_switch_log (property_id, at DESC);

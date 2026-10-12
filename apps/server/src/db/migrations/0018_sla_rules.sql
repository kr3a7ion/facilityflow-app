-- Specific response and resolve targets.
--
-- P1 to P4 stay the defaults for every job. A rule narrows one of them for a trade, a
-- place, or both — "P2 electrical: respond in 30 minutes", "P1 anywhere in Block A:
-- escalate to the head of department" — and the most specific rule that matches a job
-- when it is raised decides its deadlines.
--
-- Deadlines are still computed once, at creation, and stored on the job. A rule edited or
-- deleted later shapes future work only; it never moves a deadline somebody was already
-- judged against. The job records which rule it took (`work_orders.sla_rule_id`) so the
-- job card can say why its deadline is what it is, and so escalation tells the person
-- that rule named.

CREATE TABLE sla_rules (
  id                TEXT PRIMARY KEY,
  property_id       TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  priority          TEXT NOT NULL CHECK (priority IN ('P1','P2','P3','P4')),
  -- What the rule applies to. At least one, or it is just the priority's default again.
  trade             TEXT,
  location_id       TEXT REFERENCES locations(id),
  -- What it changes. NULL means "as the priority's default says".
  respond_minutes   INTEGER CHECK (respond_minutes IS NULL OR respond_minutes > 0),
  resolve_minutes   INTEGER CHECK (resolve_minutes IS NULL OR resolve_minutes > 0),
  escalate_to_role  TEXT,
  note              TEXT,
  created_by        TEXT REFERENCES users(id),
  created_at        TEXT NOT NULL,
  updated_by        TEXT REFERENCES users(id),
  updated_at        TEXT NOT NULL,
  -- Removed from the list, kept for the jobs that took it. Never hard-deleted: a job
  -- pointing at a rule that no longer exists cannot explain its own deadline.
  deleted_at        TEXT,
  CHECK (trade IS NOT NULL OR location_id IS NOT NULL),
  CHECK (respond_minutes IS NOT NULL OR resolve_minutes IS NOT NULL OR escalate_to_role IS NOT NULL)
);

-- One live rule per priority, trade and place. Two would leave "which one wins" to the
-- order rows happen to come back in.
CREATE UNIQUE INDEX idx_sla_rules_unique
  ON sla_rules (property_id, priority, COALESCE(trade, ''), COALESCE(location_id, ''))
  WHERE deleted_at IS NULL;

ALTER TABLE work_orders ADD COLUMN sla_rule_id TEXT REFERENCES sla_rules(id);

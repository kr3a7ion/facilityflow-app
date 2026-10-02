-- Who may see what things cost.
--
-- The hole this closes: reading requisitions was gated on `stock.read`, which every
-- technician and team lead holds so they can check whether a part is on the shelf. That
-- one grant handed them every requisition in the property, with its estimate, plus the
-- average cost and stock value of every item in the catalogue. Nobody intended it; it is
-- what happens when one permission guards two unrelated things.
--
-- Two new codes split them apart:
--
--   requisition.read  -- may see requisitions. Granted at 'own' scope to the people who
--                        raise them, so a technician still sees their own request and what
--                        was decided about it, and at 'all' scope to the people who decide,
--                        buy and pay.
--   cost.read         -- may see money. One code for every naira figure outside the finance
--                        module: stock values, unit costs, requisition estimates, count
--                        variances in money, cost per kWh.
--
-- Grants are by role key, so a property that runs differently can change them under
-- Admin > Roles like any other permission.

INSERT OR IGNORE INTO permissions (code, module, description) VALUES
  ('requisition.read', 'stores',  'View requisitions'),
  ('cost.read',        'finance', 'See prices, costs and values anywhere they appear');

-- ---- requisition.read ------------------------------------------------------------
-- Everyone who could already raise one keeps sight of their own.
INSERT OR IGNORE INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, 'requisition.read', 'own'
  FROM roles r
 WHERE r.key IN ('technician', 'team_lead');

-- The people who decide, fulfil, buy and pay see all of them.
INSERT OR IGNORE INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, 'requisition.read', 'all'
  FROM roles r
 WHERE r.key IN ('admin', 'hod', 'supervisor', 'storekeeper', 'finance', 'auditor');

-- ---- cost.read -------------------------------------------------------------------
-- The storekeeper is in this list because receiving stock means entering a unit cost;
-- without it they could not do their job. It gives them store values only.
INSERT OR IGNORE INTO role_permissions (role_id, permission_code, scope)
SELECT r.id, 'cost.read', 'all'
  FROM roles r
 WHERE r.key IN ('admin', 'hod', 'supervisor', 'storekeeper', 'finance', 'auditor');

-- Not granted: technician, team_lead, requester. A job is work, not a number.

/**
 * The permission catalogue. Handlers check a CODE, never a role name — that is the
 * difference between "the HOD wants supervisors to issue permits now" being a
 * settings change and being a release.
 */
export interface PermissionDef { code: string; module: string; description: string }

export const PERMISSIONS: PermissionDef[] = [
  // M1 core & admin
  { code: 'admin.property.manage', module: 'core', description: 'Edit property details and branding' },
  { code: 'admin.users.manage',    module: 'core', description: 'Create, disable and reset users' },
  { code: 'admin.roles.manage',    module: 'core', description: 'Edit roles and their permissions' },
  { code: 'alerts.silence',        module: 'core', description: 'Turn their own alert sounds off' },
  // Loud, therefore accountable: a permission to use it and a record of who did.
  { code: 'alerts.ring',           module: 'core', description: "Ring another person's device" },
  { code: 'alerts.emergency',      module: 'core', description: 'Raise an emergency alert to everybody' },
  // Getting in from outside the property, and being able to change anything once in.
  // Two codes on purpose: the worst case of a lost phone depends on keeping them apart.
  { code: 'remote.access',         module: 'core', description: 'Sign in from outside the property network' },
  { code: 'remote.write',          module: 'core', description: 'Change things while signed in from outside' },
  // Setting up the shared screen that covers a shift is an operational decision, not an
  // administrative one: a supervisor putting a tablet in the plant room should not need
  // an administrator to do it.
  { code: 'duty.device.manage',    module: 'core', description: 'Mark a screen as the duty device' },
  { code: 'admin.settings.manage', module: 'core', description: 'Edit reference data and SLA targets' },
  { code: 'admin.backup.run',      module: 'core', description: 'Run and download backups' },
  { code: 'admin.audit.read',      module: 'core', description: 'Read the audit log' },

  // M2 staff, shifts & availability
  { code: 'staff.read',            module: 'people', description: 'View staff records' },
  { code: 'staff.manage',          module: 'people', description: 'Create and edit staff and teams' },
  { code: 'roster.read',           module: 'people', description: 'View the roster' },
  { code: 'roster.edit',           module: 'people', description: 'Draft and change the roster' },
  { code: 'roster.publish',        module: 'people', description: 'Publish a roster week to staff' },
  { code: 'roster.mark',           module: 'people', description: 'Mark staff present or absent on the day' },
  { code: 'handover.write',        module: 'people', description: 'Submit a shift handover' },
  { code: 'handover.acknowledge',  module: 'people', description: 'Acknowledge an incoming handover' },

  // M3 places & apartments
  { code: 'location.read',         module: 'places', description: 'View blocks, floors and plant rooms' },
  { code: 'location.manage',       module: 'places', description: 'Edit the location tree' },
  { code: 'apartment.read',        module: 'places', description: 'View apartments' },
  { code: 'apartment.manage',      module: 'places', description: 'Edit apartments and their status' },
  { code: 'apartment.import',      module: 'places', description: 'Import a unit list from CSV or Day Book' },

  // M4 assets
  { code: 'asset.read',            module: 'assets', description: 'View the asset register' },
  { code: 'asset.manage',          module: 'assets', description: 'Create and edit assets' },

  // M5 work orders
  { code: 'wo.read',               module: 'jobs', description: 'View jobs' },
  { code: 'wo.create',             module: 'jobs', description: 'Raise a job or fault request' },
  { code: 'wo.assign',             module: 'jobs', description: 'Assign and reassign jobs' },
  { code: 'wo.accept',             module: 'jobs', description: 'Accept a job assigned to you' },
  { code: 'wo.update',             module: 'jobs', description: 'Log progress, hours, parts and photos' },
  { code: 'wo.hold',               module: 'jobs', description: 'Put a job on hold with a reason' },
  { code: 'wo.complete',           module: 'jobs', description: 'Mark a job complete' },
  { code: 'wo.verify',             module: 'jobs', description: 'Verify a completed job (never your own)' },
  { code: 'wo.cancel',             module: 'jobs', description: 'Cancel a job with a reason' },
  { code: 'wo.cost.read',          module: 'jobs', description: 'See job costs' },

  // M6 preventive maintenance
  { code: 'ppm.read',              module: 'ppm', description: 'View PPM schedules and compliance' },
  { code: 'ppm.manage',            module: 'ppm', description: 'Create and edit PPM schedules and checklists' },

  // M7 generator & diesel
  { code: 'fuel.read',             module: 'power', description: 'View tanks, dips and reconciliation' },
  { code: 'fuel.dip.log',          module: 'power', description: 'Record a tank dip' },
  { code: 'fuel.delivery.create',  module: 'power', description: 'Receive a diesel delivery' },
  { code: 'fuel.delivery.witness', module: 'power', description: 'Countersign a delivery (second signature)' },
  { code: 'fuel.reconcile',        module: 'power', description: 'Close and explain a reconciliation period' },
  { code: 'genset.run.log',        module: 'power', description: 'Record a generator run' },
  { code: 'power.clamp.log',       module: 'power', description: 'Record a clamp meter reading' },
  { code: 'power.source.manage',   module: 'power', description: 'Set up incomers, feeders and CT ratios' },

  // M8 stores
  { code: 'stock.read',            module: 'stores', description: 'View stock levels' },
  { code: 'stock.issue',           module: 'stores', description: 'Issue parts against a job' },
  { code: 'stock.receive',         module: 'stores', description: 'Receive stock into the store' },
  { code: 'stock.adjust',          module: 'stores', description: 'Adjust stock after a count' },
  { code: 'requisition.read',      module: 'stores', description: 'View requisitions' },
  { code: 'requisition.create',    module: 'stores', description: 'Raise a requisition' },
  { code: 'requisition.approve',   module: 'stores', description: 'Approve a requisition (never your own)' },

  // M9 vendors & purchases
  { code: 'vendor.read',           module: 'vendors', description: 'View vendors and contracts' },
  { code: 'vendor.manage',         module: 'vendors', description: 'Edit vendors, contracts and AMCs' },
  { code: 'purchase.record',       module: 'vendors', description: 'Record a purchase against a requisition' },
  { code: 'purchase.approve',      module: 'vendors', description: 'Approve a purchase' },

  // M10 finance
  // The money gate. Separate from finance.read because seeing a price is not the same
  // right as opening the finance screen: a storekeeper receiving stock must enter and
  // read unit costs, and has no business with budgets; a technician has business with
  // neither. Every naira figure outside the finance module is gated on this one code,
  // so there is one place to look when somebody asks who can see what things cost.
  { code: 'cost.read',             module: 'finance', description: 'See prices, costs and values anywhere they appear' },
  { code: 'finance.read',          module: 'finance', description: 'View costs and budgets' },
  { code: 'finance.budget.edit',   module: 'finance', description: 'Set budgets by cost centre' },
  { code: 'finance.expense.create',module: 'finance', description: 'Record an expense' },
  { code: 'finance.expense.approve',module:'finance', description: 'Approve an expense' },

  // M11 safety
  { code: 'permit.request',        module: 'safety', description: 'Request a permit to work' },
  { code: 'permit.issue',          module: 'safety', description: 'Issue and close permits' },
  { code: 'incident.report',       module: 'safety', description: 'Report an incident or near miss' },
  { code: 'incident.read',         module: 'safety', description: 'Read incident records' },

  // M13 reports
  { code: 'report.read',           module: 'reports', description: 'View dashboards and reports' },
  { code: 'report.export',         module: 'reports', description: 'Export to Excel or PDF' },
];

export const ALL_CODES: string[] = PERMISSIONS.map((p) => p.code);

export interface RoleDef { key: string; name: string; description: string; permissions: string[] | '*' }

const TECHNICIAN = [
  'wo.read', 'wo.accept', 'wo.update', 'wo.hold', 'wo.complete',
  'asset.read', 'location.read', 'apartment.read',
  'roster.read', 'stock.read', 'requisition.create', 'requisition.read',
  'fuel.read', 'fuel.dip.log', 'fuel.delivery.create', 'genset.run.log', 'power.clamp.log',
  'permit.request', 'incident.report', 'ppm.read',
];

export const ROLES: RoleDef[] = [
  {
    key: 'admin', name: 'System administrator',
    description: 'Everything technical. Keep it to one or two people and never use it as a daily account.',
    permissions: '*',
  },
  {
    key: 'hod', name: 'Head of department',
    description: 'Reads everything, approves above supervisor limits, owns budgets and contracts.',
    permissions: [
      ...ALL_CODES.filter((c) => !c.startsWith('admin.') || c === 'admin.audit.read'),
    ],
  },
  {
    key: 'supervisor', name: 'Supervisor',
    description: 'Assigns and verifies jobs, publishes the roster, issues permits, countersigns fuel.',
    permissions: [
      'staff.read', 'roster.read', 'roster.edit', 'roster.publish', 'roster.mark',
      'handover.write', 'handover.acknowledge',
      'location.read', 'apartment.read', 'apartment.manage',
      'asset.read', 'asset.manage',
      'wo.read', 'wo.create', 'wo.assign', 'wo.update', 'wo.hold', 'wo.verify', 'wo.cancel', 'wo.cost.read',
      'ppm.read', 'ppm.manage',
      'fuel.read', 'fuel.dip.log', 'fuel.delivery.witness', 'fuel.reconcile', 'genset.run.log',
      'power.clamp.log', 'power.source.manage',
      'stock.read', 'requisition.create', 'requisition.read', 'requisition.approve', 'cost.read',
      'vendor.read', 'purchase.record',
      'permit.request', 'permit.issue', 'incident.report', 'incident.read',
      'report.read', 'report.export', 'alerts.silence',
      'alerts.ring', 'alerts.emergency',
      'remote.access', 'remote.write', 'duty.device.manage',
    ],
  },
  {
    key: 'team_lead', name: 'Team lead',
    description: 'Assigns and verifies within their own team, raises requisitions, logs readings.',
    // No alerts.silence: a team lead is dispatched work and is expected to hear it.
    permissions: [
      ...TECHNICIAN, 'wo.assign', 'wo.verify', 'wo.create', 'staff.read', 'report.read',
      // Their own team, and only their own: the scope is set below.
      'alerts.ring',
      'duty.device.manage',
    ],
  },
  {
    key: 'technician', name: 'Technician',
    description: 'Works jobs. Cannot verify their own work and cannot see costs.',
    permissions: TECHNICIAN,
  },
  {
    key: 'storekeeper', name: 'Storekeeper',
    description: 'Receives, issues and counts stock. Cannot approve what they raised.',
    permissions: [
      'stock.read', 'stock.issue', 'stock.receive', 'stock.adjust',
      'requisition.create', 'requisition.read',
      // A storekeeper cannot receive stock without entering what it cost, so the money
      // gate has to be open for them. It gets them store values and nothing else: no
      // budgets, no job costs, no expenses.
      'cost.read',
      'fuel.read', 'fuel.delivery.create',
      'wo.read', 'asset.read', 'vendor.read', 'report.read', 'alerts.silence',
    ],
  },
  {
    key: 'finance', name: 'Finance officer',
    description: 'Costs, budgets and expenses. Read-only on operational records.',
    permissions: [
      'cost.read', 'requisition.read',
      'finance.read', 'finance.budget.edit', 'finance.expense.create', 'finance.expense.approve',
      'purchase.record', 'purchase.approve', 'vendor.read', 'vendor.manage',
      'wo.read', 'wo.cost.read', 'stock.read', 'fuel.read', 'report.read', 'report.export',
      'alerts.silence',
    ],
  },
  {
    key: 'requester', name: 'Requester',
    description: 'Front office and housekeeping. Raises faults and tracks only what they raised.',
    permissions: ['wo.create', 'wo.read', 'apartment.read', 'location.read', 'alerts.silence'],
  },
  {
    key: 'auditor', name: 'Auditor',
    description: 'Read-only across every module, plus the audit log.',
    permissions: [
      ...ALL_CODES.filter((c) => c.endsWith('.read') || c === 'admin.audit.read'),
      'alerts.silence',
    ],
  },
];

/** Scope narrows a grant: a team lead assigns within their team; a supervisor anywhere. */
export const ROLE_SCOPES: Record<string, Record<string, 'own' | 'team' | 'all'>> = {
  // 'requisition.read' is 'own' and not 'team' on purpose: a requisition records who
  // raised it and not which team they were in, so there is no honest team boundary to
  // draw. A technician or team lead sees the requests they made and what was decided
  // about them, which is what they need, and not the whole department's shopping.
  technician: { 'wo.read': 'own', 'wo.update': 'own', 'wo.complete': 'own', 'wo.accept': 'own', 'wo.hold': 'own',
                'requisition.read': 'own' },
  team_lead:  { 'wo.assign': 'team', 'wo.verify': 'team', 'wo.read': 'team', 'requisition.read': 'own',
                'alerts.ring': 'team' },
  requester:  { 'wo.read': 'own' },
};

/**
 * What is set up, and what is not.
 *
 * A fresh install presents eleven admin tabs and no opinion about which to open. The
 * person holding it has never seen the system and has no way to know that staff come
 * before accounts, or that a generator without a kVA rating is invisible to the load
 * screen. This turns that tribal knowledge into something the software says out loud.
 *
 * Two rules keep it honest. Every step reports a real count from the database rather
 * than a flag somebody could tick and forget. And a step that is genuinely optional says
 * so, because a checklist that nags forever about a module this property will never use
 * is a checklist people learn to ignore.
 */
import type { Db } from '../db/connection.js';
import type { Config } from '../config.js';
import { backupSummary } from './host.js';

export type StepState = 'done' | 'todo' | 'attention';

export interface Step {
  key: string;
  /** Imperative, in the department's words. */
  title: string;
  /** Why this one matters — the consequence of skipping it, not a restatement. */
  why: string;
  state: StepState;
  /** What the count means, e.g. "8 people". Null when counting is not the point. */
  detail: string | null;
  /** Where to go. A client route plus the tab within it, when there is one. */
  to: string;
  /** Blocks real work if missing, as opposed to merely unlocking a module. */
  essential: boolean;
  /** The permission needed to act on it — a supervisor is not shown admin-only steps. */
  needs: string;
}

export interface Readiness {
  /** Essential steps only: the bar for "this system can be used". */
  ready: boolean;
  doneCount: number;
  totalCount: number;
  essentialRemaining: number;
  steps: Step[];
}

function count(db: Db, sql: string, ...args: unknown[]): number {
  return (db.prepare(sql).get(...args) as { n: number }).n;
}

export function readiness(db: Db, propertyId: string, cfg: Config): Readiness {
  const staff = count(db, 'SELECT COUNT(*) n FROM staff WHERE property_id = ? AND is_active = 1', propertyId);
  const users = count(db,
    `SELECT COUNT(*) n FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.property_id = ? AND u.is_active = 1 AND r.key <> 'admin'`, propertyId);
  const shifts = count(db, 'SELECT COUNT(*) n FROM shift_patterns WHERE property_id = ? AND is_active = 1', propertyId);
  // The site itself is created by the wizard, so it does not count as the department's own work.
  const places = count(db,
    `SELECT COUNT(*) n FROM locations WHERE property_id = ? AND is_active = 1 AND type <> 'site'`, propertyId);
  const apartments = count(db, 'SELECT COUNT(*) n FROM apartments WHERE property_id = ? AND is_active = 1', propertyId);
  const assets = count(db, 'SELECT COUNT(*) n FROM assets WHERE property_id = ? AND is_active = 1', propertyId);

  // A generator with no rating cannot be recommended and nothing can say whether it
  // would run cold — so "has gensets but none rated" is a distinct, louder state.
  //
  // Identified by category rather than by having an hour meter: a water pump has running
  // hours too, and counting it would report a generator that needs rating and can never
  // be satisfied. Category names are the department's own, so this matches loosely and
  // errs toward saying nothing rather than nagging about a pump.
  const gensets = count(db,
    `SELECT COUNT(*) n FROM assets a
       LEFT JOIN asset_categories c ON c.id = a.category_id
      WHERE a.property_id = ? AND a.is_active = 1
        AND (LOWER(COALESCE(c.name,'')) LIKE '%gen%'
             OR EXISTS (SELECT 1 FROM genset_profiles g WHERE g.asset_id = a.id))`,
    propertyId);
  const rated = count(db,
    `SELECT COUNT(*) n FROM genset_profiles g JOIN assets a ON a.id = g.asset_id
      WHERE a.property_id = ? AND a.is_active = 1`, propertyId);

  const tanks = count(db, 'SELECT COUNT(*) n FROM fuel_tanks WHERE property_id = ? AND is_active = 1', propertyId);
  const incomers = count(db,
    'SELECT COUNT(*) n FROM power_sources WHERE property_id = ? AND is_active = 1 AND is_incomer = 1', propertyId);
  const ppm = count(db, 'SELECT COUNT(*) n FROM ppm_schedules WHERE property_id = ? AND is_active = 1', propertyId);
  const stock = count(db, 'SELECT COUNT(*) n FROM stock_items WHERE property_id = ? AND is_active = 1', propertyId);
  const centres = count(db, 'SELECT COUNT(*) n FROM cost_centres WHERE property_id = ? AND is_active = 1', propertyId);
  const rostered = count(db,
    'SELECT COUNT(*) n FROM roster_entries WHERE property_id = ? AND published_at IS NOT NULL', propertyId);
  const backups = backupSummary(cfg);

  const plural = (n: number, one: string, many = one + 's'): string => `${n} ${n === 1 ? one : many}`;

  const steps: Step[] = [
    {
      key: 'staff', title: 'Add the people who do the work', needs: 'staff.manage',
      why: 'A job can only be assigned to somebody who is rostered, and only people on this list can be rostered. Nothing else works until this does.',
      state: staff > 0 ? 'done' : 'todo',
      detail: staff > 0 ? plural(staff, 'person', 'people') : null,
      to: '/admin?tab=people', essential: true,
    },
    {
      key: 'users', title: 'Give the team accounts', needs: 'admin.users.manage',
      why: 'Two people minimum beyond your own: a diesel delivery needs two different signatures and nobody can verify a job they completed themselves.',
      state: users >= 2 ? 'done' : users > 0 ? 'attention' : 'todo',
      detail: users > 0 ? `${plural(users, 'account')} besides yours` : null,
      to: '/admin?tab=users', essential: true,
    },
    {
      key: 'places', title: 'Name the places', needs: 'location.manage',
      why: 'Blocks, risers, the generator house. A job has to hang off a place, an apartment or an asset — "generator house" is the difference between readable history and a list of things that happened somewhere.',
      state: places > 0 ? 'done' : 'todo',
      detail: places > 0 ? plural(places, 'place') : null,
      to: '/admin?tab=places', essential: true,
    },
    {
      key: 'shifts', title: 'Set the shift patterns', needs: 'admin.settings.manage',
      why: 'A roster entry points at a pattern, so the patterns have to exist before anybody can be put on a shift.',
      state: shifts > 0 ? 'done' : 'todo',
      detail: shifts > 0 ? plural(shifts, 'pattern') : null,
      to: '/admin?tab=shifts', essential: true,
    },
    {
      key: 'apartments', title: 'Import the unit list', needs: 'apartment.import',
      why: 'Units have to exist before the ACs and heaters that live in them, and before anybody can raise a job against a room number.',
      state: apartments > 0 ? 'done' : 'todo',
      detail: apartments > 0 ? plural(apartments, 'unit') : null,
      to: '/apartments', essential: false,
    },
    {
      key: 'assets', title: 'Build the asset register', needs: 'asset.manage',
      why: 'Gensets, pumps, lifts, ACs. The tag you type here is what gets printed on the QR sticker and what a phone camera opens.',
      state: assets > 0 ? 'done' : 'todo',
      detail: assets > 0 ? plural(assets, 'asset') : null,
      to: '/assets', essential: false,
    },
    {
      key: 'gensets', title: 'Rate every generator', needs: 'asset.manage',
      why: 'Without a kVA rating a set is invisible to the load screen — it cannot be recommended, and nothing can say whether it would run cold and glaze its bores.',
      // Only nags once there is a generator to rate.
      state: gensets === 0 ? 'todo' : rated >= gensets ? 'done' : 'attention',
      detail: gensets === 0 ? null : `${rated} of ${gensets} rated`,
      to: '/assets', essential: false,
    },
    {
      key: 'tanks', title: 'Add the diesel tanks', needs: 'admin.settings.manage',
      why: 'No tank means no dips, no deliveries and no reconciliation — the whole fuel module stays dark.',
      state: tanks > 0 ? 'done' : 'todo',
      detail: tanks > 0 ? plural(tanks, 'tank') : null,
      to: '/admin?tab=supplies', essential: false,
    },
    {
      key: 'supplies', title: 'Set up what you clamp', needs: 'power.source.manage',
      why: 'The utility incomer and each set’s output breaker. Get the feeder flag right here and the building load is honest; get it wrong and it reads double.',
      state: incomers > 0 ? 'done' : 'todo',
      detail: incomers > 0 ? plural(incomers, 'incomer') : null,
      to: '/admin?tab=supplies', essential: false,
    },
    {
      key: 'ppm', title: 'Schedule the planned work', needs: 'ppm.manage',
      why: 'Servicing that happens because a schedule said so, not because something broke. This is the half of maintenance that stops being reactive.',
      state: ppm > 0 ? 'done' : 'todo',
      detail: ppm > 0 ? plural(ppm, 'schedule') : null,
      to: '/ppm', essential: false,
    },
    {
      key: 'stock', title: 'List the store', needs: 'stock.receive',
      why: 'Parts issued against a job are what make a job cost mean anything, and what stops a filter running out unnoticed.',
      state: stock > 0 ? 'done' : 'todo',
      detail: stock > 0 ? plural(stock, 'item') : null,
      to: '/stores', essential: false,
    },
    {
      key: 'budget', title: 'Set cost centres and a budget', needs: 'finance.budget.edit',
      why: 'Spend has to be measured against something. Without a budget the first month of purchases has nothing to be compared to.',
      state: centres > 0 ? 'done' : 'todo',
      detail: centres > 0 ? plural(centres, 'cost centre') : null,
      to: '/money', essential: false,
    },
    {
      key: 'roster', title: 'Publish a roster week', needs: 'roster.publish',
      why: 'A drafted week is invisible to the team, and an unrostered person cannot be given a job. Publishing is what makes the week real.',
      state: rostered > 0 ? 'done' : 'todo',
      detail: rostered > 0 ? 'published' : null,
      to: '/roster', essential: true,
    },
    {
      key: 'host', title: 'Make the PC serve it at boot', needs: 'admin.settings.manage',
      why: 'Until this is done the system only runs while somebody has a window open. Close it, log out, or let the PC restart overnight and the department loses it.',
      // The server cannot see the scheduled task from in here on every platform, so this
      // one is never marked done automatically — it points at the screen that can tell.
      state: 'attention',
      detail: 'check on the Host PC tab',
      to: '/admin?tab=host', essential: false,
    },
    {
      key: 'backup', title: 'Get a backup off this PC', needs: 'admin.backup.run',
      why: 'The host takes one a day by itself, but a snapshot on the same disk as the database survives a mistake — not a dead machine, a theft or a fire.',
      state: backups.count > 0 ? 'done' : 'todo',
      detail: backups.count > 0 ? `${plural(backups.count, 'snapshot')} kept` : null,
      to: '/admin?tab=backups', essential: false,
    },
  ];

  const essentialRemaining = steps.filter((s) => s.essential && s.state !== 'done').length;
  return {
    ready: essentialRemaining === 0,
    doneCount: steps.filter((s) => s.state === 'done').length,
    totalCount: steps.length,
    essentialRemaining,
    steps,
  };
}

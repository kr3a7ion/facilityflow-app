import { openDb } from './connection.js';
import { migrate } from './migrate.js';
import { loadConfig } from '../config.js';
import { ulid } from '../lib/ids.js';
import { nextRef } from '../lib/refs.js';
import { nowIso, localDate } from '../lib/time.js';
import { hashPassword } from '../auth/password.js';
import { PERMISSIONS, ROLES, ALL_CODES, ROLE_SCOPES } from '../auth/permissions.js';
import { compute } from '../services/load.js';
import type { Db } from './connection.js';

/**
 * Demo dataset. You cannot sell this over a screen-share against empty tables,
 * and you cannot test a roster with no staff on it.
 *
 * Everything here is invented sample data for a fictional property.
 * Run with --force to wipe and rebuild.
 */

const DEMO_PASSWORD = 'facilityflow-demo';

const STAFF = [
  { first: 'Musa',    last: 'Ibrahim',  trade: 'electrical', team: 'Electrical', lead: true },
  { first: 'Tunde',   last: 'Adeyemi',  trade: 'electrical', team: 'Electrical' },
  { first: 'Ifeoma',  last: 'Bassey',   trade: 'hvac',       team: 'Mechanical', lead: true },
  { first: 'Emeka',   last: 'Nwosu',    trade: 'hvac',       team: 'Mechanical' },
  { first: 'Chinedu', last: 'Okeke',    trade: 'plumbing',   team: 'Plumbing',   lead: true },
  { first: 'Sadiq',   last: 'Aliyu',    trade: 'general',    team: 'General' },
  { first: 'Halima',  last: 'Yusuf',    trade: 'general',    team: 'General' },
  { first: 'Grace',   last: 'Etim',     trade: 'supervisor', team: 'General' },
];

const SHIFTS = [
  { name: 'Morning',   start: '06:00', end: '14:00', midnight: 0, colour: '#2563C9' },
  { name: 'Afternoon', start: '14:00', end: '22:00', midnight: 0, colour: '#1F7A4C' },
  { name: 'Night',     start: '22:00', end: '06:00', midnight: 1, colour: '#5B3FA8' },
];

const BLOCKS = [
  { code: 'A', name: 'Block A', floors: ['09', '12'], units: 8 },
  { code: 'B', name: 'Block B', floors: ['08'],       units: 8 },
  { code: 'C', name: 'Block C', floors: ['05'],       units: 6 },
];

const UNIT_STATUS = ['occupied', 'occupied', 'occupied', 'vacant_ready', 'occupied', 'under_maintenance',
                     'occupied', 'occupied'] as const;

const round1 = (n: number): number => Math.round(n * 10) / 10;
const daysAgo = (d: number): string => new Date(Date.now() - d * 86_400_000).toISOString();
const daysAhead = (d: number): string => new Date(Date.now() + d * 86_400_000).toISOString();

async function seed(db: Db, force: boolean): Promise<void> {
  const existing = (db.prepare('SELECT COUNT(*) AS n FROM properties').get() as { n: number }).n;
  if (existing > 0 && !force) {
    console.log('database already has a property — pass --force to wipe and reseed');
    return;
  }
  if (existing > 0) {
    // Ordered by dependency; audit_log is append-only so it is dropped, not deleted.
    db.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TRIGGER IF EXISTS wo_events_no_delete; DROP TRIGGER IF EXISTS stock_mv_no_delete;
      DELETE FROM work_order_events; DELETE FROM work_order_parts; DELETE FROM work_order_labour;
      DELETE FROM work_order_assignees; DELETE FROM work_orders; DELETE FROM job_requests;
      DELETE FROM ppm_schedules; DELETE FROM checklist_items; DELETE FROM checklist_templates;
      DELETE FROM fuel_reconciliations; DELETE FROM generator_runs; DELETE FROM power_outages;
      DELETE FROM fuel_issues; DELETE FROM fuel_deliveries; DELETE FROM fuel_dips;
      DELETE FROM clamp_readings; DELETE FROM power_sources;
      DELETE FROM genset_profiles; DELETE FROM fuel_tanks;
      DELETE FROM stock_movements; DELETE FROM stock_items; DELETE FROM requisition_items;
      DELETE FROM requisitions; DELETE FROM purchases; DELETE FROM expenses; DELETE FROM budgets;
      DELETE FROM labour_rates; DELETE FROM contracts; DELETE FROM vendors; DELETE FROM cost_centres;
      DELETE FROM isolation_points; DELETE FROM permits; DELETE FROM incidents;
      DELETE FROM meter_readings; DELETE FROM meters;
      DELETE FROM asset_meter_readings; DELETE FROM apartment_appliances; DELETE FROM assets;
      DELETE FROM asset_categories;
      DELETE FROM apartment_imports; DELETE FROM apartments; DELETE FROM locations;
      DELETE FROM shift_handovers; DELETE FROM absences; DELETE FROM roster_entries;
      DELETE FROM shift_patterns; DELETE FROM staff; DELETE FROM teams;
      DELETE FROM attachments; DELETE FROM notifications; DELETE FROM sessions;
      DELETE FROM users; DELETE FROM role_permissions; DELETE FROM roles;
      DELETE FROM settings; DELETE FROM ref_sequences;
      DROP TRIGGER IF EXISTS audit_log_no_delete;
      DELETE FROM audit_log;
      CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
      BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
      DELETE FROM properties;
      CREATE TRIGGER wo_events_no_delete BEFORE DELETE ON work_order_events
      BEGIN SELECT RAISE(ABORT, 'work_order_events is append-only'); END;
      CREATE TRIGGER stock_mv_no_delete BEFORE DELETE ON stock_movements
      BEGIN SELECT RAISE(ABORT, 'stock_movements is append-only'); END;
      PRAGMA foreign_keys = ON;
    `);
    console.log('wiped existing data');
  }

  const at = nowIso();
  const tz = 'Africa/Lagos';
  const propertyId = ulid();
  const hash = await hashPassword(DEMO_PASSWORD);

  db.transaction(() => {
    const insPerm = db.prepare('INSERT OR IGNORE INTO permissions (code, module, description) VALUES (?, ?, ?)');
    for (const p of PERMISSIONS) insPerm.run(p.code, p.module, p.description);

    db.prepare(
      `INSERT INTO properties (id, name, short_name, address, city, timezone, currency, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'NGN', ?, ?)`
    ).run(propertyId, 'Harmony Court Serviced Residences', 'Harmony Court',
          '14 Aminu Kano Crescent', 'Abuja', tz, at, at);

    // roles + grants
    const insRole = db.prepare(
      'INSERT INTO roles (id, property_id, key, name, description, is_system, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)'
    );
    const insGrant = db.prepare(
      'INSERT OR IGNORE INTO role_permissions (role_id, permission_code, scope) VALUES (?, ?, ?)'
    );
    const roleIds: Record<string, string> = {};
    for (const role of ROLES) {
      const id = ulid();
      roleIds[role.key] = id;
      insRole.run(id, propertyId, role.key, role.name, role.description, at);
      const codes = role.permissions === '*' ? ALL_CODES : role.permissions;
      const scopes = ROLE_SCOPES[role.key] ?? {};
      for (const code of codes) insGrant.run(id, code, scopes[code] ?? 'all');
    }

    // teams
    const insTeam = db.prepare(
      'INSERT INTO teams (id, property_id, name, default_trade, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const teamIds: Record<string, string> = {};
    for (const [name, trade] of [['Electrical', 'electrical'], ['Mechanical', 'hvac'],
                                 ['Plumbing', 'plumbing'], ['General', 'general']] as const) {
      const id = ulid();
      teamIds[name] = id;
      insTeam.run(id, propertyId, name, trade, at, at);
    }

    // staff
    const insStaff = db.prepare(
      `INSERT INTO staff (id, property_id, staff_no, first_name, last_name, trade, team_id,
                          employment_type, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'permanent', 1, ?, ?)`
    );
    const staffIds: string[] = [];
    STAFF.forEach((s, i) => {
      const id = ulid();
      staffIds.push(id);
      insStaff.run(id, propertyId, `MT-${String(i + 1).padStart(3, '0')}`, s.first, s.last,
                   s.trade, teamIds[s.team]!, at, at);
      if (s.lead) {
        db.prepare('UPDATE teams SET team_lead_staff_id = ? WHERE id = ?').run(id, teamIds[s.team]!);
      }
    });
    // Grace supervises everything
    const graceId = staffIds[STAFF.findIndex((s) => s.first === 'Grace')]!;
    db.prepare('UPDATE teams SET supervisor_staff_id = ? WHERE property_id = ?').run(graceId, propertyId);

    // users — one per role so every permission set can be exercised
    const insUser = db.prepare(
      `INSERT INTO users (id, property_id, staff_id, username, display_name, password_hash, role_id,
                          must_change_password, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    );
    const users: [string, string, string, string | null][] = [
      ['admin',   'admin',      'System Administrator', null],
      ['grace',   'supervisor', 'Grace Etim',           graceId],
      ['musa',    'team_lead',  'Musa Ibrahim',         staffIds[0]!],
      ['ifeoma',  'technician', 'Ifeoma Bassey',        staffIds[2]!],
      ['halima',  'storekeeper','Halima Yusuf',         staffIds[6]!],
      ['finance', 'finance',    'Finance Officer',      null],
      ['front',   'requester',  'Front Office',         null],
      ['hod',     'hod',        'Head of Maintenance',  null],
    ];
    for (const [username, roleKey, displayName, staffId] of users) {
      insUser.run(ulid(), propertyId, staffId, username, displayName, hash, roleIds[roleKey]!, at, at);
    }

    // shift patterns
    const insShift = db.prepare(
      `INSERT INTO shift_patterns (id, property_id, name, start_time, end_time, crosses_midnight,
                                   weekdays, colour, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, '1234567', ?, ?, ?, ?)`
    );
    const shiftIds: string[] = [];
    SHIFTS.forEach((s, i) => {
      const id = ulid();
      shiftIds.push(id);
      insShift.run(id, propertyId, s.name, s.start, s.end, s.midnight, s.colour, i, at, at);
    });

    // a published roster week, with today already marked
    const today = localDate(tz);
    const insRoster = db.prepare(
      `INSERT INTO roster_entries (id, property_id, staff_id, work_date, shift_pattern_id, status,
                                   published_at, marked_at, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insAbsence = db.prepare(
      `INSERT INTO absences (id, property_id, staff_id, work_date, reason, note, marked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (let d = 0; d < 7; d++) {
      const date = new Date(`${today}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() + d);
      const workDate = date.toISOString().slice(0, 10);
      staffIds.forEach((sid, i) => {
        const rota = (i + d) % 4;
        const off = rota === 3;
        const shiftId = off ? null : shiftIds[rota]!;
        // day 0 is today: mark most people present, one absent
        let status: string = off ? 'off' : 'scheduled';
        let markedAt: string | null = null;
        if (d === 0 && !off) {
          const absent = i === 5;
          status = absent ? 'absent' : 'present';
          markedAt = at;
          if (absent) insAbsence.run(ulid(), propertyId, sid, workDate, 'sick', 'Called in at 05:40', at);
        }
        insRoster.run(ulid(), propertyId, sid, workDate, shiftId, status, at, markedAt, null, at, at);
      });
    }

    // locations: site -> blocks -> floors -> units, plus plant rooms
    const insLoc = db.prepare(
      `INSERT INTO locations (id, property_id, parent_id, type, code, name, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const siteId = ulid();
    insLoc.run(siteId, propertyId, null, 'site', 'SITE', 'Harmony Court', 0, at, at);
    const plantGenId = ulid(); const plantPumpId = ulid();
    insLoc.run(plantGenId, propertyId, siteId, 'plant_room', 'PLANT-GEN', 'Generator house', 90, at, at);
    insLoc.run(plantPumpId, propertyId, siteId, 'plant_room', 'PLANT-PUMP', 'Pump room', 91, at, at);
    insLoc.run(ulid(), propertyId, siteId, 'common_area', 'POOL', 'Pool deck', 92, at, at);

    const insApt = db.prepare(
      `INSERT INTO apartments (id, property_id, location_id, unit_no, block, floor, unit_type, status,
                               created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    let order = 1;
    let unitCount = 0;
    for (const block of BLOCKS) {
      const blockId = ulid();
      insLoc.run(blockId, propertyId, siteId, 'block', block.code, block.name, order++, at, at);
      for (const floor of block.floors) {
        const floorId = ulid();
        insLoc.run(floorId, propertyId, blockId, 'floor', `${block.code}-F${floor}`,
                   `${block.name} floor ${Number(floor)}`, order++, at, at);
        for (let u = 1; u <= block.units; u++) {
          const unitNo = `${block.code}-${floor}${String(u).padStart(2, '0')}`;
          const locId = ulid();
          insLoc.run(locId, propertyId, floorId, 'apartment', unitNo, `Unit ${unitNo}`, order++, at, at);
          insApt.run(ulid(), propertyId, locId, unitNo, block.code, floor,
                     u % 3 === 0 ? '2BR' : '1BR', UNIT_STATUS[(u - 1) % UNIT_STATUS.length]!, at, at);
          unitCount++;
        }
      }
    }

    db.prepare(
      `INSERT INTO apartment_imports (id, property_id, source, imported_at, row_count, notes)
       VALUES (?, ?, 'manual', ?, ?, 'Seeded demo unit list')`
    ).run(ulid(), propertyId, at, unitCount);

    const insSetting = db.prepare(
      'INSERT INTO settings (property_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)'
    );
    insSetting.run(propertyId, 'sla_matrix', JSON.stringify([
      { priority: 'P1', label: 'Emergency', respondMinutes: 15, resolveMinutes: 240, escalateToRole: 'supervisor' },
      { priority: 'P2', label: 'Urgent', respondMinutes: 60, resolveMinutes: 1440, escalateToRole: 'supervisor' },
      { priority: 'P3', label: 'Routine', respondMinutes: 240, resolveMinutes: 4320, escalateToRole: 'team_lead' },
      { priority: 'P4', label: 'Scheduled', respondMinutes: 1440, resolveMinutes: 10080, escalateToRole: 'team_lead' },
    ]), at);
    insSetting.run(propertyId, 'trades', JSON.stringify(
      ['electrical', 'plumbing', 'hvac', 'carpentry', 'civil', 'mechanical', 'general', 'vendor']), at);
    insSetting.run(propertyId, 'fuel_variance_tolerance_pct', JSON.stringify(2), at);

    // ---- assets, plant and the diesel installation --------------------------
    const insCat = db.prepare(
      `INSERT INTO asset_categories (id, property_id, name, default_trade, default_criticality, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const catIds: Record<string, string> = {};
    for (const [name, trade, crit] of [
      ['Generator', 'mechanical', 1], ['Split AC', 'hvac', 2], ['Water pump', 'mechanical', 1],
      ['Water heater', 'electrical', 3], ['Lift', 'vendor', 1],
    ] as const) {
      const id = ulid(); catIds[name] = id;
      insCat.run(id, propertyId, name, trade, crit, at, at);
    }

    const insAsset = db.prepare(
      `INSERT INTO assets (id, property_id, asset_tag, name, category_id, location_id, apartment_id,
        manufacturer, model, capacity, status, criticality, meter_type, current_meter, current_meter_at,
        replacement_cost_kobo, warranty_expiry, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const gensets: { id: string; tag: string; hours: number; kva: number }[] = [];
    for (const [tag, name, mfr, model, kva, hours, status] of [
      ['GEN-01', 'Generator 1', 'Perkins', '2506A-E15TAG2', 250, 4281.6, 'in_service'],
      ['GEN-02', 'Generator 2', 'Cummins', 'C150D5', 150, 1904.2, 'standby'],
      ['GEN-03', 'Generator 3', 'Mikano', 'MP100', 100, 3120.8, 'faulty'],
    ] as const) {
      const id = ulid();
      insAsset.run(id, propertyId, tag, `${name} · ${kva} kVA`, catIds['Generator']!, plantGenId, null,
                   mfr, model, `${kva} kVA`, status, 1, 'hours', hours, at,
                   kva * 18_000_00, null, at, at);
      gensets.push({ id, tag, hours, kva });
    }
    const insProfile = db.prepare(
      `INSERT INTO genset_profiles (asset_id, kva_rating, expected_lph_at_50pct, expected_lph_at_75pct,
        expected_lph_at_100pct, service_interval_hours, last_service_hours, next_service_hours,
        deviation_threshold_pct, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 10, ?)`
    );
    for (const g of gensets) {
      const base = g.kva * 0.16;
      insProfile.run(g.id, g.kva, round1(base * 0.75), round1(base), round1(base * 1.35),
                     250, Math.floor(g.hours / 250) * 250, (Math.floor(g.hours / 250) + 1) * 250, at);
    }

    // A split AC in every third unit, so job history has somewhere to land.
    const aptRows = db.prepare('SELECT id, unit_no FROM apartments WHERE property_id = ? ORDER BY unit_no')
      .all(propertyId) as { id: string; unit_no: string }[];
    aptRows.forEach((a, i) => {
      if (i % 3 !== 0) return;
      insAsset.run(ulid(), propertyId, `AC-${a.unit_no}`, `Split AC — ${a.unit_no}`, catIds['Split AC']!,
                   null, a.id, 'LG', 'S4-Q12JA3QD', '1.5 HP', 'in_service', 2, 'none', null, null,
                   450_000_00, null, at, at);
    });
    insAsset.run(ulid(), propertyId, 'PMP-01', 'Booster pump 1', catIds['Water pump']!, plantPumpId, null,
                 'Grundfos', 'CM10-2', '3 HP', 'in_service', 1, 'hours', 8210, at, 1_200_000_00, null, at, at);

    const insTank = db.prepare(
      `INSERT INTO fuel_tanks (id, property_id, name, location_id, kind, capacity_l, min_level_l,
        dip_chart_json, current_level_l, current_level_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const bulkId = ulid(); const dayTankId = ulid();
    insTank.run(bulkId, propertyId, 'Bulk tank', plantGenId, 'bulk', 15000, 2500,
                JSON.stringify([[0, 0], [500, 2000], [1000, 5000], [1500, 7500], [2000, 10000],
                                [2500, 12500], [3000, 15000]]), 9240, at, at, at);
    insTank.run(dayTankId, propertyId, 'Day tank', plantGenId, 'day_tank', 1000, 300, null, 410, at, at, at);

    const nowDate = new Date();

    // ---- supplies and a month of clamp readings ----------------------------
    // The utility incomer, each set's output breaker, and one riser to show why a
    // feeder must never be added to the building total.
    const insSrc = db.prepare(
      `INSERT INTO power_sources (id, property_id, name, kind, genset_asset_id, phases, nominal_volts,
        default_pf, ct_ratio, breaker_amps, is_incomer, sort_order, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    );
    const utilitySrc = ulid();
    insSrc.run(utilitySrc, propertyId, 'Utility incomer', 'utility', null, 3, 415, 0.85, 1, 630, 1, 0, at, at);
    const gensetSrc: Record<string, string> = {};
    gensets.forEach((g, i) => {
      const id = ulid();
      gensetSrc[g.tag] = id;
      insSrc.run(id, propertyId, `${g.tag} output`, 'genset', g.id, 3, 415, 0.8, 1,
                 Math.round((g.kva * 1000) / (Math.sqrt(3) * 415) * 1.25), 1, i + 1, at, at);
    });
    const riserSrc = ulid();
    insSrc.run(riserSrc, propertyId, 'Block B riser', 'feeder', null, 3, 415, 0.9, 1, 250, 0, 9, at, at);

    const clampBy = (db.prepare('SELECT id FROM users WHERE property_id = ? AND username = ?')
      .get(propertyId, 'ifeoma') as { id: string } | undefined)?.id ?? null;
    const insClamp = db.prepare(
      `INSERT INTO clamp_readings (id, property_id, source_id, taken_at, l1_amps, l2_amps, l3_amps,
        neutral_amps, volts, power_factor, ct_ratio, avg_amps, max_amps, imbalance_pct, kva, kw,
        taken_by, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    function clamp(sourceId: string, takenAt: string, l1: number, l2: number, l3: number,
                   volts: number, pf: number, neutral: number | null, note: string | null): void {
      const c = compute({ l1Amps: l1, l2Amps: l2, l3Amps: l3, neutralAmps: neutral,
                          volts, powerFactor: pf, phases: 3 });
      insClamp.run(ulid(), propertyId, sourceId, takenAt, l1, l2, l3, neutral, volts, pf,
                   c.avgAmps, c.maxAmps, c.imbalancePct, c.kva, c.kw, clampBy, note, at);
    }

    // A month of rounds: mid-morning and late-evening on the incomer, so the daily
    // swing between a full house and a sleeping one is visible on the trend.
    for (let d = 30; d >= 0; d--) {
      const day = new Date(nowDate.getTime() - d * 86_400_000);
      const weekend = day.getDay() === 0 || day.getDay() === 6;
      const swing = Math.sin(d / 3.4) * 14;
      const dayBase = (weekend ? 268 : 244) + swing;
      const nightBase = (weekend ? 132 : 118) + swing * 0.5;

      const morning = new Date(day); morning.setHours(10, 20, 0, 0);
      const evening = new Date(day); evening.setHours(22, 40, 0, 0);
      // The board is not balanced: L1 carries most of the single-phase lighting and
      // small power, which is exactly the finding this screen exists to surface.
      if (morning.getTime() < nowDate.getTime()) {
        clamp(utilitySrc, morning.toISOString(),
              round1(dayBase * 1.09), round1(dayBase * 0.97), round1(dayBase * 0.94),
              412, 0.85, round1(dayBase * 0.11), null);
      }
      if (evening.getTime() < nowDate.getTime()) {
        clamp(utilitySrc, evening.toISOString(),
              round1(nightBase * 1.07), round1(nightBase * 0.98), round1(nightBase * 0.95),
              418, 0.85, round1(nightBase * 0.09), null);
      }
    }

    // The live one — recent enough that the screen has a current figure to work from.
    const freshAt = new Date(nowDate.getTime() - 34 * 60_000);
    clamp(utilitySrc, freshAt.toISOString(), 129.4, 116.8, 112.1, 414, 0.85, 12.6,
          'Night round, house quiet.');

    // GEN-01 last time it carried the building, during the outage a fortnight back.
    clamp(gensetSrc['GEN-01']!, daysAgo(14), 268.2, 249.7, 244.0, 408, 0.8, 26.1,
          'On load, block A and B.');
    // And the riser, badly out of balance — a feeder finding that must not be summed
    // into the building total.
    clamp(riserSrc, daysAgo(2), 138.0, 96.4, 88.2, 413, 0.9, 44.8,
          'L1 carrying most of the corridor lighting.');


    // A fortnight that actually reconciles: opening 6,760 L, one 5,000 L delivery on
    // day 9, 180 L a day to the gensets, closing 9,240 L. Dips that disagree with the
    // movement records would open the demo on a variance nobody can explain.
    const insDip = db.prepare(
      `INSERT INTO fuel_dips (id, tank_id, taken_at, litres, taken_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    );
    const bulkLitres = (d: number) => (d >= 9 ? 6760 - (14 - d) * 180 : 10860 - (9 - d) * 180);
    for (let d = 14; d >= 0; d--) {
      insDip.run(ulid(), bulkId, daysAgo(d), bulkLitres(d), null, at);
      insDip.run(ulid(), dayTankId, daysAgo(d), 410 + (d % 4) * 90, null, at);
    }


    // ---- cost centres, budgets, stores, vendors -----------------------------
    const insCc = db.prepare(
      'INSERT INTO cost_centres (id, property_id, code, name, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    const ccIds: Record<string, string> = {};
    for (const [code, name] of [['DIESEL', 'Diesel'], ['SPARES', 'Spares'],
                                ['CONTRACT', 'Contract services'], ['CONSUM', 'Consumables']] as const) {
      const id = ulid(); ccIds[code] = id; insCc.run(id, propertyId, code, name, at);
    }
    const insBudget = db.prepare(
      `INSERT INTO budgets (id, property_id, fiscal_year, period_month, cost_centre_id, amount_kobo,
        created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const [code, kobo] of [['DIESEL', 6_900_000_00], ['SPARES', 1_500_000_00],
                                ['CONTRACT', 2_400_000_00], ['CONSUM', 400_000_00]] as const) {
      insBudget.run(ulid(), propertyId, nowDate.getUTCFullYear(), nowDate.getUTCMonth() + 1,
                    ccIds[code]!, kobo, at, at);
    }
    const insRate = db.prepare(
      `INSERT INTO labour_rates (id, property_id, trade, effective_from, hourly_rate_kobo, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const [trade, kobo] of [['electrical', 5_000_00], ['plumbing', 4_500_00], ['hvac', 5_500_00],
                                 ['mechanical', 5_500_00], ['carpentry', 4_000_00],
                                 ['general', 3_500_00]] as const) {
      insRate.run(ulid(), propertyId, trade, daysAgo(365), kobo, at);
    }

    const insItem = db.prepare(
      `INSERT INTO stock_items (id, property_id, code, name, category, unit, bin_location, min_level,
        reorder_qty, avg_cost_kobo, current_qty, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insMv = db.prepare(
      `INSERT INTO stock_movements (id, property_id, item_id, at, type, qty_delta, balance_after,
        unit_cost_kobo, note) VALUES (?, ?, ?, ?, 'receipt', ?, ?, ?, 'Opening stock')`
    );
    for (const [code, name, cat, unit, qty, min, cost] of [
      ['SP-0142', 'Contactor coil 240 V', 'Electrical', 'pcs', 8, 2, 38_500_00],
      ['SP-0088', 'Control fuse 6 A', 'Electrical', 'pcs', 40, 10, 1_400_00],
      ['SP-0210', 'AC gas R410a', 'HVAC', 'kg', 12, 4, 9_800_00],
      ['SP-0311', 'Mechanical seal 25 mm', 'Plumbing', 'pcs', 2, 2, 22_000_00],
      ['SP-0402', 'Air filter — Perkins', 'Mechanical', 'pcs', 6, 3, 15_500_00],
      ['SP-0510', 'LED tube 18 W', 'Electrical', 'pcs', 55, 20, 3_200_00],
    ] as const) {
      const id = ulid();
      insItem.run(id, propertyId, code, name, cat, unit, `Bin ${code.slice(-2)}`, min, min * 3, cost, qty, at, at);
      insMv.run(ulid(), propertyId, id, daysAgo(30), qty, qty, cost);
    }

    const insVendor = db.prepare(
      `INSERT INTO vendors (id, property_id, name, category, contact_person, phone, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const vendorIds: Record<string, string> = {};
    for (const [name, cat, person, phone] of [
      ['Northgate Fuels', 'Diesel supply', 'Sunday A.', '0803 000 0001'],
      ['Skyrise Lifts', 'Lift maintenance', 'Ngozi E.', '0803 000 0002'],
      ['CoolAir Services', 'HVAC contract', 'Bashir M.', '0803 000 0003'],
    ] as const) {
      const id = ulid(); vendorIds[name] = id;
      insVendor.run(id, propertyId, name, cat, person, phone, at, at);
    }
    const insContract = db.prepare(
      `INSERT INTO contracts (id, property_id, vendor_id, title, type, start_date, end_date, value_kobo,
        renewal_reminder_days, created_at, updated_at) VALUES (?, ?, ?, ?, 'AMC', ?, ?, ?, 60, ?, ?)`
    );
    insContract.run(ulid(), propertyId, vendorIds['Skyrise Lifts']!, 'Lift AMC — both cars',
                    daysAgo(300).slice(0, 10), daysAhead(40).slice(0, 10), 2_400_000_00, at, at);
    insContract.run(ulid(), propertyId, vendorIds['CoolAir Services']!, 'HVAC quarterly service',
                    daysAgo(200).slice(0, 10), daysAhead(160).slice(0, 10), 1_800_000_00, at, at);

    const adminUserId = (db.prepare(
      `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.key = 'admin' LIMIT 1`
    ).get() as { id: string }).id;
    const supervisorUserId = (db.prepare(
      `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.key = 'supervisor' LIMIT 1`
    ).get() as { id: string }).id;

    db.prepare(
      `INSERT INTO fuel_deliveries (id, property_id, ref, tank_id, delivered_at, vendor_id, waybill_no,
        truck_reg, invoiced_l, dip_before_l, dip_after_l, received_l, variance_l, variance_pct, flagged,
        unit_price_kobo, total_kobo, received_by, witnessed_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'NG-4471', 'ABJ-441-XA', 5050, 5860, 10860, 5000, -50, -0.99, 0,
               ?, ?, ?, ?, ?)`
    ).run(ulid(), propertyId, nextRef(db, propertyId, 'FD'), bulkId, daysAgo(9),
          vendorIds['Northgate Fuels']!, 1_250_00, Math.round(1_250_00 * 5050),
          adminUserId, supervisorUserId, at);

    // ---- spend, so budget-vs-actual has something to say ---------------------
    // Budgets with no spend against them make the finance screen a row of zeros and
    // teach nobody anything. Diesel deliberately runs hot: an over-budget line is the
    // case the screen exists to surface, and a demo that never shows it is a brochure.
    const financeUserId = (db.prepare(
      `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.key = 'finance' LIMIT 1`
    ).get() as { id: string } | undefined)?.id ?? adminUserId;
    const hodUserId = (db.prepare(
      `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.key = 'hod' LIMIT 1`
    ).get() as { id: string } | undefined)?.id ?? adminUserId;

    // Budget-vs-actual is reported per calendar month, so spend has to land INSIDE the
    // current one. daysAgo() would put most of it in the previous month whenever the
    // seed runs early in a month, and the screen would show a full budget and no spend.
    const spend = [
      ['Northgate Fuels', 'Diesel — 5,050 L at ₦1,250', 6_312_500_00, 'DIESEL'],
      ['Northgate Fuels', 'Diesel top-up — 900 L', 1_125_000_00, 'DIESEL'],
      ['CoolAir Services', 'R410a gas and drier kits', 285_000_00, 'SPARES'],
      ['Skyrise Lifts', 'Lift AMC — quarterly instalment', 600_000_00, 'CONTRACT'],
      ['CoolAir Services', 'Condenser coil clean, block B', 175_000_00, 'CONTRACT'],
      ['Northgate Fuels', 'Engine oil, 4 × 20 L', 240_000_00, 'CONSUM'],
    ] as const;
    /** Spread evenly between the 1st of this month and today, inclusive. */
    const inThisMonth = (i: number, count: number): string => {
      const today = nowDate.getUTCDate();
      const dayOfMonth = count > 1 ? 1 + Math.round((i * (today - 1)) / (count - 1)) : today;
      return new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), dayOfMonth, 10, 0, 0))
        .toISOString();
    };

    const insPurchase = db.prepare(
      `INSERT INTO purchases (id, property_id, ref, vendor_id, purchased_at, description, amount_kobo,
        cost_centre_id, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    spend.forEach(([vendor, description, kobo, cc], i) => {
      insPurchase.run(ulid(), propertyId, nextRef(db, propertyId, 'PU'),
                      vendorIds[vendor]!, inThisMonth(i, spend.length), description, kobo,
                      ccIds[cc]!, adminUserId, at);
    });

    // One approved, one still waiting — so the approval queue is not empty on day one,
    // and the self-approval rule has something real to demonstrate.
    const insExpense = db.prepare(
      `INSERT INTO expenses (id, property_id, spent_at, cost_centre_id, category, amount_kobo, vendor_id,
        description, status, raised_by, approved_by, approved_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insExpense.run(ulid(), propertyId, inThisMonth(0, 2), ccIds['CONSUM']!, 'consumables', 84_000_00, null,
                   'Cleaning chemicals and rags for the plant room', 'approved',
                   financeUserId, hodUserId, at, at, at);
    insExpense.run(ulid(), propertyId, inThisMonth(1, 2), ccIds['SPARES']!, 'call-out', 150_000_00,
                   vendorIds['CoolAir Services']!,
                   'Emergency call-out — chiller alarm, block C', 'pending',
                   financeUserId, null, null, at, at);

    // ---- safety: a live permit, a closed one, two incidents -------------------
    // An empty permit register teaches nothing about the one rule that matters — a
    // permit cannot close while a lock is still on — so the demo ships one live
    // isolation to try closing, and one properly restored.
    const insPermit = db.prepare(
      `INSERT INTO permits (id, property_id, ref, type, location_id, requested_by, issued_by,
        valid_from, valid_to, precautions_json, status, closed_by, closed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insPoint = db.prepare(
      `INSERT INTO isolation_points (id, permit_id, asset_id, point_description, lock_tag_no,
        isolated_by, isolated_at, restored_by, restored_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const livePermit = ulid();
    insPermit.run(livePermit, propertyId, nextRef(db, propertyId, 'PTW'), 'electrical_isolation',
                  plantGenId, supervisorUserId, adminUserId, daysAgo(0.12), daysAhead(0.3),
                  JSON.stringify(['Circuit proved dead at the point of work', 'Locks and tags fitted',
                                  'Keys held by the issuing officer']),
                  'issued', null, null, at, at);
    insPoint.run(ulid(), livePermit, gensets[2]!.id, 'GEN-03 starter battery isolator', 'LT-021',
                 adminUserId, daysAgo(0.12), null, null);

    const donePermit = ulid();
    insPermit.run(donePermit, propertyId, nextRef(db, propertyId, 'PTW'), 'hot_work',
                  plantGenId, supervisorUserId, adminUserId, daysAgo(4), daysAgo(3.7),
                  JSON.stringify(['Fire extinguisher within reach', 'Combustibles removed or covered',
                                  'Fire watch posted for 30 minutes after work']),
                  'closed', adminUserId, daysAgo(3.7), at, at);
    insPoint.run(ulid(), donePermit, null, 'Smoke detector, generator house zone 4', 'LT-018',
                 adminUserId, daysAgo(4), adminUserId, daysAgo(3.7));

    const insIncident = db.prepare(
      `INSERT INTO incidents (id, property_id, ref, occurred_at, type, location_id, description,
        severity, immediate_action, reported_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insIncident.run(ulid(), propertyId, nextRef(db, propertyId, 'INC'), daysAgo(6), 'near_miss',
                    plantGenId,
                    'Riser cupboard door on the 8th floor was found unlatched with the busbar exposed. '
                    + 'Nobody was working on it at the time.',
                    'minor',
                    'Cupboard secured and a new catch fitted the same afternoon. Job raised against the door.',
                    supervisorUserId, at, at);
    insIncident.run(ulid(), propertyId, nextRef(db, propertyId, 'INC'), daysAgo(19), 'spill',
                    plantGenId,
                    'Roughly 15 litres of diesel spilled at the bulk tank fill point during a delivery '
                    + 'when the hose coupling was released before the pump had fully stopped.',
                    'moderate',
                    'Area bunded with absorbent granules, waste bagged for disposal. Delivery procedure '
                    + 'now requires the pump to be confirmed off before uncoupling.',
                    supervisorUserId, at, at);

    const insIssue = db.prepare(
      `INSERT INTO fuel_issues (id, tank_id, to_asset_id, issued_at, quantity_l, method, issued_by, created_at)
       VALUES (?, ?, ?, ?, 180, 'pump', ?, ?)`
    );
    for (let d = 13; d >= 0; d--) {
      insIssue.run(ulid(), bulkId, gensets[0]!.id, daysAgo(d), supervisorUserId, at);
    }

    // Twelve runs on GEN-01 with burn creeping from 42.1 to 46.2 L/h against an
    // expected 40 — the trend the fuel chart exists to show. Two of the three runs
    // needed to trip the automatic job are already banked, so the next one raises it.
    const burn = [42.1, 42.4, 42.0, 42.8, 43.1, 43.0, 43.9, 44.2, 44.8, 45.1, 45.6, 46.2];
    const insRun = db.prepare(
      `INSERT INTO generator_runs (id, property_id, genset_asset_id, started_at, ended_at, hours_start,
        hours_end, run_hours, reason, fuel_used_l, actual_lph, expected_lph, deviation_pct,
        avg_load_kw, kwh_generated, logged_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 10, ?, ?, ?, 40, ?, 142, 1420, ?, ?)`
    );
    burn.forEach((lph, i) => {
      const startHours = round1(4161.6 + i * 10);
      insRun.run(ulid(), propertyId, gensets[0]!.id, daysAgo(20 - i * 1.6), daysAgo(20 - i * 1.6 - 0.42),
                 startHours, round1(startHours + 10), i % 4 === 3 ? 'weekly_test' : 'utility_outage',
                 round1(lph * 10), lph, round1(((lph - 40) / 40) * 100), supervisorUserId, at);
    });
    db.prepare('UPDATE genset_profiles SET consecutive_deviations = 2 WHERE asset_id = ?')
      .run(gensets[0]!.id);

    // ---- checklists ----------------------------------------------------------
    // A schedule with no sheet produces a job that says "serviced" and proves nothing, so
    // the demo attaches real ones — including critical steps, which block completion until
    // they are recorded.
    const insTpl = db.prepare(
      `INSERT INTO checklist_templates (id, property_id, name, asset_category_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const insTplItem = db.prepare(
      `INSERT INTO checklist_items (id, template_id, seq, task, expected_value, requires_reading,
        requires_photo, is_critical) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    function template(name: string, categoryId: string | null,
                      items: readonly (readonly [string, string | null, boolean, boolean, boolean])[]): string {
      const id = ulid();
      insTpl.run(id, propertyId, name, categoryId, at, at);
      items.forEach(([task, expected, reading, photo, critical], i) => {
        insTplItem.run(ulid(), id, i + 1, task, expected, reading ? 1 : 0, photo ? 1 : 0, critical ? 1 : 0);
      });
      return id;
    }

    const gensetSheet = template('Generator 250-hour service sheet', catIds['Generator'] ?? null, [
      ['Record running hours at start', null, true, false, true],
      ['Coolant level between MIN and MAX', 'between marks', false, false, true],
      ['Engine oil level and condition', 'above MIN, not black', false, true, true],
      ['Change oil filter and air filter', null, false, false, false],
      ['Battery terminals clean, tight and greased', null, false, true, false],
      ['Check for fuel, oil and coolant leaks', 'none', false, false, true],
      ['Fan belt tension and condition', '10 mm deflection', false, false, false],
      ['Exhaust and silencer secure, no blowing joints', null, false, false, false],
      ['Test run on load, record output', 'steady at rated kW', true, false, true],
      ['Plant room left clean and clear of rags', null, false, true, false],
    ] as const);

    const acSheet = template('Split AC quarterly clean sheet', catIds['Split AC'] ?? null, [
      ['Wash filters and refit', null, false, false, false],
      ['Clean evaporator coil and blower wheel', null, false, true, false],
      ['Clear condensate drain and test flow', 'drains freely', false, false, true],
      ['Check gas pressure', '110–130 psi', true, false, false],
      ['Measure supply air temperature', 'below 14 °C', true, false, false],
      ['Isolator and cabling secure', null, false, false, true],
    ] as const);

    // ---- PPM schedules -------------------------------------------------------
    const insPpm = db.prepare(
      `INSERT INTO ppm_schedules (id, property_id, name, scope_type, asset_id, asset_category_id,
        location_id, trigger_type, interval_value, interval_unit, lead_days, default_trade, priority,
        estimated_minutes, checklist_template_id, next_due_at, next_due_meter, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const g of gensets) {
      insPpm.run(ulid(), propertyId, `${g.tag} · 250-hour service`, 'asset', g.id, null, null,
                 'meter', 250, 'hours', 0, 'mechanical', 'P4', 180, gensetSheet, null,
                 (Math.floor(g.hours / 250) + 1) * 250, at, at);
    }
    insPpm.run(ulid(), propertyId, 'Split AC quarterly clean', 'category', null, catIds['Split AC']!, null,
               'calendar', 3, 'month', 7, 'hvac', 'P4', 45, acSheet, daysAhead(5), null, at, at);
    insPpm.run(ulid(), propertyId, 'Fire extinguisher monthly check', 'location', null, null, siteId,
               'calendar', 1, 'month', 3, 'general', 'P4', 60, null, daysAhead(2), null, at, at);

    // ---- a board that looks like a real afternoon ---------------------------
    const staffByName = (first: string) => staffIds[STAFF.findIndex((x) => x.first === first)]!;
    const aptByNo = (no: string) => aptRows.find((a) => a.unit_no.endsWith(no))?.id ?? aptRows[0]!.id;
    const insWo = db.prepare(
      `INSERT INTO work_orders (id, property_id, ref, source, title, description, trade, priority,
        asset_id, location_id, apartment_id, status, hold_reason, assigned_to_staff_id, assigned_at,
        reported_at, respond_by, due_at, responded_at, started_at, completed_at, completed_by,
        resolution_notes, labour_minutes, cost_labour_kobo, cost_parts_kobo, created_at, updated_at)
       VALUES (?, ?, ?, 'reactive', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insEv = db.prepare(
      `INSERT INTO work_order_events (id, wo_id, at, actor_name, event_type, from_status, to_status, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    const plus = (isoStr: string, mins: number) =>
      new Date(new Date(isoStr).getTime() + mins * 60_000).toISOString();

    const board: [string, string, string, string, string, string | null, string | null, number, number][] = [
      // title, description, trade, priority, status, hold, staff, hoursSinceReported, resolveMins
      ['No power to Block B riser — GEN-02 changeover failed',
       'Utility failed at 14:00. GEN-01 took the main load but the Block B riser stayed dead.',
       'electrical', 'P1', 'in_progress', null, 'Musa', 5.5, 240],
      ['Lift stalled between floors 3 and 4',
       'Car 2 stopped with no passengers inside. Skyrise engineer called.',
       'vendor', 'P1', 'on_hold', 'awaiting_vendor', null, 3.2, 240],
      ['Water heater tripping the breaker',
       'Element suspected. Unit is occupied; guest using the second bathroom.',
       'electrical', 'P2', 'on_hold', 'awaiting_parts', 'Tunde', 26, 1440],
      ['AC not cooling, guest in residence',
       'Guest reports no cooling since 14:00. Gas pressure low on test.',
       'hvac', 'P2', 'in_progress', null, 'Ifeoma', 2.1, 1440],
      ['Pool pump mechanical seal weeping',
       'Steady drip at the seal face. Isolated and made safe pending the spare.',
       'plumbing', 'P3', 'completed', null, 'Chinedu', 30, 4320],
      ['Toilet cistern running continuously',
       'Reported by housekeeping during the morning round.',
       'plumbing', 'P2', 'open', null, null, 1.1, 1440],
    ];

    board.forEach((row, i) => {
      const [title, description, trade, priority, status, hold, staffFirst, hoursSince, resolveMins] = row;
      const id = ulid();
      const ref = nextRef(db, propertyId, 'WO');
      const reportedAt = hoursAgo(hoursSince);
      const respondBy = plus(reportedAt, priority === 'P1' ? 15 : priority === 'P2' ? 60 : 240);
      const dueAt = plus(reportedAt, resolveMins);
      const settled = status === 'completed';
      const staffId = staffFirst ? staffByName(staffFirst) : null;
      const assigned = staffId ? plus(reportedAt, 4) : null;
      const responded = staffId ? plus(reportedAt, 7) : null;
      const started = staffId ? plus(reportedAt, 12) : null;

      insWo.run(id, propertyId, ref, title, description, trade, priority,
                null, siteId, i === 2 ? aptByNo('03') : i === 3 ? aptByNo('04') : null,
                status, hold, staffId, assigned, reportedAt, respondBy, dueAt,
                responded, started, settled ? plus(reportedAt, 180) : null,
                null, settled ? 'Seal replaced and pump run-tested.' : null,
                settled ? 165 : 0, settled ? 15_125_00 : 0, 0, at, at);

      insEv.run(ulid(), id, reportedAt, 'Front office', 'created', null, 'open', title);
      if (staffId) {
        insEv.run(ulid(), id, assigned!, 'Grace Etim', 'assigned', 'open', 'assigned', null);
        insEv.run(ulid(), id, responded!, `${staffFirst} `, 'accepted', 'assigned', 'accepted', null);
        insEv.run(ulid(), id, started!, `${staffFirst} `, 'started', 'accepted', 'in_progress', null);
      }
      if (hold) {
        insEv.run(ulid(), id, plus(reportedAt, 40), 'Grace Etim', 'hold', 'in_progress', 'on_hold', hold);
      }
      if (settled) {
        insEv.run(ulid(), id, plus(reportedAt, 180), `${staffFirst} `, 'completed', 'in_progress',
                  'completed', 'Seal replaced and pump run-tested.');
      }
    });

    db.prepare(
      `INSERT INTO audit_log (id, property_id, at, action, entity_type, entity_id, after_json)
       VALUES (?, ?, ?, 'seed.demo', 'property', ?, ?)`
    ).run(ulid(), propertyId, at, propertyId, JSON.stringify({ staff: STAFF.length, units: unitCount }));

    console.log(`property     Harmony Court Serviced Residences`);
    console.log(`assets       ${(db.prepare('SELECT COUNT(*) n FROM assets WHERE property_id = ?')
      .get(propertyId) as { n: number }).n} · 3 gensets, 2 tanks, 14 days of dips`);
    console.log(`stores       6 spare-part lines with opening stock`);
    console.log(`finance      4 budgets with diesel already over, 6 purchases, 1 expense awaiting approval`);
    console.log(`safety       1 live permit with a lock still on, 1 closed, 2 incidents`);
    console.log(`ppm          ${(db.prepare('SELECT COUNT(*) n FROM ppm_schedules WHERE property_id = ?')
      .get(propertyId) as { n: number }).n} schedules (meter and calendar)`);
    console.log(`roles        ${ROLES.length}  ·  permissions ${PERMISSIONS.length}`);
    console.log(`users        ${users.length} (password: ${DEMO_PASSWORD})`);
    console.log(`staff        ${STAFF.length} across ${Object.keys(teamIds).length} teams`);
    console.log(`shifts       ${SHIFTS.length} patterns, 7 days rostered and today marked`);
    console.log(`apartments   ${unitCount} across ${BLOCKS.length} blocks`);
    console.log(`jobs         6 open reactive jobs, one breached P1, one awaiting verification`);
    console.log(`fuel         a fortnight that reconciles to zero, 12 genset runs with a rising burn`);
  })();
}

const cfg = loadConfig();
const db = openDb(cfg.dbPath);
migrate(db);
await seed(db, process.argv.includes('--force'));
db.close();

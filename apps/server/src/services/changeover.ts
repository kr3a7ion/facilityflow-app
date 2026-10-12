import type { Db } from '../db/connection.js';
import { ulid } from '../lib/ids.js';
import { nowIso } from '../lib/time.js';
import { HttpError } from '../lib/errors.js';
import { audit } from '../audit.js';
import { alert } from './alertRouting.js';
import * as bus from './bus.js';
import { propertyTimezone } from './roster.js';

/**
 * Mains and generators, as they change.
 *
 * Generator runs and outages were only ever written up afterwards, with a start and an
 * end. That is right for the diesel book and useless for the people who need to know
 * the building has just gone onto a set: by the time the run is logged the event is
 * over. This records the changeover as it happens — mains off, set started, mains back,
 * set stopped, set tripped — keeps the live state the status strip reads, and tells the
 * people routed to each event.
 *
 * It also keeps the two facts about a generator apart. `assets.status` is availability:
 * in service, on standby, faulty. `genset_profiles.running_since` is whether it is
 * running right now. A set can be in service and stopped, which is most of the time.
 */

export type SwitchEvent = 'mains_off' | 'mains_on' | 'genset_start' | 'genset_stop' | 'genset_fault';
export interface Ctx { propertyId: string; userId: string | null; displayName: string; ip?: string }

export interface SwitchInput {
  event: SwitchEvent;
  gensetAssetId?: string;
  /** When it happened, if it is being entered a few minutes late. Not in the future. */
  at?: string;
  note?: string;
}

interface GensetRow {
  asset_id: string; asset_tag: string; name: string; status: string; running_since: string | null;
}

function gensets(db: Db, propertyId: string): GensetRow[] {
  return db.prepare(
    `SELECT a.id AS asset_id, a.asset_tag, a.name, a.status, g.running_since
       FROM assets a JOIN genset_profiles g ON g.asset_id = a.id
      WHERE a.property_id = ? AND a.is_active = 1 ORDER BY a.asset_tag`
  ).all(propertyId) as GensetRow[];
}

function openOutage(db: Db, propertyId: string): { id: string; started_at: string } | undefined {
  return db.prepare(
    `SELECT id, started_at FROM power_outages WHERE property_id = ? AND ended_at IS NULL
      ORDER BY started_at DESC LIMIT 1`
  ).get(propertyId) as { id: string; started_at: string } | undefined;
}

function minutesBetween(a: string, b: string): number {
  return Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000));
}

export function span(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** "14:05" on the property's own clock, not the server's UTC. */
function clockIn(tz: string) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
  return (iso: string) => f.format(new Date(iso));
}

export function now(db: Db, propertyId: string) {
  const outage = openOutage(db, propertyId);
  return {
    mains: outage ? 'off' as const : 'on' as const,
    mainsOffSince: outage?.started_at ?? null,
    gensets: gensets(db, propertyId).map((g) => ({
      assetId: g.asset_id, tag: g.asset_tag, name: g.name, status: g.status,
      runningSince: g.running_since,
    })),
  };
}

export function history(db: Db, propertyId: string, limit = 20) {
  return db.prepare(
    `SELECT l.id, l.at, l.event, l.ran_minutes, l.note, a.asset_tag, u.display_name AS logged_by_name
       FROM power_switch_log l
       LEFT JOIN assets a ON a.id = l.genset_asset_id
       LEFT JOIN users u ON u.id = l.logged_by
      WHERE l.property_id = ? ORDER BY l.at DESC, l.created_at DESC LIMIT ?`
  ).all(propertyId, Math.min(Math.max(limit, 1), 100));
}

export function record(db: Db, ctx: Ctx, input: SwitchInput) {
  const recorded = nowIso();
  const at = input.at ?? recorded;
  if (Number.isNaN(new Date(at).getTime())) throw new HttpError(400, 'invalid_time', 'That time is not a date.');
  if (new Date(at).getTime() > Date.now() + 2 * 60_000) {
    throw new HttpError(400, 'future', 'A changeover cannot be recorded in the future.');
  }
  const note = input.note?.trim() || null;
  const clock = clockIn(propertyTimezone(db, ctx.propertyId));
  const outage = openOutage(db, ctx.propertyId);
  const sets = gensets(db, ctx.propertyId);
  const set = input.gensetAssetId ? sets.find((g) => g.asset_id === input.gensetAssetId) : undefined;

  if (input.event.startsWith('genset_') && !set) {
    throw new HttpError(400, 'unknown_genset', 'Pick which generator.');
  }

  let outageId: string | null = null;
  let ranMinutes: number | null = null;
  let title = '';
  let body = '';
  const running = () => sets.filter((g) => g.running_since && g.asset_id !== set?.asset_id);

  switch (input.event) {
    case 'mains_off': {
      if (outage) throw new HttpError(409, 'already_off', `Mains has been recorded off since ${clock(outage.started_at)}.`);
      outageId = ulid();
      const live = sets.filter((g) => g.running_since);
      title = `Mains failed at ${clock(at)}`;
      body = live.length
        ? `${live.map((g) => g.asset_tag).join(' and ')} already running.`
        : 'No generator is running yet.';
      break;
    }
    case 'mains_on': {
      if (!outage) throw new HttpError(409, 'already_on', 'Mains is already recorded on.');
      outageId = outage.id;
      const live = sets.filter((g) => g.running_since);
      title = 'Mains restored';
      body = `Off for ${span(minutesBetween(outage.started_at, at))}.` +
        (live.length ? ` ${live.map((g) => g.asset_tag).join(' and ')} still running — stop ${live.length === 1 ? 'it' : 'them'} once the load is back on mains.` : '');
      break;
    }
    case 'genset_start': {
      if (set!.running_since) throw new HttpError(409, 'already_running', `${set!.asset_tag} has been running since ${clock(set!.running_since)}.`);
      if (!['in_service', 'standby'].includes(set!.status)) {
        throw new HttpError(409, 'not_available',
          `${set!.asset_tag} is marked ${set!.status.replace('_', ' ')}. Put it back in service on its asset record first.`);
      }
      title = `${set!.asset_tag} started`;
      body = outage ? `Mains off since ${clock(outage.started_at)}.` : 'Mains is on — a test or a load run.';
      break;
    }
    case 'genset_stop': {
      if (!set!.running_since) throw new HttpError(409, 'not_running', `${set!.asset_tag} is not recorded as running.`);
      ranMinutes = minutesBetween(set!.running_since, at);
      title = `${set!.asset_tag} stopped after ${span(ranMinutes)}`;
      body = 'Log the run under Power so the diesel adds up.' +
        (outage && running().length === 0 ? ' Mains is still off and no other set is running.' : '');
      break;
    }
    case 'genset_fault': {
      if (set!.running_since) ranMinutes = minutesBetween(set!.running_since, at);
      title = `${set!.asset_tag} reported faulty`;
      body = (note ? `${note} ` : '') + 'Taken out of service.' +
        (outage && running().length === 0 ? ' Mains is off and no other set is running.' : '');
      break;
    }
  }

  const id = ulid();
  db.transaction(() => {
    if (input.event === 'mains_off') {
      db.prepare(
        `INSERT INTO power_outages (id, property_id, started_at, ended_at, source, notes, logged_by, created_at)
         VALUES (?, ?, ?, NULL, 'utility', ?, ?, ?)`
      ).run(outageId, ctx.propertyId, at, note, ctx.userId, recorded);
    } else if (input.event === 'mains_on') {
      db.prepare('UPDATE power_outages SET ended_at = ? WHERE id = ?').run(at, outageId);
    } else if (input.event === 'genset_start') {
      db.prepare('UPDATE genset_profiles SET running_since = ?, updated_at = ? WHERE asset_id = ?')
        .run(at, recorded, set!.asset_id);
    } else if (input.event === 'genset_stop') {
      db.prepare('UPDATE genset_profiles SET running_since = NULL, updated_at = ? WHERE asset_id = ?')
        .run(recorded, set!.asset_id);
    } else if (input.event === 'genset_fault') {
      db.prepare('UPDATE genset_profiles SET running_since = NULL, updated_at = ? WHERE asset_id = ?')
        .run(recorded, set!.asset_id);
      db.prepare(`UPDATE assets SET status = 'faulty', updated_at = ? WHERE id = ?`).run(recorded, set!.asset_id);
    }
    db.prepare(
      `INSERT INTO power_switch_log (id, property_id, at, event, genset_asset_id, outage_id, ran_minutes,
                                     note, logged_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, ctx.propertyId, at, input.event, set?.asset_id ?? null, outageId, ranMinutes, note,
          ctx.userId, recorded);
    audit(db, {
      propertyId: ctx.propertyId, userId: ctx.userId, actorName: ctx.displayName,
      action: `power.${input.event}`, entityType: set ? 'asset' : 'power_outage',
      entityId: set?.asset_id ?? outageId ?? id,
      after: { at, ranMinutes, note }, ip: ctx.ip,
    });
    alert(db, ctx.propertyId, `power.${input.event}`, {
      title, body: note && input.event !== 'genset_fault' ? `${body} “${note}”` : body,
      entityType: set ? 'asset' : undefined, entityId: set?.asset_id, at,
    }, { exceptUserId: ctx.userId });
  })();

  // The status strip on every screen reads this state.
  bus.publishAll('plant');
  return { id, ...now(db, ctx.propertyId), ranMinutes };
}

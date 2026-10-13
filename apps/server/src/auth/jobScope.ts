import type { FastifyRequest } from 'fastify';
import type { Db } from '../db/connection.js';
import { HttpError } from '../lib/errors.js';
import { scopeOf } from './guard.js';
import type { Principal } from './sessions.js';

/**
 * Which jobs a grant at a given scope reaches.
 *
 * The scopes were in the role table from the start — a technician holds wo.accept, wo.update
 * and wo.complete at 'own', a team lead holds wo.assign and wo.verify at 'team' — but only
 * the board applied them. Every route that took a job id took any job id: a technician
 * could accept, start and complete somebody else's job, and a team lead could dispatch work
 * to another team. One clause now answers "is this job within reach" for the board and for
 * every route that touches a single job, so the two cannot disagree.
 *
 *  - **own**: jobs assigned to this person by name. Not a team-pool job: the department
 *    decided a job has to be put in somebody's name before a technician can take it.
 *  - **team**: jobs assigned to this person, to their team, or to anybody on their team —
 *    plus jobs nobody has been given yet, because dispatching those to their own people is
 *    what a team lead's wo.assign is for.
 *
 * An account with no staff record has no assignments and no team; it reaches only the jobs
 * it raised, which is what the board already showed it — wrong in the harmless direction,
 * and visible on the Users tab as the missing link it is.
 */
export function jobScopeClause(
  me: Principal, scope: 'own' | 'team' | 'all', alias = 'w'
): { sql: string; args: unknown[] } {
  if (scope === 'all') return { sql: '1 = 1', args: [] };
  if (!me.staffId) return { sql: `${alias}.created_by = ?`, args: [me.userId] };
  if (scope === 'own') return { sql: `${alias}.assigned_to_staff_id = ?`, args: [me.staffId] };
  const myTeam = '(SELECT team_id FROM staff WHERE id = ?)';
  return {
    sql: `(${alias}.assigned_to_staff_id = ?
           OR (${alias}.assigned_to_staff_id IS NULL AND ${alias}.assigned_team_id IS NULL)
           OR ${alias}.assigned_team_id = ${myTeam}
           OR ${alias}.assigned_to_staff_id IN (SELECT id FROM staff WHERE team_id = ${myTeam}))`,
    args: [me.staffId, me.staffId, me.staffId],
  };
}

/**
 * Refuse, with a reason, a job outside the reach of any of these grants.
 *
 * wo.read is always among them: a job somebody cannot see is not one they can act on,
 * whatever the action's own grant says. A job that does not exist is left for the service
 * to refuse with its own 404, so a mistyped id reads the same as it always has.
 *
 * Requesters hold wo.read at 'own' with no staff record. Whether they may open a job raised
 * from their own request is not decided yet, so opening a job is left exactly as it was for
 * them; acting on one still needs a grant they do not have.
 */
export function assertJobInScope(db: Db, req: FastifyRequest, woId: string, codes: string[] = []): void {
  const me = req.principal!;
  const exists = db.prepare('SELECT 1 FROM work_orders WHERE id = ? AND property_id = ?')
    .get(woId, me.propertyId);
  if (!exists) return;

  for (const code of new Set(['wo.read', ...codes])) {
    const scope = scopeOf(req, code);
    if (scope === 'all') continue;
    if (code === 'wo.read' && scope === 'own' && !me.staffId && codes.length === 0) continue;
    const { sql, args } = jobScopeClause(me, scope);
    const within = db.prepare(`SELECT 1 FROM work_orders w WHERE w.id = ? AND ${sql}`).get(woId, ...args);
    if (!within) {
      throw new HttpError(403, 'out_of_scope', scope === 'own'
        ? 'This job is not assigned to you. Ask a supervisor to assign it to you first.'
        : 'This job belongs to another team. A supervisor can move it.');
    }
  }
}

/** The team a staff record is on, or null. */
export function teamOfStaff(db: Db, staffId: string | null): string | null {
  if (!staffId) return null;
  return (db.prepare('SELECT team_id FROM staff WHERE id = ?').get(staffId) as
    { team_id: string | null } | undefined)?.team_id ?? null;
}

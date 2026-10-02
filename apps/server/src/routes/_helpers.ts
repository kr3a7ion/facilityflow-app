import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { currentMonth, monthRange, type MonthRange } from '../lib/time.js';
import { isHttpError } from '../lib/errors.js';

export interface Ctx {
  propertyId: string; userId: string | null; displayName: string; ip?: string;
  /** On the property network, or through the tunnel. Rides along so a service that
   *  writes an audit row does not have to be handed the request to know. */
  origin?: 'lan' | 'remote';
}

export function ctxOf(req: FastifyRequest): Ctx {
  const me = req.principal!;
  return {
    propertyId: me.propertyId, userId: me.userId, displayName: me.displayName,
    ip: req.ip, origin: req.origin,
  };
}

/**
 * Services throw HttpError with a message written for the person reading it.
 * Everything else is a bug and becomes a 500 with the detail in the log, not the body.
 */
export async function send<T>(reply: FastifyReply, fn: () => T, status = 200): Promise<unknown> {
  try {
    return await reply.code(status).send(fn() as object);
  } catch (err) {
    if (isHttpError(err)) {
      return reply.code(err.status).send({ error: err.code, message: err.message });
    }
    reply.log.error({ err }, 'unhandled service error');
    return reply.code(500).send({
      error: 'server_error',
      message: 'Something went wrong on the server. The error has been logged.',
    });
  }
}

/**
 * Resolve the `?month=YYYY-MM` a screen asked for, in the property's own timezone.
 *
 * Every list that grows without limit takes this. Defaulting to the current month is
 * what keeps a property three years in from asking the host to read its entire history
 * to draw one table — and it is also, nearly always, the month somebody wanted.
 */
export function monthOf(app: FastifyInstance, req: FastifyRequest): MonthRange {
  const me = req.principal!;
  const row = app.db.prepare('SELECT timezone FROM properties WHERE id = ?')
    .get(me.propertyId) as { timezone: string } | undefined;
  const tz = row?.timezone ?? 'Africa/Lagos';
  const asked = (req.query as { month?: string } | undefined)?.month;
  // A malformed month is the caller's mistake, not a reason to fall over: current month
  // is always a defensible answer.
  if (asked) {
    try { return monthRange(asked, tz); } catch { /* fall through */ }
  }
  return monthRange(currentMonth(tz), tz);
}

/**
 * May this caller see money?
 *
 * One code, checked in one way, everywhere a naira figure could leave the server. The
 * rule the department asked for is "staff who have no business with costs never see
 * them", and the only way to keep that true is for the figure to be absent from the
 * response rather than hidden by the screen — a hidden column is still a column somebody
 * can read in the network tab.
 */
export function seesMoney(req: FastifyRequest): boolean {
  return req.principal?.permissions.has('cost.read') ?? false;
}

/**
 * Drop the named keys from every row unless the caller may see money.
 *
 * Deleting rather than zeroing: a zero is a number somebody will believe. An absent
 * field makes the client show a dash, which is the truth — "not yours to see".
 */
export function withoutMoney<T extends Record<string, unknown>>(
  req: FastifyRequest, rows: T[], keys: string[]
): Partial<T>[] {
  if (seesMoney(req)) return rows;
  return rows.map((row) => {
    const out: Record<string, unknown> = { ...row };
    for (const k of keys) delete out[k];
    return out as Partial<T>;
  });
}

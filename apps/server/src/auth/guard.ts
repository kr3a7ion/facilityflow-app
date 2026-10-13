import type { FastifyReply, FastifyRequest } from 'fastify';

/** No session — and when the remote timeout ended it, say so, for the sign-in screen. */
export function notSignedIn(req: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply.code(401).send(req.timedOut
    ? { error: 'timed_out', message: 'You were signed out after a while without use from outside the property. Sign in again.' }
    : { error: 'not_signed_in', message: 'Sign in to continue.' });
}

/**
 * One middleware, one permission code. No role names in route handlers, anywhere.
 */
export function requirePermission(code: string) {
  return async function guard(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const me = req.principal;
    if (!me) {
      await notSignedIn(req, reply);
      return;
    }
    if (!me.permissions.has(code)) {
      await reply.code(403).send({
        error: 'forbidden',
        message: `Your role does not allow this (${code}).`,
        required: code,
      });
      return;
    }
  };
}

export function requireSignedIn() {
  return async function guard(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!req.principal) await notSignedIn(req, reply);
  };
}

/** Scope for a granted permission: 'own' | 'team' | 'all'. Callers narrow their query with it. */
export function scopeOf(req: FastifyRequest, code: string): 'own' | 'team' | 'all' {
  const s = req.principal?.scopes[code];
  return s === 'own' || s === 'team' ? s : 'all';
}

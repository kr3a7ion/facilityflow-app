import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * One middleware, one permission code. No role names in route handlers, anywhere.
 */
export function requirePermission(code: string) {
  return async function guard(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const me = req.principal;
    if (!me) {
      await reply.code(401).send({ error: 'not_signed_in', message: 'Sign in to continue.' });
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
    if (!req.principal) {
      await reply.code(401).send({ error: 'not_signed_in', message: 'Sign in to continue.' });
    }
  };
}

/** Scope for a granted permission: 'own' | 'team' | 'all'. Callers narrow their query with it. */
export function scopeOf(req: FastifyRequest, code: string): 'own' | 'team' | 'all' {
  const s = req.principal?.scopes[code];
  return s === 'own' || s === 'team' ? s : 'all';
}

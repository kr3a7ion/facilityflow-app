import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * One middleware, one permission code. No role names in route handlers, anywhere.
 */
function permissionGuard(code: string) {
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

function signedInGuard() {
  return async function guard(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!req.principal) {
      await reply.code(401).send({ error: 'not_signed_in', message: 'Sign in to continue.' });
    }
  };
}

/*
 * The guards routes use, each labelled with what it requires, so the API reference is read
 * off the routes themselves (docs/API.md) instead of kept by hand beside them.
 */
export const requirePermission = (code: string) => Object.assign(permissionGuard(code), { requires: code });
export const requireSignedIn = () => Object.assign(signedInGuard(), { requires: 'signed in' });

/** Scope for a granted permission: 'own' | 'team' | 'all'. Callers narrow their query with it. */
export function scopeOf(req: FastifyRequest, code: string): 'own' | 'team' | 'all' {
  const s = req.principal?.scopes[code];
  return s === 'own' || s === 'team' ? s : 'all';
}

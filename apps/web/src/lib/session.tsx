import { createContext, useContext, type ReactNode } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { api, qk, ApiError } from './api';

export interface Me {
  user: {
    id: string; username: string; displayName: string; staffId: string | null;
    role: string; roleName: string; roleDescription: string; mustChangePassword: boolean;
  };
  property: { name: string; short_name: string; timezone: string; currency: string } | null;
  permissions: string[];
  scopes: Record<string, string>;
}

interface Ctx {
  me: Me | null;
  can: (code: string) => boolean;
  canAny: (...codes: string[]) => boolean;
  query: UseQueryResult<Me, Error>;
}

const SessionContext = createContext<Ctx | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const query = useQuery<Me, Error>({
    queryKey: qk.me,
    queryFn: () => api.get<Me>('/api/me'),
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 2,
    staleTime: 60_000,
  });
  const me = query.data ?? null;
  const set = new Set(me?.permissions ?? []);
  const value: Ctx = {
    me,
    can: (code) => set.has(code),
    canAny: (...codes) => codes.some((c) => set.has(c)),
    query,
  };
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Ctx {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside SessionProvider');
  return ctx;
}

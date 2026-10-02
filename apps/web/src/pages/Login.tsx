import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, qk } from '../lib/api';
import { Icon } from '../components/Icon';
import { LogoTile } from '../components/Logo';

export function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const qc = useQueryClient();
  const navigate = useNavigate();

  const { data: setup } = useQuery<{ needsSetup: boolean }>({
    queryKey: ['setup-status'],
    queryFn: () => api.get('/api/setup/status'),
  });

  /**
   * Sign in, and start from nothing.
   *
   * invalidateQueries could not fix what sign-out had left behind: the session query had
   * been removed from the cache entirely, so there was nothing to invalidate, and the
   * mounted observer went on rendering the previous person. Landing with a full page load
   * means the app boots knowing exactly one identity — this one.
   */
  const signIn = useMutation({
    mutationFn: () => api.post<{ mustChangePassword: boolean }>('/api/auth/login', { username, password }),
    onSuccess: async () => {
      await qc.cancelQueries();
      qc.clear();
      window.location.assign('/');
    },
  });

  if (setup?.needsSetup) {
    return (
      <div className="center">
        <div className="panel-form">
          <div className="brand" style={{ padding: 0, border: 0, marginBottom: 18 }}>
            <LogoTile size={34} />
            <span><b>FacilityFlow</b><small>Maintenance &amp; FM</small></span>
          </div>
          <div className="note">
            <b>This installation is not configured yet.</b>
            <div style={{ marginTop: 6 }}>
              Run the first-run setup to create the property and its first administrator.
            </div>
          </div>
          <button className="btn pri" style={{ width: '100%', marginTop: 16 }}
                  onClick={() => navigate('/setup')}>
            Set up FacilityFlow
          </button>
        </div>
      </div>
    );
  }

  const err = signIn.error as ApiError | null;

  return (
    <div className="center">
      <form className="panel-form" onSubmit={(e) => { e.preventDefault(); signIn.mutate(); }}>
        <div className="brand" style={{ padding: 0, border: 0, marginBottom: 20 }}>
          <LogoTile size={34} />
          <span><b>FacilityFlow</b><small>Maintenance &amp; FM</small></span>
        </div>

        <div className="fld">
          <label htmlFor="u">Username</label>
          <input id="u" className="inp" autoComplete="username" autoCapitalize="none" autoFocus
                 value={username} onChange={(e) => setUsername(e.target.value)} />
        </div>
        <div className="fld">
          <label htmlFor="p">Password</label>
          <input id="p" className="inp" type="password" autoComplete="current-password"
                 value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>

        {err && (
          <div className={`note ${err.status === 423 ? 'warn' : 'crit'}`} style={{ marginBottom: 14 }} role="alert">
            {err.message}
          </div>
        )}

        <button className="btn pri" style={{ width: '100%' }} type="submit"
                disabled={signIn.isPending || !username || !password}>
          {signIn.isPending ? 'Signing in…' : 'Sign in'}
        </button>

        <p style={{ marginTop: 16, marginBottom: 0, fontSize: '0.75rem', color: 'var(--text-3)', textAlign: 'center' }}>
          Named accounts only. Shared logins make the audit trail worthless.
        </p>
      </form>
    </div>
  );
}

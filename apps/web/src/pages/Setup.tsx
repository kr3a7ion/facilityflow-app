import { useState, type ChangeEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { LogoTile } from '../components/Logo';

/** First run: the difference between software you can hand someone and software you install for them. */
export function Setup() {
  const [f, setF] = useState({
    name: '', shortName: '', city: '', displayName: '', username: '', password: '',
  });
  const qc = useQueryClient();
  const navigate = useNavigate();
  const set = (k: keyof typeof f) => (e: ChangeEvent<HTMLInputElement>) =>
    setF((s) => ({ ...s, [k]: e.target.value }));

  const run = useMutation({
    mutationFn: () => api.post('/api/setup', {
      property: { name: f.name, shortName: f.shortName || f.name.slice(0, 30), city: f.city || undefined,
                  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Africa/Lagos' },
      admin: { displayName: f.displayName, username: f.username, password: f.password },
    }),
    onSuccess: async () => { await qc.invalidateQueries(); navigate('/login', { replace: true }); },
  });

  const err = run.error as ApiError | null;
  const ready = f.name.length > 1 && f.displayName.length > 1
    && f.username.length > 2 && f.password.length >= 10;

  return (
    <div className="center">
      <form className="panel-form" style={{ maxWidth: 460 }}
            onSubmit={(e) => { e.preventDefault(); run.mutate(); }}>
        <div className="brand p-0 mb-4 no-border">
          <LogoTile size={34} />
          <span><b>FacilityFlow</b><small>First run</small></span>
        </div>
        <p className="c-2 t-ui mt-0 mb-7">
          Name the property and create the first administrator. Everything else — shifts, trades,
          cost centres, SLA targets — is reference data you edit afterwards.
        </p>

        <div className="fld"><label htmlFor="pn">Property name</label>
          <input id="pn" className="inp" value={f.name} onChange={set('name')} autoFocus /></div>
        <div className="grid g2 gap-5">
          <div className="fld"><label htmlFor="sn">Short name</label>
            <input id="sn" className="inp" placeholder="shown in the header"
                   value={f.shortName} onChange={set('shortName')} /></div>
          <div className="fld"><label htmlFor="ct">City</label>
            <input id="ct" className="inp" value={f.city} onChange={set('city')} /></div>
        </div>

        <hr className="rule mt-3 mb-6" />

        <div className="fld"><label htmlFor="dn">Administrator name</label>
          <input id="dn" className="inp" value={f.displayName} onChange={set('displayName')} /></div>
        <div className="grid g2 gap-5">
          <div className="fld"><label htmlFor="un">Username</label>
            <input id="un" className="inp" autoCapitalize="none" value={f.username} onChange={set('username')} /></div>
          <div className="fld"><label htmlFor="pw">Password</label>
            <input id="pw" className="inp" type="password" value={f.password} onChange={set('password')} /></div>
        </div>
        <p className="t-sm c-3" style={{ marginTop: -4 }}>At least 10 characters.</p>

        {err && <div className="note crit mt-5 mb-5" role="alert">{err.message}</div>}

        <button className="btn pri full mt-4" type="submit"
                disabled={!ready || run.isPending}>
          {run.isPending ? 'Configuring…' : 'Create property and administrator'}
        </button>
      </form>
    </div>
  );
}

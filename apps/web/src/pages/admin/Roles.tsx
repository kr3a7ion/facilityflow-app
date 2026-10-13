/** Admin → Roles and what each may do. A settings change, never a release. */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { Card, Chip, Loading, Btn, Modal, Field, DeleteBtn } from '../../components/Bits';
import type { Role } from './Users';

export function Roles() {
  const qc = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [details, setDetails] = useState<Role | 'new' | null>(null);
  const refreshRoles = () => qc.invalidateQueries({ queryKey: ['admin-roles'] });

  const roles = useQuery<{ roles: (Role & {
                                    permission_count: number; user_count: number })[] }>({
    queryKey: ['admin-roles'], queryFn: () => api.get('/api/admin/roles'),
  });
  const catalogue = useQuery<{ permissions: { code: string; module: string; description: string }[] }>({
    queryKey: ['admin-permissions'], queryFn: () => api.get('/api/admin/permissions'),
  });
  const granted = useQuery<{ role: { key: string; name: string };
                            granted: { permission_code: string; scope: string }[] }>({
    queryKey: ['role-perms', open], queryFn: () => api.get(`/api/admin/roles/${open}/permissions`),
    enabled: !!open,
  });

  const [draft, setDraft] = useState<Set<string> | null>(null);
  const codes = draft ?? new Set((granted.data?.granted ?? []).map((g) => g.permission_code));
  // A permission held over "own" or "team" is a different permission from the same code
  // held over the whole property, and until now the screen showed one checkbox for both.
  const scopes = new Map((granted.data?.granted ?? []).map((g) => [g.permission_code, g.scope]));

  const save = useMutation({
    mutationFn: () => api.post(`/api/admin/roles/${open}/permissions`, { codes: [...codes] }),
    onSuccess: async () => {
      setMsg('Role updated. It takes effect the next time those people load a screen.');
      setDraft(null); setOpen(null);
      await qc.invalidateQueries({ queryKey: ['admin-roles'] });
    },
    onError: (e) => setMsg((e as ApiError).message),
  });

  const byModule = new Map<string, { code: string; description: string }[]>();
  for (const p of catalogue.data?.permissions ?? []) {
    const list = byModule.get(p.module) ?? [];
    list.push(p);
    byModule.set(p.module, list);
  }

  return (
    <>
      {msg && <div className="note mb-6" role="status">{msg}</div>}
      <Card title="Roles" flush
            right={<>
              <Chip>{roles.data?.roles.length ?? 0}</Chip>
              <Btn size="sm" tone="pri" icon="plus" onClick={() => setDetails('new')}>New role</Btn>
            </>}>
        {roles.isLoading ? <Loading rows={4} /> : (
          <div className="tw">
            <table className="wide">
              <thead><tr><th>Role</th><th>Sees</th><th className="num">People</th>
                         <th className="num">Permissions</th><th /></tr></thead>
              <tbody>
                {(roles.data?.roles ?? []).map((r) => (
                  <tr key={r.id}>
                    <td>
                      <span className="ttl">{r.name}{r.is_system === 0 && <> <Chip>Custom</Chip></>}</span>
                      <span className="sub">{r.description}</span>
                    </td>
                    <td>{r.key === 'admin' ? <Chip>Everything</Chip>
                      : r.job_scope === 'own' ? <Chip>Their own jobs</Chip>
                        : r.job_scope === 'team' ? <Chip>Their team's jobs</Chip>
                          : r.job_scope ? <Chip>Every job</Chip>
                            : <span className="sub">No job access</span>}</td>
                    <td className="num">{r.user_count}</td>
                    <td className="num">{r.permission_count}</td>
                    <td className="tar nw">
                      {r.key === 'admin'
                        ? <Chip>Always everything</Chip>
                        : <>
                            <Btn size="sm" onClick={() => setDetails(r)}>Rename</Btn>{' '}
                            <Btn size="sm" onClick={() => { setDraft(null); setOpen(r.id); }}>Permissions</Btn>
                            {/* The roles the system ships with are kept: other screens and
                                the manual describe them by name. Custom ones can go once
                                nobody holds them. */}
                            {r.is_system === 0 && <>{' '}
                              <DeleteBtn kind="role" id={r.id} label={r.name}
                                         onDone={async (m) => { setMsg(m); await refreshRoles(); }} />
                            </>}
                          </>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {open && (
        <Modal title={`Permissions — ${granted.data?.role.name ?? ''}`}
               onClose={() => { setOpen(null); setDraft(null); }}>
          <div className="note mb-5">
            Ticking a box grants the permission; it never widens one this role already
            holds narrowly. A grant marked <b>own</b> or <b>team</b> keeps that reach.
          </div>
          <div className="mb-6 scrollbox">
            {[...byModule.entries()].map(([module, perms]) => (
              <div className="mb-6" key={module}>
                <div className="t-lab mb-3">{module}</div>
                {perms.map((p) => (
                  <label className="row gap-4 start py-2 px-0 t-ui clickable" key={p.code}>
                    <input className="mt-1" type="checkbox" checked={codes.has(p.code)}
                           onChange={(e) => {
                             const next = new Set(codes);
                             if (e.target.checked) next.add(p.code); else next.delete(p.code);
                             setDraft(next);
                           }} />
                    <span>
                      <span className="f-mono t-sm">{p.code}</span>
                      {codes.has(p.code) && scopes.get(p.code) && scopes.get(p.code) !== 'all' && (
                        <> <Chip>{scopes.get(p.code)}</Chip></>
                      )}
                      <span className="block c-3 t-sm">{p.description}</span>
                    </span>
                  </label>
                ))}
              </div>
            ))}
          </div>
          <Btn full tone="pri" disabled={save.isPending}
               onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : `Save ${codes.size} permission${codes.size === 1 ? '' : 's'}`}
          </Btn>
        </Modal>
      )}

      {details && (
        <RoleDialog role={details === 'new' ? null : details}
                    roles={(roles.data?.roles ?? []).filter((r) => r.key !== 'admin')}
                    onClose={() => setDetails(null)}
                    onSaved={async (text, newId) => {
                      setDetails(null); setMsg(text); await refreshRoles();
                      // A new role is only useful once it can do something, so go straight
                      // to its permissions rather than leaving the next click to be found.
                      if (newId) { setDraft(null); setOpen(newId); }
                    }} />
      )}
    </>
  );
}

/**
 * Create a role, or rename one.
 *
 * Copying is offered first because it is nearly always what is wanted: a "security lead"
 * is a team lead plus one permission, not sixty ticks from nothing. Narrow grants are
 * copied as narrow — a copy of Technician still sees only its own jobs.
 */
function RoleDialog({ role, roles, onClose, onSaved }: {
  role: Role | null; roles: Role[];
  onClose: () => void; onSaved: (text: string, newId?: string) => void;
}) {
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [copyFrom, setCopyFrom] = useState('');
  const save = useMutation({
    mutationFn: () => role
      ? api.patch<{ id: string }>(`/api/admin/roles/${role.id}`, { name: name.trim(), description: description.trim() || null })
      : api.post<{ id: string }>('/api/admin/roles', {
          name: name.trim(), description: description.trim() || undefined, copyFrom: copyFrom || undefined,
        }),
    onSuccess: (r) => role
      ? onSaved(`${name.trim()} saved.`)
      : onSaved(`${name.trim()} created. Choose what it may do below.`, r.id),
  });
  const err = save.error as ApiError | null;
  return (
    <Modal title={role ? `Rename ${role.name}` : 'New role'} onClose={onClose}>
      <Field label="Name" hint="What people will see when an account is given this role.">
        <input className="inp" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="What it is for" hint="One sentence, shown under the role when an account is created.">
        <input className="inp" value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      {!role && (
        <Field label="Start from"
               hint="Its permissions are copied, including any limited to their own or their team's work.">
          <select className="inp" value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
            <option value="">Nothing — no permissions yet</option>
            {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </Field>
      )}
      {err && <div className="note crit mb-5" role="alert">{err.message}</div>}
      <Btn full tone="pri" disabled={name.trim().length < 2 || save.isPending}
           onClick={() => save.mutate()}>
        {save.isPending ? 'Saving…' : role ? 'Save' : 'Create role'}
      </Btn>
    </Modal>
  );
}

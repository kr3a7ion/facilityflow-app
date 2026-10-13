/** Admin → Accounts: who can sign in, as which role, linked to which person, and who each event reaches. */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { useSession } from '../../lib/session';
import { when } from '../../lib/format';
import { Card, Chip, Loading, Btn, Modal, DeleteBtn } from '../../components/Bits';

interface User {
  id: string; username: string; display_name: string; role: string; is_active: number;
  must_change_password: number; last_login_at: string | null; locked_until: string | null;
  role_name: string; role_description: string;
  staff_id: string | null; staff_name: string | null; does_jobs: number;
}
export interface Role {
  id: string; key: string; name: string; description: string;
  /** 1 for the roles the system ships with — those can be edited but never deleted. */
  is_system?: number;
  /** Read off the role's real grants: can this role be assigned work, and how far it sees. */
  does_jobs: number; job_scope: string | null;
  /** Likewise for money: 1 when the role holds cost.read, and the requisition scope. */
  sees_money: number; requisition_scope: string | null;
}

/**
 * What choosing this role actually means, in the department's words.
 *
 * Every line is read off the role's real grants rather than its name, so a role somebody
 * edited last month still describes itself honestly. It sits under the dropdown because
 * that is where the decision is made — a reference table on another tab is a table nobody
 * opens while they are halfway through creating an account.
 */
function RoleHint({ role }: { role: Role | undefined }) {
  if (!role) return null;
  const scope = role.job_scope;
  const sees = scope === 'own' ? 'Sees only the jobs assigned to them.'
    : scope === 'team' ? 'Sees their own jobs and their team\u2019s.'
      : scope ? 'Sees every job on the property.' : null;
  return (
    <div className="rolehint">
      <b>{role.name}</b> — {role.description}
      <div className="cando">
        {sees && <Chip>{sees}</Chip>}
        {/* The department's rule is that money is only for the people whose job it is, so
            say which side of that line the role falls on before the account exists. */}
        <Chip tone={role.sees_money === 1 ? 'warn' : 'ok'}>
          {role.sees_money === 1 ? 'Sees prices and costs' : 'Costs are hidden'}
        </Chip>
        {role.requisition_scope === 'own'
          ? <Chip>Sees only their own requisitions</Chip>
          : role.requisition_scope ? <Chip>Sees every requisition</Chip>
          : <Chip>No access to requisitions</Chip>}
        {role.does_jobs === 1 && <Chip tone="warn">Must be linked to a person below</Chip>}
      </div>
    </div>
  );
}
interface Person { id: string; first_name: string; last_name: string }

/** An account that can be assigned work but is linked to nobody has an empty job board. */
function broken(u: User): boolean {
  return u.is_active === 1 && u.does_jobs === 1 && !u.staff_id;
}

export function Users() {
  const { me, can } = useSession();
  const qc = useQueryClient();
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState<User | null>(null);
  const [editing, setEditing] = useState<User | null>(null);

  const users = useQuery<{ users: User[] }>({ queryKey: ['admin-users'], queryFn: () => api.get('/api/admin/users') });
  const roles = useQuery<{ roles: Role[] }>({
    queryKey: ['admin-roles'], queryFn: () => api.get('/api/admin/roles'),
  });
  const people = useQuery<{ staff: Person[] }>({
    queryKey: ['staff'], queryFn: () => api.get('/api/staff'),
  });

  const list = users.data?.users ?? [];
  const unlinked = list.filter(broken);

  const after = async (text: string) => {
    setMsg({ text });
    await qc.invalidateQueries({ queryKey: ['admin-users'] });
  };
  const fail = (e: unknown) => setMsg({ text: (e as ApiError).message, bad: true });

  const toggle = useMutation({
    mutationFn: (u: User) => api.post(`/api/admin/users/${u.id}/${u.is_active ? 'disable' : 'enable'}`),
    onSuccess: (_r, u) => after(u.is_active ? `${u.display_name} disabled and signed out everywhere.` : `${u.display_name} enabled.`),
    onError: fail,
  });

  /*
   * Ring somebody's device.
   *
   * The reply is worth showing in full rather than a tick: the server counts what was
   * actually listening when the button was pressed, and "nothing rang" is the answer the
   * person pressing it most needs — it means go and find them.
   */
  const [ringing, setRinging] = useState<string | null>(null);
  const ring = useMutation({
    mutationFn: (u: User) => {
      setRinging(u.id);
      return api.post<{ reached: number; message: string }>(`/api/users/${u.id}/ring`, {});
    },
    onSuccess: (r) => { setRinging(null); setMsg({ text: r.message, bad: r.reached === 0 }); },
    onError: (e) => { setRinging(null); fail(e); },
  });

  return (
    <>
      {msg && <div className={`note ${msg.bad ? 'crit' : ''} mb-6`} role="status">{msg.text}</div>}

      {unlinked.length > 0 && (
        <div className="note warn mb-6">
          <b>{unlinked.length === 1 ? 'One account cannot see its own work' : `${unlinked.length} accounts cannot see their own work`}</b>
          <p className="mt-2 mb-0">
            A job is assigned to a <i>person</i>, not to a login. These accounts are allowed to
            work jobs but are not linked to anybody on the staff list, so they sign in to an
            empty board and assume the system is broken.
          </p>
          <p className="mt-4 mb-0 row gap-3">
            {unlinked.map((u) => (
              <Btn key={u.id} size="sm" onClick={() => setEditing(u)}>Link {u.display_name}</Btn>
            ))}
          </p>
        </div>
      )}

      <Card title="People with a login" flush
            right={<Btn size="sm" tone="pri" icon="plus" onClick={() => setCreating(true)}>Add user</Btn>}>
        {users.isLoading ? <Loading rows={4} /> : (
          <div className="tw">
            <table className="wide">
              <thead><tr><th>Name</th><th>Can do</th><th>Is on the floor</th>
                         <th>Last signed in</th><th>State</th><th /></tr></thead>
              <tbody>
                {list.map((u) => (
                  <tr key={u.id}>
                    <td><span className="ttl">{u.display_name}</span><span className="sub">{u.username}</span></td>
                    {/* The role's own name and its own sentence. "Hod" told nobody anything. */}
                    <td style={{ maxWidth: 300 }}>
                      <span className="ttl">{u.role_name}</span>
                      <span className="sub wrap">{u.role_description}</span>
                    </td>
                    <td>
                      {u.staff_name
                        ? <span className="ttl fw-4">{u.staff_name}</span>
                        : broken(u)
                          ? <Chip tone="warn" lamp>Nobody — empty job board</Chip>
                          : <span className="sub">Office account</span>}
                    </td>
                    <td className="mono">{u.last_login_at ? when(u.last_login_at) : 'never'}</td>
                    <td>
                      {!u.is_active ? <Chip tone="crit" lamp>Disabled</Chip>
                        : u.locked_until && new Date(u.locked_until) > new Date()
                          ? <Chip tone="warn" lamp>Locked</Chip>
                          : u.must_change_password ? <Chip tone="warn">Must change password</Chip>
                            : <Chip tone="ok" lamp>Active</Chip>}
                    </td>
                    <td className="tar nw">
                      <Btn size="sm" onClick={() => setEditing(u)}>Change</Btn>{' '}
                      <Btn size="sm" onClick={() => setResetting(u)}>Reset password</Btn>{' '}
                      {/* Ringing somebody from the account list, where you are already
                          looking at who they are. It is audited, and it tells you
                          afterwards whether anything was actually listening. */}
                      {can('alerts.ring') && u.is_active === 1 && u.id !== me?.user.id && (
                        <>
                          <Btn size="sm" disabled={ringing === u.id}
                               onClick={() => ring.mutate(u)}>
                            {ringing === u.id ? 'Ringing…' : 'Ring'}
                          </Btn>{' '}
                        </>
                      )}
                      {/* The server refuses it anyway; offering it is just a trap. */}
                      {u.id === me?.user.id
                        ? <Chip>You</Chip>
                        : <>
                            <Btn size="sm" tone={u.is_active ? 'danger' : undefined}
                                 onClick={() => toggle.mutate(u)}>
                              {u.is_active ? 'Disable' : 'Enable'}
                            </Btn>{' '}
                            {/* Only goes through for an account nobody has used yet —
                                anything with a history is disabled instead. */}
                            <DeleteBtn kind="user" id={u.id} label={u.display_name}
                                       onDone={(m) => void after(m)} />
                          </>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="mt-6"><AlertReach /></div>

      <div className="note mt-6">
        Named accounts only. The audit log is worthless the moment three people share a username —
        and disabling someone signs them out of every device immediately.
        Changing a role takes effect the next time that person loads a screen; nobody has to
        be deleted and recreated to be promoted. <b>Delete</b> is only for an account created by
        mistake and never used — one with any history is disabled instead.
      </div>

      {creating && (
        <NewUser roles={roles.data?.roles ?? []} people={people.data?.staff ?? []}
                 onClose={() => setCreating(false)}
                 onDone={(name) => { setCreating(false); void after(`${name} created. They must change their password at first sign-in.`); }} />
      )}
      {editing && (
        <EditUser user={editing} roles={roles.data?.roles ?? []} people={people.data?.staff ?? []}
                  isSelf={editing.id === me?.user.id}
                  onClose={() => setEditing(null)}
                  onDone={(text) => { setEditing(null); void after(text); }} />
      )}
      {resetting && (
        <ResetPassword user={resetting} onClose={() => setResetting(null)}
                       onDone={() => { const n = resetting.display_name; setResetting(null); void after(`Password reset for ${n}. They are signed out everywhere.`); }} />
      )}
    </>
  );
}

interface Reach {
  id: string; display_name: string; username: string; role_name: string;
  may_silence: number; devices: number; listening: number; muted: number;
  last_seen: string | null;
  phones: number; phones_live: number; phone_last_seen: string | null;
  state: 'phone' | 'phone_offline' | 'unreported' | 'muted' | 'listening' | 'not_ready';
}

/**
 * Who can actually be reached.
 *
 * The alert sound lives in each browser's own storage, so before this the department had
 * no way to know whether a technician's phone would make a noise when a P1 landed on it.
 * A tablet sitting silently in the plant room looked exactly like a tablet that was
 * listening.
 *
 * Three silences, kept apart because they need different answers: an account that has
 * never signed in anywhere, one whose browser will not play audio until somebody touches
 * it, and one that was deliberately switched off by somebody entitled to.
 */
function AlertReach() {
  const [open, setOpen] = useState(false);
  const q = useQuery<{ people: Reach[] }>({
    queryKey: ['alert-reach'], queryFn: () => api.get('/api/admin/alerts'), enabled: open,
  });

  const people = q.data?.people ?? [];
  const problems = people.filter((p) =>
    p.state === 'muted' || p.state === 'not_ready' || p.state === 'phone_offline');

  return (
    <Card title="Who can hear an alert" flush
          right={<Btn size="sm" onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide' : 'Check'}
          </Btn>}>
      {!open ? (
        <div className="note m-5">
          Alert sounds are set on each device, so this is the only way to see whether a phone
          will actually make a noise when a job lands on it. Technicians and team leads
          cannot turn theirs off — everybody else can.
        </div>
      ) : q.isLoading ? <Loading rows={4} /> : (
        <>
          {problems.length > 0 && (
            <div className="note warn m-5">
              <b>{problems.length} {problems.length === 1 ? 'account' : 'accounts'} may not hear you.</b>
              {' '}Ring them rather than assuming the chime did its job.
            </div>
          )}
          <div className="tw">
            <table className="wide">
              <thead><tr><th>Name</th><th>Role</th><th>Alerts</th>
                         <th className="num">Devices</th><th>Last seen</th></tr></thead>
              <tbody>
                {people.map((p) => (
                  <tr key={p.id}>
                    <td><span className="ttl">{p.display_name}</span>
                        <span className="sub">{p.username}</span></td>
                    <td>{p.role_name}
                        {p.may_silence === 0 && <span className="sub">cannot be silenced</span>}</td>
                    <td>
                      {p.state === 'phone' ? <Chip tone="ok" lamp>Phone will ring</Chip>
                        : p.state === 'phone_offline'
                          ? <Chip tone="crit" lamp>Phone app not running</Chip>
                          : p.state === 'listening' ? <Chip tone="ok" lamp>Will hear it</Chip>
                            : p.state === 'muted' ? <Chip tone="crit" lamp>Turned off</Chip>
                              : p.state === 'not_ready'
                                ? <Chip tone="warn" lamp>Screen not touched yet</Chip>
                                : <Chip>No device yet</Chip>}
                    </td>
                    <td className="num">{p.phones > 0
                      ? <span title={`${p.phones_live} of ${p.phones} phones connected`}>
                          {p.phones_live}/{p.phones} app
                        </span>
                      : p.devices}</td>
                    <td className="mono">{p.last_seen ? when(p.last_seen) : '\u2014'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {people.some((p) => p.state === 'phone_offline') && (
            <div className="note crit m-5">
              <b>"Phone app not running" is the one to chase.</b> That person paired a phone,
              so it should be ringing with the screen off — and it has stopped holding its
              connection. Almost always the handset's own battery manager killing it:
              Tecno, Infinix, Xiaomi and Oppo all do this. The fix is on the phone, under
              battery settings, and it is in the manual.
            </div>
          )}
          <div className="note m-5">
            <b>"Screen not touched yet"</b> is not somebody ignoring you. A browser refuses to
            play any sound until the page has been tapped at least once since it loaded, so a
            phone in a pocket since this morning is silent whatever its setting says. The bell
            and the job board still show the work — only the noise is missing.
          </div>
        </>
      )}
    </Card>
  );
}

function NewUser({ roles, people, onClose, onDone }:
  { roles: Role[]; people: Person[]; onClose: () => void; onDone: (name: string) => void }) {
  const [f, setF] = useState({
    displayName: '', username: '', password: '', roleKey: 'technician', staffId: '',
  });
  const chosen = roles.find((r) => r.key === f.roleKey);
  // Linking the account to a person is what makes "my jobs" mean anything: a technician's
  // board is filtered to what is assigned to their staff record, not their login. So the
  // form refuses to create an account that would open on an empty screen.
  const needsPerson = chosen?.does_jobs === 1;
  const create = useMutation({
    mutationFn: () => api.post('/api/admin/users', { ...f, staffId: f.staffId || undefined }),
    onSuccess: () => onDone(f.displayName),
  });
  const err = create.error as ApiError | null;
  const ready = f.displayName.length > 1 && f.username.length > 2 && f.password.length >= 10
    && (!needsPerson || !!f.staffId);
  return (
    <Modal title="Add a user" onClose={onClose}>
      <div className="fld"><label>Full name</label>
        <input className="inp" autoFocus value={f.displayName}
               onChange={(e) => setF({ ...f, displayName: e.target.value })} /></div>
      <div className="grid g2 gap-5">
        <div className="fld"><label>Username</label>
          <input className="inp" autoCapitalize="none" value={f.username}
                 onChange={(e) => setF({ ...f, username: e.target.value })} /></div>
        <div className="fld"><label>Role</label>
          <select className="inp" value={f.roleKey} onChange={(e) => setF({ ...f, roleKey: e.target.value })}>
            {roles.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
          </select></div>
      </div>
      <RoleHint role={chosen} />
      <div className="fld mt-5"><label>Which person is this</label>
        <select className="inp" value={f.staffId}
                onChange={(e) => {
                  const id = e.target.value;
                  const p = people.find((x) => x.id === id);
                  setF((v) => ({
                    ...v, staffId: id,
                    displayName: p && !v.displayName ? `${p.first_name} ${p.last_name}` : v.displayName,
                  }));
                }}>
          <option value="">Not linked to anyone on the floor</option>
          {people.map((p) =>
            <option key={p.id} value={p.id}>{p.first_name} {p.last_name}</option>)}
        </select>
        <p className="sub mt-2 wrap">
          {people.length === 0
            ? 'Nobody on the staff list yet — add people under the Staff tab first, and a technician can then see their own jobs.'
            : needsPerson
              ? 'Required for this role: jobs are assigned to a person, so without this link they sign in to an empty board.'
              : 'Office accounts can be left unlinked — nothing is ever assigned to them.'}
        </p></div>
      <div className="fld"><label>Temporary password</label>
        <input className="inp" value={f.password}
               onChange={(e) => setF({ ...f, password: e.target.value })} />
        <p className="sub mt-2 wrap">
          At least 10 characters. They will be made to change it when they first sign in.
        </p></div>
      {err && <div className="note crit mb-5" role="alert">{err.message}</div>}
      <Btn full tone="pri" disabled={!ready || create.isPending}
           onClick={() => create.mutate()}>{create.isPending ? 'Creating…' : 'Create user'}</Btn>
    </Modal>
  );
}

/**
 * Change a role, a link, or a name — without deleting anybody.
 *
 * Getting a role wrong on somebody's first day is ordinary. The alternative people reach
 * for is delete-and-recreate, which throws away their history and orphans every job that
 * points at them, so the affordance has to be here where the mistake is noticed.
 */
function EditUser({ user, roles, people, isSelf, onClose, onDone }:
  { user: User; roles: Role[]; people: Person[]; isSelf: boolean;
    onClose: () => void; onDone: (text: string) => void }) {
  const [roleKey, setRoleKey] = useState(user.role);
  const [staffId, setStaffId] = useState(user.staff_id ?? '');
  const [displayName, setDisplayName] = useState(user.display_name);
  const chosen = roles.find((r) => r.key === roleKey);
  const needsPerson = chosen?.does_jobs === 1;

  const save = useMutation({
    mutationFn: () => api.patch(`/api/admin/users/${user.id}`, {
      roleKey: roleKey !== user.role ? roleKey : undefined,
      staffId: staffId !== (user.staff_id ?? '') ? (staffId || null) : undefined,
      displayName: displayName !== user.display_name ? displayName : undefined,
    }),
    onSuccess: () => onDone(`${displayName} updated. It takes effect the next time they load a screen.`),
  });
  const err = save.error as ApiError | null;
  const changed = roleKey !== user.role || staffId !== (user.staff_id ?? '')
    || displayName !== user.display_name;

  return (
    <Modal title={`Change ${user.display_name}`} onClose={onClose}>
      <div className="fld"><label>Full name</label>
        <input className="inp" value={displayName} onChange={(e) => setDisplayName(e.target.value)} /></div>

      <div className="fld"><label>Role</label>
        <select className="inp" value={roleKey} disabled={isSelf}
                onChange={(e) => setRoleKey(e.target.value)}>
          {roles.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
        </select>
        {isSelf && (
          <p className="sub mt-2 wrap">
            You cannot change your own role — that is how an administrator locks themselves
            out of the only screen that could undo it. Ask the other administrator.
          </p>
        )}
      </div>
      <RoleHint role={chosen} />

      <div className="fld mt-5"><label>Which person is this</label>
        <select className="inp" value={staffId} onChange={(e) => setStaffId(e.target.value)}>
          <option value="">Not linked to anyone on the floor</option>
          {people.map((p) => <option key={p.id} value={p.id}>{p.first_name} {p.last_name}</option>)}
        </select>
        <p className="sub mt-2 wrap">
          {needsPerson && !staffId
            ? 'This role works jobs, and a job is assigned to a person. Without this link they sign in to an empty board.'
            : 'Jobs already assigned to the old person stay with that person — this only changes what this login sees.'}
        </p>
      </div>

      {needsPerson && !staffId && (
        <div className="note warn mb-5">
          Saving this leaves an account that can be given work but will never be shown any.
        </div>
      )}
      {err && <div className="note crit mb-5" role="alert">{err.message}</div>}
      <Btn full tone="pri" disabled={!changed || save.isPending}
           onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save changes'}</Btn>
    </Modal>
  );
}

function ResetPassword({ user, onClose, onDone }:
  { user: User; onClose: () => void; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const reset = useMutation({
    mutationFn: () => api.post(`/api/admin/users/${user.id}/reset-password`, { password }),
    onSuccess: onDone,
  });
  const err = reset.error as ApiError | null;
  return (
    <Modal title={`Reset password — ${user.display_name}`} onClose={onClose}>
      <div className="fld"><label>New temporary password</label>
        <input className="inp" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} /></div>
      <div className="note warn mb-5">
        This signs {user.display_name} out of every device and makes them choose a new password
        at their next sign-in.
      </div>
      {err && <div className="note crit mb-5" role="alert">{err.message}</div>}
      <Btn full tone="pri" disabled={password.length < 10 || reset.isPending}
           onClick={() => reset.mutate()}>{reset.isPending ? 'Resetting…' : 'Reset password'}</Btn>
    </Modal>
  );
}

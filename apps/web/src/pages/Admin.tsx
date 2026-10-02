import { useEffect, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { StartHere } from '../components/StartHere';
import QRCode from 'qrcode';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useSession } from '../lib/session';
import { titleCase, when } from '../lib/format';
import { humanBytes } from '../lib/image';
import { useMonth } from '../lib/month';
import { Card, Chip, Tile, Loading, Empty, ErrorNote, Btn, DownloadLink,
         Modal, Field, MonthBar, Flash, RetireBtn, DeleteBtn } from '../components/Bits';

type Tab = 'start' | 'host' | 'users' | 'people' | 'roles' | 'shifts' | 'settings' | 'places' | 'supplies' | 'backups' | 'exports' | 'audit';

/**
 * Grouped, because eleven flat tabs tell nobody which to open first. The order within
 * "Set up once" is the order the software actually requires — people before accounts,
 * because an account linked to nobody has an empty job board.
 */
const GROUPS = [
  { label: 'Start', keys: ['start'] },
  { label: 'Set up once', keys: ['people', 'users', 'roles', 'places', 'shifts', 'supplies'] },
  { label: 'Settings', keys: ['settings', 'exports'] },
  { label: 'The machine', keys: ['host', 'backups', 'audit'] },
] as const;

const TABS: { key: Tab; label: string; need: string }[] = [
  { key: 'start', label: 'Start here', need: 'admin.settings.manage' },
  { key: 'people', label: 'Staff', need: 'staff.manage' },
  { key: 'users', label: 'Users', need: 'admin.users.manage' },
  { key: 'roles', label: 'Roles', need: 'admin.roles.manage' },
  { key: 'places', label: 'Places', need: 'location.manage' },
  { key: 'shifts', label: 'Shifts', need: 'admin.settings.manage' },
  { key: 'supplies', label: 'Supplies', need: 'power.source.manage' },
  { key: 'settings', label: 'Settings', need: 'admin.settings.manage' },
  { key: 'exports', label: 'Exports', need: 'report.export' },
  { key: 'host', label: 'Host PC', need: 'admin.settings.manage' },
  { key: 'backups', label: 'Backups', need: 'admin.backup.run' },
  { key: 'audit', label: 'Audit log', need: 'admin.audit.read' },
];

export function Admin() {
  const { can } = useSession();
  const allowed = TABS.filter((t) => can(t.need));
  // A link from the Start here checklist lands on the right tab rather than dumping
  // somebody on the first one and making them hunt.
  const [params, setParams] = useSearchParams();
  const asked = params.get('tab') as Tab | null;
  const initial = asked && allowed.some((t) => t.key === asked) ? asked : (allowed[0]?.key ?? 'users');
  const [tab, setTabState] = useState<Tab>(initial);
  const setTab = (next: Tab) => {
    setTabState(next);
    setParams((prev) => {
      const n = new URLSearchParams(prev);
      n.set('tab', next);
      return n;
    }, { replace: true });
  };

  if (allowed.length === 0) {
    return <main className="view"><div className="note">Your role has no administrative rights.</div></main>;
  }

  return (
    <main className="view">
      <div className="vhead">
        <div>
          <p className="eyebrow">Configuration · everything here is data, not a release</p>
          <h1>Admin</h1>
          <p>Roles, people, shifts and thresholds. Changing what a role may do is a settings
             change here, never a code change.</p>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginBottom: 18,
                    alignItems: 'flex-start' }}>
        {GROUPS.map((g) => {
          const mine = allowed.filter((t) => (g.keys as readonly string[]).includes(t.key));
          if (mine.length === 0) return null;
          return (
            <div key={g.label}>
              <p className="eyebrow" style={{ marginBottom: 6 }}>{g.label}</p>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {mine.map((t) => (
                  <button key={t.key} className={`btn sm ${tab === t.key ? 'on' : ''}`}
                          onClick={() => setTab(t.key)}>{t.label}</button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {tab === 'start' && <StartHere />}
      {tab === 'host' && <Host />}
      {tab === 'users' && <Users />}
      {tab === 'people' && <People />}
      {tab === 'roles' && <Roles />}
      {tab === 'shifts' && <Shifts />}
      {tab === 'settings' && <Settings />}
      {tab === 'places' && <Places />}
      {tab === 'supplies' && <Supplies />}
      {tab === 'backups' && <Backups />}
      {tab === 'exports' && <Exports />}
      {tab === 'audit' && <AuditLog />}
    </main>
  );
}

/* ------------------------------------------------------------------ users -- */
interface User {
  id: string; username: string; display_name: string; role: string; is_active: number;
  must_change_password: number; last_login_at: string | null; locked_until: string | null;
  role_name: string; role_description: string;
  staff_id: string | null; staff_name: string | null; does_jobs: number;
}
interface Role {
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

function Users() {
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
      {msg && <div className={`note ${msg.bad ? 'crit' : ''}`} style={{ marginBottom: 14 }} role="status">{msg.text}</div>}

      {unlinked.length > 0 && (
        <div className="note warn" style={{ marginBottom: 14 }}>
          <b>{unlinked.length === 1 ? 'One account cannot see its own work' : `${unlinked.length} accounts cannot see their own work`}</b>
          <p style={{ margin: '5px 0 0' }}>
            A job is assigned to a <i>person</i>, not to a login. These accounts are allowed to
            work jobs but are not linked to anybody on the staff list, so they sign in to an
            empty board and assume the system is broken.
          </p>
          <p style={{ margin: '8px 0 0', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
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
                      <span className="sub" style={{ whiteSpace: 'normal' }}>{u.role_description}</span>
                    </td>
                    <td>
                      {u.staff_name
                        ? <span className="ttl" style={{ fontWeight: 400 }}>{u.staff_name}</span>
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
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
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

      <div style={{ marginTop: 14 }}><AlertReach /></div>

      <div className="note" style={{ marginTop: 14 }}>
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
        <div className="note" style={{ margin: 13 }}>
          Alert sounds are set on each device, so this is the only way to see whether a phone
          will actually make a noise when a job lands on it. Technicians and team leads
          cannot turn theirs off — everybody else can.
        </div>
      ) : q.isLoading ? <Loading rows={4} /> : (
        <>
          {problems.length > 0 && (
            <div className="note warn" style={{ margin: 13 }}>
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
            <div className="note crit" style={{ margin: 13 }}>
              <b>"Phone app not running" is the one to chase.</b> That person paired a phone,
              so it should be ringing with the screen off — and it has stopped holding its
              connection. Almost always the handset's own battery manager killing it:
              Tecno, Infinix, Xiaomi and Oppo all do this. The fix is on the phone, under
              battery settings, and it is in the manual.
            </div>
          )}
          <div className="note" style={{ margin: 13 }}>
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
      <div className="grid g2" style={{ gap: 12 }}>
        <div className="fld"><label>Username</label>
          <input className="inp" autoCapitalize="none" value={f.username}
                 onChange={(e) => setF({ ...f, username: e.target.value })} /></div>
        <div className="fld"><label>Role</label>
          <select className="inp" value={f.roleKey} onChange={(e) => setF({ ...f, roleKey: e.target.value })}>
            {roles.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
          </select></div>
      </div>
      <RoleHint role={chosen} />
      <div className="fld" style={{ marginTop: 12 }}><label>Which person is this</label>
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
        <p className="sub" style={{ marginTop: 5, whiteSpace: 'normal' }}>
          {people.length === 0
            ? 'Nobody on the staff list yet — add people under the Staff tab first, and a technician can then see their own jobs.'
            : needsPerson
              ? 'Required for this role: jobs are assigned to a person, so without this link they sign in to an empty board.'
              : 'Office accounts can be left unlinked — nothing is ever assigned to them.'}
        </p></div>
      <div className="fld"><label>Temporary password</label>
        <input className="inp" value={f.password}
               onChange={(e) => setF({ ...f, password: e.target.value })} />
        <p className="sub" style={{ marginTop: 5, whiteSpace: 'normal' }}>
          At least 10 characters. They will be made to change it when they first sign in.
        </p></div>
      {err && <div className="note crit" style={{ marginBottom: 12 }} role="alert">{err.message}</div>}
      <Btn tone="pri" style={{ width: '100%' }} disabled={!ready || create.isPending}
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
          <p className="sub" style={{ marginTop: 5, whiteSpace: 'normal' }}>
            You cannot change your own role — that is how an administrator locks themselves
            out of the only screen that could undo it. Ask the other administrator.
          </p>
        )}
      </div>
      <RoleHint role={chosen} />

      <div className="fld" style={{ marginTop: 12 }}><label>Which person is this</label>
        <select className="inp" value={staffId} onChange={(e) => setStaffId(e.target.value)}>
          <option value="">Not linked to anyone on the floor</option>
          {people.map((p) => <option key={p.id} value={p.id}>{p.first_name} {p.last_name}</option>)}
        </select>
        <p className="sub" style={{ marginTop: 5, whiteSpace: 'normal' }}>
          {needsPerson && !staffId
            ? 'This role works jobs, and a job is assigned to a person. Without this link they sign in to an empty board.'
            : 'Jobs already assigned to the old person stay with that person — this only changes what this login sees.'}
        </p>
      </div>

      {needsPerson && !staffId && (
        <div className="note warn" style={{ marginBottom: 12 }}>
          Saving this leaves an account that can be given work but will never be shown any.
        </div>
      )}
      {err && <div className="note crit" style={{ marginBottom: 12 }} role="alert">{err.message}</div>}
      <Btn tone="pri" style={{ width: '100%' }} disabled={!changed || save.isPending}
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
      <div className="note warn" style={{ marginBottom: 12 }}>
        This signs {user.display_name} out of every device and makes them choose a new password
        at their next sign-in.
      </div>
      {err && <div className="note crit" style={{ marginBottom: 12 }} role="alert">{err.message}</div>}
      <Btn tone="pri" style={{ width: '100%' }} disabled={password.length < 10 || reset.isPending}
           onClick={() => reset.mutate()}>{reset.isPending ? 'Resetting…' : 'Reset password'}</Btn>
    </Modal>
  );
}

/* ------------------------------------------------------------------ roles -- */
function Roles() {
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
      {msg && <div className="note" style={{ marginBottom: 14 }} role="status">{msg}</div>}
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
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
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
          <div className="note" style={{ marginBottom: 12 }}>
            Ticking a box grants the permission; it never widens one this role already
            holds narrowly. A grant marked <b>own</b> or <b>team</b> keeps that reach.
          </div>
          <div style={{ maxHeight: '52vh', overflowY: 'auto', marginBottom: 14 }}>
            {[...byModule.entries()].map(([module, perms]) => (
              <div key={module} style={{ marginBottom: 14 }}>
                <div className="t-lab" style={{ marginBottom: 6 }}>{module}</div>
                {perms.map((p) => (
                  <label key={p.code} style={{ display: 'flex', gap: 9, alignItems: 'flex-start',
                                               padding: '5px 0', fontSize: '0.8125rem', cursor: 'pointer' }}>
                    <input type="checkbox" checked={codes.has(p.code)} style={{ marginTop: 3 }}
                           onChange={(e) => {
                             const next = new Set(codes);
                             if (e.target.checked) next.add(p.code); else next.delete(p.code);
                             setDraft(next);
                           }} />
                    <span>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: '0.7188rem' }}>{p.code}</span>
                      {codes.has(p.code) && scopes.get(p.code) && scopes.get(p.code) !== 'all' && (
                        <> <Chip>{scopes.get(p.code)}</Chip></>
                      )}
                      <span style={{ display: 'block', color: 'var(--text-3)', fontSize: '0.75rem' }}>{p.description}</span>
                    </span>
                  </label>
                ))}
              </div>
            ))}
          </div>
          <Btn tone="pri" style={{ width: '100%' }} disabled={save.isPending}
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
      {err && <div className="note crit" style={{ marginBottom: 12 }} role="alert">{err.message}</div>}
      <Btn tone="pri" style={{ width: '100%' }} disabled={name.trim().length < 2 || save.isPending}
           onClick={() => save.mutate()}>
        {save.isPending ? 'Saving…' : role ? 'Save' : 'Create role'}
      </Btn>
    </Modal>
  );
}

/* ----------------------------------------------------------------- shifts -- */
function Shifts() {
  const qc = useQueryClient();
  const [f, setF] = useState({ name: '', startTime: '06:00', endTime: '14:00' });
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);

  const patterns = useQuery<{ patterns: { id: string; name: string; start_time: string;
                                          end_time: string; crosses_midnight: number }[] }>({
    queryKey: ['patterns'], queryFn: () => api.get('/api/shift-patterns'),
  });
  const add = useMutation({
    mutationFn: () => api.post('/api/shift-patterns', f),
    onSuccess: async (r) => {
      const res = r as { crossesMidnight: boolean };
      setMsg({ text: `${f.name} added${res.crossesMidnight ? ' — detected as crossing midnight.' : '.'}` });
      setF({ name: '', startTime: '06:00', endTime: '14:00' });
      await qc.invalidateQueries({ queryKey: ['patterns'] });
    },
    onError: (e) => setMsg({ text: (e as ApiError).message, bad: true }),
  });

  return (
    <>
      {msg && <div className={`note ${msg.bad ? 'crit' : ''}`} style={{ marginBottom: 14 }} role="status">{msg.text}</div>}
      <div className="grid g21">
        <Card title="Shift patterns" flush>
          {patterns.isLoading ? <Loading rows={3} />
            : (patterns.data?.patterns.length ?? 0) === 0 ? <Empty title="No shifts defined yet" />
            : (
              <table>
                <tbody>
                  {patterns.data!.patterns.map((p) => (
                    <tr key={p.id}>
                      <td><span className="ttl">{p.name}</span>
                          <span className="sub">{p.start_time}–{p.end_time}</span></td>
                      <td style={{ textAlign: 'right' }}>
                        {p.crosses_midnight ? <Chip tone="acc">Crosses midnight</Chip> : <Chip>Same day</Chip>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </Card>

        <Card title="Add a pattern">
          <div className="fld"><label>Name</label>
            <input className="inp" value={f.name} placeholder="Morning"
                   onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <div className="grid g2" style={{ gap: 12 }}>
            <div className="fld"><label>Starts</label>
              <input className="inp" type="time" value={f.startTime}
                     onChange={(e) => setF({ ...f, startTime: e.target.value })} /></div>
            <div className="fld"><label>Ends</label>
              <input className="inp" type="time" value={f.endTime}
                     onChange={(e) => setF({ ...f, endTime: e.target.value })} /></div>
          </div>
          <Btn tone="pri" style={{ width: '100%' }} disabled={f.name.length < 2 || add.isPending}
               onClick={() => add.mutate()}>{add.isPending ? 'Adding…' : 'Add pattern'}</Btn>
          <p className="sub" style={{ marginTop: 10, whiteSpace: 'normal' }}>
            Any number of patterns, any times. An end time earlier than the start is detected as
            crossing midnight — nothing about morning, afternoon or night is built in.
          </p>
        </Card>
      </div>
    </>
  );
}

/* --------------------------------------------------------------- settings -- */
interface SlaRow {
  priority: string; label: string; respondMinutes: number; resolveMinutes: number; escalateToRole: string;
}

function Settings() {
  const qc = useQueryClient();
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [draft, setDraft] = useState<SlaRow[] | null>(null);
  const [tolerance, setTolerance] = useState<string>('');

  const settings = useQuery<{ settings: { sla_matrix: SlaRow[] | null;
                                          fuel_variance_tolerance_pct: number | null } }>({
    queryKey: ['admin-settings'], queryFn: () => api.get('/api/admin/settings'),
  });

  const sla = draft ?? settings.data?.settings.sla_matrix ?? [];

  const put = useMutation({
    mutationFn: (v: { key: string; value: unknown }) => api.post('/api/admin/settings', v),
    onSuccess: async (_r, v) => {
      setMsg({ text: v.key === 'sla_matrix'
        ? 'SLA targets saved. They apply to jobs raised from now on — deadlines already set do not move.'
        : 'Saved.' });
      setDraft(null);
      await qc.invalidateQueries({ queryKey: ['admin-settings'] });
    },
    onError: (e) => setMsg({ text: (e as ApiError).message, bad: true }),
  });

  if (settings.isLoading) return <Card><Loading rows={5} /></Card>;
  if (settings.isError) return <ErrorNote error={settings.error} />;

  return (
    <>
      {msg && <div className={`note ${msg.bad ? 'crit' : ''}`} style={{ marginBottom: 14 }} role="status">{msg.text}</div>}

      <Card title="Response and resolve targets" flush
            right={<Btn size="sm" tone="pri" disabled={!draft || put.isPending}
                        onClick={() => put.mutate({ key: 'sla_matrix', value: sla })}>Save</Btn>}>
        <div className="tw">
          <table className="wide">
            <thead><tr><th>Priority</th><th>Label</th><th className="num">Respond (min)</th>
              <th className="num">Resolve (min)</th><th>Escalates to</th></tr></thead>
            <tbody>
              {sla.map((row, i) => (
                <tr key={row.priority}>
                  <td className="mono">{row.priority}</td>
                  <td>
                    <input className="inp" style={{ minHeight: 32, padding: '4px 8px' }} value={row.label}
                           onChange={(e) => {
                             const next = sla.map((r, j) => j === i ? { ...r, label: e.target.value } : r);
                             setDraft(next);
                           }} />
                  </td>
                  {(['respondMinutes', 'resolveMinutes'] as const).map((field) => (
                    <td className="num" key={field}>
                      <input className="inp" style={{ minHeight: 32, padding: '4px 8px', textAlign: 'right' }}
                             inputMode="numeric" value={row[field]}
                             onChange={(e) => {
                               const n = Number(e.target.value);
                               const next = sla.map((r, j) => j === i ? { ...r, [field]: Number.isFinite(n) ? n : 0 } : r);
                               setDraft(next);
                             }} />
                    </td>
                  ))}
                  <td className="mono">{row.escalateToRole}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="note" style={{ margin: '14px 0' }}>
        A job's deadline is computed once when it is raised and stored on the job. Changing these
        targets shapes future work — <b>it never rewrites a deadline somebody was already judged against.</b>
      </div>

      <Card title="Fuel variance tolerance"
            right={<Btn size="sm" tone="pri" disabled={!tolerance || put.isPending}
                        onClick={() => put.mutate({ key: 'fuel_variance_tolerance_pct', value: Number(tolerance) })}>
                     Save</Btn>}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="fld" style={{ marginBottom: 0, width: 140 }}>
            <label>Percent</label>
            <input className="inp" inputMode="decimal"
                   value={tolerance || String(settings.data?.settings.fuel_variance_tolerance_pct ?? 2)}
                   onChange={(e) => setTolerance(e.target.value)} />
          </div>
          <p className="sub" style={{ whiteSpace: 'normal', maxWidth: '48ch', marginBottom: 6 }}>
            Measured against throughput, not the tank balance. Below about 2% you will be chasing
            measurement noise from the dip stick rather than losses.
          </p>
        </div>
      </Card>
    </>
  );
}

/* ---------------------------------------------------------------- backups -- */
interface BackupFile { file: string; bytes: number; at: string }

function Backups() {
  const qc = useQueryClient();
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [restoring, setRestoring] = useState<BackupFile | null>(null);

  const backups = useQuery<{ directory: string; keep: number; pending: boolean;
                             backups: BackupFile[] }>({
    queryKey: ['admin-backups'], queryFn: () => api.get('/api/admin/backups'),
  });
  const run = useMutation({
    mutationFn: () => api.post('/api/admin/backup'),
    onSuccess: async (r) => {
      const res = r as { bytes: number; integrity: string };
      setMsg({ text: `Backup written and verified — ${humanBytes(res.bytes)}, integrity ${res.integrity}.` });
      await qc.invalidateQueries({ queryKey: ['admin-backups'] });
    },
    onError: (e) => setMsg({ text: (e as ApiError).message, bad: true }),
  });
  const cancel = useMutation({
    mutationFn: () => api.del('/api/admin/restore'),
    onSuccess: async () => {
      setMsg({ text: 'Staged restore cancelled. The server will come back up on the current database.' });
      await qc.invalidateQueries({ queryKey: ['admin-backups'] });
    },
    onError: (e) => setMsg({ text: (e as ApiError).message, bad: true }),
  });

  return (
    <>
      {msg && <div className={`note ${msg.bad ? 'crit' : ''}`} style={{ marginBottom: 14 }} role="status">{msg.text}</div>}

      {backups.data?.pending && (
        <div className="note crit" style={{ marginBottom: 14 }}>
          <b>A restore is staged and waiting.</b> The next time this server restarts it will
          come up on that snapshot instead of the current database. Nothing has changed yet.
          <div style={{ marginTop: 10 }}>
            <Btn size="sm" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
              Cancel the restore
            </Btn>
          </div>
        </div>
      )}

      <Card title="Snapshots" flush
            right={<Btn size="sm" tone="pri" disabled={run.isPending}
                        onClick={() => run.mutate()}>{run.isPending ? 'Running…' : 'Back up now'}</Btn>}>
        {backups.isLoading ? <Loading rows={3} />
          : (backups.data?.backups.length ?? 0) === 0
            ? <Empty title="No snapshots yet" hint="Run one now, then download it and keep it elsewhere." />
            : (
              <div className="tw">
                <table className="wide">
                  <thead><tr><th>Taken</th><th className="num">Size</th><th /></tr></thead>
                  <tbody>
                    {backups.data!.backups.map((b) => (
                      <tr key={b.file}>
                        <td><span className="ttl">{when(b.at)}</span>
                            <span className="sub mono">{b.file}</span></td>
                        <td className="num">{humanBytes(b.bytes)}</td>
                        <td className="num" style={{ whiteSpace: 'nowrap' }}>
                          <DownloadLink href={`/api/admin/backups/${encodeURIComponent(b.file)}`}
                                        aria-label={`Download ${b.file}`}>Download</DownloadLink>
                          <Btn size="sm" tone="danger" style={{ marginLeft: 6 }}
                               onClick={() => setRestoring(b)}>Restore</Btn>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
      </Card>

      <div className="note warn" style={{ marginTop: 14 }}>
        Keeping the last {backups.data?.keep ?? 14} in <code>{backups.data?.directory ?? 'the data folder'}</code>.
        Every snapshot is reopened and integrity-checked as it is written.
        <b> Download one and keep it somewhere other than this PC.</b> A snapshot on the same
        disk as the database survives a mistake, but not a dead machine, a theft or a fire —
        and those are the cases the department actually needs to survive.
      </div>

      {restoring && (
        <RestoreDialog backup={restoring} onClose={() => setRestoring(null)}
                       onDone={async (text) => {
                         setRestoring(null); setMsg({ text });
                         await qc.invalidateQueries({ queryKey: ['admin-backups'] });
                       }} />
      )}
    </>
  );
}

/**
 * Restoring replaces every record the department has, so it asks for the word rather than
 * a second button. Nothing happens on the live database here — the snapshot is staged and
 * applied on the next restart.
 */
function RestoreDialog({ backup, onClose, onDone }: {
  backup: BackupFile; onClose: () => void; onDone: (msg: string) => void;
}) {
  const [typed, setTyped] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const stage = useMutation({
    mutationFn: () => api.post<{ safetyCopy: string; integrity: string }>(
      '/api/admin/restore', { file: backup.file, confirm: 'RESTORE' }),
    onSuccess: (r) => onDone(
      `Restore staged from ${backup.file}. Restart the server to apply it. `
      + `The database as it stands right now was saved to ${r.safetyCopy}.`),
    onError: (e) => setErr((e as ApiError).message),
  });

  return (
    <Modal title="Restore this snapshot" onClose={onClose}>
      {err && <div className="note crit" style={{ marginBottom: 14 }} role="alert">{err}</div>}

      <dl className="kv" style={{ marginBottom: 16 }}>
        <dt>Snapshot</dt><dd className="mono">{backup.file}</dd>
        <dt>Taken</dt><dd>{when(backup.at)}</dd>
        <dt>Size</dt><dd>{humanBytes(backup.bytes)}</dd>
      </dl>

      <div className="note crit">
        <b>Every job, reading, photo record and audit entry made since {when(backup.at)} will be
        gone.</b> The database as it stands now is copied to the backups folder first, so this
        is reversible — but only if somebody notices.
      </div>

      <div className="note" style={{ marginTop: 12 }}>
        The snapshot is integrity-checked before it is staged, and applied on the next
        restart rather than swapped underneath the running server. Nothing changes until
        you restart.
      </div>

      <Field label="Type RESTORE to confirm">
        <input className="inp" value={typed} autoFocus autoComplete="off"
               placeholder="RESTORE" onChange={(e) => setTyped(e.target.value)} />
      </Field>

      <div className="modal-foot">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn tone="danger" disabled={typed !== 'RESTORE' || stage.isPending}
             onClick={() => stage.mutate()}>
          {stage.isPending ? 'Staging…' : 'Stage the restore'}
        </Btn>
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------- audit log -- */
function AuditLog() {
  // The fastest-growing table in the database, and the one nobody ever deletes from.
  // A month at a time is not a nicety here; it is what keeps this screen openable in
  // year three on an office PC.
  const month = useMonth();
  const entries = useQuery<{ entries: { id: string; at: string; actor_name: string | null;
                                        action: string; entity_type: string; ip: string | null }[];
                             truncated: boolean; limit: number }>({
    queryKey: ['admin-audit', month.month],
    queryFn: () => api.get(`/api/admin/audit?limit=300&${month.param}`),
  });
  return (
    <>
      <MonthBar month={month.month} label={month.label} isCurrent={month.isCurrent}
                onStep={month.step} onSet={month.set} onReset={month.reset} />
      {entries.data?.truncated && (
        <div className="note warn" style={{ marginBottom: 14 }}>
          More than {entries.data.limit} entries this month — this is the most recent
          {' '}{entries.data.limit}. Export the month for the whole trail.
        </div>
      )}
      <Card title="Recent activity" flush right={<Chip>Append-only</Chip>}>
        {entries.isLoading ? <Loading rows={5} /> : (
          <div className="tw">
            <table className="wide">
              <thead><tr><th>When</th><th>Who</th><th>Action</th><th>On</th><th className="mono">From</th></tr></thead>
              <tbody>
                {(entries.data?.entries ?? []).map((e) => (
                  <tr key={e.id}>
                    <td className="mono">{when(e.at)}</td>
                    <td>{e.actor_name ?? 'System'}</td>
                    <td className="mono">{e.action}</td>
                    <td className="mono">{e.entity_type}</td>
                    <td className="mono">{e.ip ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <div className="note" style={{ marginTop: 14 }}>
        The audit table refuses <code>UPDATE</code> and <code>DELETE</code> at the database level, not
        by convention. Nobody — including an administrator — can edit this list.
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- exports -- */
interface ExportSpec { kind: string; what: string; columns: number; dated: boolean }

/**
 * The server decides what this person may export, so the list here is never a set of
 * buttons that turn out to be forbidden when pressed.
 */
function Exports() {
  // Whole-history by default, because an export is usually going into a pivot table.
  // A month is a deliberate choice, and when it is made the filename says so.
  const [scoped, setScoped] = useState(false);
  const month = useMonth();
  const q = useQuery<{ exports: ExportSpec[] }>({
    queryKey: ['exports'], queryFn: () => api.get('/api/exports'),
  });

  if (q.isLoading) return <Card><Loading rows={4} /></Card>;
  if (q.isError) return <Card><ErrorNote error={q.error} /></Card>;
  const rows = q.data?.exports ?? [];

  return (
    <Card flush title="Download a CSV"
          right={<>
            <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: '0.7812rem' }}>
              <input type="checkbox" checked={scoped} onChange={(e) => setScoped(e.target.checked)} />
              One month only
            </label>
            {scoped && (
              <input type="month" className="inp" value={month.month}
                     max={new Date().toISOString().slice(0, 7)} aria-label="Which month"
                     style={{ width: 145, minHeight: 30, padding: '4px 8px', fontSize: '0.75rem' }}
                     onChange={(e) => { if (/^\d{4}-\d{2}$/.test(e.target.value)) month.set(e.target.value); }} />
            )}
          </>}>
      {rows.length === 0
        ? <Empty title="Your role can export nothing"
                 hint="An export also needs the read permission for the screen its data comes from." />
        : (
          <div className="tw">
            <table className="wide">
              <thead><tr><th>Export</th><th>What is in it</th>
                <th className="num">Columns</th><th /></tr></thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.kind}>
                    <td><span className="ttl">{titleCase(e.kind.replace(/-/g, ' '))}</span>
                        <span className="sub mono">{e.kind}</span></td>
                    <td>{e.what}</td>
                    <td className="num">{e.columns}</td>
                    <td className="num">
                      <DownloadLink
                        href={scoped && e.dated
                          ? `/api/exports/${e.kind}?${month.param}`
                          : `/api/exports/${e.kind}`}
                        aria-label={`Download the ${e.kind} export`}>
                        Download
                      </DownloadLink>
                      {scoped && !e.dated && (
                        <span className="sub" style={{ fontSize: '0.6875rem' }}>register — always current</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      <div className="note" style={{ margin: 15 }}>
        <b>Money leaves as naira, not kobo</b>, so a column sums straight away. Files open in
        Excel with the right characters — the ₦ sign and Nigerian names survive intact — and a
        cell beginning with <span className="mono">=</span> is escaped so opening an export can
        never run something somebody typed into a job title.
      </div>
    </Card>
  );
}

/* --------------------------------------------------------------- supplies -- */

interface Supply {
  id: string; name: string; kind: 'utility' | 'genset' | 'feeder'; phases: number;
  nominal_volts: number; default_pf: number; ct_ratio: number; breaker_amps: number | null;
  is_incomer: number; is_active: number;
}

const BLANK = {
  name: '', kind: 'feeder' as Supply['kind'], phases: 3, nominalVolts: 415,
  defaultPf: 0.8, ctRatio: 1, breakerAmps: '', isIncomer: true,
};

/**
 * The things a clamp meter gets put around.
 *
 * This is the setup that makes the load figure mean anything. Get the voltage, the CT
 * ratio and — above all — the incomer flag right once, and every reading afterwards is
 * arithmetic. Get the incomer flag wrong and the building appears to be drawing twice
 * what it is, because a feeder is being added to the incomer that supplies it.
 */
function Supplies() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Supply | 'new' | null>(null);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['power-sources-all'] });

  const q = useQuery<{ sources: Supply[] }>({
    queryKey: ['power-sources-all'], queryFn: () => api.get('/api/power/sources?all=1'),
  });
  const rows = q.data?.sources ?? [];

  return (
    <>
      <Flash msg={msg} />
      <Card flush title="Supplies you clamp"
            right={<Btn size="sm" icon="plus" onClick={() => setEditing('new')}>Add a supply</Btn>}>
        {q.isLoading ? <Loading rows={4} />
          : q.isError ? <div style={{ padding: 15 }}><ErrorNote error={q.error} /></div>
          : rows.length === 0
            ? <Empty title="Nothing set up yet"
                     hint="Add the utility incomer first, then each generator's output breaker." />
            : (
              <div className="tw">
                <table className="wide">
                  <thead><tr><th>Supply</th><th>Kind</th><th className="num">Volts</th>
                    <th className="num">PF</th><th className="num">CT</th>
                    <th className="num">Breaker</th><th>Counts</th><th /></tr></thead>
                  <tbody>
                    {rows.map((s) => (
                      <tr key={s.id}>
                        <td><span className="ttl">{s.name}</span>
                            <span className="sub">{s.phases === 1 ? 'single phase' : 'three phase'}
                              {s.is_active ? '' : ' · retired'}</span></td>
                        <td>{titleCase(s.kind)}</td>
                        <td className="num">{s.nominal_volts}</td>
                        <td className="num">{s.default_pf}</td>
                        <td className="num">{s.ct_ratio}</td>
                        <td className="num">{s.breaker_amps ?? '—'}</td>
                        <td>
                          <Chip tone={s.is_incomer ? 'ok' : ''}>
                            {s.is_incomer ? 'in the total' : 'diagnostic only'}
                          </Chip>
                        </td>
                        <td className="num" style={{ whiteSpace: 'nowrap' }}>
                          <button className="btn sm" onClick={() => setEditing(s)}>Edit</button>
                          <span style={{ marginLeft: 6 }}>
                            <RetireBtn kind="power-source" id={s.id} label={s.name}
                                       active={!!s.is_active}
                                       onDone={async (m) => { setMsg({ text: m }); await refresh(); }} />
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        <div className="note" style={{ margin: 15 }}>
          <b>Only an incomer counts toward the building total.</b> A feeder — a block riser, the
          laundry board, a chiller supply — sits below an incomer that is already counted, so
          adding it would count the same amps twice. Mark those as feeders and they stay useful
          for finding an imbalance without corrupting the load figure.
        </div>
      </Card>

      <div style={{ marginTop: 14 }}><Tanks /></div>

      {editing && (
        <SupplyDialog
          supply={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await qc.invalidateQueries({ queryKey: ['power-sources-all'] });
            await qc.invalidateQueries({ queryKey: ['power-sources'] });
            await qc.invalidateQueries({ queryKey: ['power-load'] });
          }} />
      )}
    </>
  );
}

function SupplyDialog({ supply, onClose, onSaved }:
  { supply: Supply | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState(() => supply ? {
    name: supply.name, kind: supply.kind, phases: supply.phases,
    nominalVolts: supply.nominal_volts, defaultPf: supply.default_pf, ctRatio: supply.ct_ratio,
    breakerAmps: supply.breaker_amps == null ? '' : String(supply.breaker_amps),
    isIncomer: supply.is_incomer === 1,
  } : { ...BLANK });

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: f.name, kind: f.kind, phases: f.phases === 1 ? 1 : 3,
        nominalVolts: f.nominalVolts, defaultPf: f.defaultPf, ctRatio: f.ctRatio,
        breakerAmps: f.breakerAmps ? Number(f.breakerAmps) : undefined,
        isIncomer: f.kind === 'feeder' ? false : f.isIncomer,
      };
      return supply
        ? api.patch(`/api/power/sources/${supply.id}`, body)
        : api.post('/api/power/sources', body);
    },
    onSuccess: onSaved,
  });
  const err = save.error as ApiError | null;

  return (
    <Modal title={supply ? `Edit ${supply.name}` : 'Add a supply'} onClose={onClose}>
      <Field label="Name" hint="What somebody would call it standing in front of it.">
        <input className="inp" autoFocus value={f.name}
               onChange={(e) => setF({ ...f, name: e.target.value })} />
      </Field>
      <div className="grid g2" style={{ gap: 10 }}>
        <Field label="Kind">
          <select className="inp" value={f.kind}
                  onChange={(e) => setF({ ...f, kind: e.target.value as Supply['kind'] })}>
            <option value="utility">Utility incomer</option>
            <option value="genset">Generator output</option>
            <option value="feeder">Feeder / sub-main</option>
          </select>
        </Field>
        <Field label="Phases">
          <select className="inp" value={f.phases}
                  onChange={(e) => setF({ ...f, phases: Number(e.target.value) })}>
            <option value={3}>Three phase</option>
            <option value={1}>Single phase</option>
          </select>
        </Field>
      </div>
      <div className="grid g3" style={{ gap: 10 }}>
        <Field label="Volts" hint={f.phases === 3 ? 'Line to line' : 'Line to neutral'}>
          <input className="inp" inputMode="decimal" value={f.nominalVolts}
                 onChange={(e) => setF({ ...f, nominalVolts: Number(e.target.value) || 0 })} />
        </Field>
        <Field label="Power factor" hint="0.8 is the usual assumption">
          <input className="inp" inputMode="decimal" value={f.defaultPf}
                 onChange={(e) => setF({ ...f, defaultPf: Number(e.target.value) || 0 })} />
        </Field>
        <Field label="CT ratio" hint="1 when clamping the cable itself">
          <input className="inp" inputMode="decimal" value={f.ctRatio}
                 onChange={(e) => setF({ ...f, ctRatio: Number(e.target.value) || 0 })} />
        </Field>
      </div>
      <Field label="Breaker rating in amps" hint="Optional. Used to warn when a phase is close to it.">
        <input className="inp" inputMode="decimal" value={f.breakerAmps}
               onChange={(e) => setF({ ...f, breakerAmps: e.target.value })} />
      </Field>
      {f.kind !== 'feeder' && (
        <Field label="Counts toward the building total"
               hint="Leave this on unless this supply sits below another one you also clamp.">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={f.isIncomer}
                   onChange={(e) => setF({ ...f, isIncomer: e.target.checked })} />
            <span style={{ fontSize: '0.8125rem' }}>Yes, this is an incomer</span>
          </label>
        </Field>
      )}
      {f.kind === 'feeder' && (
        <div className="note" style={{ marginBottom: 12 }}>
          A feeder never counts toward the building total — it is already inside whatever
          incomer supplies it.
        </div>
      )}
      {err && <div className="note crit" style={{ marginBottom: 12 }} role="alert">{err.message}</div>}
      <Btn tone="pri" style={{ width: '100%' }}
           disabled={f.name.trim().length < 2 || !f.nominalVolts || !f.ctRatio || save.isPending}
           onClick={() => save.mutate()}>
        {save.isPending ? 'Saving…' : supply ? 'Save changes' : 'Add supply'}
      </Btn>
    </Modal>
  );
}

/* ----------------------------------------------------------------- places -- */

interface Place {
  id: string; parent_id: string | null; type: string; code: string; name: string; sort_order: number;
  is_active?: number;
}

const PLACE_TYPES = [
  ['block', 'Block'], ['floor', 'Floor'], ['plant_room', 'Plant room'],
  ['common_area', 'Common area'], ['external', 'External'],
] as const;

/**
 * Blocks, floors, plant rooms — everywhere a job can be raised against that is not
 * somebody's apartment.
 *
 * The first-run wizard creates the site itself, because a database with no location at
 * all cannot accept a single common-area job. Everything below it is the department's
 * own geography and gets typed in here: the generator house, the roof plant, the pump
 * room, the block risers.
 */
function Places() {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Place | null>(null);
  const [showRetired, setShowRetired] = useState(false);
  const [placeMsg, setPlaceMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  // Invalidating the prefix refreshes every picker in the app as well as this list.
  const refreshPlaces = () => qc.invalidateQueries({ queryKey: ['locations'] });

  // Retired places come too, so they can be brought back; they are only drawn on request.
  const q = useQuery<{ locations: Place[] }>({
    queryKey: ['locations', 'all'], queryFn: () => api.get('/api/locations?all=1'),
  });
  const everything = q.data?.locations ?? [];
  const retiredCount = everything.filter((l) => l.is_active === 0).length;
  const all = showRetired ? everything : everything.filter((l) => l.is_active !== 0);
  const live = everything.filter((l) => l.is_active !== 0);
  const site = all.find((l) => l.type === 'site');
  // With retired places hidden, a live place under a retired parent is drawn at the top
  // level rather than vanishing along with it.
  const shown = new Set(all.map((l) => l.id));
  const byParent = (id: string | null) =>
    all.filter((l) => (id === null ? !l.parent_id || !shown.has(l.parent_id) : l.parent_id === id));

  const rows: { place: Place; depth: number }[] = [];
  const walk = (parent: string | null, depth: number): void => {
    for (const place of byParent(parent)) { rows.push({ place, depth }); walk(place.id, depth + 1); }
  };
  walk(null, 0);

  return (
    <>
      <Flash msg={placeMsg} />
      <Card flush title="Places"
            right={<>
              {retiredCount > 0 && (
                <Btn size="sm" tone={showRetired ? 'on' : undefined}
                     onClick={() => setShowRetired((v) => !v)}>
                  {showRetired ? 'Hide retired' : `Show retired (${retiredCount})`}
                </Btn>
              )}
              <Btn size="sm" icon="plus" onClick={() => setAdding(true)}>Add a place</Btn>
            </>}>
        {q.isLoading ? <Loading rows={4} />
          : q.isError ? <div style={{ padding: 15 }}><ErrorNote error={q.error} /></div>
          : rows.length === 0
            ? <Empty title="No places yet" hint="The site should have been created at setup. Add one to continue." />
            : (
              <div className="tw">
                <table className="wide">
                  <thead><tr><th>Place</th><th>Kind</th><th className="mono">Code</th><th /></tr></thead>
                  <tbody>
                    {rows.map(({ place, depth }) => (
                      <tr key={place.id}>
                        <td style={{ paddingLeft: 15 + depth * 22 }}>
                          <span className="ttl">{place.name}
                            {place.is_active === 0 && <> <Chip tone="warn">Retired</Chip></>}</span>
                          {isSiteRoot(place) && <span className="sub">the property itself</span>}
                        </td>
                        <td>{titleCase(place.type)}</td>
                        <td className="mono">{place.code}</td>
                        <td className="num" style={{ whiteSpace: 'nowrap' }}>
                          <Btn size="sm" onClick={() => setEditing(place)}>Edit</Btn>{' '}
                          {/* The property itself is neither retirable nor deletable —
                              everything hangs off it. */}
                          {!isSiteRoot(place) && <>
                            <RetireBtn kind="location" id={place.id} label={place.name}
                                       active={place.is_active !== 0}
                                       onDone={async (m) => { setPlaceMsg({ text: m }); await refreshPlaces(); }} />{' '}
                            <DeleteBtn kind="location" id={place.id} label={place.name}
                                       onDone={async (m) => { setPlaceMsg({ text: m }); await refreshPlaces(); }} />
                          </>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        <div className="note" style={{ margin: 15 }}>
          A job has to hang off <b>something</b> — an asset, an apartment or a place. Plant
          rooms earn their place here: "generator house" on a job is the difference between a
          history you can read in a year and a list of jobs that happened somewhere.
        </div>
      </Card>

      {adding && (
        <PlaceDialog places={live} defaultParent={site?.id ?? null}
                     onClose={() => setAdding(false)}
                     onSaved={async () => {
                       setAdding(false);
                       await refreshPlaces();
                     }} />
      )}
      {editing && (
        <PlaceDialog places={everything} place={editing} defaultParent={editing.parent_id}
                     onClose={() => setEditing(null)}
                     onSaved={async () => {
                       setPlaceMsg({ text: `${editing.name} saved.` });
                       setEditing(null);
                       await refreshPlaces();
                     }} />
      )}
    </>
  );
}

/** The site at the root of the tree: renamed, never moved, retired or deleted. */
function isSiteRoot(p: Place): boolean {
  return p.type === 'site' && !p.parent_id;
}

/** Everything below a place, so the "sits inside" list can leave out moves that would loop. */
function descendantsOf(id: string, places: Place[]): Set<string> {
  const out = new Set<string>([id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of places) {
      if (p.parent_id && out.has(p.parent_id) && !out.has(p.id)) { out.add(p.id); grew = true; }
    }
  }
  return out;
}

function PlaceDialog({ places, place, defaultParent, onClose, onSaved }:
  { places: Place[]; place?: Place; defaultParent: string | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    name: place?.name ?? '', code: place?.code ?? '', type: place?.type ?? 'plant_room',
    parentId: defaultParent ?? '',
  });
  const isRoot = !!place && isSiteRoot(place);

  // Typing a code by hand is a job nobody wants and a duplicate waiting to happen.
  const suggested = f.name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20);
  const code = f.code.trim() || suggested;
  // A place cannot sit inside itself or anything inside it; the server refuses it too.
  const blocked = place ? descendantsOf(place.id, places) : new Set<string>();
  const parents = places.filter((p) => !blocked.has(p.id));
  // Kinds the add list does not offer (the site, an apartment) still show when editing one.
  const types: readonly (readonly [string, string])[] =
    place && !PLACE_TYPES.some(([v]) => v === place.type)
      ? [[place.type, titleCase(place.type)], ...PLACE_TYPES]
      : PLACE_TYPES;

  const save = useMutation({
    mutationFn: () => place
      ? api.patch(`/api/locations/${place.id}`, {
          name: f.name.trim(), code,
          ...(isRoot ? {} : { type: f.type, parentId: f.parentId || null }),
        })
      : api.post('/api/locations', {
          name: f.name.trim(), code, type: f.type,
          parentId: f.parentId || undefined,
        }),
    onSuccess: onSaved,
  });
  const err = save.error as ApiError | null;

  return (
    <Modal title={place ? `Edit ${place.name}` : 'Add a place'} onClose={onClose}>
      <Field label="Name" hint="What the team calls it out loud.">
        <input className="inp" autoFocus value={f.name}
               onChange={(e) => setF({ ...f, name: e.target.value })} />
      </Field>
      <div className="grid g2" style={{ gap: 10 }}>
        <Field label="Kind">
          <select className="inp" value={f.type} disabled={isRoot}
                  onChange={(e) => setF({ ...f, type: e.target.value })}>
            {types.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>
        <Field label="Sits inside">
          <select className="inp" value={f.parentId} disabled={isRoot}
                  onChange={(e) => setF({ ...f, parentId: e.target.value })}>
            <option value="">Nothing — top level</option>
            {parents.map((p) => (
              <option key={p.id} value={p.id}>{p.name}{p.is_active === 0 ? ' (retired)' : ''}</option>))}
          </select>
        </Field>
      </div>
      <Field label="Code" hint={suggested ? `Leave blank to use ${suggested}` : 'A short unique code.'}>
        <input className="inp" value={f.code} placeholder={suggested}
               onChange={(e) => setF({ ...f, code: e.target.value })} />
      </Field>
      {err && <div className="note crit" style={{ marginBottom: 12 }} role="alert">{err.message}</div>}
      <Btn tone="pri" style={{ width: '100%' }}
           disabled={f.name.trim().length < 2 || !code || save.isPending}
           onClick={() => save.mutate()}>
        {save.isPending ? 'Saving…' : place ? 'Save changes' : 'Add place'}
      </Btn>
    </Modal>
  );
}

/* ------------------------------------------------------------------ staff -- */

interface Person {
  id: string; staff_no: string | null; first_name: string; last_name: string;
  phone: string | null; trade: string | null; team_id: string | null; team_name: string | null;
  employment_type: string | null; is_active: number;
}
interface Team {
  id: string; name: string; default_trade: string | null;
  team_lead_staff_id: string | null; supervisor_staff_id: string | null;
  team_lead_name: string | null; supervisor_name: string | null; people: number;
}

const TRADES = ['electrical', 'plumbing', 'hvac', 'carpentry', 'civil', 'mechanical', 'general'];

/**
 * The people who do the work.
 *
 * A staff record is not a login and the two are deliberately separate: a job is assigned
 * to a person who is on shift, and plenty of hands on a property never sign in to
 * anything. Nothing can be assigned to somebody with no staff record — so on a fresh
 * install this is the screen that has to be filled in before the job board does anything
 * useful at all.
 */
function People() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Person | 'new' | null>(null);
  const [addingTeam, setAddingTeam] = useState(false);
  const [editingTeam, setEditingTeam] = useState<Team | null>(null);
  const [showLeft, setShowLeft] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);

  // People who have left come too, so they can be brought back; drawn only on request.
  const q = useQuery<{ staff: Person[]; teams: Team[] }>({
    queryKey: ['staff', 'all'], queryFn: () => api.get('/api/staff?all=1'),
  });
  const everyone = q.data?.staff ?? [];
  const staff = everyone.filter((p) => p.is_active !== 0);
  const leftCount = everyone.length - staff.length;
  const listed = showLeft ? everyone : staff;
  const teams = q.data?.teams ?? [];
  // The prefix refreshes the Users tab's picker as well as this list.
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ['staff'] }); };

  return (
    <>
      <Flash msg={msg} />
      <Card flush title="People on the floor"
            right={<>
              {leftCount > 0 && (
                <Btn size="sm" tone={showLeft ? 'on' : undefined} onClick={() => setShowLeft((v) => !v)}>
                  {showLeft ? 'Hide retired' : `Show retired (${leftCount})`}
                </Btn>
              )}
              <Btn size="sm" onClick={() => setAddingTeam(true)}>Add a team</Btn>
              <Btn size="sm" tone="pri" icon="plus" onClick={() => setEditing('new')}>Add a person</Btn>
            </>}>
        {q.isLoading ? <Loading rows={4} />
          : q.isError ? <div style={{ padding: 15 }}><ErrorNote error={q.error} /></div>
          : staff.length === 0
            ? <Empty title="Nobody on the list yet"
                     hint="A job can only be assigned to somebody who is rostered, and only people on this list can be rostered. Start here." />
            : (
              <div className="tw">
                <table className="wide">
                  <thead><tr><th>Name</th><th>Trade</th><th>Team</th><th>Phone</th>
                    <th className="mono">No.</th><th /></tr></thead>
                  <tbody>
                    {listed.map((p) => (
                      <tr key={p.id}>
                        <td><span className="ttl">{p.first_name} {p.last_name}
                              {p.is_active === 0 && <> <Chip tone="warn">Retired</Chip></>}</span>
                            <span className="sub">{titleCase(p.employment_type ?? 'permanent')}</span></td>
                        <td>{p.trade ? titleCase(p.trade) : '—'}</td>
                        <td>{p.team_name ?? <span className="sub">no team</span>}</td>
                        <td className="mono">{p.phone ?? '—'}</td>
                        <td className="mono">{p.staff_no ?? '—'}</td>
                        <td className="num" style={{ whiteSpace: 'nowrap' }}>
                          <button className="btn sm" onClick={() => setEditing(p)}>Edit</button>{' '}
                          <RetireBtn kind="staff" id={p.id} label={`${p.first_name} ${p.last_name}`}
                                     active={p.is_active !== 0}
                                     onDone={async (m) => { setMsg({ text: m }); await refresh(); }} />{' '}
                          <DeleteBtn kind="staff" id={p.id} label={`${p.first_name} ${p.last_name}`}
                                     onDone={async (m) => { setMsg({ text: m }); await refresh(); }} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        <div className="note" style={{ margin: 15 }}>
          <b>A person here and an account under Users are two different things.</b> This list is
          who can be put on a shift and given a job. An account is who can sign in. Link the two
          when you create the account, and that person sees their own jobs when they log in.
          {' '}<b>Retire</b> somebody who has left — their jobs and roster history stay readable.
          <b> Delete</b> is only for a person added by mistake who has nothing recorded against them.
        </div>
      </Card>

      {teams.length > 0 && (
        <div style={{ marginTop: 14 }}><Card title="Teams" flush>
          <div className="tw">
            <table className="wide">
              <thead><tr><th>Team</th><th>Default trade</th><th>Team lead</th>
                <th className="num">People</th><th /></tr></thead>
              <tbody>
                {teams.map((t) => (
                  <tr key={t.id}>
                    <td><span className="ttl">{t.name}</span></td>
                    <td>{t.default_trade ? titleCase(t.default_trade) : '—'}</td>
                    {/* A team with no lead looks fine and is quietly broken: nobody is
                        first in the escalation chain and nobody is told when the team
                        finishes a job. Say so here rather than letting it pass. */}
                    <td>{t.team_lead_name
                      ?? <Chip tone="warn">Nobody — escalations skip this team</Chip>}</td>
                    <td className="num">{staff.filter((p) => p.team_id === t.id).length}</td>
                    <td className="num" style={{ whiteSpace: 'nowrap' }}>
                      <Btn size="sm" onClick={() => setEditingTeam(t)}>Edit</Btn>
                      <span style={{ marginLeft: 6 }}>
                        <RetireBtn kind="team" id={t.id} label={t.name}
                                   onDone={async (m) => { setMsg({ text: m }); await refresh(); }} />
                      </span>
                      <span style={{ marginLeft: 6 }}>
                        <DeleteBtn kind="team" id={t.id} label={t.name}
                                   onDone={async (m) => { setMsg({ text: m }); await refresh(); }} />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card></div>
      )}

      {editing && (
        <PersonDialog person={editing === 'new' ? null : editing} teams={teams}
                      onClose={() => setEditing(null)}
                      onSaved={async () => { setEditing(null); await refresh(); }} />
      )}
      {addingTeam && (
        <TeamDialog onClose={() => setAddingTeam(false)}
                    onSaved={async () => { setAddingTeam(false); await refresh(); }} />
      )}
      {editingTeam && (
        <EditTeamDialog team={editingTeam} staff={staff}
                        onClose={() => setEditingTeam(null)}
                        onSaved={async () => { setEditingTeam(null); await refresh(); }} />
      )}
    </>
  );
}

function PersonDialog({ person, teams, onClose, onSaved }:
  { person: Person | null; teams: Team[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    firstName: person?.first_name ?? '', lastName: person?.last_name ?? '',
    trade: person?.trade ?? '', teamId: person?.team_id ?? '', phone: person?.phone ?? '',
    staffNo: person?.staff_no ?? '', employmentType: person?.employment_type ?? 'permanent',
    isActive: person ? person.is_active === 1 : true,
  });

  const save = useMutation({
    mutationFn: () => {
      const body = {
        firstName: f.firstName.trim(), lastName: f.lastName.trim(),
        trade: f.trade || undefined, teamId: f.teamId || undefined,
        phone: f.phone || undefined, staffNo: f.staffNo || undefined,
        employmentType: f.employmentType as 'permanent' | 'contract' | 'casual' | 'vendor',
        isActive: f.isActive,
      };
      return person ? api.patch(`/api/staff/${person.id}`, body) : api.post('/api/staff', body);
    },
    onSuccess: onSaved,
  });
  const err = save.error as ApiError | null;

  return (
    <Modal title={person ? `${person.first_name} ${person.last_name}` : 'Add a person'} onClose={onClose}>
      <div className="grid g2" style={{ gap: 10 }}>
        <Field label="First name">
          <input className="inp" autoFocus value={f.firstName}
                 onChange={(e) => setF({ ...f, firstName: e.target.value })} />
        </Field>
        <Field label="Last name">
          <input className="inp" value={f.lastName}
                 onChange={(e) => setF({ ...f, lastName: e.target.value })} />
        </Field>
      </div>
      <div className="grid g2" style={{ gap: 10 }}>
        <Field label="Trade" hint="Used to route jobs to the right hands.">
          <select className="inp" value={f.trade} onChange={(e) => setF({ ...f, trade: e.target.value })}>
            <option value="">Not set</option>
            {TRADES.map((t) => <option key={t} value={t}>{titleCase(t)}</option>)}
          </select>
        </Field>
        <Field label="Team">
          <select className="inp" value={f.teamId} onChange={(e) => setF({ ...f, teamId: e.target.value })}>
            <option value="">No team</option>
            {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Field>
      </div>
      <div className="grid g3" style={{ gap: 10 }}>
        <Field label="Phone">
          <input className="inp" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        </Field>
        <Field label="Staff number" hint="Optional">
          <input className="inp" value={f.staffNo} onChange={(e) => setF({ ...f, staffNo: e.target.value })} />
        </Field>
        <Field label="Employment">
          <select className="inp" value={f.employmentType}
                  onChange={(e) => setF({ ...f, employmentType: e.target.value })}>
            {['permanent', 'contract', 'casual', 'vendor'].map((t) =>
              <option key={t} value={t}>{titleCase(t)}</option>)}
          </select>
        </Field>
      </div>
      {person && (
        <Field label="Still working here"
               hint="Turning this off keeps their history and takes them off the roster.">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={f.isActive}
                   onChange={(e) => setF({ ...f, isActive: e.target.checked })} />
            <span style={{ fontSize: '0.8125rem' }}>On the team</span>
          </label>
        </Field>
      )}
      {err && <div className="note crit" style={{ marginBottom: 12 }} role="alert">{err.message}</div>}
      <Btn tone="pri" style={{ width: '100%' }}
           disabled={f.firstName.trim().length < 1 || f.lastName.trim().length < 1 || save.isPending}
           onClick={() => save.mutate()}>
        {save.isPending ? 'Saving…' : person ? 'Save changes' : 'Add person'}
      </Btn>
    </Modal>
  );
}

function TeamDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: '', defaultTrade: '' });
  const save = useMutation({
    mutationFn: () => api.post('/api/teams', {
      name: f.name.trim(), defaultTrade: f.defaultTrade || undefined,
    }),
    onSuccess: onSaved,
  });
  const err = save.error as ApiError | null;
  return (
    <Modal title="Add a team" onClose={onClose}>
      <Field label="Name" hint="Electrical, Mechanical, Civil — however the department is split.">
        <input className="inp" autoFocus value={f.name}
               onChange={(e) => setF({ ...f, name: e.target.value })} />
      </Field>
      <Field label="Default trade">
        <select className="inp" value={f.defaultTrade}
                onChange={(e) => setF({ ...f, defaultTrade: e.target.value })}>
          <option value="">Not set</option>
          {TRADES.map((t) => <option key={t} value={t}>{titleCase(t)}</option>)}
        </select>
      </Field>
      {err && <div className="note crit" style={{ marginBottom: 12 }} role="alert">{err.message}</div>}
      <Btn tone="pri" style={{ width: '100%' }} disabled={f.name.trim().length < 2 || save.isPending}
           onClick={() => save.mutate()}>
        {save.isPending ? 'Saving…' : 'Add team'}
      </Btn>
    </Modal>
  );
}

/**
 * Editing a team — and in particular naming its lead.
 *
 * The two columns this writes have existed since the first migration and could only ever
 * be set by the demo seed. A property that set itself up through the browser ended up with
 * teams that had no lead, which silently switched off the first step of the escalation
 * chain and, later, the notice that tells a team lead their team has finished something
 * and it is waiting on their signature. Both failures look like nothing happening.
 */
function EditTeamDialog({ team, staff, onClose, onSaved }: {
  team: Team; staff: Person[]; onClose: () => void; onSaved: () => void;
}) {
  const [f, setF] = useState({
    name: team.name,
    defaultTrade: team.default_trade ?? '',
    teamLeadStaffId: team.team_lead_staff_id ?? '',
    supervisorStaffId: team.supervisor_staff_id ?? '',
  });
  const save = useMutation({
    mutationFn: () => api.patch(`/api/teams/${team.id}`, {
      name: f.name.trim(),
      defaultTrade: f.defaultTrade || null,
      teamLeadStaffId: f.teamLeadStaffId || null,
      supervisorStaffId: f.supervisorStaffId || null,
    }),
    onSuccess: onSaved,
  });
  const err = save.error as ApiError | null;
  // The people actually in this team come first: a lead from another team is possible but
  // is nearly always a mistake, so it takes a deliberate scroll past the divider.
  const inTeam = staff.filter((p) => p.team_id === team.id);
  const others = staff.filter((p) => p.team_id !== team.id);

  return (
    <Modal title={`${team.name} · team`} onClose={onClose}>
      <Field label="Name">
        <input className="inp" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      </Field>
      <Field label="Default trade">
        <select className="inp" value={f.defaultTrade}
                onChange={(e) => setF({ ...f, defaultTrade: e.target.value })}>
          <option value="">Not set</option>
          {TRADES.map((t) => <option key={t} value={t}>{titleCase(t)}</option>)}
        </select>
      </Field>
      <Field label="Team lead"
             hint="First in line when a job on this team is not accepted in time, and the person told when the team completes work that needs signing off.">
        <select className="inp" value={f.teamLeadStaffId}
                onChange={(e) => setF({ ...f, teamLeadStaffId: e.target.value })}>
          <option value="">Nobody</option>
          {inTeam.map((p) => (
            <option key={p.id} value={p.id}>{p.first_name} {p.last_name}</option>))}
          {others.length > 0 && <option disabled>── not in this team ──</option>}
          {others.map((p) => (
            <option key={p.id} value={p.id}>{p.first_name} {p.last_name}</option>))}
        </select>
      </Field>
      <Field label="Supervisor" hint="Second in line, after the team lead.">
        <select className="inp" value={f.supervisorStaffId}
                onChange={(e) => setF({ ...f, supervisorStaffId: e.target.value })}>
          <option value="">Nobody</option>
          {staff.map((p) => (
            <option key={p.id} value={p.id}>{p.first_name} {p.last_name}</option>))}
        </select>
      </Field>
      {!f.teamLeadStaffId && (
        <div className="note warn" style={{ marginBottom: 12 }}>
          With nobody named, a job on this team that passes its response deadline escalates
          straight past the floor, and nobody is told when the team finishes work that still
          needs verifying.
        </div>
      )}
      {err && <div className="note crit" style={{ marginBottom: 12 }} role="alert">{err.message}</div>}
      <Btn tone="pri" style={{ width: '100%' }}
           disabled={f.name.trim().length < 2 || save.isPending}
           onClick={() => save.mutate()}>
        {save.isPending ? 'Saving…' : 'Save team'}
      </Btn>
    </Modal>
  );
}

/* ------------------------------------------------------------------ tanks -- */

interface TankRow {
  id: string; name: string; kind: string; capacity_l: number; min_level_l: number;
  current_level_l: number | null; dip_chart_json: string | null;
}

/**
 * Diesel tanks.
 *
 * Nothing in the fuel module works without one: no dip, no delivery, no reconciliation.
 * It sits beside the electrical supplies because both are the same job — telling the
 * system what is physically in the plant room before anybody is asked to take a reading
 * from it.
 */
function Tanks() {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [tankMsg, setTankMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const refreshTanks = () => qc.invalidateQueries({ queryKey: ['tanks'] });
  const q = useQuery<{ tanks: TankRow[] }>({
    queryKey: ['tanks'], queryFn: () => api.get('/api/fuel/tanks'),
  });
  const tanks = q.data?.tanks ?? [];

  return (
    <>
      <Flash msg={tankMsg} />
      <Card flush title="Diesel tanks"
            right={<Btn size="sm" icon="plus" onClick={() => setAdding(true)}>Add a tank</Btn>}>
        {q.isLoading ? <Loading rows={3} />
          : q.isError ? <div style={{ padding: 15 }}><ErrorNote error={q.error} /></div>
          : tanks.length === 0
            ? <Empty title="No tanks yet"
                     hint="Dips, deliveries and reconciliation all hang off a tank. Add the bulk tank first." />
            : (
              <div className="tw">
                <table className="wide">
                  <thead><tr><th>Tank</th><th>Kind</th><th className="num">Capacity</th>
                    <th className="num">Minimum</th><th>Calibration</th><th /></tr></thead>
                  <tbody>
                    {tanks.map((t) => (
                      <tr key={t.id}>
                        <td><span className="ttl">{t.name}</span>
                            <span className="sub">
                              {t.current_level_l == null ? 'never dipped'
                                : `${Math.round(t.current_level_l).toLocaleString()} L on hand`}
                            </span></td>
                        <td>{titleCase(t.kind)}</td>
                        <td className="num">{t.capacity_l.toLocaleString()} L</td>
                        <td className="num">{t.min_level_l.toLocaleString()} L</td>
                        <td>
                          <Chip tone={t.dip_chart_json ? 'ok' : 'warn'} lamp>
                            {t.dip_chart_json ? 'chart loaded' : 'litres only'}
                          </Chip>
                        </td>
                        <td className="num">
                          <RetireBtn kind="tank" id={t.id} label={t.name}
                                     onDone={async (m) => { setTankMsg({ text: m }); await refreshTanks(); }} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        <div className="note" style={{ margin: 15 }}>
          <b>A horizontal cylinder is not linear.</b> Without a calibration chart — a list of
          millimetre-to-litre readings for that tank's shape — dips have to be entered in litres,
          and treating millimetres as proportional carries a standing 5–8% error, which is larger
          than the loss you are trying to catch.
        </div>
      </Card>

      {adding && (
        <TankDialog onClose={() => setAdding(false)}
                    onSaved={async () => {
                      setAdding(false);
                      await qc.invalidateQueries({ queryKey: ['tanks'] });
                      await qc.invalidateQueries({ queryKey: ['plant'] });
                    }} />
      )}
    </>
  );
}

function TankDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: '', kind: 'bulk', capacityL: '', minLevelL: '', chart: '' });

  // "0=0, 500=2000, 1000=5000" is what somebody has on a laminated card by the tank.
  const parsedChart = (() => {
    const text = f.chart.trim();
    if (!text) return { points: null as [number, number][] | null, error: null as string | null };
    const points: [number, number][] = [];
    for (const part of text.split(/[,\n]+/).map((x) => x.trim()).filter(Boolean)) {
      const m = /^(-?[\d.]+)\s*[=:]\s*(-?[\d.]+)$/.exec(part);
      if (!m) return { points: null, error: `"${part}" is not a millimetre=litres pair.` };
      points.push([Number(m[1]), Number(m[2])]);
    }
    if (points.length < 2) return { points: null, error: 'A chart needs at least two points.' };
    return { points, error: null };
  })();

  const save = useMutation({
    mutationFn: () => api.post('/api/fuel/tanks', {
      name: f.name.trim(), kind: f.kind,
      capacityL: Number(f.capacityL),
      minLevelL: f.minLevelL ? Number(f.minLevelL) : undefined,
      dipChart: parsedChart.points ?? undefined,
    }),
    onSuccess: onSaved,
  });
  const err = save.error as ApiError | null;
  const ready = f.name.trim().length > 1 && Number(f.capacityL) > 0 && !parsedChart.error;

  return (
    <Modal title="Add a tank" onClose={onClose}>
      <Field label="Name" hint="Bulk tank, day tank, the drum by the pump house.">
        <input className="inp" autoFocus value={f.name}
               onChange={(e) => setF({ ...f, name: e.target.value })} />
      </Field>
      <div className="grid g3" style={{ gap: 10 }}>
        <Field label="Kind">
          <select className="inp" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            <option value="bulk">Bulk</option>
            <option value="day_tank">Day tank</option>
            <option value="drum">Drum</option>
          </select>
        </Field>
        <Field label="Capacity in litres">
          <input className="inp" inputMode="decimal" value={f.capacityL}
                 onChange={(e) => setF({ ...f, capacityL: e.target.value })} />
        </Field>
        <Field label="Minimum" hint="Below this, order.">
          <input className="inp" inputMode="decimal" value={f.minLevelL}
                 onChange={(e) => setF({ ...f, minLevelL: e.target.value })} />
        </Field>
      </div>
      <Field label="Calibration chart"
             hint="Millimetres=litres, one pair per line or separated by commas. Leave blank to dip in litres.">
        <textarea className="inp" rows={4} value={f.chart}
                  placeholder={'0=0\n500=2000\n1000=5000\n1500=7500'}
                  onChange={(e) => setF({ ...f, chart: e.target.value })} />
      </Field>
      {parsedChart.error && (
        <div className="note warn" style={{ marginBottom: 12 }}>{parsedChart.error}</div>
      )}
      {parsedChart.points && (
        <div className="note" style={{ marginBottom: 12 }}>
          {parsedChart.points.length} points read, from {parsedChart.points[0]![0]} mm
          to {parsedChart.points[parsedChart.points.length - 1]![0]} mm.
        </div>
      )}
      {err && <div className="note crit" style={{ marginBottom: 12 }} role="alert">{err.message}</div>}
      <Btn tone="pri" style={{ width: '100%' }} disabled={!ready || save.isPending}
           onClick={() => save.mutate()}>
        {save.isPending ? 'Saving…' : 'Add tank'}
      </Btn>
    </Modal>
  );
}

/* --------------------------------------------------------------- host PC -- */

type Known<T> = { state: T | 'unknown'; why?: string; detail?: string };

interface Nic {
  name: string; address: string; netmask: string; mac: string;
  kind: 'ethernet' | 'wifi' | 'virtual' | 'other';
  linkLocal: boolean; privateRange: boolean; ssid: string | null; dhcp: boolean | null;
  recommended: boolean; note: string | null; usable: boolean;
}
interface HostStatus {
  version: string; startedAt: string; uptimeSeconds: number; node: string; platform: string;
  port: number; bindsTo: string;
  network: { nics: Nic[]; advertise: string | null; chosen: boolean; ssid: string | null;
             platform: string };
  advertise: string | null;
  boundTo: string | null;
  addresses: { label: string; url: string; kind: 'local' | 'lan' }[];
  pendingPort: number | null;
  dataDir: string; dataBytes: number; attachmentCount: number; freeBytes: number | null;
  backups: { count: number; newestAt: string | null; newestFile: string | null;
             newestBytes: number | null; totalBytes: number; ageHours: number | null };
  bootService: Known<'registered' | 'missing'>;
  firewall: Known<'open' | 'missing'>;
  isWindows: boolean;
}

function uptimeWords(s: number): string {
  if (s < 90) return `${Math.round(s)} seconds`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} minutes`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hours`;
  return `${Math.round(h / 24)} days`;
}

/**
 * The host PC, from the inside.
 *
 * Every question somebody asks on install day and cannot otherwise answer: what address
 * do I hand out, is this running as a service or just in a window somebody will close,
 * did the firewall rule take, when did it last back up. It reports what can be
 * established and says plainly when it cannot tell — a status screen that guesses is
 * worse than none, because somebody acts on it.
 *
 * It cannot start or stop anything. This page is served by the server it would be
 * reporting on, so a stop button would be a button that destroys the page pressing it,
 * and a start button could only ever appear when it was not needed. Those live in the
 * launcher on the host PC, and the commands are here to copy.
 */
interface TlsState {
  enabled: boolean; generated: boolean; httpsPort: number;
  fingerprint?: string; expiresAt?: string | null; daysLeft?: number | null;
  covers?: string[]; addresses: string[]; uncovered?: string[];
}

/**
 * The property's own certificate.
 *
 * Why it is worth the trouble: a browser only treats a page as a *secure context* over
 * HTTPS, and without one there are no background notifications and no camera API. On a
 * LAN there is nobody to buy a certificate from for 192.168.1.50 — so the property signs
 * its own, and the department installs that root on its phones once.
 *
 * The fingerprint is the part that matters. Installing a root is handing a key to
 * whatever handed it to you, so the six pairs of hex here are what somebody checks
 * against the six pairs their phone shows them.
 */
function OwnCertificate() {
  const qc = useQueryClient();
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const q = useQuery<TlsState>({ queryKey: ['tls'], queryFn: () => api.get('/api/admin/tls') });
  const host = useQuery<HostStatus>({ queryKey: ['host'], queryFn: () => api.get('/api/admin/host') });
  const save = useMutation({
    mutationFn: (enabled: boolean) => api.post<{ message: string }>('/api/admin/host/https', { enabled }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['tls'] });
      setMsg({ text: r.message });
    },
    onError: (e) => setMsg({ text: (e as ApiError).message, bad: true }),
  });

  if (q.isLoading || !q.data) return null;
  const t = q.data;
  const address = host.data?.advertise ?? t.addresses[0];

  return (
    <div style={{ marginTop: 14 }}>
      <Flash msg={msg} />
      <Card title="This property's own certificate"
            right={<Chip tone={t.enabled ? 'ok' : ''} lamp>{t.enabled ? 'On' : 'Off'}</Chip>}>
        <p style={{ margin: '0 0 12px', fontSize: '0.8438rem', lineHeight: 1.6, color: 'var(--text-2)' }}>
          Plain HTTP always keeps working. Turning this on serves <b>HTTPS as well</b>, using
          a certificate this property signs for itself — which is what lets a browser do
          background notifications without the phone app.
        </p>

        <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <input type="checkbox" checked={t.enabled} disabled={save.isPending}
                 onChange={(e) => save.mutate(e.target.checked)} />
          <span style={{ fontSize: '0.875rem' }}><b>Also serve HTTPS</b></span>
        </label>

        {t.enabled && t.generated && (
          <>
            <div className="grid g3" style={{ marginBottom: 12 }}>
              <Tile label="HTTPS address"
                    value={address ? `${address}:${t.httpsPort}` : `port ${t.httpsPort}`}
                    sub="for devices with the root installed" />
              <Tile label="Certificate runs out" value={t.daysLeft ?? '—'} unit="days"
                    tone={(t.daysLeft ?? 0) < 45 ? 'warn' : 'ok'}
                    sub="renewed by itself before then" />
              <Tile label="Covers" value={t.covers?.length ?? 0}
                    sub={(t.covers ?? []).slice(0, 2).join(', ')} />
            </div>

            {(t.uncovered?.length ?? 0) > 0 && (
              <div className="note warn" style={{ marginBottom: 12 }}>
                <b>This PC answers on {t.uncovered!.join(', ')}, which the certificate does
                not cover.</b> Devices opening that address get a warning. Restart the host
                and a new certificate covering it is made automatically — the root does not
                change, so nothing needs reinstalling.
              </div>
            )}

            <dl className="kv" style={{ marginBottom: 12 }}>
              <dt>Root fingerprint</dt>
              <dd className="mono" style={{ fontSize: '0.6875rem', wordBreak: 'break-all' }}>
                {t.fingerprint}
              </dd>
            </dl>

            <div className="note">
              <b>Installing it on a phone.</b> Open{' '}
              <span className="mono">http://{address}:{host.data?.port ?? 4700}/ca.crt</span>{' '}
              on the device and open the file it downloads. Android asks what the
              certificate is for — choose <b>Wi-Fi</b> or <b>VPN and apps</b>. iPhone needs a
              second step: <b>Settings → General → About → Certificate Trust Settings</b>, and
              switch it on there, or it is installed and still not trusted.
              {' '}<b>Check the fingerprint above matches what the phone shows before accepting it.</b>
            </div>
          </>
        )}

        {t.enabled && !t.generated && (
          <div className="note">
            The certificate is generated the next time the host restarts.
          </div>
        )}
      </Card>
    </div>
  );
}

interface RemoteState {
  enabled: boolean; publicHost: string | null; idleMinutes: number;
  changedBy: string | null; changedAt: string | null;
  allowed: { display_name: string; role_name: string; may_change: number }[];
  blocked: { display_name: string }[];
  liveRemote: number;
}

/**
 * Checking in from outside the property.
 *
 * Off until somebody deliberately turns it on, and the panel says who that was. The
 * department's whole premise is a system that needs no internet; this is the one door
 * through that premise, so it is presented as a door — what it opens, who can walk
 * through it, and what they can do once inside — rather than as a checkbox.
 */
function RemoteDoor() {
  const qc = useQueryClient();
  const [host, setHost] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const q = useQuery<RemoteState>({
    queryKey: ['remote'], queryFn: () => api.get('/api/admin/remote'),
  });
  const save = useMutation({
    mutationFn: (next: Partial<RemoteState>) => api.patch('/api/admin/remote', next),
    onSuccess: async (_r, next) => {
      await qc.invalidateQueries({ queryKey: ['remote'] });
      setHost(null);
      setMsg({ text: next.enabled === undefined ? 'Saved.'
        : next.enabled ? 'Remote access is open. It is recorded that you opened it.'
                       : 'Remote access is closed. Nothing outside the property can reach this PC.' });
    },
    onError: (e) => setMsg({ text: (e as ApiError).message, bad: true }),
  });

  if (q.isLoading || !q.data) return null;
  const r = q.data;

  return (
    <div style={{ marginTop: 14 }}>
      <Flash msg={msg} />
      <Card title="Checking in from outside"
            right={<Chip tone={r.enabled ? 'warn' : 'ok'} lamp>
              {r.enabled ? 'Open' : 'Closed'}
            </Chip>}>
        <p style={{ margin: '0 0 12px', fontSize: '0.8438rem', lineHeight: 1.6, color: 'var(--text-2)' }}>
          With this open, the people below can sign in from anywhere through the tunnel
          running on this PC. The department keeps working on the property network either
          way — this changes nothing on site.
        </p>

        <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <input type="checkbox" checked={r.enabled} disabled={save.isPending}
                 onChange={(e) => save.mutate({ enabled: e.target.checked })} />
          <span style={{ fontSize: '0.875rem' }}>
            <b>Allow signing in from outside the property</b>
          </span>
        </label>

        {r.changedBy && (
          <p style={{ fontSize: '0.75rem', color: 'var(--text-3)', margin: '0 0 12px' }}>
            Last changed by {r.changedBy}{r.changedAt ? ` · ${when(r.changedAt)}` : ''}.
          </p>
        )}

        {r.enabled && (
          <>
            <div className="grid g3" style={{ marginBottom: 12 }}>
              <Tile label="Signed in from outside" value={r.liveRemote}
                    tone={r.liveRemote ? 'warn' : undefined}
                    sub={r.liveRemote ? 'right now' : 'nobody at the moment'} />
              <Tile label="Can get in" value={r.allowed.length}
                    sub={`${r.allowed.filter((a) => a.may_change).length} can also change things`} />
              <Tile label="Times out after" value={r.idleMinutes} unit="min"
                    sub="of doing nothing" />
            </div>

            <Field label="The address the tunnel publishes"
                   hint="Shown to whoever needs it. Setting it here does not create the tunnel — see the note below.">
              <input className="inp" placeholder="e.g. srl-maintenance.example.com"
                     value={host ?? r.publicHost ?? ''}
                     onChange={(e) => setHost(e.target.value)}
                     onBlur={() => host !== null && save.mutate({ publicHost: host })} />
            </Field>

            <div className="tw" style={{ marginTop: 12 }}>
              <table className="wide">
                <thead><tr><th>Who can sign in from outside</th><th>Role</th><th>From there they can</th></tr></thead>
                <tbody>
                  {r.allowed.map((a) => (
                    <tr key={a.display_name}>
                      <td><span className="ttl">{a.display_name}</span></td>
                      <td>{a.role_name}</td>
                      <td>
                        {a.may_change
                          ? <Chip tone="warn">assign and approve</Chip>
                          : <Chip tone="ok">look only</Chip>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {r.blocked.length > 0 && (
              <div className="note warn" style={{ marginTop: 12 }}>
                <b>Still on a default password, so blocked from outside:</b>{' '}
                {r.blocked.map((b) => b.display_name).join(', ')}. They can sign in on the
                property network and change it; until they do, the tunnel will refuse them.
                That is deliberate — a known password and a public address is the one
                combination that must not exist.
              </div>
            )}
          </>
        )}

        <div className="note" style={{ marginTop: 14 }}>
          <b>This switch does not create the tunnel.</b> It decides whether the system
          accepts anything that arrives through one. Install <b>cloudflared</b> on this PC
          as a service, point it at <b>http://127.0.0.1:{'{'}port{'}'}</b>, and put
          Cloudflare Access in front with a list of the exact email addresses allowed —
          a named list, not a whole domain. Everything that comes through is marked as
          remote in the audit log, so an approval can always be placed on site or off it.
        </div>
      </Card>
    </div>
  );
}

function Host() {
  const q = useQuery<HostStatus>({
    queryKey: ['host'], queryFn: () => api.get('/api/admin/host'),
    refetchInterval: 30_000,
  });

  if (q.isLoading) return <Card><Loading rows={5} /></Card>;
  if (q.isError) return <Card><ErrorNote error={q.error} /></Card>;
  const h = q.data!;

  const backupStale = h.backups.ageHours == null || h.backups.ageHours > 48;
  const advertised = h.advertise ? `http://${h.advertise}:${h.port}` : null;

  return (
    <>
      <div className="grid g4" style={{ marginBottom: 14 }}>
        <Tile label="Listening on" value={h.port}
              sub={h.boundTo ? `only on ${h.boundTo}` : 'every network on this PC'} />
        <Tile label="Running for" value={uptimeWords(h.uptimeSeconds)}
              sub={`since ${when(h.startedAt)}`} />
        <Tile label="Newest backup"
              value={h.backups.ageHours == null ? 'none'
                : h.backups.ageHours < 1 ? 'just now' : `${Math.round(h.backups.ageHours)}h ago`}
              tone={backupStale ? 'warn' : 'ok'}
              sub={`${h.backups.count} kept · ${humanBytes(h.backups.totalBytes)}`} />
        <Tile label="Free on this disk"
              value={h.freeBytes == null ? '—' : humanBytes(h.freeBytes)}
              sub={`data folder is ${humanBytes(h.dataBytes)}`} />
      </div>

      {h.pendingPort != null && (
        <div className="note warn" style={{ marginBottom: 14 }}>
          <b>Port {h.pendingPort} is saved but not in force.</b> This host is still answering on
          {' '}{h.port} and will move when it next restarts. Open the firewall for {h.pendingPort}
          {' '}first, or the wifi loses it.
        </div>
      )}

      <div style={{ marginBottom: 14 }}><NetworkCard h={h} /></div>

      <div className="grid g2" style={{ marginBottom: 14 }}>
        <JoinCard url={advertised} port={h.port}
                  nic={h.network.nics.find((n) => n.address === h.advertise) ?? null} />

        <Card title="How it is running"
              right={<Chip tone={h.bootService.state === 'registered' ? 'ok'
                : h.bootService.state === 'missing' ? 'warn' : ''} lamp>
                {h.bootService.state === 'registered' ? 'starts at boot'
                  : h.bootService.state === 'missing' ? 'window only' : 'cannot tell'}
              </Chip>}>
          <ul className="iso" style={{ marginTop: 0 }}>
            <li>
              <span>Starts when the PC boots</span>
              <span className="sp">
                <Chip tone={h.bootService.state === 'registered' ? 'ok'
                  : h.bootService.state === 'missing' ? 'warn' : ''}>
                  {h.bootService.state === 'registered' ? 'Yes'
                    : h.bootService.state === 'missing' ? 'No' : 'Unknown'}
                </Chip>
              </span>
            </li>
            <li>
              <span>Port {h.port} open on the private network</span>
              <span className="sp">
                <Chip tone={h.firewall.state === 'open' ? 'ok'
                  : h.firewall.state === 'missing' ? 'warn' : ''}>
                  {h.firewall.state === 'open' ? 'Yes'
                    : h.firewall.state === 'missing' ? 'No' : 'Unknown'}
                </Chip>
              </span>
            </li>
          </ul>

          {h.bootService.state === 'missing' && (
            <div className="note warn" style={{ marginTop: 12 }}>
              <b>This server is only running because a window is open.</b> Close it, or log out,
              or let the PC restart overnight, and the department loses the system until somebody
              starts it again. Run the launcher on the host PC and choose
              <b> Install as a boot service</b>.
            </div>
          )}
          {h.bootService.state === 'unknown' && (
            <div className="note" style={{ marginTop: 12 }}>{h.bootService.why}</div>
          )}
          {h.firewall.state === 'missing' && h.bootService.state !== 'missing' && (
            <div className="note warn" style={{ marginTop: 12 }}>
              No firewall rule for port {h.port}. The system works on this PC but phones on the
              wifi cannot reach it.
            </div>
          )}
        </Card>
      </div>

      <div className="grid g2">
        <PortCard current={h.port} pending={h.pendingPort} />

        <Card title="Doing this on the host PC">
          <p className="sub" style={{ margin: '0 0 12px' }}>
            Starting, stopping and installing the boot service all happen on the host PC itself —
            this page is served by the server it would be acting on. Double-click
            {' '}<b>FacilityFlow.cmd</b> in the app folder for a menu, or copy a command.
          </p>
          <CmdList windows={h.isWindows} />
        </Card>
      </div>

      <OwnCertificate />
      <RemoteDoor />

      <div className="note" style={{ marginTop: 14 }}>
        <b>{h.dataDir}</b> is the whole business record — database, photos and backups.
        {' '}{h.attachmentCount.toLocaleString()} file{h.attachmentCount === 1 ? '' : 's'} attached
        so far. Copy that folder and you have copied everything.
        {' '}Running FacilityFlow {h.version} on Node {h.node}, {h.platform}.
      </div>
    </>
  );
}

/** The address, big, with a code a phone can scan to join. */
/**
 * Which of this PC's networks the department is given.
 *
 * A host PC is rarely on one network. It has a cable, and wifi, and — once anybody has
 * installed VirtualBox, Docker or WSL — two or three adapters that look exactly like a
 * network and reach nobody. Somebody has to decide which address goes on the wall, and
 * until now that decision was made by whichever adapter Node happened to list first.
 */
function NetworkCard({ h }: { h: HostStatus }) {
  const qc = useQueryClient();
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [advanced, setAdvanced] = useState(false);

  const save = useMutation({
    mutationFn: (body: { advertise?: string | null; bindTo?: string | null }) =>
      api.post<{ message: string }>('/api/admin/host/network', body),
    onSuccess: async (r) => {
      setMsg({ text: r.message });
      await qc.invalidateQueries({ queryKey: ['host'] });
    },
    onError: (e) => setMsg({ text: (e as ApiError).message, bad: true }),
  });

  const usable = h.network.nics.filter((n) => n.usable);
  const rest = h.network.nics.filter((n) => !n.usable);
  const kindWord = (n: Nic) =>
    n.kind === 'ethernet' ? 'Cable' : n.kind === 'wifi' ? 'Wifi'
      : n.kind === 'virtual' ? 'Virtual' : 'Other';

  return (
    <Card title="Which network the department reaches this PC on"
          right={h.network.ssid ? <Chip>Wifi: {h.network.ssid}</Chip> : undefined}>
      {msg && <div className={`note ${msg.bad ? 'crit' : ''}`} style={{ marginBottom: 12 }}
                   role="status">{msg.text}</div>}

      {h.network.nics.length === 0 ? (
        <Empty title="This PC is not on any network"
               hint="No cable and no wifi, so nothing in the department can reach it. Connect it to the office network, then reload this page." />
      ) : (
        <>
          <div className="niclist">
            {usable.map((n) => (
              <label key={n.address + n.name} className={n.recommended ? 'nic on' : 'nic'}>
                <input type="radio" name="advertise" checked={n.recommended}
                       onChange={() => save.mutate({ advertise: n.address })} />
                <span className="nname">
                  {n.name}
                  <Chip>{kindWord(n)}</Chip>
                  {n.ssid && <Chip>{n.ssid}</Chip>}
                </span>
                <span className="naddr">{n.address}</span>
                {n.note && <span className="nnote">{n.note}</span>}
                {n.dhcp === true && (
                  <span className="nnote">
                    This address was handed out by the router and can change — after a power cut,
                    or overnight. Ask whoever runs the network to reserve it for this PC, or every
                    phone in the department loses the system on the same morning.
                  </span>
                )}
              </label>
            ))}
          </div>

          {usable.length === 0 && (
            <div className="note warn">
              <b>Nothing here can be reached from a phone.</b> Every address this PC has belongs
              to virtual software or is one the PC gave itself because nothing answered. Plug it
              into the office network, or join it to the staff wifi.
            </div>
          )}

          {rest.length > 0 && (
            <details style={{ marginTop: 12 }}>
              <summary className="sub" style={{ cursor: 'pointer' }}>
                {rest.length} more {rest.length === 1 ? 'address' : 'addresses'} on this PC that
                cannot be used
              </summary>
              <div className="niclist" style={{ marginTop: 8, opacity: .72 }}>
                {rest.map((n) => (
                  <div key={n.address + n.name} className="nic dead">
                    <span className="nname">{n.name} <Chip>{kindWord(n)}</Chip></span>
                    <span className="naddr">{n.address}</span>
                    {n.note && <span className="nnote">{n.note}</span>}
                  </div>
                ))}
              </div>
            </details>
          )}

          <div className="note" style={{ marginTop: 14 }}>
            This is the address on the QR code and the one to write on the notice board. The host
            answers on <b>{h.boundTo ? `${h.boundTo} only` : 'every network above'}</b> whichever
            you pick — choosing here changes what people are told, not what the server listens on.
          </div>

          <button className="btn sm" style={{ marginTop: 12 }}
                  onClick={() => setAdvanced((v) => !v)} aria-expanded={advanced}>
            {advanced ? 'Hide' : 'Show'} advanced: answer on one network only
          </button>

          {advanced && (
            <div className="note warn" style={{ marginTop: 12 }}>
              <b>Only if this PC can be reached from a network the department should not be on</b>
              {' '}— a guest wifi, for instance. Narrowing it here means the system refuses every
              other network from the next restart.
              <p style={{ margin: '8px 0 0' }}>
                The risk is the address itself. Most are handed out by the router and can change
                overnight; if that happens the host cannot answer on the old one. It will fall back
                to every network and say so when it starts, rather than dying — but until somebody
                notices, the narrowing is not doing its job. A reserved or static address first.
              </p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                {usable.map((n) => (
                  <Btn key={n.address} size="sm"
                       tone={h.boundTo === n.address ? 'pri' : undefined}
                       onClick={() => save.mutate({ bindTo: n.address })}>
                    Only {n.name} ({n.address})
                  </Btn>
                ))}
                {h.boundTo && (
                  <Btn size="sm" onClick={() => save.mutate({ bindTo: null })}>
                    Answer on every network again
                  </Btn>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function JoinCard({ url, port, nic }: { url: string | null; port: number; nic: Nic | null }) {
  const [svg, setSvg] = useState('');
  // One address, chosen deliberately. This used to be addresses[0] — whichever adapter the
  // operating system happened to enumerate first, printed onto a code for the wall.
  const primary = url;

  useEffect(() => {
    let cancelled = false;
    if (!primary) { setSvg(''); return; }
    // Generated in the browser: the host has no route to the internet, so a code from
    // an image service would be a permanently broken square on the wall.
    QRCode.toString(primary, { type: 'svg', errorCorrectionLevel: 'M', margin: 0,
                               color: { dark: '#000000', light: '#ffffff' } })
      .then((out) => { if (!cancelled) setSvg(out); })
      .catch(() => { if (!cancelled) setSvg(''); });
    return () => { cancelled = true; };
  }, [primary]);

  return (
    <Card title="The address to hand out" right={<Chip>Port {port}</Chip>}>
      {!primary ? (
        <Empty title="No address to hand out"
               hint="This PC has no cable or wifi connection the department could reach it on. Connect it to the office network and this fills in." />
      ) : (
        <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          {svg && (
            <div style={{ width: 132, height: 132, flex: 'none', background: '#fff',
                          padding: 8, borderRadius: 8, border: '1px solid var(--line)' }}
                 dangerouslySetInnerHTML={{ __html: svg }} />
          )}
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: '0.9375rem', fontWeight: 500,
                          wordBreak: 'break-all', marginBottom: 6 }}>
              {primary}
            </div>
            {nic && (
              <p className="sub" style={{ margin: '0 0 8px' }}>
                over {nic.name}{nic.ssid ? ` on ${nic.ssid}` : ''}
                {nic.kind === 'wifi' ? ' — phones must be on this same wifi' : ''}
              </p>
            )}
            <p className="sub" style={{ margin: '10px 0 0' }}>
              Anyone on the office wifi opens this and signs in. On a phone, <b>Add to home
              screen</b> and it behaves like an app.
            </p>
          </div>
        </div>
      )}
      <div className="note warn" style={{ marginTop: 14 }}>
        <b>Ask IT to reserve this address before printing it on anything.</b> If this PC is on
        DHCP the address will change, and every bookmark and every QR sticker on the plant breaks
        at the same moment.
      </div>
    </Card>
  );
}

function PortCard({ current, pending }: { current: number; pending: number | null }) {
  const qc = useQueryClient();
  const [value, setValue] = useState(String(pending ?? current));
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);

  const save = useMutation({
    mutationFn: () => api.post('/api/admin/host/port', { port: Number(value) }),
    onSuccess: async (r) => {
      setMsg({ text: (r as { message: string }).message });
      await qc.invalidateQueries({ queryKey: ['host'] });
    },
    onError: (e) => setMsg({ text: (e as ApiError).message, bad: true }),
  });

  const n = Number(value);
  const ready = Number.isInteger(n) && n >= 1024 && n <= 65535 && n !== (pending ?? current);

  return (
    <Card title="Port" right={<Chip tone={pending != null ? 'warn' : ''}>
      {pending != null ? `${current} → ${pending}` : String(current)}</Chip>}>
      <Field label="Listen on port"
             hint="Takes effect the next time the host starts, not now — rebinding under a running server would kill this page and every device mid-action.">
        <input className="inp" inputMode="numeric" value={value}
               onChange={(e) => setValue(e.target.value.replace(/[^0-9]/g, ''))} />
      </Field>
      {msg && <div className={`note ${msg.bad ? 'crit' : 'good'}`} style={{ marginBottom: 12 }}
                   role="status">{msg.text}</div>}
      <Btn tone="pri" style={{ width: '100%' }} disabled={!ready || save.isPending}
           onClick={() => save.mutate()}>
        {save.isPending ? 'Saving…' : 'Save for next start'}
      </Btn>
      <div className="note" style={{ marginTop: 12 }}>
        Change this only if something else on the PC already uses {current}. Every bookmark,
        home-screen shortcut and printed QR code carries the port in it, so moving it means
        reprinting the stickers.
      </div>
    </Card>
  );
}

const HOST_CMDS: { what: string; cmd: string }[] = [
  { what: 'Stop the host', cmd: 'Stop-ScheduledTask -TaskName FacilityFlow' },
  { what: 'Start it again', cmd: 'Start-ScheduledTask -TaskName FacilityFlow' },
  { what: 'Install it to start at boot',
    cmd: 'powershell -ExecutionPolicy Bypass -File .\\scripts\\windows\\install-host.ps1' },
  { what: 'See why it will not start', cmd: 'Get-Content .\\data\\logs\\*.log -Tail 40' },
];

function CmdList({ windows }: { windows: boolean }) {
  const [copied, setCopied] = useState<string | null>(null);
  if (!windows) {
    return (
      <div className="note">
        This host is not Windows, so the scheduled-task commands do not apply. Start it with
        {' '}<code>npm start</code> in the app folder.
      </div>
    );
  }
  return (
    <ul className="iso" style={{ marginTop: 0 }}>
      {HOST_CMDS.map((c) => (
        <li key={c.cmd} style={{ flexWrap: 'wrap' }}>
          <span style={{ minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: '0.7812rem' }}>{c.what}</span>
            <span className="tagno" style={{ wordBreak: 'break-all' }}>{c.cmd}</span>
          </span>
          <span className="sp">
            <button className="btn sm" onClick={() => {
              try {
                void navigator.clipboard?.writeText(c.cmd);
                setCopied(c.cmd);
                setTimeout(() => setCopied(null), 1400);
              } catch { /* no clipboard on an insecure origin in some browsers */ }
            }}>{copied === c.cmd ? 'Copied' : 'Copy'}</button>
          </span>
        </li>
      ))}
    </ul>
  );
}

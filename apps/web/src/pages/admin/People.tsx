/** Admin → Staff and teams. */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { titleCase } from '../../lib/format';
import { Card, Chip, Loading, Empty, ErrorNote, Btn, Modal, Field, Flash, RetireBtn,
         DeleteBtn } from '../../components/Bits';

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
export function People() {
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
          : q.isError ? <div className="p-6"><ErrorNote error={q.error} /></div>
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
                        <td className="num nw">
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
        <div className="note m-6">
          <b>A person here and an account under Users are two different things.</b> This list is
          who can be put on a shift and given a job. An account is who can sign in. Link the two
          when you create the account, and that person sees their own jobs when they log in.
          {' '}<b>Retire</b> somebody who has left — their jobs and roster history stay readable.
          <b> Delete</b> is only for a person added by mistake who has nothing recorded against them.
        </div>
      </Card>

      {teams.length > 0 && (
        <div className="mt-6"><Card title="Teams" flush>
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
                    <td className="num nw">
                      <Btn size="sm" onClick={() => setEditingTeam(t)}>Edit</Btn>
                      <span className="ml-3">
                        <RetireBtn kind="team" id={t.id} label={t.name}
                                   onDone={async (m) => { setMsg({ text: m }); await refresh(); }} />
                      </span>
                      <span className="ml-3">
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
      <div className="grid g2 gap-5">
        <Field label="First name">
          <input className="inp" autoFocus value={f.firstName}
                 onChange={(e) => setF({ ...f, firstName: e.target.value })} />
        </Field>
        <Field label="Last name">
          <input className="inp" value={f.lastName}
                 onChange={(e) => setF({ ...f, lastName: e.target.value })} />
        </Field>
      </div>
      <div className="grid g2 gap-5">
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
      <div className="grid g3 gap-5">
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
          <label className="row gap-4">
            <input type="checkbox" checked={f.isActive}
                   onChange={(e) => setF({ ...f, isActive: e.target.checked })} />
            <span className="t-ui">On the team</span>
          </label>
        </Field>
      )}
      {err && <div className="note crit mb-5" role="alert">{err.message}</div>}
      <Btn full tone="pri"
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
      {err && <div className="note crit mb-5" role="alert">{err.message}</div>}
      <Btn full tone="pri" disabled={f.name.trim().length < 2 || save.isPending}
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
        <div className="note warn mb-5">
          With nobody named, a job on this team that passes its response deadline escalates
          straight past the floor, and nobody is told when the team finishes work that still
          needs verifying.
        </div>
      )}
      {err && <div className="note crit mb-5" role="alert">{err.message}</div>}
      <Btn full tone="pri"
           disabled={f.name.trim().length < 2 || save.isPending}
           onClick={() => save.mutate()}>
        {save.isPending ? 'Saving…' : 'Save team'}
      </Btn>
    </Modal>
  );
}

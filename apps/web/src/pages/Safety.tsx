import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qk, ApiError } from '../lib/api';
import { useSession } from '../lib/session';
import { titleCase, when } from '../lib/format';
import { Card, Chip, Tile, Loading, Empty, ErrorNote, Btn, Modal, Field, Tabs, Flash,
         PrintBtn, SignOff, MonthBar } from '../components/Bits';
import { useMonth } from '../lib/month';
import { Icon } from '../components/Icon';
import { Photos } from '../components/Photos';

interface IsolationPoint {
  id: string; point_description: string; lock_tag_no: string | null;
  isolated_at: string | null; restored_at: string | null; asset_tag: string | null;
}
interface Permit {
  id: string; ref: string; type: string; status: string; requested_by: string;
  wo_ref: string | null; valid_from: string; valid_to: string;
  precautions_json: string | null;
  requested_by_name: string | null; issued_by_name: string | null;
  isolationPoints: IsolationPoint[];
}
interface Incident {
  id: string; ref: string; occurred_at: string; type: string; severity: string;
  description: string; immediate_action: string | null; location_name: string | null;
  reported_by_name: string | null; corrective_wo_id: string | null;
}

type Tab = 'permits' | 'incidents';

const PERMIT_TYPES: Record<string, string> = {
  hot_work: 'Hot work',
  electrical_isolation: 'Electrical isolation',
  height: 'Working at height',
  confined_space: 'Confined space',
  excavation: 'Excavation',
};
const INCIDENT_TYPES: Record<string, string> = {
  injury: 'Injury', near_miss: 'Near miss', property_damage: 'Property damage',
  fire: 'Fire', spill: 'Spill',
};
/** Standard precautions per permit type — a starting point, not a substitute for judgement. */
const PRECAUTIONS: Record<string, string[]> = {
  hot_work: ['Fire extinguisher within reach', 'Combustibles removed or covered',
             'Fire watch posted for 30 minutes after work', 'Smoke detector isolated and logged'],
  electrical_isolation: ['Circuit proved dead at the point of work', 'Locks and tags fitted',
                         'Keys held by the issuing officer', 'Test lamp proved before and after'],
  height: ['Anchor point inspected', 'Harness and lanyard within test date',
           'Area below barricaded', 'Second person at ground level'],
  confined_space: ['Atmosphere tested before entry', 'Continuous gas monitoring',
                   'Standby person at the entrance', 'Rescue plan agreed'],
  excavation: ['Underground services traced', 'Edges shored or battered',
               'Barricades and lighting in place', 'Spoil kept back from the edge'],
};

function permitTone(p: Permit): 'ok' | 'warn' | 'crit' | '' {
  if (p.status === 'closed' || p.status === 'cancelled') return '';
  if (p.status === 'requested') return 'warn';
  return new Date(p.valid_to).getTime() < Date.now() ? 'crit' : 'ok';
}

export function Safety() {
  const { me, can } = useSession();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('permits');
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [newPermit, setNewPermit] = useState(false);
  const [newIncident, setNewIncident] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const month = useMonth();
  const permits = useQuery<{ permits: Permit[] }>({
    queryKey: [...qk.permits, month.month],
    queryFn: () => api.get(`/api/permits?${month.param}`), enabled: can('permit.request'),
  });
  const incidents = useQuery<{ incidents: Incident[] }>({
    queryKey: [...qk.incidents, month.month],
    queryFn: () => api.get(`/api/incidents?${month.param}`), enabled: can('incident.read'),
  });

  const act = useMutation({
    mutationFn: (v: { path: string; body?: unknown; ok: string }) => api.post(v.path, v.body),
    onSuccess: async (_r, v) => {
      setMsg({ text: v.ok });
      await qc.invalidateQueries({ queryKey: ['permits'] });
    },
    onError: (e) => setMsg({ text: (e as ApiError).message, bad: true }),
  });

  const rows = permits.data?.permits ?? [];
  const live = rows.filter((p) => p.status === 'issued');
  const waiting = rows.filter((p) => p.status === 'requested');
  const lockedOut = live.reduce(
    (n, p) => n + p.isolationPoints.filter((i) => i.isolated_at && !i.restored_at).length, 0);
  const openPermit = rows.find((p) => p.id === open) ?? null;

  return (
    <main className="view">
      <div className="vhead">
        <div>
          <p className="eyebrow">Permits to work · incidents</p>
          <h1>Safety</h1>
          <p>A permit is a conversation with a signature on it. The person who asks for one never
             issues it, and no permit closes while a lock is still on.</p>
        </div>
        <div className="acts">
          {can('incident.report') && (
            <Btn icon="alert" onClick={() => setNewIncident(true)}>Report an incident</Btn>)}
          {can('permit.request') && (
            <Btn icon="plus" tone="pri" onClick={() => setNewPermit(true)}>Request a permit</Btn>)}
        </div>
      </div>

      <MonthBar month={month.month} label={month.label} isCurrent={month.isCurrent}
                onStep={month.step} onSet={month.set} onReset={month.reset}
                note={tab === 'permits' ? 'live permits always show' : undefined} />

      <Flash msg={msg} />

      <div className="grid g4" style={{ marginBottom: 16 }}>
        <Tile label="Live permits" value={live.length} tone={live.length ? 'acc' : undefined}
              sub="Issued and inside their window" />
        <Tile label="Waiting to be issued" value={waiting.length}
              tone={waiting.length ? 'warn' : undefined} sub="Requested, not yet authorised" />
        <Tile label="Points locked out" value={lockedOut} tone={lockedOut ? 'crit' : undefined}
              sub="Isolated and not yet restored" />
        <Tile label="Incidents on file" value={incidents.data?.incidents.length ?? (can('incident.read') ? '—' : 'n/a')}
              sub={can('incident.read') ? 'Most recent 200' : 'Your role cannot read these'} />
      </div>

      <Tabs<Tab> value={tab} onChange={setTab} items={[
        { key: 'permits', label: 'Permits', count: rows.length },
        { key: 'incidents', label: 'Incidents', count: incidents.data?.incidents.length ?? 0 },
      ]} />

      {tab === 'permits' ? (
        <Card flush title="Permit register">
          {!can('permit.request') ? <div style={{ padding: 15 }}>
              <Empty title="Your role does not handle permits" /></div>
            : permits.isLoading ? <Loading rows={5} />
            : permits.isError ? <div style={{ padding: 15 }}><ErrorNote error={permits.error} /></div>
            : rows.length === 0
              ? <Empty title="No permits raised yet"
                       hint="Hot work, an electrical isolation, a job at height — each one starts here." />
              : (
                <div className="tw">
                  <table className="wide">
                    <thead><tr><th>Ref</th><th>Type</th><th>Job</th><th>Valid</th>
                      <th>Requested by</th><th>Isolations</th><th>Status</th></tr></thead>
                    <tbody>
                      {rows.map((p) => {
                        const locked = p.isolationPoints.filter((i) => i.isolated_at && !i.restored_at).length;
                        return (
                          <tr key={p.id} className="click" onClick={() => setOpen(p.id)}>
                            <td className="mono">{p.ref}</td>
                            <td><span className="ttl">{PERMIT_TYPES[p.type] ?? titleCase(p.type)}</span></td>
                            <td className="mono">{p.wo_ref ?? '—'}</td>
                            <td>{when(p.valid_from)}<span className="sub">to {when(p.valid_to)}</span></td>
                            <td>{p.requested_by_name ?? '—'}</td>
                            <td>{p.isolationPoints.length === 0 ? '—'
                              : locked > 0 ? <Chip tone="crit" lamp>{locked} locked</Chip>
                              : <Chip tone="ok">{p.isolationPoints.length} restored</Chip>}</td>
                            <td><Chip tone={permitTone(p)} lamp>{titleCase(p.status)}</Chip></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
        </Card>
      ) : (
        <IncidentList q={incidents} canRead={can('incident.read')} canReport={can('incident.report')} />
      )}

      {openPermit && (
        <PermitDetail permit={openPermit} onClose={() => setOpen(null)}
                      meId={me?.user.id ?? ''} canIssue={can('permit.issue')}
                      onAct={(path, ok, body) => act.mutate({ path, ok, body })}
                      pending={act.isPending} />
      )}
      {newPermit && <NewPermit onClose={() => setNewPermit(false)}
                               onDone={(t) => { setNewPermit(false); setMsg({ text: t }); }} />}
      {newIncident && <NewIncident onClose={() => setNewIncident(false)}
                                   onDone={(t) => { setNewIncident(false); setMsg({ text: t }); }} />}
    </main>
  );
}

function PermitDetail({ permit, onClose, meId, canIssue, onAct, pending }: {
  permit: Permit; onClose: () => void; meId: string; canIssue: boolean;
  onAct: (path: string, ok: string, body?: unknown) => void; pending: boolean;
}) {
  const p = permit;
  const precautions: string[] = p.precautions_json ? JSON.parse(p.precautions_json) : [];
  const stillLocked = p.isolationPoints.filter((i) => i.isolated_at && !i.restored_at).length;
  // The database refuses a self-issue outright; offering the button would only produce an error.
  const mine = p.requested_by === meId;

  return (
    <Modal title={`${p.ref} · ${PERMIT_TYPES[p.type] ?? titleCase(p.type)}`} onClose={onClose}
           actions={<PrintBtn label="Print permit" />}>
      <dl className="kv" style={{ marginBottom: 16 }}>
        <dt>Status</dt><dd><Chip tone={permitTone(p)} lamp>{titleCase(p.status)}</Chip></dd>
        <dt>Valid</dt><dd>{when(p.valid_from)} → {when(p.valid_to)}</dd>
        <dt>Requested</dt><dd>{p.requested_by_name ?? '—'}</dd>
        <dt>Issued</dt><dd>{p.issued_by_name ?? <span style={{ color: 'var(--text-3)' }}>not yet issued</span>}</dd>
        {p.wo_ref && <><dt>Job</dt><dd className="mono">{p.wo_ref}</dd></>}
      </dl>

      {precautions.length > 0 && (
        <>
          <p className="eyebrow" style={{ marginBottom: 6 }}>Precautions</p>
          <ul style={{ margin: '0 0 16px', paddingLeft: 18, fontSize: '0.8125rem', color: 'var(--text-2)' }}>
            {precautions.map((c, i) => <li key={i} style={{ marginBottom: 4 }}>{c}</li>)}
          </ul>
        </>
      )}

      <p className="eyebrow" style={{ marginBottom: 0 }}>Isolation points</p>
      {p.isolationPoints.length === 0
        ? <div className="note" style={{ marginTop: 8 }}>No isolations recorded on this permit.</div>
        : (
          <ul className="iso">
            {p.isolationPoints.map((i) => {
              const state = i.restored_at ? 'restored' : i.isolated_at ? 'isolated' : 'not isolated';
              return (
                <li key={i.id}>
                  <Icon name={i.isolated_at && !i.restored_at ? 'lock' : 'check'} size={14} />
                  <span>
                    {i.point_description}
                    {i.asset_tag && <span className="tagno"> · {i.asset_tag}</span>}
                    {i.lock_tag_no && <span className="tagno"> · lock {i.lock_tag_no}</span>}
                  </span>
                  <span className="sp">
                    <Chip tone={i.restored_at ? 'ok' : i.isolated_at ? 'crit' : ''}>{state}</Chip>
                    {canIssue && p.status === 'issued' && (
                      i.restored_at ? null : (
                        <Btn size="sm" disabled={pending}
                             onClick={() => onAct(
                               `/api/permits/${p.id}/isolation/${i.id}`,
                               i.isolated_at ? 'Isolation restored.' : 'Point isolated and locked.',
                               { action: i.isolated_at ? 'restore' : 'isolate' })}>
                          {i.isolated_at ? 'Restore' : 'Isolate'}
                        </Btn>
                      )
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}

      <div style={{ marginTop: 16 }}>
        <Photos entityType="permit" entityId={p.id} canUpload title="Photos of the isolation and the area" />
      </div>

      {canIssue && p.status === 'issued' && stillLocked > 0 && (
        <div className="note warn" style={{ marginTop: 14 }}>
          {stillLocked} point{stillLocked === 1 ? ' is' : 's are'} still locked out. Restore
          {stillLocked === 1 ? ' it' : ' them'} before the permit can be closed.
        </div>
      )}

      <SignOff lines={[
        'Requested by — signature and date',
        'Issued by — signature and date',
        'Work complete, area left safe — signature and date',
        'Permit cancelled and isolations restored — signature and date',
      ]} />

      {canIssue && (
        <div className="modal-foot">
          {p.status === 'requested' && (
            mine
              ? <Chip tone="warn">You requested this one — another officer has to issue it</Chip>
              : <Btn tone="pri" icon="check" disabled={pending}
                     onClick={() => onAct(`/api/permits/${p.id}/issue`, `${p.ref} issued.`)}>
                  Issue this permit
                </Btn>
          )}
          {p.status === 'issued' && (
            <Btn tone="pri" icon="check" disabled={pending || stillLocked > 0}
                 onClick={() => onAct(`/api/permits/${p.id}/close`, `${p.ref} closed.`)}>
              Close the permit
            </Btn>
          )}
        </div>
      )}
      {p.status === 'requested' && !canIssue && (
        <div className="note" style={{ marginTop: 14 }}>
          This permit is waiting on a supervisor or the duty engineer to issue it. Work must not
          start until it shows as issued.
        </div>
      )}
    </Modal>
  );
}

function IncidentList({ q, canRead, canReport }: {
  q: ReturnType<typeof useQuery<{ incidents: Incident[] }>>; canRead: boolean; canReport: boolean;
}) {
  // Photos load per incident, so they hang off a modal rather than firing one query per card.
  const [shots, setShots] = useState<Incident | null>(null);
  if (!canRead) {
    return <Card><Empty title="Incident records are restricted"
      hint="They can contain injury details, so reading them is a separate permission from reporting one." /></Card>;
  }
  if (q.isLoading) return <Card><Loading rows={4} /></Card>;
  if (q.isError) return <Card><ErrorNote error={q.error} /></Card>;
  const rows = q.data?.incidents ?? [];
  if (rows.length === 0) {
    return <Card><Empty title="Nothing reported" hint="Long may it stay that way — but log the near misses." /></Card>;
  }
  return (
    <div className="grid g2">
      {rows.map((i) => (
        <Card key={i.id} title={`${i.ref} · ${INCIDENT_TYPES[i.type] ?? titleCase(i.type)}`}
              right={<Chip tone={i.severity === 'critical' || i.severity === 'major' ? 'crit'
                                 : i.severity === 'moderate' ? 'warn' : ''} lamp>
                       {titleCase(i.severity)}</Chip>}>
          <p style={{ margin: 0, fontSize: '0.8438rem', lineHeight: 1.6 }}>{i.description}</p>
          {i.immediate_action && (
            <div className="note" style={{ marginTop: 12 }}>
              <b>Action taken</b><div style={{ marginTop: 4 }}>{i.immediate_action}</div>
            </div>
          )}
          <dl className="kv" style={{ marginTop: 14 }}>
            <dt>Occurred</dt><dd>{when(i.occurred_at)}</dd>
            <dt>Where</dt><dd>{i.location_name ?? '—'}</dd>
            <dt>Reported by</dt><dd>{i.reported_by_name ?? '—'}</dd>
          </dl>
          <Btn size="sm" icon="cam" style={{ marginTop: 12 }} onClick={() => setShots(i)}>Photos</Btn>
        </Card>
      ))}
      {shots && (
        <Modal title={`${shots.ref} · photos`} onClose={() => setShots(null)}>
          <Photos entityType="incident" entityId={shots.id} canUpload={canReport}
                  title="What it looked like" />
        </Modal>
      )}
    </div>
  );
}

interface DraftPoint { description: string; lockTagNo: string; assetId: string }

function NewPermit({ onClose, onDone }: { onClose: () => void; onDone: (msg: string) => void }) {
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const localNow = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:00`;
  const localEnd = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(Math.min(23, now.getHours() + 6))}:00`;

  const [type, setType] = useState('hot_work');
  const [woId, setWoId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [validFrom, setValidFrom] = useState(localNow);
  const [validTo, setValidTo] = useState(localEnd);
  const [checked, setChecked] = useState<string[]>(PRECAUTIONS.hot_work!.slice());
  const [points, setPoints] = useState<DraftPoint[]>([]);

  const locs = useQuery<{ locations: { id: string; name: string }[] }>({
    queryKey: qk.locations, queryFn: () => api.get('/api/locations'),
  });
  const assets = useQuery<{ assets: { id: string; asset_tag: string; name: string }[] }>({
    queryKey: qk.assets, queryFn: () => api.get('/api/assets'),
  });
  const jobs = useQuery<{ jobs: { id: string; ref: string; title: string }[] }>({
    queryKey: qk.jobs('permit'), queryFn: () => api.get('/api/jobs?limit=60'),
  });

  const list = PRECAUTIONS[type] ?? [];

  const save = useMutation({
    mutationFn: () => api.post<{ ref: string }>('/api/permits', {
      type, woId: woId || undefined, locationId: locationId || undefined,
      validFrom: new Date(validFrom).toISOString(),
      validTo: new Date(validTo).toISOString(),
      precautions: checked,
      isolationPoints: points.filter((p) => p.description.trim()).map((p) => ({
        description: p.description.trim(),
        lockTagNo: p.lockTagNo.trim() || undefined,
        assetId: p.assetId || undefined,
      })),
    }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['permits'] });
      onDone(`${r.ref} raised. Someone other than you has to issue it before work starts.`);
    },
    onError: (e) => setErr((e as ApiError).message),
  });

  const badDates = new Date(validTo) <= new Date(validFrom);

  return (
    <Modal title="Request a permit to work" onClose={onClose}>
      {err && <div className="note crit" style={{ marginBottom: 14 }} role="alert">{err}</div>}

      <div className="grid g2">
        <Field label="Permit type">
          <select className="inp" value={type}
                  onChange={(e) => { setType(e.target.value); setChecked((PRECAUTIONS[e.target.value] ?? []).slice()); }}>
            {Object.entries(PERMIT_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <Field label="Where">
          <select className="inp" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">Not tied to one location</option>
            {(locs.data?.locations ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </Field>
      </div>

      <Field label="Against which job" hint="Optional, but it links the permit to the work order history.">
        <select className="inp" value={woId} onChange={(e) => setWoId(e.target.value)}>
          <option value="">None</option>
          {(jobs.data?.jobs ?? []).map((j) => (
            <option key={j.id} value={j.id}>{j.ref} · {j.title}</option>))}
        </select>
      </Field>

      <div className="grid g2">
        <Field label="Valid from">
          <input className="inp" type="datetime-local" value={validFrom}
                 onChange={(e) => setValidFrom(e.target.value)} />
        </Field>
        <Field label="Valid to">
          <input className="inp" type="datetime-local" value={validTo}
                 onChange={(e) => setValidTo(e.target.value)} />
        </Field>
      </div>
      {badDates && <div className="note warn" style={{ marginBottom: 14 }}>
        The permit has to end after it starts.</div>}

      <p className="eyebrow" style={{ marginBottom: 8 }}>Precautions in place</p>
      <div style={{ display: 'grid', gap: 7, marginBottom: 16 }}>
        {list.map((c) => (
          <label key={c} style={{ display: 'flex', gap: 9, alignItems: 'flex-start', fontSize: '0.8125rem' }}>
            <input type="checkbox" checked={checked.includes(c)} style={{ marginTop: 2 }}
                   onChange={(e) => setChecked((s) => (e.target.checked ? [...s, c] : s.filter((x) => x !== c)))} />
            <span>{c}</span>
          </label>
        ))}
      </div>

      <p className="eyebrow" style={{ marginBottom: 8 }}>Isolation points</p>
      {points.map((p, i) => (
        <div className="grid g4" key={i}>
          <Field label={`Point ${i + 1}`}>
            <input className="inp" value={p.description} placeholder="e.g. DB-3 breaker way 7"
                   onChange={(e) => setPoints((s) => s.map((x, n) => (n === i ? { ...x, description: e.target.value } : x)))} />
          </Field>
          <Field label="Lock tag no.">
            <input className="inp" value={p.lockTagNo} placeholder="optional"
                   onChange={(e) => setPoints((s) => s.map((x, n) => (n === i ? { ...x, lockTagNo: e.target.value } : x)))} />
          </Field>
          <Field label="Asset">
            <select className="inp" value={p.assetId}
                    onChange={(e) => setPoints((s) => s.map((x, n) => (n === i ? { ...x, assetId: e.target.value } : x)))}>
              <option value="">None</option>
              {(assets.data?.assets ?? []).map((a) => (
                <option key={a.id} value={a.id}>{a.asset_tag} · {a.name}</option>))}
            </select>
          </Field>
          {/* An isolation point typed in error had to be lived with until the permit was
              abandoned — on the one form where being exact is the whole point. */}
          <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 2 }}>
            <Btn size="sm" aria-label={`Remove isolation point ${i + 1}`}
                 onClick={() => setPoints((s) => s.filter((_, n) => n !== i))}>Remove</Btn>
          </div>
        </div>
      ))}
      <Btn size="sm" icon="plus"
           onClick={() => setPoints((s) => [...s, { description: '', lockTagNo: '', assetId: '' }])}>
        Add an isolation point
      </Btn>

      <div className="modal-foot">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn tone="pri" icon="shield" disabled={badDates || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Raising…' : 'Request permit'}
        </Btn>
      </div>
    </Modal>
  );
}

function NewIncident({ onClose, onDone }: { onClose: () => void; onDone: (msg: string) => void }) {
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const [occurredAt, setOccurredAt] = useState(
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`);
  const [type, setType] = useState('near_miss');
  const [severity, setSeverity] = useState('minor');
  const [locationId, setLocationId] = useState('');
  const [description, setDescription] = useState('');
  const [immediateAction, setImmediateAction] = useState('');

  const locs = useQuery<{ locations: { id: string; name: string }[] }>({
    queryKey: qk.locations, queryFn: () => api.get('/api/locations'),
  });

  const save = useMutation({
    mutationFn: () => api.post<{ ref: string }>('/api/incidents', {
      type, severity, occurredAt: new Date(occurredAt).toISOString(),
      locationId: locationId || undefined,
      description: description.trim(),
      immediateAction: immediateAction.trim() || undefined,
    }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['incidents'] });
      onDone(`Incident ${r.ref} recorded.`);
    },
    onError: (e) => setErr((e as ApiError).message),
  });

  return (
    <Modal title="Report an incident" onClose={onClose}>
      {err && <div className="note crit" style={{ marginBottom: 14 }} role="alert">{err}</div>}
      <div className="note" style={{ marginBottom: 16 }}>
        Report near misses too. They are the cheapest warning the department will ever get.
      </div>

      <div className="grid g3">
        <Field label="What happened">
          <select className="inp" value={type} onChange={(e) => setType(e.target.value)}>
            {Object.entries(INCIDENT_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <Field label="How serious">
          <select className="inp" value={severity} onChange={(e) => setSeverity(e.target.value)}>
            <option value="minor">Minor</option>
            <option value="moderate">Moderate</option>
            <option value="major">Major</option>
            <option value="critical">Critical</option>
          </select>
        </Field>
        <Field label="When">
          <input className="inp" type="datetime-local" value={occurredAt}
                 onChange={(e) => setOccurredAt(e.target.value)} />
        </Field>
      </div>

      <Field label="Where">
        <select className="inp" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
          <option value="">Not recorded</option>
          {(locs.data?.locations ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </Field>

      <Field label="What happened, in plain words">
        <textarea className="inp" rows={4} value={description} autoFocus
                  placeholder="Describe the event as you saw it. Facts first, opinions after."
                  onChange={(e) => setDescription(e.target.value)} />
      </Field>

      <Field label="What was done immediately">
        <textarea className="inp" rows={3} value={immediateAction}
                  placeholder="Made the area safe, isolated the supply, called the supervisor…"
                  onChange={(e) => setImmediateAction(e.target.value)} />
      </Field>

      <div className="modal-foot">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn tone="pri" icon="alert" disabled={description.trim().length < 5 || save.isPending}
             onClick={() => save.mutate()}>
          {save.isPending ? 'Recording…' : 'Record incident'}
        </Btn>
      </div>
    </Modal>
  );
}

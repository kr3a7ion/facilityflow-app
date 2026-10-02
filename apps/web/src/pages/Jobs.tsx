import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qk, ApiError } from '../lib/api';
import { useSession } from '../lib/session';
import { useMonth } from '../lib/month';
import { slaLabel, slaTone, titleCase } from '../lib/format';
import { Card, Chip, Loading, Empty, ErrorNote, Btn, MonthBar } from '../components/Bits';
import { Icon } from '../components/Icon';

interface Job {
  id: string; ref: string; title: string; priority: string; status: string; trade: string | null;
  source: string; assignee: string | null; unit_no: string | null; asset_tag: string | null;
  hold_reason: string | null; reported_at: string;
  sla: { state: string; minutesRemaining: number | null };
}

interface Board {
  jobs: Job[]; scope: string;
  period: { month: string; label: string; from: string; to: string } | null;
  truncated: boolean; limit: number;
}

/**
 * Work that is sitting on somebody and has not been picked up.
 *
 * Not `status === 'open'`: a job goes open -> assigned -> accepted, so by the time it
 * reaches the person who has to do it, it has already left 'open'. Filtering on that
 * showed a technician "Not started - 0" above a board of two untouched jobs.
 */
function waiting(j: Job): boolean {
  return j.status === 'open' || j.status === 'assigned';
}

/** Per device, like the sound toggle: the store's tablet wants tiles, the HOD's laptop rows. */
const VIEW_KEY = 'ff-jobs-view';
function savedView(): 'table' | 'grid' {
  try { return localStorage.getItem(VIEW_KEY) === 'grid' ? 'grid' : 'table'; } catch { return 'table'; }
}

/**
 * Each filter carries the permission that makes it worth offering.
 *
 * "Unassigned - 0" and "Awaiting verify - 0" sat on a technician's board for weeks: two
 * counts of work they are not allowed to assign and not allowed to verify, taking up the
 * row where the one thing they can do belongs. A filter nobody can act on is noise.
 */
const FILTERS: { key: string; label: string; need?: string }[] = [
  { key: 'open', label: 'All open' },
  { key: 'breached', label: 'Breached' },
  { key: 'accept', label: 'Not started', need: 'wo.accept' },  // see waiting() below
  { key: 'unassigned', label: 'Unassigned', need: 'wo.assign' },
  { key: 'verify', label: 'Awaiting verify', need: 'wo.verify' },
  { key: 'hold', label: 'On hold' },
  { key: 'ppm', label: 'PPM', need: 'ppm.read' },
];

export function Jobs() {
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<string>('open');
  const [view, setView] = useState<'table' | 'grid'>(savedView);
  const month = useMonth();
  const q = params.get('q')?.toLowerCase() ?? '';

  useEffect(() => { try { localStorage.setItem(VIEW_KEY, view); } catch { /* private mode */ } }, [view]);

  const jobs = useQuery<Board>({
    queryKey: qk.jobs(`board:${month.month}`),
    queryFn: () => api.get(`/api/jobs?view=all&limit=400&${month.param}`),
  });
  // Everything still live carries over into whatever month is on screen, so a job raised
  // in July and still open is never lost behind a date. This is the count of those.
  const carried = useMemo(() => {
    const from = jobs.data?.period?.from;
    if (!from) return 0;
    return (jobs.data?.jobs ?? []).filter((j) => j.reported_at < from).length;
  }, [jobs.data]);

  const rows = useMemo(() => {
    let list = jobs.data?.jobs ?? [];
    if (q) {
      list = list.filter((j) =>
        `${j.ref} ${j.title} ${j.unit_no ?? ''} ${j.asset_tag ?? ''}`.toLowerCase().includes(q));
    }
    switch (filter) {
      case 'breached': return list.filter((j) => j.sla.state === 'breached');
      case 'accept': return list.filter(waiting);
      case 'unassigned': return list.filter((j) => !j.assignee && j.status === 'open');
      case 'verify': return list.filter((j) => j.status === 'completed');
      case 'hold': return list.filter((j) => j.status === 'on_hold');
      case 'ppm': return list.filter((j) => j.source === 'ppm');
      default: return list.filter((j) => !['closed', 'cancelled', 'verified'].includes(j.status));
    }
  }, [jobs.data, filter, q]);

  const count = (key: string) => {
    const list = jobs.data?.jobs ?? [];
    switch (key) {
      case 'breached': return list.filter((j) => j.sla.state === 'breached').length;
      case 'accept': return list.filter(waiting).length;
      case 'unassigned': return list.filter((j) => !j.assignee && j.status === 'open').length;
      case 'verify': return list.filter((j) => j.status === 'completed').length;
      case 'hold': return list.filter((j) => j.status === 'on_hold').length;
      case 'ppm': return list.filter((j) => j.source === 'ppm').length;
      default: return list.filter((j) => !['closed', 'cancelled', 'verified'].includes(j.status)).length;
    }
  };

  return (
    <main className="view">
      <div className="vhead">
        <div>
          <p className="eyebrow">Work orders · {jobs.data?.scope === 'own' ? 'yours'
            : jobs.data?.scope === 'team' ? 'your team' : 'the whole property'}</p>
          <h1>Jobs</h1>
          {/* Written for whoever is reading it. A technician was being told to scan an SLA
              column and decide — the supervisor's job, not theirs. And a requester, who
              is never assigned anything and cannot accept or complete, was being told to
              wait for their supervisor to assign them work. */}
          <p>{jobs.data?.scope === 'own' && !can('wo.complete')
            ? 'The faults you have reported, and how far each one has got. Raise a new one the moment you see it — a note in a book is not a job.'
            : jobs.data?.scope === 'own'
              ? 'Everything assigned to you. Open one to accept it, log what you did, and mark it complete — your supervisor verifies from there.'
              : jobs.data?.scope === 'team'
                ? 'Your team\u2019s work. Assign inside the team, and verify what they finish — priority is the left edge, the SLA column is what to scan.'
                : 'Priority is the left edge; the SLA column is the only thing you need to scan.'}</p>
        </div>
        <div className="acts">
          <div className="vtoggle" role="group" aria-label="How to show the board">
            <button className={view === 'table' ? 'on' : ''} onClick={() => setView('table')}
                    aria-pressed={view === 'table'} title="Rows" aria-label="Show as rows">
              <Icon name="rows" />
            </button>
            <button className={view === 'grid' ? 'on' : ''} onClick={() => setView('grid')}
                    aria-pressed={view === 'grid'} title="Cards" aria-label="Show as cards">
              <Icon name="grid" />
            </button>
          </div>
          {can('wo.create') && <NewJob />}
        </div>
      </div>

      <MonthBar month={month.month} label={month.label} isCurrent={month.isCurrent}
                onStep={month.step} onSet={month.set} onReset={month.reset}
                note={carried > 0
                  ? `${carried} still open from before this month`
                  : month.isCurrent ? 'plus anything still open' : undefined} />

      {jobs.data?.truncated && (
        <div className="note warn" style={{ marginBottom: 14 }}>
          Showing the first {jobs.data.limit} jobs for this month — there are more. Narrow the
          month or use a filter.
        </div>
      )}

      {q && (
        <div className="note" style={{ marginBottom: 14 }}>
          Showing matches for <b>{q}</b>.{' '}
          <button className="btn sm" onClick={() => setParams({})}>Clear</button>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        {FILTERS.filter((f) => !f.need || can(f.need)).map((f) => (
          <button key={f.key} className={`btn sm ${filter === f.key ? 'on' : ''}`}
                  onClick={() => setFilter(f.key)}>
            {f.label} · {count(f.key)}
          </button>
        ))}
      </div>

      <Card flush>
        {jobs.isLoading ? <Loading rows={6} />
          : jobs.isError ? <div style={{ padding: 15 }}><ErrorNote error={jobs.error} /></div>
          : rows.length === 0 ? (
            <Empty title={filter !== 'open' || q ? 'Nothing here'
                            : jobs.data?.scope !== 'own' ? 'No open jobs'
                              : can('wo.complete') ? 'Nothing is assigned to you'
                                : 'You have not reported anything yet'}
                   hint={filter !== 'open' || q
                     ? (q ? 'No job matches that search this month.'
                          : 'Try another filter, or step back a month.')
                     : jobs.data?.scope !== 'own'
                       ? 'Everything raised has been closed out.'
                       : can('wo.complete')
                         ? 'When your supervisor assigns you a job it lands here. Anything you raised yourself shows up too.'
                         : 'Report a fault and it appears here with a reference you can quote when somebody asks.'} />
          )
          : view === 'grid' ? (
            <div className="jgrid" style={{ padding: 13 }}>
              {rows.map((j) => (
                <Link key={j.id} to={`/jobs/${j.id}`}
                      className={`jcard ${j.priority.toLowerCase()}`}
                      style={{ textDecoration: 'none', color: 'inherit' }}>
                  <div className="jtop">
                    <span className="jref">{j.ref}</span>
                    <span className="spacer" style={{ flex: 1 }} />
                    <Chip tone={j.priority === 'P1' ? 'crit' : j.priority === 'P2' ? 'warn' : ''}>
                      {j.priority}
                    </Chip>
                  </div>
                  <div className="jttl">{j.title}</div>
                  <div className="jmeta">
                    <span>{j.unit_no ?? j.asset_tag ?? 'Site'}</span>
                    <span>{j.trade ? titleCase(j.trade) : 'Trade not set'}</span>
                  </div>
                  <div className="jfoot">
                    <Chip tone={slaTone(j.sla.state)} lamp={j.sla.state !== 'paused'}>
                      {slaLabel(j.sla)}
                    </Chip>
                    <span className="spacer" style={{ flex: 1 }} />
                    <span className="jmeta">{j.assignee ?? 'Unassigned'}</span>
                  </div>
                </Link>
              ))}
            </div>
          )
          : (
            <>
            <div className="tw jobtable">
              <table className="wide">
                <thead>
                  <tr><th>Job</th><th>Trade</th><th>Assigned</th><th>SLA</th>
                      <th className="mono">State</th><th className="mono">Source</th></tr>
                </thead>
                <tbody>
                  {rows.map((j) => (
                    <tr key={j.id}>
                      <td className={`pri-cell ${j.priority}`}>
                        <Link to={`/jobs/${j.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
                          <span className="ttl">{j.title}</span>
                          <span className="sub">
                            {j.ref} · {j.unit_no ?? j.asset_tag ?? 'site'} · {j.priority}
                          </span>
                        </Link>
                      </td>
                      <td>{j.trade ? titleCase(j.trade) : '—'}</td>
                      <td>{j.assignee ?? <span className="sub">Unassigned</span>}</td>
                      <td><Chip tone={slaTone(j.sla.state)} lamp={j.sla.state !== 'paused'}>
                        {slaLabel(j.sla)}</Chip></td>
                      <td className="mono">
                        {titleCase(j.status)}{j.hold_reason ? ` · ${j.hold_reason.replace('awaiting_', '')}` : ''}
                      </td>
                      <td className="mono">{titleCase(j.source)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="joblist">
              {rows.map((j) => (
                <Link key={j.id} to={`/jobs/${j.id}`} className={`jobrow ${j.priority}`}>
                  <b>{j.title}</b>
                  <Chip tone={slaTone(j.sla.state)} lamp={j.sla.state !== 'paused'}>
                    {j.priority} · {slaLabel(j.sla)}
                  </Chip>
                  <span className="meta">
                    <span>{j.ref} · {j.unit_no ?? j.asset_tag ?? 'site'}</span>
                    {/* On your own board every card said your own name back to you. The
                        trade is what actually helps you pick the next one up. */}
                    <span>{jobs.data?.scope === 'own'
                      ? (j.trade ? titleCase(j.trade) : 'no trade set')
                      : (j.assignee ?? 'unassigned')} · {titleCase(j.status)}</span>
                  </span>
                </Link>
              ))}
            </div>
            </>
          )}
      </Card>
    </main>
  );
}

function NewJob() {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ title: '', description: '', priority: 'P3', trade: '', apartmentId: '' });
  const qc = useQueryClient();

  const apartments = useQuery<{ apartments: { id: string; unit_no: string }[] }>({
    queryKey: qk.apartments, queryFn: () => api.get('/api/apartments'), enabled: open,
  });
  const locations = useQuery<{ locations: { id: string; type: string; name: string }[] }>({
    queryKey: ['locations'], queryFn: () => api.get('/api/locations'), enabled: open,
  });
  const site = locations.data?.locations.find((l) => l.type === 'site');

  const create = useMutation({
    mutationFn: () => api.post('/api/jobs', {
      title: f.title, description: f.description || undefined, priority: f.priority,
      trade: f.trade || undefined,
      apartmentId: f.apartmentId || undefined,
      locationId: f.apartmentId ? undefined : site?.id,
    }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['jobs'] });
      await qc.invalidateQueries({ queryKey: qk.dashboard });
      setOpen(false);
      setF({ title: '', description: '', priority: 'P3', trade: '', apartmentId: '' });
    },
  });

  if (!open) return <Btn tone="pri" icon="plus" onClick={() => setOpen(true)}>Raise job</Btn>;

  const err = create.error as ApiError | null;
  return (
    <div className="card" style={{ width: 'min(460px, 92vw)', position: 'absolute', right: 22, zIndex: 30,
                                   boxShadow: 'var(--shadow)' }}>
      <header><h2>Raise a job</h2><div className="r">
        <button className="btn sm" onClick={() => setOpen(false)}>Cancel</button></div></header>
      <div className="body">
        <div className="fld"><label>What is wrong</label>
          <input className="inp" autoFocus value={f.title}
                 onChange={(e) => setF({ ...f, title: e.target.value })} /></div>
        <div className="grid g2" style={{ gap: 12 }}>
          <div className="fld"><label>Priority</label>
            <select className="inp" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>
              <option value="P1">P1 · emergency</option>
              <option value="P2">P2 · urgent</option>
              <option value="P3">P3 · routine</option>
              <option value="P4">P4 · scheduled</option>
            </select></div>
          <div className="fld"><label>Trade</label>
            <select className="inp" value={f.trade} onChange={(e) => setF({ ...f, trade: e.target.value })}>
              <option value="">Not sure yet</option>
              {['electrical', 'plumbing', 'hvac', 'carpentry', 'civil', 'mechanical', 'general', 'vendor']
                .map((t) => <option key={t} value={t}>{titleCase(t)}</option>)}
            </select></div>
        </div>
        <div className="fld"><label>Unit (leave blank for common areas)</label>
          <select className="inp" value={f.apartmentId}
                  onChange={(e) => setF({ ...f, apartmentId: e.target.value })}>
            <option value="">Site / common area</option>
            {(apartments.data?.apartments ?? []).map((a) =>
              <option key={a.id} value={a.id}>{a.unit_no}</option>)}
          </select></div>
        <div className="fld"><label>Detail</label>
          <textarea className="inp" rows={3} value={f.description}
                    onChange={(e) => setF({ ...f, description: e.target.value })} /></div>
        {err && <div className="note crit" style={{ marginBottom: 12 }} role="alert">{err.message}</div>}
        <Btn tone="pri" style={{ width: '100%' }} disabled={f.title.length < 3 || create.isPending}
             onClick={() => create.mutate()}>
          {create.isPending ? 'Raising…' : 'Raise job'}
        </Btn>
      </div>
    </div>
  );
}

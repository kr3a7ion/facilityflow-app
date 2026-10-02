import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, qk } from '../lib/api';
import { useSession } from '../lib/session';
import { useMonth } from '../lib/month';
import { naira, slaLabel, slaTone, titleCase } from '../lib/format';
import { Card, Chip, Tile, Loading, ErrorNote, Empty, Gauge, MonthBar } from '../components/Bits';
import { StartHere } from '../components/StartHere';

interface Dashboard {
  openJobs: { onTime: number; dueSoon: number; breached: number; paused: number; total: number };
  aging: { under24h: number; d1to3: number; d3to7: number; over7d: number };
  mttr: { jobs: number; meanResolveMinutes: number | null; meanResponseMinutes: number | null };
  firstTimeFix: { verified: number; reopened: number; firstTimeFixPct: number | null };
  workMix: { total: number; reactivePct: number; bySource: { source: string; n: number }[] };
  ppm: { generated: number; onTime: number; open: number; compliancePct: number };
  /** costPerKwhKobo is absent without cost.read — a naira figure, not a plant reading. */
  power: { fuelUsedL: number; kwh: number; costPerKwhKobo?: number | null };
  contractsExpiring: { id: string; title: string; end_date: string; vendor: string }[];
  lowStock?: { id: string; name: string; current_qty: number; unit: string; min_level: number }[];
}
interface Job {
  id: string; ref: string; title: string; priority: string; status: string;
  assignee: string | null; unit_no: string | null;
  sla: { state: string; minutesRemaining: number | null };
}
interface Plant {
  tanks: { id: string; name: string; litres: number | null; capacity: number;
           minLevel: number; belowMinimum: boolean }[];
  gensets: { tag: string; name: string; status: string; lastLph: number | null }[];
}

export function Overview() {
  const { can, me } = useSession();
  // A dashboard that resets to zero every first of the month tells the morning meeting
  // nothing, so the default stays a rolling thirty days. The calendar month is one click
  // away for whoever has to report on it.
  const month = useMonth();
  const [scope, setScope] = useState<'rolling' | 'month'>('rolling');
  const dash = useQuery<Dashboard>({
    queryKey: [...qk.dashboard, scope === 'month' ? month.month : 'rolling'],
    queryFn: () => api.get(scope === 'month'
      ? `/api/reports/dashboard?${month.param}`
      : '/api/reports/dashboard'),
  });
  const jobs = useQuery<{ jobs: Job[] }>({
    queryKey: qk.jobs('needs-you'), queryFn: () => api.get('/api/jobs?limit=60'), enabled: can('wo.read'),
  });
  const plant = useQuery<Plant>({
    queryKey: qk.plant, queryFn: () => api.get('/api/status/plant'), enabled: can('fuel.read'),
  });

  const needsYou = (jobs.data?.jobs ?? [])
    .filter((j) => !['verified', 'closed', 'cancelled'].includes(j.status))
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, 6);

  const d = dash.data;
  const stack = d ? [
    { n: d.openJobs.onTime, label: 'on time', v: 'ok' },
    { n: d.openJobs.dueSoon, label: 'due soon', v: 'warn' },
    { n: d.openJobs.breached, label: 'breached', v: 'crit' },
    { n: d.openJobs.paused, label: 'paused', v: 'idle' },
  ].filter((s) => s.n > 0) : [];
  const stackTotal = stack.reduce((s, x) => s + x.n, 0) || 1;

  return (
    <main className="view">
      <div className="vhead">
        <div>
          <p className="eyebrow">{me?.user.roleName ?? ''} · {new Date().toLocaleDateString(undefined,
            { weekday: 'long', day: 'numeric', month: 'long' })}</p>
          <h1>Overview</h1>
          <p>What is late, what is burning fuel, and who is on the floor to fix it.</p>
        </div>
        <div className="acts">
          <div className="vtoggle" role="group" aria-label="Which period the figures cover">
            <button className={scope === 'rolling' ? 'on' : ''} onClick={() => setScope('rolling')}
                    aria-pressed={scope === 'rolling'}
                    style={{ padding: '7px 12px', fontSize: '0.7812rem' }}>Last 30 days</button>
            <button className={scope === 'month' ? 'on' : ''} onClick={() => setScope('month')}
                    aria-pressed={scope === 'month'}
                    style={{ padding: '7px 12px', fontSize: '0.7812rem' }}>By month</button>
          </div>
          {can('wo.create') && <Link className="btn pri" to="/jobs?new=1">Raise job</Link>}
        </div>
      </div>

      {scope === 'month' && (
        <MonthBar month={month.month} label={month.label} isCurrent={month.isCurrent}
                  onStep={month.step} onSet={month.set} onReset={month.reset}
                  note="rates and costs for the calendar month" />
      )}

      <StartHere />

      {dash.isError && <ErrorNote error={dash.error} hint="The rest of the page may be incomplete." />}

      <div className="grid g4" style={{ marginBottom: 14 }}>
        <Tile label="Open jobs" value={d?.openJobs.total ?? '—'}
              sub={d ? `${d.aging.under24h} raised in the last 24 h` : ''} />
        <Tile label="Breaching SLA" value={d?.openJobs.breached ?? '—'}
              tone={d && d.openJobs.breached > 0 ? 'crit' : undefined}
              sub={d && d.openJobs.paused > 0 ? <Chip>{d.openJobs.paused} on hold</Chip> : 'nothing overdue'} />
        {/* compliancePct is null until something has actually been judged, and printing
            that straight gave everyone "null% completed on time" on their first morning. */}
        <Tile label="PPM open" value={d?.ppm.open ?? '—'}
              sub={!d ? '' : d.ppm.compliancePct == null
                ? (d.ppm.generated > 0 ? 'none due yet' : 'no schedules yet')
                : `${d.ppm.compliancePct}% completed on time`} />
        <Tile label="Reactive share" value={d ? d.workMix.reactivePct : '—'} unit="%"
              sub={d ? `${d.workMix.total} jobs in the period` : ''} />
      </div>

      <div className="grid g21" style={{ marginBottom: 14 }}>
        <Card title="Needs you now" flush
              right={<><Chip>Sorted by breach</Chip><Link className="btn sm" to="/jobs">All jobs</Link></>}>
          {jobs.isLoading ? <Loading rows={5} />
            : needsYou.length === 0
              ? <Empty title="Nothing is waiting on you" hint="Every open job is inside its SLA." />
              : (
                <div className="tw">
                  <table className="wide">
                    <thead><tr><th>Job</th><th>Assigned</th><th>SLA</th><th className="mono">State</th></tr></thead>
                    <tbody>
                      {needsYou.map((j) => (
                        <tr key={j.id}>
                          <td className={`pri-cell ${j.priority}`}>
                            <Link to={`/jobs/${j.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
                              <span className="ttl">{j.title}</span>
                              <span className="sub">{j.ref} · {j.unit_no ?? 'site'} · {j.priority}</span>
                            </Link>
                          </td>
                          <td>{j.assignee ?? <span className="sub">Unassigned</span>}</td>
                          <td><Chip tone={slaTone(j.sla.state)} lamp={j.sla.state !== 'paused'}>
                            {slaLabel(j.sla)}</Chip></td>
                          <td className="mono">{titleCase(j.status)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
        </Card>

        {can('fuel.read') && (
          <Card title="Fuel &amp; gensets" right={<Link className="btn sm" to="/power">Open</Link>}>
            {(plant.data?.tanks.length ?? 0) === 0 && (plant.data?.gensets.length ?? 0) === 0 ? (
              <Empty title="No tanks or gensets yet"
                     hint="Once the diesel tanks and the standby sets are on the register, this is the corner of the morning meeting that answers itself."
                     action={can('admin.settings.manage')
                       ? <Link className="btn pri" to="/admin?tab=supplies">Add the tanks</Link> : undefined}
                     ask="Ask an administrator to add the tanks and generators." />
            ) : (
            <>
            <div className="tanks" style={{ marginBottom: 16 }}>
              {(plant.data?.tanks ?? []).map((t) => (
                <Gauge key={t.id} name={t.name} litres={t.litres} capacity={t.capacity}
                       minLevel={t.minLevel || undefined} />
              ))}
            </div>
            <table>
              <tbody>
                {(plant.data?.gensets ?? []).map((g) => (
                  <tr key={g.tag}>
                    <td style={{ paddingLeft: 0 }}>
                      <span className="ttl">{g.tag}</span><span className="sub">{g.name}</span>
                    </td>
                    <td><Chip lamp tone={g.status === 'in_service' ? 'ok' : g.status === 'faulty' ? 'crit' : ''}>
                      {titleCase(g.status)}</Chip></td>
                    <td className="num">{g.lastLph != null ? `${g.lastLph} L/h` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </>
            )}
          </Card>
        )}
      </div>

      <div className="grid g2">
        <Card title="Open job aging" right={<Chip>{d?.openJobs.total ?? 0} jobs</Chip>}>
          {stack.length === 0 ? <Empty title="No open jobs" /> : (
            <>
              <div className="stack">
                {stack.map((s) => (
                  <b key={s.label} style={{ width: `${(s.n / stackTotal) * 100}%`, background: `var(--${s.v})` }}>
                    {(s.n / stackTotal) > 0.14 ? `${s.n} ${s.label}` : s.n}
                  </b>
                ))}
              </div>
              <div className="legend">
                <span><i style={{ background: 'var(--ok)' }} />On time — inside SLA</span>
                <span><i style={{ background: 'var(--warn)' }} />Due soon — under 2 h left</span>
                <span><i style={{ background: 'var(--crit)' }} />Breached — past due</span>
                <span><i style={{ background: 'var(--idle)' }} />On hold — clock paused</span>
              </div>
            </>
          )}
          <div className="note" style={{ marginTop: 14 }}>
            Breached jobs escalate on their own: past the response deadline to the team lead,
            past resolve to the supervisor, and a P1 at twice its deadline to the HOD.
            <b> Nobody has to remember to check.</b>
          </div>
        </Card>

        <Card title="Department numbers"
              right={<Chip>{scope === 'month' ? month.label : 'Last 30 days'}</Chip>}>
          <dl className="kv">
            <dt>MTTR</dt>
            <dd>{d?.mttr.meanResolveMinutes != null
              ? `${Math.round(d.mttr.meanResolveMinutes / 60)} h across ${d.mttr.jobs} jobs`
              : 'no completed jobs yet'}</dd>
            <dt>Response</dt>
            <dd>{d?.mttr.meanResponseMinutes != null ? `${d.mttr.meanResponseMinutes} minutes` : '—'}</dd>
            <dt>First-time fix</dt>
            <dd>{d?.firstTimeFix.firstTimeFixPct != null
              ? `${d.firstTimeFix.firstTimeFixPct}% of ${d.firstTimeFix.verified} verified`
              : '—'}</dd>
            <dt>PPM compliance</dt>
            <dd>{!d ? '—' : d.ppm.compliancePct == null
              ? (d.ppm.generated > 0 ? `${d.ppm.generated} generated, none due yet` : 'no planned work scheduled')
              : `${d.ppm.compliancePct}% of ${d.ppm.generated} generated`}</dd>
            {can('cost.read') ? (
              <>
                <dt>Cost per kWh</dt>
                <dd>{d?.power.costPerKwhKobo != null
                  ? `${naira(d.power.costPerKwhKobo)} · ${d.power.fuelUsedL.toLocaleString()} L burned`
                  : 'no generator runs logged'}</dd>
              </>
            ) : (
              <>
                <dt>Diesel burned</dt>
                <dd>{d ? `${d.power.fuelUsedL.toLocaleString()} L · ${Math.round(d.power.kwh).toLocaleString()} kWh generated`
                       : '—'}</dd>
              </>
            )}
          </dl>

          {(d?.contractsExpiring.length ?? 0) > 0 && (
            <div className="note warn" style={{ marginTop: 14 }}>
              <b>Contracts expiring inside 60 days</b>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {d!.contractsExpiring.map((c) => (
                  <li key={c.id}>{c.title} — {c.vendor}, ends {c.end_date}</li>
                ))}
              </ul>
            </div>
          )}
          {(d?.lowStock?.length ?? 0) > 0 && (
            <div className="note warn" style={{ marginTop: 12 }}>
              <b>At or below minimum stock</b>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {d!.lowStock!.map((s) => (
                  <li key={s.id}>{s.name} — {s.current_qty} {s.unit} left, minimum {s.min_level}</li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      </div>
    </main>
  );
}

function rank(j: Job): number {
  const state = j.sla.state === 'breached' ? 0 : j.sla.state === 'due_soon' ? 1 : j.sla.state === 'paused' ? 3 : 2;
  const p = Number(j.priority.slice(1));
  return state * 10 + p;
}

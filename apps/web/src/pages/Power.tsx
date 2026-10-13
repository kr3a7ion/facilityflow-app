import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qk, ApiError } from '../lib/api';
import { useSession } from '../lib/session';
import { duration, hours, litres, naira, titleCase, when } from '../lib/format';
import { Card, Chip, Tile, Gauge, Loading, ErrorNote, Empty, Btn, Field, Modal, MonthBar,
         type Tone } from '../components/Bits';
import { useMonth } from '../lib/month';

interface Tank {
  id: string; name: string; kind: string; capacity_l: number; min_level_l: number;
  current_level_l: number | null; pct_full: number | null; last_dip_at: string | null;
  dip_chart_json: string | null;
}
interface Delivery {
  id: string; ref: string; delivered_at: string; tank_name: string; waybill_no: string | null;
  invoiced_l: number; received_l: number; variance_l: number; variance_pct: number; flagged: number;
  received_by_name: string | null; witnessed_by_name: string | null;
}
interface Run {
  id: string; asset_tag: string; genset_name: string; started_at: string; run_hours: number | null;
  fuel_used_l: number | null; actual_lph: number | null; expected_lph: number | null;
  deviation_pct: number | null; kwh_generated: number | null; reason: string;
}
interface Rec {
  tankName: string; openingL: number; deliveriesL: number; issuesL: number;
  computedClosingL: number; dippedClosingL: number; varianceL: number; variancePct: number;
  tolerancePct: number; status: string;
}

export function Power() {
  const { can } = useSession();
  const qc = useQueryClient();
  const [tankId, setTankId] = useState<string>('');
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [clamping, setClamping] = useState(false);
  const month = useMonth();

  const tanks = useQuery<{ tanks: Tank[] }>({ queryKey: qk.tanks, queryFn: () => api.get('/api/fuel/tanks') });
  const deliveries = useQuery<{ deliveries: Delivery[] }>({
    queryKey: [...qk.deliveries, month.month],
    queryFn: () => api.get(`/api/fuel/deliveries?${month.param}`),
  });
  const runs = useQuery<{ runs: Run[] }>({ queryKey: qk.runs, queryFn: () => api.get('/api/gensets/runs?limit=12') });
  // Naira per unit generated now takes cost.read, so a technician who dips tanks does not
  // ask for it at all rather than being handed a 403 on every visit to this screen.
  const money = can('cost.read');
  const cost = useQuery<{ fuelUsedL: number; kwh: number; fuelCostKobo: number; costPerKwhKobo: number | null }>({
    queryKey: ['power-cost'], queryFn: () => api.get('/api/power/cost'), enabled: money,
  });

  const bulk = tanks.data?.tanks.find((t) => t.kind === 'bulk');
  const selected = tankId || bulk?.id || '';
  const from = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const to = new Date().toISOString();

  const rec = useQuery<Rec>({
    queryKey: ['reconcile', selected],
    queryFn: () => api.get(`/api/fuel/reconcile?tankId=${selected}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
    enabled: !!selected,
    retry: false,
  });

  const dip = useMutation({
    mutationFn: (v: { tankId: string; litres?: number; dipMm?: number }) =>
      api.post(`/api/fuel/tanks/${v.tankId}/dip`, { litres: v.litres, dipMm: v.dipMm }),
    onSuccess: async (r) => {
      const res = r as { litres: number; belowMinimum: boolean };
      setMsg({ text: `Dip recorded at ${Math.round(res.litres)} L.${res.belowMinimum ? ' Below minimum — order diesel.' : ''}`,
               bad: res.belowMinimum });
      await qc.invalidateQueries({ queryKey: qk.tanks });
      await qc.invalidateQueries({ queryKey: qk.plant });
      await qc.invalidateQueries({ queryKey: ['reconcile'] });
    },
    onError: (e) => setMsg({ text: (e as ApiError).message, bad: true }),
  });

  const lastRuns = (runs.data?.runs ?? []).slice().reverse();

  return (
    <main className="view">
      <div className="vhead">
        <div>
          <p className="eyebrow">Generators · tanks · reconciliation</p>
          <h1>Power &amp; Diesel</h1>
          <p>Clamp the incomer, and the building's load stops being a guess. Recording
             deliveries and dips is bookkeeping — reconciling them is what makes this module
             pay for the project.</p>
        </div>
        {can('fuel.dip.log') && bulk && (
          <div className="acts"><DipButton tanks={tanks.data?.tanks ?? []} onSubmit={dip.mutate}
                                           pending={dip.isPending} /></div>
        )}
      </div>

      {msg && <div className={`note ${msg.bad ? 'warn' : ''} mb-6`} role="status">
        {msg.text}</div>}

      {/* What is carrying the building right now, and the buttons to change it. First,
          because during an outage this is what somebody opened the screen for. */}
      <Changeover canLog={can('genset.run.log')} />

      {/* Then the load: during an outage it is the next thing anybody needs. */}
      <LoadPanel canLog={can('power.clamp.log')} onLog={() => setClamping(true)} />
      {clamping && <ClampDialog onClose={() => setClamping(false)} />}

      <GensetLog canLog={can('genset.run.log')} />

      <MonthBar month={month.month} label={month.label} isCurrent={month.isCurrent}
                onStep={month.step} onSet={month.set} onReset={month.reset}
                note="deliveries and readings below" />

      <div className="grid g21 mb-6">
        <Card title="Fuel burn per running hour"
              right={lastRuns.length > 0 && lastRuns.at(-1)?.deviation_pct != null
                ? <Chip tone={(lastRuns.at(-1)!.deviation_pct ?? 0) > 10 ? 'warn' : 'ok'} lamp>
                    {(lastRuns.at(-1)!.deviation_pct ?? 0) > 0 ? '+' : ''}
                    {lastRuns.at(-1)!.deviation_pct}% vs expected
                  </Chip>
                : undefined}>
          {runs.isLoading ? <Loading rows={3} />
            : lastRuns.length < 2
              ? <Empty title="Not enough generator runs yet"
                       hint="Log a couple of runs and the burn trend appears here." />
              : <BurnChart runs={lastRuns} />}
          <div className="note mt-6">
            Three consecutive runs above the deviation threshold raise a PPM job automatically —
            <b> injectors, air filter or fuel filter</b> — before the set fails during an outage.
          </div>
        </Card>

        <Card title="Tank reconciliation"
              right={(tanks.data?.tanks.length ?? 0) === 0 ? undefined : (
                // An empty dropdown is a control that looks broken rather than unused.
                <select className="inp compact w-sm"
                        value={selected} onChange={(e) => setTankId(e.target.value)}
                        aria-label="Which tank">
                  {(tanks.data?.tanks ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              )}>
          {(tanks.data?.tanks.length ?? 0) === 0
            ? <Empty title="Nothing to reconcile yet"
                     hint="Reconciliation is opening dip, plus deliveries, minus what the sets burned, against the closing dip. It needs a tank to measure." />
            : rec.isLoading ? <Loading rows={4} />
            : rec.isError
              ? <div className="note warn">{(rec.error as ApiError).message}</div>
              : rec.data && (
                <>
                  <div className="f-cond t-readout fw-7 lh-1 tnum">
                    {rec.data.varianceL > 0 ? '+' : ''}{rec.data.varianceL}
                    <span className="t-lede c-3"> L</span>
                  </div>
                  <div className="mt-4 mb-6">
                    <Chip tone={rec.data.status === 'ok' ? 'ok' : 'warn'} lamp>
                      {rec.data.status === 'ok' ? 'Within tolerance' : 'Flagged'} · {rec.data.variancePct}%
                    </Chip>
                  </div>
                  <table className="f-mono t-sm">
                    <tbody>
                      <tr><td className="pl-0">Opening dip</td>
                          <td className="num">{litres(rec.data.openingL)}</td></tr>
                      <tr><td className="pl-0">+ Deliveries received</td>
                          <td className="num">{litres(rec.data.deliveriesL)}</td></tr>
                      <tr><td className="pl-0">− Issued to gensets</td>
                          <td className="num">{litres(rec.data.issuesL)}</td></tr>
                      <tr><td className="fw-6 c-1 pl-0">= Expected closing</td>
                          <td className="num fw-6 c-1">
                            {litres(rec.data.computedClosingL)}</td></tr>
                      <tr><td className="pl-0">Dipped closing</td>
                          <td className="num">{litres(rec.data.dippedClosingL)}</td></tr>
                    </tbody>
                  </table>
                  <div className="note warn mt-6">
                    Tolerance is {rec.data.tolerancePct}%, measured against throughput rather than the
                    balance. Beyond it the period is flagged and somebody explains it in writing.
                  </div>
                </>
              )}
        </Card>
      </div>

      <div className="grid g2 mb-6">
        <Card title="Tanks" right={<Chip>{tanks.data?.tanks.length ?? 0}</Chip>}>
          {(tanks.data?.tanks.length ?? 0) === 0 ? (
            <Empty title="No tanks yet"
                   hint="Dips, deliveries and reconciliation all hang off a tank, so until one exists this whole module stays dark. Add the bulk tank first, then any day tanks."
                   action={can('admin.settings.manage')
                     ? <Link className="btn pri" to="/admin?tab=supplies">Add a tank</Link> : undefined}
                   ask="Ask an administrator to add the diesel tanks under Admin → Supplies." />
          ) : (
            <>
              <div className="tanks">
                {(tanks.data?.tanks ?? []).map((t) => (
                  <Gauge key={t.id} name={t.name} litres={t.current_level_l}
                         capacity={t.capacity_l} minLevel={t.min_level_l || undefined} />
                ))}
              </div>
              <div className="legend mt-6">
                {(tanks.data?.tanks ?? []).map((t) => (
                  <span key={t.id}>
                    {t.name}: last dipped {t.last_dip_at ? when(t.last_dip_at) : 'never'}
                    {t.dip_chart_json ? '' : ' · no calibration chart'}
                  </span>
                ))}
              </div>
            </>
          )}
        </Card>

{money && (
                <Card title="Cost of generated power" right={<Chip>Last 30 days</Chip>}>
          <div className="grid g2 gap-5">
            <Tile label="Cost per kWh" value={naira(cost.data?.costPerKwhKobo)}
                  sub={cost.data?.kwh ? `${Math.round(cost.data.kwh).toLocaleString()} kWh generated` : 'no runs logged'} />
            <Tile label="Diesel burned" value={cost.data ? Math.round(cost.data.fuelUsedL).toLocaleString() : '—'}
                  unit="L" sub={naira(cost.data?.fuelCostKobo, { compact: true })} />
          </div>
          <div className="note mt-6">
            Cost per kWh against the grid tariff is the number to take upstairs. It is the whole
            business case for solar, a smaller standby set, or a load-shedding policy — and right now
            <b> nobody in the department can produce it on demand.</b>
          </div>
        </Card>)}
      </div>

      <div className="grid g2">
        <Card title="Deliveries" flush right={<Chip>Two signatures each</Chip>}>
          {deliveries.isLoading ? <Loading rows={3} />
            : (deliveries.data?.deliveries.length ?? 0) === 0
              ? <Empty title="No deliveries this month"
                       hint={month.isCurrent ? 'Nothing has come in yet.' : `Nothing in ${month.label}.`} />
              : (
                <div className="tw">
                  <table className="wide">
                    <thead><tr><th>Date · tank</th><th className="num">Invoiced</th>
                      <th className="num">Received</th><th>Variance</th></tr></thead>
                    <tbody>
                      {deliveries.data!.deliveries.map((d) => (
                        <tr key={d.id}>
                          <td><span className="ttl">{d.tank_name}</span>
                              <span className="sub">{when(d.delivered_at)}
                                {d.waybill_no ? ` · ${d.waybill_no}` : ''}</span></td>
                          <td className="num">{litres(d.invoiced_l)}</td>
                          <td className="num">{litres(d.received_l)}</td>
                          <td><Chip tone={d.flagged ? 'warn' : 'ok'} lamp>
                            {d.variance_pct > 0 ? '+' : ''}{d.variance_pct}%{d.flagged ? ' flagged' : ''}
                          </Chip></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
        </Card>

        <Card title="Generator runs" flush right={<Chip>Newest first</Chip>}>
          {(runs.data?.runs.length ?? 0) === 0 ? <Empty title="No runs logged" /> : (
            <div className="tw">
              <table className="wide">
                <thead><tr><th>Genset</th><th className="num">Hours</th><th className="num">L/h</th>
                  <th>Against expected</th></tr></thead>
                <tbody>
                  {(runs.data?.runs ?? []).map((r) => (
                    <tr key={r.id}>
                      <td><span className="ttl">{r.asset_tag}</span>
                          <span className="sub">{when(r.started_at)} · {titleCase(r.reason)}</span></td>
                      <td className="num">{hours(r.run_hours)}</td>
                      <td className="num">{r.actual_lph ?? '—'}</td>
                      <td>{r.deviation_pct == null ? '—' : (
                        <Chip tone={r.deviation_pct > 10 ? 'warn' : 'ok'} lamp>
                          {r.deviation_pct > 0 ? '+' : ''}{r.deviation_pct}%
                        </Chip>
                      )}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </main>
  );
}

/** A single series with an expected-burn reference line. No legend needed — the title names it. */
function BurnChart({ runs }: { runs: Run[] }) {
  const pts = runs.filter((r) => r.actual_lph != null);
  if (pts.length < 2) return <Empty title="Not enough runs" />;
  const values = pts.map((p) => p.actual_lph!);
  const expected = pts.at(-1)?.expected_lph ?? null;
  const all = expected != null ? [...values, expected] : values;
  const min = Math.min(...all) * 0.96;
  const max = Math.max(...all) * 1.04;
  const W = 640, H = 180, L = 42, R = 12, T = 14, B = 26;
  const x = (i: number) => L + (i * (W - L - R)) / (pts.length - 1);
  const y = (v: number) => T + ((max - v) / (max - min || 1)) * (H - T - B);
  const line = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const area = `${line} L${x(values.length - 1).toFixed(1)} ${H - B} L${L} ${H - B} Z`;
  const ticks = [min + (max - min) * 0.15, (min + max) / 2, max - (max - min) * 0.15];

  return (
    <div className="tw">
      <svg className="w-full block" viewBox={`0 0 ${W} ${H}`} style={{ height: 'auto', overflow: 'visible' }}
           role="img" aria-label={`Fuel burn over the last ${pts.length} runs, latest ${values.at(-1)} litres per hour.`}>
        <g stroke="var(--line)" strokeWidth="1">
          {ticks.map((t, i) => <path key={i} d={`M${L} ${y(t).toFixed(1)}H${W - R}`} />)}
        </g>
        <g fill="var(--text-3)" fontFamily="IBM Plex Mono, monospace" fontSize="10">
          {ticks.map((t, i) => (
            <text key={i} x={L - 8} y={y(t) + 3.5} textAnchor="end">{t.toFixed(1)}</text>
          ))}
          <text x={L} y={H - 6}>{pts.length} runs ago</text>
          <text x={W - R} y={H - 6} textAnchor="end">latest</text>
        </g>
        {expected != null && (
          <>
            <path d={`M${L} ${y(expected).toFixed(1)}H${W - R}`} stroke="var(--text-3)" strokeWidth="1.5"
                  strokeDasharray="5 4" opacity="0.75" />
            <text x={L + 4} y={y(expected) + 13} fill="var(--text-3)"
                  fontFamily="IBM Plex Mono, monospace" fontSize="10">
              expected {expected} L/h at this load
            </text>
          </>
        )}
        <path d={area} fill="var(--accent)" opacity="0.1" />
        <path d={line} fill="none" stroke="var(--accent)" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round" />
        {values.map((v, i) => (
          <circle key={i} cx={x(i)} cy={y(v)} r={i === values.length - 1 ? 4.5 : 2.5}
                  fill="var(--accent)" stroke="var(--panel)" strokeWidth={i === values.length - 1 ? 2 : 0}>
            <title>{`${v} L/h`}</title>
          </circle>
        ))}
        <text x={W - R - 6} y={y(values.at(-1)!) - 10} textAnchor="end" fill="var(--text)"
              fontFamily="Saira Condensed, sans-serif" fontSize="16" fontWeight="700">
          {values.at(-1)} L/h
        </text>
      </svg>
    </div>
  );
}

function DipButton({ tanks, onSubmit, pending }:
  { tanks: Tank[]; onSubmit: (v: { tankId: string; litres?: number; dipMm?: number }) => void; pending: boolean }) {
  const [open, setOpen] = useState(false);
  const [tank, setTank] = useState(tanks[0]?.id ?? '');
  const [mode, setMode] = useState<'litres' | 'mm'>('litres');
  const [value, setValue] = useState('');
  const chosen = tanks.find((t) => t.id === tank);
  const hasChart = !!chosen?.dip_chart_json;

  if (!open) return <Btn tone="pri" icon="plus" onClick={() => setOpen(true)}>Log dip</Btn>;
  return (
    <div className="card" style={{ width: 'min(400px,92vw)', position: 'absolute', right: 22, zIndex: 30,
                                   boxShadow: 'var(--shadow)' }}>
      <header><h2>Log a dip</h2><div className="r">
        <button className="btn sm" onClick={() => setOpen(false)}>Cancel</button></div></header>
      <div className="body">
        <div className="fld"><label>Tank</label>
          <select className="inp" value={tank} onChange={(e) => { setTank(e.target.value); setMode('litres'); }}>
            {tanks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select></div>
        <div className="fld"><label>Reading</label>
          <div className="row gap-4">
            <input className="inp" inputMode="decimal" value={value} autoFocus
                   onChange={(e) => setValue(e.target.value)} placeholder={mode === 'mm' ? 'millimetres' : 'litres'} />
            <select className="inp w-sm" value={mode}
                    onChange={(e) => setMode(e.target.value as 'litres' | 'mm')}>
              <option value="litres">Litres</option>
              <option value="mm" disabled={!hasChart}>Millimetres</option>
            </select>
          </div>
        </div>
        {!hasChart && (
          <div className="note warn mb-5">
            This tank has no calibration chart, so a millimetre dip cannot be converted.
            A horizontal cylinder is not linear — add the chart in Admin, or read in litres.
          </div>
        )}
        <Btn full tone="pri" disabled={!value || pending}
             onClick={() => {
               const n = Number(value);
               if (!Number.isFinite(n)) return;
               onSubmit(mode === 'mm' ? { tankId: tank, dipMm: n } : { tankId: tank, litres: n });
               setOpen(false); setValue('');
             }}>
          {pending ? 'Recording…' : 'Record dip'}
        </Btn>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Clamp readings and building load
// ---------------------------------------------------------------------------

interface Source {
  id: string; name: string; kind: string; phases: number; nominal_volts: number;
  default_pf: number; ct_ratio: number; breaker_amps: number | null; is_incomer: number;
}
interface LiveSource {
  id: string; name: string; kind: string; isIncomer: boolean;
  takenAt: string | null; ageMinutes: number | null; stale: boolean; counted: boolean;
  phaseAmps: number[]; avgAmps: number | null; maxAmps: number | null;
  imbalancePct: number | null; imbalanceFlag: 'ok' | 'watch' | 'act' | null;
  kva: number | null; kw: number | null;
  breakerAmps: number | null; breakerPct: number | null; why: string;
}
interface GensetOption {
  assetId: string; tag: string; name: string; status: string; kvaRating: number;
  loadPct: number | null; verdict: 'good' | 'light' | 'tight' | 'over' | 'unavailable';
  expectedLph: number | null; note: string;
}
interface LoadNow {
  at: string; utility: 'on' | 'off';
  totalKw: number | null; totalKva: number | null;
  sources: LiveSource[];
  worstImbalance: { name: string; pct: number } | null;
  gensets: GensetOption[];
  recommended: string | null; advice: string; freshMinutes: number;
}

const VERDICT_TONE: Record<GensetOption['verdict'], Tone> = {
  good: 'ok', tight: 'warn', light: '', over: 'crit', unavailable: '',
};

/**
 * What the building is drawing, and which set to start.
 *
 * This is the whole reason the clamp round is worth typing in. The numbers a technician
 * reads off three phases are not a load until somebody multiplies them by √3, the
 * voltage and the power factor — and nobody does that standing in a switchroom, so the
 * decision gets made on the size of the set instead of the size of the load.
 */
function LoadPanel({ onLog, canLog }: { onLog: () => void; canLog: boolean }) {
  const { can } = useSession();
  const now = useQuery<LoadNow>({
    queryKey: ['power-load'],
    queryFn: () => api.get('/api/power/load'),
    refetchInterval: 60_000,
  });

  if (now.isLoading) return <Card title="Building load right now"><Loading rows={5} /></Card>;
  if (now.isError) return <Card title="Building load right now"><ErrorNote error={now.error} /></Card>;
  const d = now.data!;

  const counted = d.sources.filter((s) => s.counted);
  const usable = d.gensets.filter((g) => g.verdict !== 'unavailable');

  return (
    <div className="grid g21 mb-6">
      <Card title="Building load right now"
            right={<>
              {d.totalKva != null && <Chip tone={d.utility === 'off' ? 'warn' : 'ok'} lamp>
                Utility {d.utility}
              </Chip>}
              {canLog && <Btn size="sm" icon="amp" onClick={onLog}>Log clamp reading</Btn>}
            </>}>
        {d.totalKw == null ? (
          // Two different dead ends wearing the same face: nothing to clamp, or nothing
          // clamped yet. Telling somebody to take a reading on a property with no incomer
          // configured sends them looking for a button that does not exist.
          d.sources.some((s) => s.isIncomer) ? (
            <Empty title="Nobody has clamped yet today"
                   hint={`Clamp an incomer and the load appears here. Anything older than ${
                     Math.round(d.freshMinutes / 60)} hours is treated as history, not as now.`}
                   action={canLog
                     ? <Btn tone="pri" icon="amp" onClick={onLog}>Log clamp reading</Btn> : undefined}
                   ask="Ask a supervisor or technician to clamp the incomer." />
          ) : (
            <Empty title="Nothing is set up to clamp"
                   hint="The utility incomer has to be described once — its voltage, its CT ratio, whether it feeds the whole building — before a reading means anything."
                   action={can('power.source.manage')
                     ? <Link className="btn pri" to="/admin?tab=supplies">Set up the incomer</Link> : undefined}
                   ask="Ask an administrator to add the incomer under Admin → Supplies." />
          )
        ) : (
          <>
            <div className="bigload">
              {Math.round(d.totalKw).toLocaleString()}<u>kW</u>
              <span className="t-lede c-3 ml-6">
                {Math.round(d.totalKva!).toLocaleString()} kVA
              </span>
            </div>
            <p className="sub mt-4 mb-0">
              From {counted.length === 1 ? counted[0]!.name.toLowerCase()
                : `${counted.length} incomers`}, clamped{' '}
              {counted[0]?.ageMinutes != null ? `${duration(counted[0].ageMinutes)} ago` : 'recently'}.
            </p>
          </>
        )}

        {d.sources.filter((s) => s.phaseAmps.length > 0).map((s) => (
          // A stale supply is dimmed rather than hidden: it is still the last thing anyone
          // measured, and hiding it would look like the reading was never taken.
          <div className="mt-7" key={s.id} style={{ opacity: s.counted ? 1 : 0.62 }}>
            <div className="row gap-4">
              <b className="t-ui">{s.name}</b>
              {s.imbalancePct != null && (
                <Chip tone={s.imbalanceFlag === 'act' ? 'crit' : s.imbalanceFlag === 'watch' ? 'warn' : 'ok'}
                      lamp>
                  {s.imbalancePct}% out of balance
                </Chip>
              )}
              {s.breakerPct != null && s.breakerPct > 80 && (
                <Chip tone={s.breakerPct > 100 ? 'crit' : 'warn'} lamp>
                  {Math.round(s.breakerPct)}% of breaker
                </Chip>
              )}
              <span className="spacer fill" />
              <span className="sub">{s.kw != null ? `${s.kw} kW` : '—'}</span>
            </div>
            <PhaseBars amps={s.phaseAmps} breaker={s.breakerAmps} />
            <p className="sub m-0 t-sm">
              {s.stale && s.ageMinutes != null
                ? `last read ${duration(s.ageMinutes)} ago — too old to call current`
                : s.why}
            </p>
          </div>
        ))}

        {d.worstImbalance && (
          <div className="note warn mt-6">
            <b>{d.worstImbalance.name} is {d.worstImbalance.pct}% out of balance.</b> The heaviest
            phase trips first, the neutral carries the difference, and a three-phase motor on that
            board runs hot on one winding. Moving single-phase circuits between phases costs an
            afternoon and is the cheapest reliability work in the building.
          </div>
        )}
      </Card>

      <Card title="Which set to start"
            right={d.recommended
              ? <Chip tone="ok" lamp>{d.gensets.find((g) => g.assetId === d.recommended)?.tag}</Chip>
              : <Chip tone="warn" lamp>No clear answer</Chip>}>
        <div className="note mb-6">{d.advice}</div>

        {usable.length === 0 && d.gensets.length === 0
          ? <Empty title="No generators with a rating on file"
                   hint="A set with no kVA rating cannot be compared to the load, so nothing here can say which one to start or whether it would run cold. The rating is on the nameplate."
                   action={can('asset.manage')
                     ? <Link className="btn pri" to="/assets">Rate the sets</Link> : undefined}
                   ask="Ask a supervisor to add each set's kVA rating under Assets." />
          : (
            <ul className="setlist">
              {d.gensets.map((g) => (
                <li key={g.assetId} className={g.assetId === d.recommended ? 'pick' : ''}>
                  <span className="sname">
                    <b>{g.tag}</b>
                    <span className="sub fw-4">{g.kvaRating} kVA</span>
                  </span>
                  <span className="smeta">
                    {g.assetId === d.recommended && <Chip tone="ok">start this one</Chip>}
                    {g.loadPct != null && g.verdict !== 'unavailable' && (
                      <span className="loadbar" title={`${g.loadPct}% of rating`}>
                        <i className={g.verdict === 'over' ? 'crit' : g.verdict === 'tight' ? 'warn'
                                     : g.verdict === 'light' ? 'light' : ''}
                           style={{ width: `${Math.max(2, Math.min(100, g.loadPct))}%` }} />
                      </span>
                    )}
                    <Chip tone={VERDICT_TONE[g.verdict]} lamp>
                      {g.verdict === 'unavailable' ? titleCase(g.status)
                        : g.loadPct != null ? `${g.loadPct}%` : '—'}
                    </Chip>
                  </span>
                  <span className="swhy">{g.note}</span>
                </li>
              ))}
            </ul>
          )}

        <div className="note mt-6">
          A set is happiest between <b>30% and 80%</b> of its rating. Below that it runs cold —
          unburnt fuel glazes the bores and wet-stacks the exhaust, and the de-coke costs more
          than every litre it ever saved. Above 80% there is nothing left for a lift or a chiller
          starting.
        </div>
      </Card>
    </div>
  );
}

/** Three bars against the heaviest phase. Imbalance is obvious as a picture and invisible as a column. */
function PhaseBars({ amps, breaker }: { amps: number[]; breaker: number | null }) {
  const top = Math.max(breaker ?? 0, ...amps, 1);
  const labels = ['L1', 'L2', 'L3'];
  const avg = amps.reduce((s, a) => s + a, 0) / (amps.length || 1);
  return (
    <div className="phases">
      {amps.map((a, i) => {
        const off = avg > 0 ? Math.abs(a - avg) / avg : 0;
        return (
          <div className="phase" key={i}>
            <span>{labels[i] ?? `L${i + 1}`}</span>
            <span className="bar">
              <i className={off >= 0.2 ? 'crit' : off >= 0.1 ? 'warn' : ''}
                 style={{ width: `${(a / top) * 100}%` }} />
            </span>
            <span className="amp">{a.toFixed(1)} A</span>
          </div>
        );
      })}
    </div>
  );
}

/** Entering a reading is three numbers and a tap. Anything longer and it goes back on paper. */
function ClampDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [sourceId, setSourceId] = useState('');
  const [f, setF] = useState({ l1: '', l2: '', l3: '', neutral: '', volts: '', pf: '', note: '' });
  const [result, setResult] = useState<{ kw: number; kva: number; imbalancePct: number | null } | null>(null);

  const list = useQuery<{ sources: Source[] }>({
    queryKey: ['power-sources'], queryFn: () => api.get('/api/power/sources'),
  });
  const sources = list.data?.sources ?? [];
  const chosen = sources.find((s) => s.id === sourceId) ?? sources[0];

  const save = useMutation({
    mutationFn: () => api.post('/api/power/clamp', {
      sourceId: chosen!.id,
      l1Amps: Number(f.l1),
      l2Amps: f.l2 ? Number(f.l2) : undefined,
      l3Amps: f.l3 ? Number(f.l3) : undefined,
      neutralAmps: f.neutral ? Number(f.neutral) : undefined,
      volts: f.volts ? Number(f.volts) : undefined,
      powerFactor: f.pf ? Number(f.pf) : undefined,
      note: f.note || undefined,
    }),
    onSuccess: async (r) => {
      setResult(r as { kw: number; kva: number; imbalancePct: number | null });
      await qc.invalidateQueries({ queryKey: ['power-load'] });
      await qc.invalidateQueries({ queryKey: ['clamp-readings'] });
      await qc.invalidateQueries({ queryKey: qk.plant });
    },
  });

  const threePhase = (chosen?.phases ?? 3) === 3;
  const ready = !!chosen && f.l1 !== '' && (!threePhase || (f.l2 !== '' && f.l3 !== ''));
  const err = save.error as ApiError | null;

  // An empty dropdown over a dead button is the worst version of this: the person is
  // holding a clamp meter at a panel and the software will not say what is wrong.
  if (!list.isLoading && sources.length === 0) {
    return (
      <Modal title="Log a clamp reading" onClose={onClose}>
        <Empty title="Nothing to clamp yet"
               hint="A reading is recorded against a described supply — the utility incomer, or a set's output breaker — because the volts, the CT ratio and whether it feeds the whole building are what turn amps into kW."
               action={<Link className="btn pri" to="/admin?tab=supplies">Set one up</Link>}
               ask="Ask an administrator to add the incomer under Admin → Supplies." />
      </Modal>
    );
  }

  return (
    <Modal title="Log a clamp reading" onClose={onClose}>
      {result ? (
        <>
          <div className="bigload mb-5">
            {Math.round(result.kw).toLocaleString()}<u>kW</u>
            <span className="t-lede c-3 ml-5">
              {Math.round(result.kva).toLocaleString()} kVA
            </span>
          </div>
          {result.imbalancePct != null && (
            <Chip tone={result.imbalancePct >= 20 ? 'crit' : result.imbalancePct >= 10 ? 'warn' : 'ok'} lamp>
              {result.imbalancePct}% out of balance
            </Chip>
          )}
          <div className="note mt-6">
            Recorded. The load figure and the set recommendation are updated.
          </div>
          <Btn full className="mt-5" tone="pri" onClick={onClose}>Done</Btn>
        </>
      ) : (
        <>
          <Field label="Which supply"
                 hint="A feeder is recorded for diagnosis and never added to the building total.">
            <select className="inp" value={chosen?.id ?? ''} onChange={(e) => setSourceId(e.target.value)}>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}{s.is_incomer ? '' : ' (feeder)'}
                </option>
              ))}
            </select>
          </Field>

          <div className="grid g3 gap-5">
            <Field label="L1 amps">
              <input className="inp" inputMode="decimal" autoFocus value={f.l1}
                     onChange={(e) => setF({ ...f, l1: e.target.value })} />
            </Field>
            <Field label="L2 amps">
              <input className="inp" inputMode="decimal" value={f.l2} disabled={!threePhase}
                     onChange={(e) => setF({ ...f, l2: e.target.value })} />
            </Field>
            <Field label="L3 amps">
              <input className="inp" inputMode="decimal" value={f.l3} disabled={!threePhase}
                     onChange={(e) => setF({ ...f, l3: e.target.value })} />
            </Field>
          </div>

          <div className="grid g3 gap-5">
            <Field label="Neutral" hint="Optional">
              <input className="inp" inputMode="decimal" value={f.neutral}
                     onChange={(e) => setF({ ...f, neutral: e.target.value })} />
            </Field>
            <Field label="Volts" hint={`Default ${chosen?.nominal_volts ?? 415}`}>
              <input className="inp" inputMode="decimal" value={f.volts}
                     placeholder={String(chosen?.nominal_volts ?? 415)}
                     onChange={(e) => setF({ ...f, volts: e.target.value })} />
            </Field>
            <Field label="Power factor" hint={`Default ${chosen?.default_pf ?? 0.8}`}>
              <input className="inp" inputMode="decimal" value={f.pf}
                     placeholder={String(chosen?.default_pf ?? 0.8)}
                     onChange={(e) => setF({ ...f, pf: e.target.value })} />
            </Field>
          </div>

          <Field label="Note" hint="Optional — what was running, what was off.">
            <input className="inp" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
          </Field>

          {chosen && chosen.ct_ratio !== 1 && (
            <div className="note mb-5">
              This supply is read through a CT with a ratio of {chosen.ct_ratio}. Type what the
              clamp shows — the ratio is applied here.
            </div>
          )}
          {err && <div className="note crit mb-5" role="alert">{err.message}</div>}
          <Btn full tone="pri" disabled={!ready || save.isPending}
               onClick={() => save.mutate()}>
            {save.isPending ? 'Working it out…' : 'Record reading'}
          </Btn>
        </>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------ generator logbook -- */
interface SetToday {
  assetId: string; tag: string; name: string; entries: number;
  lastAt: string | null; worst: 'ok' | 'watch' | 'act';
}
interface Finding { field: string; severity: 'watch' | 'act'; says: string }
interface LogEntry {
  id: string; taken_at: string; state: string; hours_meter: number | null;
  day_tank_l: number | null; day_tank_pct: number | null;
  coolant_temp_c: number | null; oil_pressure_bar: number | null; battery_volts: number | null;
  volts_l1: number | null; volts_l2: number | null; volts_l3: number | null;
  frequency_hz: number | null; load_kw: number | null;
  remarks: string | null; out_of_range: string | null;
  asset_tag: string; logged_by_name: string;
}

/**
 * The book by the plant-room door.
 *
 * Every plant room already keeps one, and it is the earliest warning the department gets:
 * a set rarely fails without first running ten degrees hotter, or dropping oil pressure,
 * for a week beforehand. On paper that pattern is invisible — nobody reads back through
 * a hardback book — so the readings were being taken and thrown away.
 *
 * Today first, because the question at the end of a shift is "did anybody log the sets",
 * and that is the one the paper book could only answer by walking down there.
 */
function GensetLog({ canLog }: { canLog: boolean }) {
  const [logging, setLogging] = useState<SetToday | null>(null);
  const [showBook, setShowBook] = useState(false);

  const today = useQuery<{ workDate: string; sets: SetToday[] }>({
    queryKey: ['genset-today'], queryFn: () => api.get('/api/power/gensets/today'),
    refetchInterval: 120_000,
  });
  const book = useQuery<{ entries: LogEntry[] }>({
    queryKey: ['genset-log'], queryFn: () => api.get('/api/power/gensets/log?limit=60'),
    enabled: showBook,
  });

  const sets = today.data?.sets ?? [];
  const logged = sets.filter((s) => s.entries > 0).length;

  return (
    <>
      <Card title="Generator log"
            right={<>
              <Chip tone={sets.length === 0 ? '' : logged === sets.length ? 'ok' : 'warn'} lamp={sets.length > 0}>
                {logged} of {sets.length} logged today
              </Chip>
              <Btn size="sm" onClick={() => setShowBook((v) => !v)}>
                {showBook ? 'Hide the book' : 'Read the book'}
              </Btn>
            </>}
            className="gcard">
        {today.isLoading ? <Loading rows={2} />
          : sets.length === 0 ? (
            <Empty title="No rated generators yet"
                   hint="A set needs its kVA rating on file before its readings can be judged — 96 °C means nothing until the system knows what normal is for this machine."
                   action={<Link className="btn pri" to="/assets">Rate the sets</Link>} />
          ) : (
            <div className="setlog">
              {sets.map((s) => (
                <div key={s.assetId} className={`slrow ${s.worst}`}>
                  <span className="sltag">
                    {s.tag}
                    <span className="sub">{s.name}</span>
                  </span>
                  <span className="slstate">
                    {s.entries === 0
                      ? <Chip tone="warn">Not logged today</Chip>
                      : <Chip tone={s.worst === 'act' ? 'crit' : s.worst === 'watch' ? 'warn' : 'ok'} lamp>
                          {s.worst === 'act' ? 'Out of range' : s.worst === 'watch' ? 'Worth watching' : 'Normal'}
                        </Chip>}
                  </span>
                  <span className="sllast">
                    {s.entries > 0
                      ? `${s.entries} ${s.entries === 1 ? 'entry' : 'entries'} · last ${when(s.lastAt)}`
                      : 'nothing recorded'}
                  </span>
                  {canLog && (
                    <Btn size="sm" tone={s.entries === 0 ? 'pri' : undefined}
                         onClick={() => setLogging(s)}>Log readings</Btn>
                  )}
                </div>
              ))}
            </div>
          )}

        <div className="note mt-6">
          Take the readings while the set is running and in front of you. A gauge you cannot
          safely reach is left blank — <b>the system would rather have four honest numbers than
          six invented ones.</b>
        </div>
      </Card>

      {showBook && (
        <Card title="The book" flush right={<Chip>Newest first</Chip>} className="gcard">
          {book.isLoading ? <Loading rows={5} />
            : (book.data?.entries.length ?? 0) === 0
              ? <Empty title="Nothing logged yet" />
              : (
                <div className="tw">
                  <table className="wide">
                    <thead>
                      <tr><th>When</th><th>Set</th><th className="num">Hours</th>
                          <th className="num">°C</th><th className="num">Oil bar</th>
                          <th className="num">Batt V</th><th className="num">Hz</th>
                          <th>Remarks</th><th>By</th></tr>
                    </thead>
                    <tbody>
                      {book.data!.entries.map((e) => {
                        const f: Finding[] = e.out_of_range ? JSON.parse(e.out_of_range) : [];
                        const bad = (name: string) => f.some((x) => x.field === name) ? 'num warnv' : 'num';
                        return (
                          <tr key={e.id}>
                            <td className="mono">{when(e.taken_at)}
                              {e.state === 'stopped' && <span className="sub">stopped</span>}</td>
                            <td><span className="ttl">{e.asset_tag}</span></td>
                            <td className={bad('hoursMeter')}>{e.hours_meter ?? '—'}</td>
                            <td className={bad('coolantTempC')}>{e.coolant_temp_c ?? '—'}</td>
                            <td className={bad('oilPressureBar')}>{e.oil_pressure_bar ?? '—'}</td>
                            <td className={bad('batteryVolts')}>{e.battery_volts ?? '—'}</td>
                            <td className={bad('frequencyHz')}>{e.frequency_hz ?? '—'}</td>
                            <td className="wrap" style={{ maxWidth: 260 }}>
                              {e.remarks}
                              {f.length > 0 && (
                                <span className="sub c-crit wrap">
                                  {f.map((x) => x.says).join(' ')}
                                </span>
                              )}
                            </td>
                            <td className="sub">{e.logged_by_name}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
        </Card>
      )}

      {logging && <LogDialog set={logging} onClose={() => setLogging(null)} />}
    </>
  );
}

/**
 * The entry form.
 *
 * Laid out in the order somebody walks the machine — the meter and the tank as you come
 * in, the panel gauges, then the output side — rather than in the order the columns
 * happen to sit in the table. Every field is optional but the form will not save empty,
 * and what it says back is the point: a temperature is only worth taking if something
 * tells you it is wrong while you are still standing there.
 */
function LogDialog({ set, onClose }: { set: SetToday; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState<Record<string, string>>({});
  const [state, setState] = useState<'running' | 'stopped'>('running');
  const [result, setResult] = useState<Finding[] | null>(null);

  const num = (k: string): number | undefined => {
    const v = f[k];
    if (v === undefined || v.trim() === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const set_ = (k: string) => (e: { target: { value: string } }) =>
    setF((p) => ({ ...p, [k]: e.target.value }));

  const save = useMutation({
    mutationFn: () => api.post<{ findings: Finding[] }>(`/api/power/gensets/${set.assetId}/log`, {
      state,
      hoursMeter: num('hours'), dayTankL: num('tankL'), dayTankPct: num('tankPct'),
      coolantTempC: num('temp'), oilPressureBar: num('oil'), batteryVolts: num('batt'),
      voltsL1: num('v1'), voltsL2: num('v2'), voltsL3: num('v3'),
      ampsL1: num('a1'), ampsL2: num('a2'), ampsL3: num('a3'),
      frequencyHz: num('hz'), loadKw: num('kw'),
      remarks: f.remarks?.trim() || undefined,
    }),
    onSuccess: async (r) => {
      setResult(r.findings);
      await qc.invalidateQueries({ queryKey: ['genset-today'] });
      await qc.invalidateQueries({ queryKey: ['genset-log'] });
      await qc.invalidateQueries({ queryKey: qk.plant });
    },
  });
  const err = save.error as ApiError | null;

  if (result) {
    const act = result.filter((x) => x.severity === 'act');
    const watch = result.filter((x) => x.severity === 'watch');
    return (
      <Modal title={`${set.tag} logged`} onClose={onClose}>
        {result.length === 0 ? (
          <div className="note mb-5">
            <b>Everything in range.</b> Nothing here needs anybody tonight.
          </div>
        ) : (
          <>
            {act.map((x, i) => (
              <div key={i} className="note crit mb-5" role="alert">
                <b>Act on this</b>
                <div className="mt-2">{x.says}</div>
              </div>
            ))}
            {watch.map((x, i) => (
              <div key={i} className="note warn mb-5">{x.says}</div>
            ))}
            {act.length > 0 && (
              <p className="sub wrap">
                The supervisor has been notified. The reading is in the book either way.
              </p>
            )}
          </>
        )}
        <Btn full className="mt-4" tone="pri" onClick={onClose}>Done</Btn>
      </Modal>
    );
  }

  return (
    <Modal title={`Log readings — ${set.tag}`} onClose={onClose}>
      <div className="vtoggle mb-6 w-full" role="group" aria-label="Was the set running">
        <button className={`grow ${state === 'running' ? 'on' : ''}`} onClick={() => setState('running')}
                aria-pressed={state === 'running'}>Running</button>
        <button className={`grow ${state === 'stopped' ? 'on' : ''}`} onClick={() => setState('stopped')}
                aria-pressed={state === 'stopped'}>Stopped</button>
      </div>
      {state === 'stopped' && (
        <div className="note mb-5">
          Worth doing daily even when the set has not run. A flat battery, a leak or an empty
          day tank is found on this round — before the outage, not during it.
        </div>
      )}

      <Field label="Hour meter" hint="Off the engine meter, not the clock.">
        <input className="inp" inputMode="decimal" autoFocus value={f.hours ?? ''} onChange={set_('hours')} />
      </Field>

      <div className="grid g2 gap-5">
        <Field label="Day tank litres"><input className="inp" inputMode="decimal"
               value={f.tankL ?? ''} onChange={set_('tankL')} /></Field>
        <Field label="or % full" hint="Whichever the gauge shows.">
          <input className="inp" inputMode="decimal" value={f.tankPct ?? ''} onChange={set_('tankPct')} /></Field>
      </div>

      {state === 'running' && (
        <>
          <div className="grid g3 gap-5">
            <Field label="Coolant °C"><input className="inp" inputMode="decimal"
                   value={f.temp ?? ''} onChange={set_('temp')} /></Field>
            <Field label="Oil bar"><input className="inp" inputMode="decimal"
                   value={f.oil ?? ''} onChange={set_('oil')} /></Field>
            <Field label="Battery V"><input className="inp" inputMode="decimal"
                   value={f.batt ?? ''} onChange={set_('batt')} /></Field>
          </div>

          <div className="grid g3 gap-5">
            <Field label="Volts L1"><input className="inp" inputMode="decimal"
                   value={f.v1 ?? ''} onChange={set_('v1')} /></Field>
            <Field label="L2"><input className="inp" inputMode="decimal"
                   value={f.v2 ?? ''} onChange={set_('v2')} /></Field>
            <Field label="L3"><input className="inp" inputMode="decimal"
                   value={f.v3 ?? ''} onChange={set_('v3')} /></Field>
          </div>

          <div className="grid g3 gap-5">
            <Field label="Amps L1"><input className="inp" inputMode="decimal"
                   value={f.a1 ?? ''} onChange={set_('a1')} /></Field>
            <Field label="L2"><input className="inp" inputMode="decimal"
                   value={f.a2 ?? ''} onChange={set_('a2')} /></Field>
            <Field label="L3"><input className="inp" inputMode="decimal"
                   value={f.a3 ?? ''} onChange={set_('a3')} /></Field>
          </div>

          <div className="grid g2 gap-5">
            <Field label="Frequency Hz"><input className="inp" inputMode="decimal"
                   value={f.hz ?? ''} onChange={set_('hz')} /></Field>
            <Field label="Load kW"><input className="inp" inputMode="decimal"
                   value={f.kw ?? ''} onChange={set_('kw')} /></Field>
          </div>
        </>
      )}

      <Field label="Remarks"
             hint="The knocking, the smoke, the smell of coolant. No gauge shows this and it is the most useful line in the book.">
        <textarea className="inp" rows={2} value={f.remarks ?? ''} onChange={set_('remarks')} />
      </Field>

      {err && <div className="note crit mb-5" role="alert">{err.message}</div>}
      <Btn full tone="pri" disabled={save.isPending}
           onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save to the book'}</Btn>
    </Modal>
  );
}


/* ---------------------------------------------------------------- changeover -- */
type SwitchEvent = 'mains_off' | 'mains_on' | 'genset_start' | 'genset_stop' | 'genset_fault';
interface PowerNow {
  mains: 'on' | 'off'; mainsOffSince: string | null;
  gensets: { assetId: string; tag: string; name: string; status: string; runningSince: string | null }[];
  history: { id: string; at: string; event: SwitchEvent; ran_minutes: number | null; note: string | null;
             asset_tag: string | null; logged_by_name: string | null }[];
}

const SWITCH_WORDS: Record<SwitchEvent, string> = {
  mains_off: 'Mains failed', mains_on: 'Mains restored', genset_start: 'started',
  genset_stop: 'stopped', genset_fault: 'reported faulty',
};

function sinceWords(iso: string): string {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return `${new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${duration(m)}`;
}

/**
 * Mains and generators as they change. Recording it here is what tells the people routed
 * to each event — mains off reaches the whole team, urgently — so every button goes
 * through a short confirm: a mis-tap would otherwise ring every technician on site.
 */
function Changeover({ canLog }: { canLog: boolean }) {
  const now = useQuery<PowerNow>({
    queryKey: [...qk.plant, 'now'], queryFn: () => api.get('/api/power/now'), refetchInterval: 60_000,
  });
  const [asking, setAsking] = useState<{ event: SwitchEvent; set?: PowerNow['gensets'][number] } | null>(null);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);

  if (now.isLoading) return <Card title="Mains and generators now"><Loading rows={3} /></Card>;
  if (now.isError) return <Card title="Mains and generators now"><ErrorNote error={now.error} /></Card>;
  const d = now.data!;
  const off = d.mains === 'off';
  const running = d.gensets.filter((g) => g.runningSince);

  return (
    <div className="mb-6">
      {msg && <div className={`note ${msg.bad ? 'crit' : 'ok'} mb-5`} role="status">{msg.text}</div>}
      {off && running.length === 0 && (
        <div className="note crit mb-5" role="alert">
          <b>Mains is off and no generator is recorded running.</b> If a set is carrying the load,
          record it starting so the strip and the diesel book are right.
        </div>
      )}
      <Card title="Mains and generators now" flush
            right={<Chip tone={off ? 'crit' : 'ok'} lamp>Mains {off ? 'off' : 'on'}</Chip>}>
        <div className="switchrow">
          <div className="who"><b>Mains</b><span className="sub">utility supply</span></div>
          <div className="state">
            {off ? <Chip tone="crit" lamp>Off since {sinceWords(d.mainsOffSince!)}</Chip>
                 : <Chip tone="ok" lamp>On</Chip>}
          </div>
          {canLog && (
            <div className="acts">
              {off
                ? <Btn size="sm" tone="pri" onClick={() => setAsking({ event: 'mains_on' })}>Mains restored</Btn>
                : <Btn size="sm" tone="danger" onClick={() => setAsking({ event: 'mains_off' })}>Mains failed</Btn>}
            </div>
          )}
        </div>
        {d.gensets.map((g) => {
          const usable = g.status === 'in_service' || g.status === 'standby';
          return (
            <div className="switchrow" key={g.assetId}>
              <div className="who"><b>{g.tag}</b><span className="sub">{g.name}</span></div>
              <div className="state">
                {g.runningSince ? <Chip tone="ok" lamp>Running since {sinceWords(g.runningSince)}</Chip>
                  : g.status === 'faulty' || g.status === 'under_repair'
                    ? <Chip tone="crit" lamp>{titleCase(g.status)}</Chip>
                    : <Chip>{g.status === 'in_service' ? 'Ready' : titleCase(g.status)}</Chip>}
              </div>
              {canLog && (g.runningSince || usable || g.status !== 'faulty') && (
                <div className="acts">
                  {g.runningSince
                    ? <Btn size="sm" onClick={() => setAsking({ event: 'genset_stop', set: g })}>Stop</Btn>
                    : usable && <Btn size="sm" tone="pri" onClick={() => setAsking({ event: 'genset_start', set: g })}>Start</Btn>}
                  {g.status !== 'faulty' && (
                    <Btn size="sm" onClick={() => setAsking({ event: 'genset_fault', set: g })}>Report fault</Btn>)}
                </div>
              )}
            </div>
          );
        })}
        {d.history.length > 0 && (
          <div className="p-6">
            <p className="eyebrow mb-4">Latest changeovers</p>
            <div>
              {d.history.slice(0, 6).map((h) => (
                <div key={h.id} className="t-ui mb-2">
                  <span className="mono c-3">{when(h.at)}</span>{' · '}
                  {h.asset_tag ? <><b>{h.asset_tag}</b> {SWITCH_WORDS[h.event]}</> : <b>{SWITCH_WORDS[h.event]}</b>}
                  {h.ran_minutes != null && ` after ${duration(h.ran_minutes)}`}
                  {h.note && <span className="c-2"> — {h.note}</span>}
                  {h.logged_by_name && <span className="c-3"> · {h.logged_by_name}</span>}
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>
      {asking && <SwitchDialog ask={asking} onClose={() => setAsking(null)}
                               onDone={(text) => { setAsking(null); setMsg({ text }); }} />}
    </div>
  );
}

function SwitchDialog({ ask, onClose, onDone }: {
  ask: { event: SwitchEvent; set?: { assetId: string; tag: string } };
  onClose: () => void; onDone: (text: string) => void;
}) {
  const qc = useQueryClient();
  const [ago, setAgo] = useState('0');
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const what = ask.set ? `${ask.set.tag} ${SWITCH_WORDS[ask.event]}` : SWITCH_WORDS[ask.event];
  const fault = ask.event === 'genset_fault';
  const save = useMutation({
    mutationFn: () => api.post('/api/power/changeover', {
      event: ask.event, gensetAssetId: ask.set?.assetId, note: note.trim() || undefined,
      at: ago === '0' ? undefined : new Date(Date.now() - Number(ago) * 60_000).toISOString(),
    }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.plant });
      onDone(`${what} — recorded, and the people routed to it have been told.`);
    },
    onError: (e) => setErr((e as ApiError).message),
  });
  return (
    <Modal title={`Record: ${what}`} onClose={onClose}
           actions={<>
             <Btn onClick={onClose}>Cancel</Btn>
             <Btn tone={ask.event === 'mains_off' || fault ? 'danger' : 'pri'}
                  disabled={save.isPending || (fault && note.trim().length < 3)}
                  onClick={() => { setErr(null); save.mutate(); }}>
               {save.isPending ? 'Recording…' : 'Record it'}
             </Btn>
           </>}>
      {err && <div className="note crit" role="alert">{err}</div>}
      <Field label="When">
        <select className="inp" value={ago} onChange={(e) => setAgo(e.target.value)}>
          <option value="0">Just now</option>
          {[5, 10, 15, 30, 60].map((m) => <option key={m} value={m}>{m} minutes ago</option>)}
        </select>
      </Field>
      <Field label={fault ? 'What happened' : 'Note (optional)'}
             hint={fault ? 'It goes to everyone told about the fault, and the set is taken out of service.' : undefined}>
        <input className="inp" value={note} maxLength={300} autoFocus={fault}
               placeholder={fault ? 'e.g. tripped on low oil pressure' : ''} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <div className="note">
        {ask.event === 'mains_off'
          ? 'Everybody routed to “Mains failed” is told now, with the urgent tone.'
          : 'The people routed to this under Admin → Settings → Who is alerted are told now.'}
      </div>
    </Modal>
  );
}

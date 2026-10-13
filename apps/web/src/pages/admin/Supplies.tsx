/** Admin → Power supplies, and the fuel tanks behind them. */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { titleCase } from '../../lib/format';
import { Card, Chip, Loading, Empty, ErrorNote, Btn, Modal, Field, Flash, RetireBtn } from '../../components/Bits';

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
export function Supplies() {
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
          : q.isError ? <div className="p-6"><ErrorNote error={q.error} /></div>
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
                        <td className="num nw">
                          <button className="btn sm" onClick={() => setEditing(s)}>Edit</button>
                          <span className="ml-3">
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
        <div className="note m-6">
          <b>Only an incomer counts toward the building total.</b> A feeder — a block riser, the
          laundry board, a chiller supply — sits below an incomer that is already counted, so
          adding it would count the same amps twice. Mark those as feeders and they stay useful
          for finding an imbalance without corrupting the load figure.
        </div>
      </Card>

      <div className="mt-6"><Tanks /></div>

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
      <div className="grid g2 gap-5">
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
      <div className="grid g3 gap-5">
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
          <label className="row gap-4">
            <input type="checkbox" checked={f.isIncomer}
                   onChange={(e) => setF({ ...f, isIncomer: e.target.checked })} />
            <span className="t-ui">Yes, this is an incomer</span>
          </label>
        </Field>
      )}
      {f.kind === 'feeder' && (
        <div className="note mb-5">
          A feeder never counts toward the building total — it is already inside whatever
          incomer supplies it.
        </div>
      )}
      {err && <div className="note crit mb-5" role="alert">{err.message}</div>}
      <Btn full tone="pri"
           disabled={f.name.trim().length < 2 || !f.nominalVolts || !f.ctRatio || save.isPending}
           onClick={() => save.mutate()}>
        {save.isPending ? 'Saving…' : supply ? 'Save changes' : 'Add supply'}
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
          : q.isError ? <div className="p-6"><ErrorNote error={q.error} /></div>
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
        <div className="note m-6">
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
      <div className="grid g3 gap-5">
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
        <div className="note warn mb-5">{parsedChart.error}</div>
      )}
      {parsedChart.points && (
        <div className="note mb-5">
          {parsedChart.points.length} points read, from {parsedChart.points[0]![0]} mm
          to {parsedChart.points[parsedChart.points.length - 1]![0]} mm.
        </div>
      )}
      {err && <div className="note crit mb-5" role="alert">{err.message}</div>}
      <Btn full tone="pri" disabled={!ready || save.isPending}
           onClick={() => save.mutate()}>
        {save.isPending ? 'Saving…' : 'Add tank'}
      </Btn>
    </Modal>
  );
}

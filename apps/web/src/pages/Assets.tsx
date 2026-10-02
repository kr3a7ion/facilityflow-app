import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qk, ApiError } from '../lib/api';
import { useSession } from '../lib/session';
import { hours, naira, titleCase, when } from '../lib/format';
import { Card, Chip, Loading, Empty, ErrorNote, Btn, Tile, Modal, Field } from '../components/Bits';
import { Photos } from '../components/Photos';
import { LabelButton } from './AssetLabels';

interface Asset {
  id: string; asset_tag: string; name: string; status: string; criticality: number;
  category_name: string | null; location_name: string | null; unit_no?: string | null;
  manufacturer: string | null; model: string | null; serial_no: string | null; capacity: string | null;
  meter_type: string; current_meter: number | null; current_meter_at: string | null;
  warranty_expiry: string | null; replacement_cost_kobo?: number | null;
}
interface Detail {
  asset: Asset & {
    kva_rating: number | null; expected_lph_at_75pct: number | null;
    service_interval_hours: number | null; next_service_hours: number | null;
  };
  jobs: { id: string; ref: string; title: string; status: string; priority: string;
          reported_at: string; cost_kobo?: number }[];
  readings: { read_at: string; reading: number; unit: string; source: string }[];
  schedules: { id: string; name: string; trigger_type: string; next_due_at: string | null;
               next_due_meter: number | null }[];
  /** Both absent for anyone without cost.read; the server never sends them. */
  lifetimeCostKobo?: number;
  pctOfReplacement: number | null;
  showsCost?: boolean;
}

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'crit' | ''> = {
  in_service: 'ok', standby: '', faulty: 'crit', under_repair: 'warn', decommissioned: '',
};

export function Assets() {
  const { can } = useSession();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const [params, setParams] = useSearchParams();
  const scanned = params.get('tag');

  const list = useQuery<{ assets: Asset[] }>({
    queryKey: qk.assets, queryFn: () => api.get('/api/assets'),
  });

  // A QR sticker lands here with ?tag=GEN-01. Opening that asset is the entire reason the
  // sticker exists, so it happens without the person searching for what they just scanned.
  useEffect(() => {
    if (!scanned || !list.data) return;
    const hit = list.data.assets.find(
      (a) => a.asset_tag.toLowerCase() === scanned.toLowerCase());
    if (hit) { setOpen(hit.id); setMsg(null); }
    else setMsg(`No asset carries the tag "${scanned}". The label may be for a different property.`);
    // The tag has done its job; leaving it in the URL reopens the drawer on every back-press.
    params.delete('tag');
    setParams(params, { replace: true });
  }, [scanned, list.data]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (list.data?.assets ?? []).filter((a) =>
      (!status || a.status === status) &&
      (!needle || `${a.asset_tag} ${a.name} ${a.serial_no ?? ''} ${a.location_name ?? ''}`
        .toLowerCase().includes(needle)));
  }, [list.data, q, status]);

  const counts = (list.data?.assets ?? []).reduce<Record<string, number>>((acc, a) => {
    acc[a.status] = (acc[a.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <main className="view">
      <div className="vhead">
        <div>
          <p className="eyebrow">Register · {list.data?.assets.length ?? 0} maintainable things</p>
          <h1>Assets</h1>
          <p>Jobs attach to a thing, not just a room. Without this you can never answer what a
             chiller has cost you this year, or whether to repair it again.</p>
        </div>
        <div className="acts">
          <LabelButton />
          {can('asset.manage') && (
            <Btn tone="pri" icon="plus" onClick={() => setCreating(true)}>Add asset</Btn>)}
        </div>
      </div>

      {msg && <div className="note" style={{ marginBottom: 14 }} role="status">{msg}</div>}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14, alignItems: 'center' }}>
        <input className="inp" style={{ width: 260, minHeight: 34 }} value={q}
               placeholder="Tag, name or serial…" onChange={(e) => setQ(e.target.value)} />
        <button className={`btn sm ${status === '' ? 'on' : ''}`} onClick={() => setStatus('')}>
          All · {list.data?.assets.length ?? 0}
        </button>
        {Object.entries(counts).map(([s, n]) => (
          <button key={s} className={`btn sm ${status === s ? 'on' : ''}`}
                  onClick={() => setStatus(status === s ? '' : s)}>{titleCase(s)} · {n}</button>
        ))}
      </div>

      <Card flush>
        {list.isLoading ? <Loading rows={5} />
          : list.isError ? <div style={{ padding: 15 }}><ErrorNote error={list.error} /></div>
          : rows.length === 0
            ? <Empty title="No assets match"
                     hint={list.data?.assets.length ? 'Try another filter.' : 'Add the plant first — gensets, pumps, lifts — then the units.'} />
            : (
              <div className="tw">
                <table className="wide">
                  <thead><tr><th>Tag</th><th>Asset</th><th>Where</th><th>Meter</th><th>State</th></tr></thead>
                  <tbody>
                    {rows.map((a) => (
                      <tr key={a.id} className="click" onClick={() => setOpen(a.id)}>
                        <td className="mono">{a.asset_tag}</td>
                        <td><span className="ttl">{a.name}</span>
                            <span className="sub">
                              {a.category_name ?? 'uncategorised'}
                              {a.capacity ? ` · ${a.capacity}` : ''}
                              {a.criticality === 1 ? ' · critical' : ''}
                            </span></td>
                        <td>{a.unit_no ?? a.location_name ?? '—'}</td>
                        <td className="num">
                          {a.meter_type === 'none' ? '—' : hours(a.current_meter)}
                        </td>
                        <td><Chip tone={STATUS_TONE[a.status] ?? ''} lamp>{titleCase(a.status)}</Chip></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
      </Card>

      <div className="note" style={{ marginTop: 14 }}>
        <b>Print the tag as a QR sticker.</b> Scanning it on a phone opens the asset's full job
        history — no searching, no typing a unit number with oily hands. It is the cheapest
        high-value feature in the product.
      </div>

      {open && <AssetDetail id={open} onClose={() => setOpen(null)}
                            onChange={(t) => setMsg(t)} />}
      {creating && <NewAsset onClose={() => setCreating(false)}
                             onDone={(tag) => { setCreating(false); setMsg(`${tag} added to the register.`); }} />}
    </main>
  );
}

function AssetDetail({ id, onClose, onChange }:
  { id: string; onClose: () => void; onChange: (msg: string) => void }) {
  const { can } = useSession();
  const money = can('cost.read');
  const qc = useQueryClient();
  const [reading, setReading] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const detail = useQuery<Detail>({ queryKey: qk.asset(id), queryFn: () => api.get(`/api/assets/${id}`) });

  const addReading = useMutation({
    // The unit follows the asset, otherwise a kWh meter is silently logged as running hours.
    mutationFn: () => api.post(`/api/assets/${id}/reading`, {
      reading: Number(reading),
      unit: detail.data?.asset.meter_type === 'kwh' ? 'kwh' : 'hours',
    }),
    onSuccess: async () => {
      setReading(''); setErr(null);
      onChange('Meter reading recorded.');
      await qc.invalidateQueries({ queryKey: qk.asset(id) });
      await qc.invalidateQueries({ queryKey: qk.assets });
    },
    onError: (e) => setErr((e as ApiError).message),
  });

  if (detail.isLoading) return <Modal title="Loading" onClose={onClose}><Loading rows={5} /></Modal>;
  if (detail.isError) return <Modal title="Asset" onClose={onClose}><ErrorNote error={detail.error} /></Modal>;

  const d = detail.data!;
  const a = d.asset;

  return (
    <Modal title={`${a.asset_tag} · ${a.name}`} onClose={onClose}>
      {/* A technician scans a tag to read the machine's service history. Repair-or-replace
          is a different conversation, held by the people who hold the budget, so the two
          money tiles are simply not here for them — and the third fills the row. */}
      <div className={`grid ${money ? 'g3' : 'g1'}`} style={{ marginBottom: 14 }}>
        {money && (
          <>
            <Tile label="Lifetime cost" value={naira(d.lifetimeCostKobo ?? 0, { compact: true })}
                  sub={`${d.jobs.length} job${d.jobs.length === 1 ? '' : 's'}`} />
            <Tile label="Of replacement" value={d.pctOfReplacement ?? '—'} unit={d.pctOfReplacement != null ? '%' : ''}
                  tone={d.pctOfReplacement != null && d.pctOfReplacement > 50 ? 'warn' : undefined}
                  sub={a.replacement_cost_kobo ? naira(a.replacement_cost_kobo, { compact: true }) + ' to replace' : 'no replacement value set'} />
          </>
        )}
        <Tile label="Meter" value={a.meter_type === 'none' ? '—' : (a.current_meter ?? 0).toLocaleString()}
              unit={a.meter_type === 'none' ? '' : a.meter_type === 'kwh' ? 'kWh' : 'h'}
              sub={a.current_meter_at ? `read ${when(a.current_meter_at)}` : 'never read'} />
      </div>

      {d.pctOfReplacement != null && d.pctOfReplacement > 50 && (
        <div className="note warn" style={{ marginBottom: 14 }}>
          This asset has cost <b>{d.pctOfReplacement}% of what it costs to replace</b>. Past roughly
          half, the repair-or-replace argument writes itself.
        </div>
      )}

      <dl className="kv" style={{ marginBottom: 16 }}>
        <dt>Status</dt><dd><Chip tone={STATUS_TONE[a.status] ?? ''} lamp>{titleCase(a.status)}</Chip></dd>
        <dt>Where</dt><dd>{a.unit_no ?? a.location_name ?? '—'}</dd>
        <dt>Make</dt><dd>{[a.manufacturer, a.model, a.capacity].filter(Boolean).join(' · ') || '—'}</dd>
        <dt>Serial</dt><dd className="mono">{a.serial_no ?? '—'}</dd>
        <dt>Warranty</dt>
        <dd>{a.warranty_expiry
          ? <span style={a.warranty_expiry < new Date().toISOString().slice(0, 10)
              ? { color: 'var(--text-3)' } : { color: 'var(--ok)' }}>{a.warranty_expiry}</span>
          : '—'}</dd>
      </dl>

      {can('asset.manage') && a.meter_type !== 'none' && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 16, flexWrap: 'wrap' }}>
          <div className="fld" style={{ marginBottom: 0, width: 160 }}>
            <label>New meter reading</label>
            <input className="inp" inputMode="decimal" value={reading}
                   onChange={(e) => setReading(e.target.value)} />
          </div>
          <Btn tone="pri" disabled={!reading || addReading.isPending}
               onClick={() => addReading.mutate()}>Record</Btn>
          {err && <span className="sub" style={{ color: 'var(--crit)', whiteSpace: 'normal' }}>{err}</span>}
        </div>
      )}

      {d.schedules.length > 0 && (
        <Card title="Scheduled maintenance" flush>
          <table>
            <tbody>
              {d.schedules.map((s) => (
                <tr key={s.id}>
                  <td><span className="ttl">{s.name}</span>
                      <span className="sub">{titleCase(s.trigger_type)}</span></td>
                  <td className="num">
                    {s.trigger_type === 'meter'
                      ? `at ${s.next_due_meter?.toLocaleString()} h`
                      : s.next_due_at ? when(s.next_due_at) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <div style={{ marginTop: 14 }}>
        <Photos entityType="asset" entityId={a.id} canUpload={can('asset.manage')}
                title="Nameplate and condition photos" />
      </div>

      <div style={{ marginTop: 14 }}>
        <Card title="Job history" flush right={<Chip>{d.jobs.length}</Chip>}>
          {d.jobs.length === 0 ? <Empty title="No jobs yet against this asset" /> : (
            <div className="tw">
              <table className="wide">
                <thead><tr><th>Job</th><th>When</th><th>State</th>
                  {money && <th className="num">Cost</th>}</tr></thead>
                <tbody>
                  {d.jobs.map((j) => (
                    <tr key={j.id}>
                      <td><Link to={`/jobs/${j.id}`} onClick={onClose}
                                style={{ textDecoration: 'none', color: 'inherit' }}>
                        <span className="ttl">{j.title}</span>
                        <span className="sub">{j.ref} · {j.priority}</span></Link></td>
                      <td className="mono">{when(j.reported_at)}</td>
                      <td className="mono">{titleCase(j.status)}</td>
                      {money && <td className="num">{naira(j.cost_kobo ?? 0)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      {/* A generator without a rating is invisible to the load screen: it cannot be
          recommended, and nothing can say whether it would run cold. This is the one
          piece of asset data the Power screen cannot work without. */}
      {can('asset.manage') && (a.meter_type === 'hours' || a.kva_rating != null) && (
        <GensetProfile id={id} asset={a} onSaved={(m) => { onChange(m); void detail.refetch(); }} />
      )}
    </Modal>
  );
}

function GensetProfile({ id, asset, onSaved }: {
  id: string;
  asset: { kva_rating: number | null; expected_lph_at_75pct: number | null;
           service_interval_hours: number | null; name: string };
  onSaved: (msg: string) => void;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(asset.kva_rating == null);
  const [f, setF] = useState({
    kva: asset.kva_rating == null ? '' : String(asset.kva_rating),
    lph50: '', lph75: asset.expected_lph_at_75pct == null ? '' : String(asset.expected_lph_at_75pct),
    lph100: '',
    interval: asset.service_interval_hours == null ? '' : String(asset.service_interval_hours),
  });

  const save = useMutation({
    mutationFn: () => api.post(`/api/gensets/${id}/profile`, {
      kvaRating: Number(f.kva),
      expectedLphAt50: f.lph50 ? Number(f.lph50) : undefined,
      expectedLphAt75: f.lph75 ? Number(f.lph75) : undefined,
      expectedLphAt100: f.lph100 ? Number(f.lph100) : undefined,
      serviceIntervalHours: f.interval ? Number(f.interval) : undefined,
    }),
    onSuccess: async () => {
      onSaved('Generator profile saved. It can now be recommended on the Power screen.');
      setOpen(false);
      await qc.invalidateQueries({ queryKey: ['power-load'] });
      await qc.invalidateQueries({ queryKey: qk.plant });
    },
  });
  const err = save.error as ApiError | null;

  // The nameplate is on the set. Typing it in once is what makes the load screen able to
  // answer "which one do we start" instead of listing three names.
  return (
    <div style={{ marginTop: 14 }}>
    <Card title="Generator profile"
          right={asset.kva_rating != null
            ? <>
                <Chip tone="ok" lamp>{asset.kva_rating} kVA</Chip>
                {!open && <Btn size="sm" onClick={() => setOpen(true)}>Edit</Btn>}
              </>
            : <Chip tone="warn" lamp>no rating yet</Chip>}>
      {!open ? (
        <p className="sub" style={{ margin: 0 }}>
          Rated {asset.kva_rating} kVA
          {asset.expected_lph_at_75pct ? `, about ${asset.expected_lph_at_75pct} L/h at three-quarter load` : ''}
          {asset.service_interval_hours ? `, serviced every ${asset.service_interval_hours} hours` : ''}.
        </p>
      ) : (
        <>
          <div className="grid g2" style={{ gap: 10 }}>
            <Field label="Rating in kVA" hint="Off the nameplate. Required.">
              <input className="inp" inputMode="decimal" value={f.kva}
                     onChange={(e) => setF({ ...f, kva: e.target.value })} />
            </Field>
            <Field label="Service interval in hours" hint="Usually 250 or 500.">
              <input className="inp" inputMode="decimal" value={f.interval}
                     onChange={(e) => setF({ ...f, interval: e.target.value })} />
            </Field>
          </div>
          <p className="eyebrow" style={{ margin: '4px 0 8px' }}>
            Expected diesel burn · litres per hour
          </p>
          <div className="grid g3" style={{ gap: 10 }}>
            <Field label="At half load">
              <input className="inp" inputMode="decimal" value={f.lph50}
                     onChange={(e) => setF({ ...f, lph50: e.target.value })} />
            </Field>
            <Field label="At three-quarters">
              <input className="inp" inputMode="decimal" value={f.lph75}
                     onChange={(e) => setF({ ...f, lph75: e.target.value })} />
            </Field>
            <Field label="At full load">
              <input className="inp" inputMode="decimal" value={f.lph100}
                     onChange={(e) => setF({ ...f, lph100: e.target.value })} />
            </Field>
          </div>
          <div className="note" style={{ marginBottom: 12 }}>
            The burn figures are on the manufacturer's data sheet. With even one of them the
            system can tell a set that is drinking more than it should from one that is simply
            working hard — <b>three runs over the threshold raises a job by itself</b>. Without
            them the set still gets recommended on rating alone.
          </div>
          {err && <div className="note crit" style={{ marginBottom: 12 }} role="alert">{err.message}</div>}
          <Btn tone="pri" style={{ width: '100%' }}
               disabled={!f.kva || Number(f.kva) <= 0 || save.isPending}
               onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : 'Save profile'}
          </Btn>
        </>
      )}
    </Card>
    </div>
  );
}

function NewAsset({ onClose, onDone }: { onClose: () => void; onDone: (tag: string) => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    assetTag: '', name: '', categoryId: '', locationId: '', manufacturer: '', model: '',
    serialNo: '', capacity: '', criticality: 2, meterType: 'none', warrantyExpiry: '',
    replacementNaira: '',
  });
  const cats = useQuery<{ categories: { id: string; name: string }[] }>({
    queryKey: qk.assetCategories, queryFn: () => api.get('/api/asset-categories'),
  });
  // A brand-new property has no categories at all, and the register is the first place
  // anybody notices. Sending them to another screen to make one — and then back — is how
  // a first afternoon gets abandoned, so the category is made here, in the flow.
  const [newCat, setNewCat] = useState('');
  const addCat = useMutation({
    mutationFn: () => api.post<{ id: string }>('/api/asset-categories', { name: newCat.trim() }),
    onSuccess: async (r) => {
      setF((v) => ({ ...v, categoryId: (r as { id: string }).id }));
      setNewCat('');
      await qc.invalidateQueries({ queryKey: qk.assetCategories });
    },
  });
  const locs = useQuery<{ locations: { id: string; type: string; name: string; code: string }[] }>({
    queryKey: qk.locations, queryFn: () => api.get('/api/locations'),
  });

  const create = useMutation({
    mutationFn: () => api.post('/api/assets', {
      assetTag: f.assetTag, name: f.name,
      categoryId: f.categoryId || undefined, locationId: f.locationId || undefined,
      manufacturer: f.manufacturer || undefined, model: f.model || undefined,
      serialNo: f.serialNo || undefined, capacity: f.capacity || undefined,
      criticality: f.criticality, meterType: f.meterType,
      warrantyExpiry: f.warrantyExpiry || undefined,
      replacementCostKobo: f.replacementNaira ? Math.round(Number(f.replacementNaira) * 100) : undefined,
    }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.assets });
      onDone(f.assetTag);
    },
  });
  const err = create.error as ApiError | null;
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });

  return (
    <Modal title="Add an asset" onClose={onClose}>
      <div className="grid g2" style={{ gap: 12 }}>
        <div className="fld"><label>Asset tag</label>
          <input className="inp" autoFocus value={f.assetTag} onChange={set('assetTag')}
                 placeholder="GEN-01" /></div>
        <div className="fld"><label>Name</label>
          <input className="inp" value={f.name} onChange={set('name')} placeholder="Generator 1" /></div>
      </div>
      <div className="grid g2" style={{ gap: 12 }}>
        <div className="fld"><label>Category</label>
          <select className="inp" value={f.categoryId} onChange={set('categoryId')}>
            <option value="">Uncategorised</option>
            {(cats.data?.categories ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <input className="inp" style={{ minHeight: 32, fontSize: '0.7812rem' }} value={newCat}
                   placeholder={(cats.data?.categories.length ?? 0) === 0
                     ? 'No categories yet — name the first one' : 'Or add a new one'}
                   aria-label="New category name"
                   onChange={(e) => setNewCat(e.target.value)}
                   onKeyDown={(e) => { if (e.key === 'Enter' && newCat.trim().length > 1) {
                     e.preventDefault(); addCat.mutate();
                   } }} />
            <Btn size="sm" onClick={() => addCat.mutate()}
                 disabled={newCat.trim().length < 2 || addCat.isPending}>Add</Btn>
          </div>
        </div>
        <div className="fld"><label>Location</label>
          <select className="inp" value={f.locationId} onChange={set('locationId')}>
            <option value="">Not placed</option>
            {(locs.data?.locations ?? []).filter((l) => l.type !== 'apartment')
              .map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select></div>
      </div>
      <div className="grid g3" style={{ gap: 12 }}>
        <div className="fld"><label>Manufacturer</label>
          <input className="inp" value={f.manufacturer} onChange={set('manufacturer')} /></div>
        <div className="fld"><label>Model</label>
          <input className="inp" value={f.model} onChange={set('model')} /></div>
        <div className="fld"><label>Capacity</label>
          <input className="inp" value={f.capacity} onChange={set('capacity')} placeholder="250 kVA" /></div>
      </div>
      <div className="grid g3" style={{ gap: 12 }}>
        <div className="fld"><label>Serial number</label>
          <input className="inp" value={f.serialNo} onChange={set('serialNo')} /></div>
        <div className="fld"><label>Criticality</label>
          <select className="inp" value={f.criticality}
                  onChange={(e) => setF({ ...f, criticality: Number(e.target.value) })}>
            <option value={1}>1 — critical, drives P1</option>
            <option value={2}>2 — important</option>
            <option value={3}>3 — routine</option>
          </select></div>
        <div className="fld"><label>Meter</label>
          <select className="inp" value={f.meterType} onChange={set('meterType')}>
            <option value="none">None</option>
            <option value="hours">Run hours</option>
            <option value="kwh">kWh</option>
            <option value="both">Both</option>
          </select></div>
      </div>
      <div className="grid g2" style={{ gap: 12 }}>
        <div className="fld"><label>Warranty expires</label>
          <input className="inp" type="date" value={f.warrantyExpiry} onChange={set('warrantyExpiry')} /></div>
        <div className="fld"><label>Replacement cost (₦)</label>
          <input className="inp" inputMode="numeric" value={f.replacementNaira}
                 onChange={set('replacementNaira')} /></div>
      </div>
      <p className="sub" style={{ whiteSpace: 'normal', marginBottom: 12 }}>
        Replacement cost is what makes the repair-or-replace report possible. A rough figure beats
        a blank.
      </p>
      {err && <div className="note crit" style={{ marginBottom: 12 }} role="alert">{err.message}</div>}
      <Btn tone="pri" style={{ width: '100%' }}
           disabled={f.assetTag.length < 1 || f.name.length < 2 || create.isPending}
           onClick={() => create.mutate()}>
        {create.isPending ? 'Adding…' : 'Add to the register'}
      </Btn>
    </Modal>
  );
}

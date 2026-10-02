import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qk, ApiError } from '../lib/api';
import { useSession } from '../lib/session';
import { naira, titleCase, when } from '../lib/format';
import { Card, Chip, Tile, Loading, ErrorNote, Empty, Btn, Modal, Field, Tabs, Flash,
         MonthBar, RetireBtn } from '../components/Bits';

interface Item {
  id: string; code: string; name: string; category: string | null; unit: string;
  bin_location: string | null; current_qty: number; min_level: number; reorder_qty: number;
  /** Absent, not zero, for anyone without cost.read — the server does not send it. */
  avg_cost_kobo?: number;
}
/** lowStock is a narrower projection than the catalogue row — say so rather than lying. */
interface LowLine {
  id: string; code: string; name: string; unit: string;
  current_qty: number; min_level: number; reorder_qty: number;
}
interface ReqLine {
  id: string; description: string; qty: number; estimated_kobo?: number; unit: string | null;
}
interface Requisition {
  id: string; ref: string; status: string; purpose: string | null; estimated_kobo?: number;
  created_at: string; decided_at: string | null; decision_note: string | null;
  raised_by: string; raised_by_name: string | null; approver_name: string | null;
  wo_ref: string | null; lines: ReqLine[];
}
interface Movement {
  id: string; at: string; type: string; qty_delta: number; balance_after: number;
  unit_cost_kobo?: number | null; ref: string | null; note: string | null;
  done_by_name: string | null; wo_ref: string | null;
}

type Tab = 'catalogue' | 'requisitions' | 'counts';

interface CountRow {
  id: string; counted_at: string; status: string; note: string | null;
  counted_by_name: string | null; verified_by_name: string | null;
  lines: number; variances: number;
}
interface CountLine {
  id: string; item_id: string; system_qty: number; counted_qty: number; variance: number;
  reason: string | null; code: string; name: string; unit: string;
  avg_cost_kobo?: number; bin_location: string | null;
}

const REQ_TONE: Record<string, 'ok' | 'warn' | 'crit' | 'acc' | ''> = {
  pending: 'warn', approved: 'ok', rejected: 'crit', purchased: 'acc', received: 'ok', draft: '',
};

export function Stores() {
  const { me, can } = useSession();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('catalogue');
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [modal, setModal] = useState<'item' | 'requisition' | null>(null);
  const [receiving, setReceiving] = useState<Item | null>(null);
  const [history, setHistory] = useState<Item | null>(null);
  const [decide, setDecide] = useState<Requisition | null>(null);
  const [counting, setCounting] = useState<string | null>(null);

  const stock = useQuery<{ items: Item[]; lowStock: LowLine[]; showsCost: boolean }>({
    queryKey: qk.stock, queryFn: () => api.get('/api/stock'),
  });
  // Not fetched at all without the permission: an empty tab is better than a 403 in
  // the console, and the tab itself is hidden below.
  const seesReqs = can('requisition.read');
  const reqs = useQuery<{ requisitions: Requisition[]; scope: 'own' | 'all'; showsCost: boolean }>({
    queryKey: qk.requisitions, queryFn: () => api.get('/api/requisitions'), enabled: seesReqs,
  });
  const counts = useQuery<{ counts: CountRow[] }>({
    queryKey: qk.stockCounts, queryFn: () => api.get('/api/stock/counts'),
  });

  /* The server decides this and strips the figures from the response; the screen only
     has to stop drawing columns that would all read "—". */
  const money = can('cost.read');
  const items = stock.data?.items ?? [];
  const low = stock.data?.lowStock ?? [];
  const rows = reqs.data?.requisitions ?? [];
  const pending = rows.filter((r) => r.status === 'pending');
  const stockValue = items.reduce((n, i) => n + i.current_qty * (i.avg_cost_kobo ?? 0), 0);

  const openCount = counts.data?.counts.find((c) => c.status === 'open') ?? null;

  const startCount = useMutation({
    mutationFn: () => api.post<{ id: string; lines: number }>('/api/stock/counts'),
    onSuccess: async (r) => {
      setMsg({ text: `Count sheet opened with ${r.lines} lines. Walk the store, then post it.` });
      await qc.invalidateQueries({ queryKey: qk.stockCounts });
      setCounting(r.id);
    },
    onError: (e) => setMsg({ text: (e as ApiError).message, bad: true }),
  });

  function done(text: string) {
    setModal(null); setReceiving(null); setDecide(null); setCounting(null); setMsg({ text });
  }

  return (
    <main className="view">
      <div className="vhead">
        <div>
          <p className="eyebrow">Spares · {items.length} lines{money ? ` · ${naira(stockValue, { compact: true })} on the shelf` : ''}</p>
          <h1>Stores</h1>
          <p>Issuing a part against a job number is the only honest route to a true job cost.
             The movement ledger is the source of truth; the balance is only its running total.</p>
        </div>
        <div className="acts">
          {can('requisition.create') && (
            <Btn icon="doc" onClick={() => setModal('requisition')}>Raise a requisition</Btn>)}
          {can('stock.receive') && (
            <Btn icon="plus" tone="pri" onClick={() => setModal('item')}>New item</Btn>)}
        </div>
      </div>

      <Flash msg={msg} />

      <div className="grid g4" style={{ marginBottom: 16 }}>
        <Tile label="Lines held" value={items.length} sub="Active catalogue items" />
        {money && (
          <Tile label="Value on the shelf" value={naira(stockValue, { compact: true })}
                sub="Quantity × average cost" />)}
        <Tile label="At or below minimum" value={low.length} tone={low.length ? 'warn' : 'ok'}
              sub={low.length ? 'Reorder before a job stalls' : 'Nothing to reorder'} />
        {seesReqs && (
          <Tile label="Requisitions pending" value={pending.length}
                tone={pending.length ? 'warn' : undefined}
                sub={pending.length
                  ? (money ? naira(pending.reduce((n, r) => n + (r.estimated_kobo ?? 0), 0))
                           : `${pending.length} waiting on a decision`)
                  : 'None waiting'} />)}
      </div>

      {low.length > 0 && (
        <div className="note warn" style={{ marginBottom: 14 }}>
          <b>At or below minimum</b>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {low.map((i) => (
              <li key={i.id}>{i.name} — {i.current_qty} {i.unit} left, minimum {i.min_level}
                {i.reorder_qty > 0 ? `, reorder ${i.reorder_qty}` : ''}</li>
            ))}
          </ul>
        </div>
      )}

      <Tabs<Tab> value={tab} onChange={setTab} items={[
        { key: 'catalogue', label: 'Catalogue', count: items.length },
        ...(seesReqs ? [{ key: 'requisitions' as Tab, label: 'Requisitions', count: rows.length }] : []),
        { key: 'counts', label: 'Stock counts', count: counts.data?.counts.length ?? 0 },
      ]} />

      {tab === 'catalogue' ? (
        <Card flush title="Catalogue">
          {stock.isLoading ? <Loading rows={5} />
            : stock.isError ? <div style={{ padding: 15 }}><ErrorNote error={stock.error} /></div>
            : items.length === 0 ? <Empty title="Nothing in the store yet"
                                         hint="Add the items you actually keep on the shelf, then receive stock against them." />
            : (
              <div className="tw">
                <table className="wide">
                  <thead><tr><th>Item</th><th>Bin</th><th className="num">On hand</th>
                    <th className="num">Minimum</th>
                    {money && <><th className="num">Avg cost</th><th className="num">Value</th></>}
                    <th /></tr></thead>
                  <tbody>
                    {items.map((i) => {
                      const isLow = i.min_level > 0 && i.current_qty <= i.min_level;
                      return (
                        <tr key={i.id}>
                          <td><span className="ttl">{i.name}</span>
                              <span className="sub">{i.code}{i.category ? ` · ${i.category}` : ''}</span></td>
                          <td className="mono">{i.bin_location ?? '—'}</td>
                          <td className="num">
                            {isLow ? <Chip tone="warn" lamp>{i.current_qty} {i.unit}</Chip>
                                   : `${i.current_qty} ${i.unit}`}
                          </td>
                          <td className="num">{i.min_level || '—'}</td>
                          {money && (
                            <>
                              <td className="num">{naira(i.avg_cost_kobo ?? 0)}</td>
                              <td className="num">{naira(i.current_qty * (i.avg_cost_kobo ?? 0))}</td>
                            </>
                          )}
                          <td className="num" style={{ whiteSpace: 'nowrap' }}>
                            <Btn size="sm" onClick={() => setHistory(i)}>History</Btn>
                            {can('stock.receive') && (
                              <>
                                <Btn size="sm" style={{ marginLeft: 6 }}
                                     onClick={() => setReceiving(i)}>Receive</Btn>
                                <span style={{ marginLeft: 6 }}>
                                  <RetireBtn kind="stock-item" id={i.id} label={i.name}
                                             onDone={(m) => { setMsg({ text: m }); void qc.invalidateQueries({ queryKey: qk.stock }); }} />
                                </span>
                              </>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
        </Card>
      ) : tab === 'counts' ? (
        <Card flush title="Stock counts"
              right={can('stock.adjust') && !openCount && (
                <Btn size="sm" icon="plus" disabled={startCount.isPending}
                     onClick={() => startCount.mutate()}>Start a count</Btn>)}>
          {counts.isLoading ? <Loading rows={3} />
            : counts.isError ? <div style={{ padding: 15 }}><ErrorNote error={counts.error} /></div>
            : (counts.data?.counts.length ?? 0) === 0
              ? <Empty title="No counts yet"
                       hint="A count freezes what the system thinks is on the shelf, then you walk the store and record what is really there." />
              : (
                <div className="tw">
                  <table className="wide">
                    <thead><tr><th>When</th><th>Counted by</th><th className="num">Lines</th>
                      <th className="num">Variances</th><th>Status</th><th /></tr></thead>
                    <tbody>
                      {counts.data!.counts.map((c) => (
                        <tr key={c.id}>
                          <td><span className="ttl">{when(c.counted_at)}</span>
                              {c.note && <span className="sub">{c.note}</span>}</td>
                          <td>{c.counted_by_name ?? '—'}
                              {c.verified_by_name && <span className="sub">posted by {c.verified_by_name}</span>}</td>
                          <td className="num">{c.lines}</td>
                          <td className="num">
                            {c.variances > 0
                              ? <Chip tone={c.status === 'open' ? 'warn' : 'crit'}>{c.variances}</Chip>
                              : <Chip tone="ok">none</Chip>}
                          </td>
                          <td><Chip tone={c.status === 'open' ? 'warn' : 'ok'} lamp>
                                {titleCase(c.status)}</Chip></td>
                          <td className="num">
                            <Btn size="sm" onClick={() => setCounting(c.id)}>
                              {c.status === 'open' && can('stock.adjust') ? 'Continue' : 'View'}
                            </Btn>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
          {openCount && (
            <div className="note warn" style={{ margin: 15 }}>
              A count is open. The store keeps moving while it is, so post it as soon as the
              walk is finished — the longer it stays open the less the numbers mean.
            </div>
          )}
        </Card>
      ) : (
        <Card flush title={reqs.data?.scope === 'own' ? 'My requisitions' : 'Requisitions'}>
          {reqs.isLoading ? <Loading rows={4} />
            : reqs.isError ? <div style={{ padding: 15 }}><ErrorNote error={reqs.error} /></div>
            : rows.length === 0
              ? <Empty title="No requisitions raised"
                       hint="A requisition is how a technician asks for something the store does not hold." />
              : (
                <div className="tw">
                  <table className="wide">
                    <thead><tr><th>Ref</th><th>What for</th><th>Lines</th><th>Raised by</th>
                      {money && <th className="num">Estimate</th>}
                      <th>Status</th><th /></tr></thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.id}>
                          <td className="mono">{r.ref}</td>
                          <td><span className="ttl">{r.purpose ?? 'No purpose given'}</span>
                              <span className="sub">{when(r.created_at)}
                                {r.wo_ref ? ` · ${r.wo_ref}` : ''}</span></td>
                          <td>{r.lines.length}
                              <span className="sub">
                                {r.lines.slice(0, 2).map((l) => `${l.qty}× ${l.description}`).join(', ')}
                                {r.lines.length > 2 ? '…' : ''}</span></td>
                          <td>{r.raised_by_name ?? '—'}
                              {r.approver_name && <span className="sub">decided by {r.approver_name}</span>}</td>
                          {money && <td className="num">{naira(r.estimated_kobo ?? 0)}</td>}
                          <td><Chip tone={REQ_TONE[r.status] ?? ''} lamp>{titleCase(r.status)}</Chip></td>
                          <td className="num">
                            {r.status === 'pending' && can('requisition.approve') && (
                              r.raised_by === me?.user.id
                                ? <Chip>yours</Chip>
                                : <Btn size="sm" onClick={() => setDecide(r)}>Decide</Btn>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
        </Card>
      )}

      {counting && <CountSheet countId={counting} onClose={() => setCounting(null)} onDone={done} />}
      {modal === 'item' && <NewItem onClose={() => setModal(null)} onDone={done} />}
      {modal === 'requisition' && <NewRequisition items={items} onClose={() => setModal(null)} onDone={done} />}
      {receiving && <Receive item={receiving} onClose={() => setReceiving(null)} onDone={done} />}
      {history && <History item={history} onClose={() => setHistory(null)} />}
      {decide && <Decide req={decide} onClose={() => setDecide(null)} onDone={done} />}
    </main>
  );
}

function NewItem({ onClose, onDone }: { onClose: () => void; onDone: (msg: string) => void }) {
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const [f, setF] = useState({ code: '', name: '', category: '', unit: 'pcs',
                               binLocation: '', minLevel: '0', reorderQty: '0' });
  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }));

  const save = useMutation({
    mutationFn: () => api.post('/api/stock', {
      code: f.code.trim().toUpperCase(), name: f.name.trim(),
      category: f.category.trim() || undefined, unit: f.unit.trim() || 'pcs',
      binLocation: f.binLocation.trim() || undefined,
      minLevel: Number(f.minLevel) || 0, reorderQty: Number(f.reorderQty) || 0,
    }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.stock });
      onDone(`${f.name.trim()} added. Receive stock against it to give it a balance.`);
    },
    onError: (e) => setErr((e as ApiError).message),
  });

  return (
    <Modal title="New stock item" onClose={onClose}>
      {err && <div className="note crit" style={{ marginBottom: 14 }} role="alert">{err}</div>}
      <div className="grid g2">
        <Field label="Item code" hint="Short and unique — it goes on the bin label.">
          <input className="inp" value={f.code} autoFocus placeholder="e.g. PLB-SEAL-15"
                 onChange={(e) => set('code')(e.target.value)} />
        </Field>
        <Field label="Name">
          <input className="inp" value={f.name} placeholder="e.g. Pump mechanical seal 15 mm"
                 onChange={(e) => set('name')(e.target.value)} />
        </Field>
      </div>
      <div className="grid g3">
        <Field label="Category">
          <input className="inp" value={f.category} placeholder="e.g. Plumbing"
                 onChange={(e) => set('category')(e.target.value)} />
        </Field>
        <Field label="Unit">
          <input className="inp" value={f.unit} onChange={(e) => set('unit')(e.target.value)} />
        </Field>
        <Field label="Bin">
          <input className="inp" value={f.binLocation} placeholder="e.g. B-04"
                 onChange={(e) => set('binLocation')(e.target.value)} />
        </Field>
      </div>
      <div className="grid g2">
        <Field label="Minimum level" hint="Below this the item appears in the reorder warning.">
          <input className="inp" type="number" min={0} value={f.minLevel}
                 onChange={(e) => set('minLevel')(e.target.value)} />
        </Field>
        <Field label="Reorder quantity">
          <input className="inp" type="number" min={0} value={f.reorderQty}
                 onChange={(e) => set('reorderQty')(e.target.value)} />
        </Field>
      </div>
      <div className="modal-foot">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn tone="pri" icon="check"
             disabled={f.code.trim().length < 1 || f.name.trim().length < 1 || save.isPending}
             onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Add item'}</Btn>
      </div>
    </Modal>
  );
}

function Receive({ item, onClose, onDone }: {
  item: Item; onClose: () => void; onDone: (msg: string) => void;
}) {
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const [type, setType] = useState<'receipt' | 'return' | 'adjustment' | 'count'>('receipt');
  const [qty, setQty] = useState('');
  const [unitCost, setUnitCost] = useState(((item.avg_cost_kobo ?? 0) / 100).toString());
  const [ref, setRef] = useState('');
  const [note, setNote] = useState('');

  const n = Number(qty);
  // A count is an absolute figure; everything else is a movement relative to the balance.
  const delta = type === 'count' ? n - item.current_qty : n;

  const save = useMutation({
    mutationFn: () => api.post<{ balance: number }>(`/api/stock/${item.id}/movement`, {
      type, qtyDelta: delta,
      unitCostKobo: type === 'receipt' ? Math.round(Number(unitCost) * 100) : undefined,
      ref: ref.trim() || undefined, note: note.trim() || undefined,
    }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: qk.stock });
      onDone(`${item.name} is now at ${r.balance} ${item.unit}.`);
    },
    onError: (e) => setErr((e as ApiError).message),
  });

  return (
    <Modal title={`${item.code} · ${item.name}`} onClose={onClose}>
      {err && <div className="note crit" style={{ marginBottom: 14 }} role="alert">{err}</div>}
      <dl className="kv" style={{ marginBottom: 16 }}>
        <dt>On hand</dt><dd>{item.current_qty} {item.unit}</dd>
        {item.avg_cost_kobo !== undefined && (
          <><dt>Average cost</dt><dd>{naira(item.avg_cost_kobo)} per {item.unit}</dd></>)}
        <dt>Bin</dt><dd className="mono">{item.bin_location ?? '—'}</dd>
      </dl>

      <div className="grid g2">
        <Field label="Movement">
          <select className="inp" value={type} onChange={(e) => setType(e.target.value as typeof type)}>
            <option value="receipt">Receipt — stock arriving</option>
            <option value="return">Return — unused part coming back</option>
            <option value="adjustment">Adjustment — correct an error</option>
            <option value="count">Stock count — set the true figure</option>
          </select>
        </Field>
        <Field label={type === 'count' ? `Counted quantity in ${item.unit}` : `Quantity in ${item.unit}`}
               hint={type === 'adjustment' ? 'Use a negative number to write stock off.' : undefined}>
          <input className="inp" inputMode="decimal" value={qty} autoFocus placeholder="0"
                 onChange={(e) => setQty(e.target.value)} />
        </Field>
      </div>

      {type === 'receipt' && (
        <Field label="Unit cost in naira"
               hint="The average cost is re-weighted from this, so it stays true as prices move.">
          <input className="inp" inputMode="decimal" value={unitCost}
                 onChange={(e) => setUnitCost(e.target.value)} />
        </Field>
      )}

      <div className="grid g2">
        <Field label="Reference">
          <input className="inp" value={ref} placeholder="Waybill or invoice number"
                 onChange={(e) => setRef(e.target.value)} />
        </Field>
        <Field label="Note">
          <input className="inp" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>

      {qty !== '' && Number.isFinite(n) && (
        <div className={`note ${item.current_qty + delta < 0 ? 'crit' : ''}`}>
          {item.current_qty} {delta >= 0 ? '+' : '−'} {Math.abs(delta)} ={' '}
          <b>{item.current_qty + delta} {item.unit}</b>
          {item.current_qty + delta < 0 && ' — a balance cannot go below zero.'}
        </div>
      )}

      <div className="modal-foot">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn tone="pri" icon="check"
             disabled={!Number.isFinite(n) || qty === '' || delta === 0
                       || item.current_qty + delta < 0 || save.isPending}
             onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Record movement'}</Btn>
      </div>
    </Modal>
  );
}

function History({ item, onClose }: { item: Item; onClose: () => void }) {
  // A month at a time. The balance shown on the card behind this dialog is computed over
  // every movement ever recorded, so narrowing the view here never changes what is
  // reported as being on the shelf.
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });
  const label = new Date(`${month}-15T00:00:00`)
    .toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const isCurrent = month === `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  const step = (by: number) => {
    const [y, m] = month.split('-').map(Number);
    const d = new Date((y ?? 1970), (m ?? 1) - 1 + by, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  };

  const q = useQuery<{ movements: Movement[] }>({
    queryKey: ['stock-movements', item.id, month],
    queryFn: () => api.get(`/api/stock/${item.id}/movements?month=${month}`),
  });
  return (
    <Modal title={`Movements · ${item.code}`} onClose={onClose} wide>
      <MonthBar month={month} label={label} isCurrent={isCurrent}
                onStep={step} onSet={setMonth}
                onReset={() => setMonth(`${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`)}
                note={`on hand now: ${item.current_qty} ${item.unit}`} />
      {q.isLoading ? <Loading rows={5} />
        : q.isError ? <ErrorNote error={q.error} />
        : (q.data?.movements.length ?? 0) === 0
          ? <Empty title={`Nothing moved in ${label}`}
                   hint="Every receipt, issue and adjustment lands here and can never be deleted." />
          : (
            <div className="tw">
              <table className="wide">
                <thead><tr><th>When</th><th>Type</th><th className="num">Change</th>
                  <th className="num">Balance</th><th>By</th><th>Against</th></tr></thead>
                <tbody>
                  {q.data!.movements.map((m) => (
                    <tr key={m.id}>
                      <td className="mono">{when(m.at)}</td>
                      <td>{titleCase(m.type)}
                          {m.note && <span className="sub">{m.note}</span>}</td>
                      <td className="num" style={{ color: m.qty_delta < 0 ? 'var(--warn)' : 'var(--ok)' }}>
                        {m.qty_delta > 0 ? '+' : ''}{m.qty_delta}</td>
                      <td className="num">{m.balance_after}</td>
                      <td>{m.done_by_name ?? '—'}</td>
                      <td className="mono">{m.wo_ref ?? m.ref ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      <div className="note" style={{ marginTop: 14 }}>
        This ledger is append-only at the database level — a movement can be corrected with
        another movement, never erased.
      </div>
    </Modal>
  );
}

interface DraftLine { itemId: string; description: string; qty: string; estimate: string }

function NewRequisition({ items, onClose, onDone }: {
  items: Item[]; onClose: () => void; onDone: (msg: string) => void;
}) {
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const [purpose, setPurpose] = useState('');
  const [woId, setWoId] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([
    { itemId: '', description: '', qty: '1', estimate: '' },
  ]);

  const jobs = useQuery<{ jobs: { id: string; ref: string; title: string }[] }>({
    queryKey: qk.jobs('requisition'), queryFn: () => api.get('/api/jobs?limit=60'),
  });

  function edit(i: number, patch: Partial<DraftLine>) {
    setLines((s) => s.map((l, n) => (n === i ? { ...l, ...patch } : l)));
  }

  const filled = lines.filter((l) => l.description.trim() && Number(l.qty) > 0);
  const total = filled.reduce((n, l) => n + Math.round((Number(l.estimate) || 0) * 100), 0);

  const save = useMutation({
    mutationFn: () => api.post<{ ref: string }>('/api/requisitions', {
      purpose: purpose.trim() || undefined,
      woId: woId || undefined,
      lines: filled.map((l) => ({
        itemId: l.itemId || undefined,
        description: l.description.trim(),
        qty: Number(l.qty),
        estimatedKobo: Math.round((Number(l.estimate) || 0) * 100),
      })),
    }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: qk.requisitions });
      onDone(`Requisition ${r.ref} raised. A supervisor has been notified.`);
    },
    onError: (e) => setErr((e as ApiError).message),
  });

  return (
    <Modal title="Raise a requisition" onClose={onClose} wide>
      {err && <div className="note crit" style={{ marginBottom: 14 }} role="alert">{err}</div>}
      <div className="grid g2">
        <Field label="What is it for">
          <input className="inp" value={purpose} autoFocus
                 placeholder="e.g. Replace failed booster pump seals, block B"
                 onChange={(e) => setPurpose(e.target.value)} />
        </Field>
        <Field label="Against which job">
          <select className="inp" value={woId} onChange={(e) => setWoId(e.target.value)}>
            <option value="">No job</option>
            {(jobs.data?.jobs ?? []).map((j) => (
              <option key={j.id} value={j.id}>{j.ref} · {j.title}</option>))}
          </select>
        </Field>
      </div>

      <p className="eyebrow" style={{ marginBottom: 8 }}>Lines</p>
      <div className="tw">
        <table className="wide">
          <thead><tr><th style={{ width: '30%' }}>Known item</th><th>Description</th>
            <th className="num" style={{ width: 90 }}>Qty</th>
            <th className="num" style={{ width: 130 }}>Estimate ₦</th><th /></tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td>
                  <select className="inp" value={l.itemId}
                          onChange={(e) => {
                            const it = items.find((x) => x.id === e.target.value);
                            edit(i, {
                              itemId: e.target.value,
                              description: it ? it.name : l.description,
                              estimate: it && it.avg_cost_kobo
                                ? ((it.avg_cost_kobo * (Number(l.qty) || 1)) / 100).toString()
                                : l.estimate,
                            });
                          }}>
                    <option value="">Not in the store</option>
                    {items.map((it) => <option key={it.id} value={it.id}>{it.code} · {it.name}</option>)}
                  </select>
                </td>
                <td>
                  <input className="inp" value={l.description} placeholder="What is needed"
                         onChange={(e) => edit(i, { description: e.target.value })} />
                </td>
                <td className="num">
                  <input className="inp" inputMode="decimal" value={l.qty}
                         onChange={(e) => edit(i, { qty: e.target.value })} />
                </td>
                <td className="num">
                  <input className="inp" inputMode="decimal" value={l.estimate} placeholder="0.00"
                         onChange={(e) => edit(i, { estimate: e.target.value })} />
                </td>
                <td className="num">
                  {lines.length > 1 && (
                    <Btn size="sm" aria-label={`Remove line ${i + 1}`}
                         onClick={() => setLines((s) => s.filter((_, n) => n !== i))}>Remove</Btn>)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Btn size="sm" icon="plus" style={{ marginTop: 10 }}
           onClick={() => setLines((s) => [...s, { itemId: '', description: '', qty: '1', estimate: '' }])}>
        Add a line
      </Btn>

      <div className="note" style={{ marginTop: 14 }}>
        Estimated total <b>{naira(total)}</b> across {filled.length} line{filled.length === 1 ? '' : 's'}.
        You cannot approve your own requisition.
      </div>

      <div className="modal-foot">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn tone="pri" icon="check" disabled={filled.length === 0 || save.isPending}
             onClick={() => save.mutate()}>
          {save.isPending ? 'Raising…' : 'Raise requisition'}</Btn>
      </div>
    </Modal>
  );
}

function Decide({ req, onClose, onDone }: {
  req: Requisition; onClose: () => void; onDone: (msg: string) => void;
}) {
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState('');

  const act = useMutation({
    mutationFn: (decision: 'approved' | 'rejected') =>
      api.post(`/api/requisitions/${req.id}/decide`, { decision, note: note.trim() || undefined }),
    onSuccess: async (_r, decision) => {
      await qc.invalidateQueries({ queryKey: qk.requisitions });
      onDone(`${req.ref} ${decision}.`);
    },
    onError: (e) => setErr((e as ApiError).message),
  });

  return (
    <Modal title={`${req.ref} · decide`} onClose={onClose}>
      {err && <div className="note crit" style={{ marginBottom: 14 }} role="alert">{err}</div>}
      <dl className="kv" style={{ marginBottom: 16 }}>
        <dt>Purpose</dt><dd>{req.purpose ?? '—'}</dd>
        <dt>Raised by</dt><dd>{req.raised_by_name ?? '—'} · {when(req.created_at)}</dd>
        {req.wo_ref && <><dt>Job</dt><dd className="mono">{req.wo_ref}</dd></>}
        <dt>Estimate</dt><dd>{naira(req.estimated_kobo ?? 0)}</dd>
      </dl>

      <div className="tw">
        <table className="wide">
          <thead><tr><th>Line</th><th className="num">Qty</th><th className="num">Estimate</th></tr></thead>
          <tbody>
            {req.lines.map((l) => (
              <tr key={l.id}>
                <td>{l.description}</td>
                <td className="num">{l.qty}{l.unit ? ` ${l.unit}` : ''}</td>
                <td className="num">{naira(l.estimated_kobo ?? 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Field label="Note">
        <textarea className="inp" rows={2} value={note}
                  placeholder="Why you approved or rejected it — the requester sees this."
                  onChange={(e) => setNote(e.target.value)} />
      </Field>

      <div className="modal-foot">
        <Btn tone="danger" disabled={act.isPending} onClick={() => act.mutate('rejected')}>Reject</Btn>
        <Btn tone="pri" icon="check" disabled={act.isPending} onClick={() => act.mutate('approved')}>
          {act.isPending ? 'Saving…' : 'Approve'}</Btn>
      </div>
    </Modal>
  );
}

/**
 * The count sheet. Every line starts at the system figure, so a line nobody touched posts
 * nothing — a half-finished walk must never write off the shelves that were not reached.
 */
function CountSheet({ countId, onClose, onDone }: {
  countId: string; onClose: () => void; onDone: (msg: string) => void;
}) {
  const { can } = useSession();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Record<string, { qty?: string; reason?: string }>>({});
  const [err, setErr] = useState<string | null>(null);
  const [onlyVariances, setOnlyVariances] = useState(false);

  const q = useQuery<{ count: CountRow; lines: CountLine[] }>({
    queryKey: qk.stockCount(countId), queryFn: () => api.get(`/api/stock/counts/${countId}`),
  });

  const open = q.data?.count.status === 'open';
  const editable = open && can('stock.adjust');

  const view = (q.data?.lines ?? []).map((l) => {
    const d = draft[l.id];
    const counted = d?.qty !== undefined && d.qty !== '' ? Number(d.qty) : l.counted_qty;
    return { line: l, counted, variance: Math.round((counted - l.system_qty) * 1000) / 1000,
             reason: d?.reason ?? l.reason ?? '' };
  }).filter((v) => !onlyVariances || Math.abs(v.variance) > 0.0001);

  const dirty = Object.entries(draft).filter(([, v]) => v.qty !== undefined || v.reason !== undefined);
  const varianceKobo = view.reduce((n, v) => n + Math.round(v.variance * (v.line.avg_cost_kobo ?? 0)), 0);
  const varianceCount = view.filter((v) => Math.abs(v.variance) > 0.0001).length;

  const save = useMutation({
    mutationFn: () => api.post<{ recorded: number }>(`/api/stock/counts/${countId}/lines`, {
      lines: dirty.map(([lineId, v]) => {
        const l = q.data!.lines.find((x) => x.id === lineId)!;
        return {
          lineId,
          countedQty: v.qty !== undefined && v.qty !== '' ? Number(v.qty) : l.counted_qty,
          reason: (v.reason ?? l.reason ?? '').trim() || undefined,
        };
      }),
    }),
    onSuccess: async () => {
      setDraft({}); setErr(null);
      await qc.invalidateQueries({ queryKey: qk.stockCount(countId) });
      await qc.invalidateQueries({ queryKey: qk.stockCounts });
    },
    onError: (e) => setErr((e as ApiError).message),
  });

  const post = useMutation({
    mutationFn: () => api.post<{ posted: number; adjustedKobo: number; unchanged: number }>(
      `/api/stock/counts/${countId}/post`),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: qk.stock });
      await qc.invalidateQueries({ queryKey: qk.stockCounts });
      await qc.invalidateQueries({ queryKey: qk.stockCount(countId) });
      onDone(r.posted
        ? `${r.posted} line${r.posted === 1 ? '' : 's'} adjusted, ${naira(r.adjustedKobo)} net. `
          + `Each one is a movement in the ledger, not a silent edit.`
        : 'Count posted with no variances — the shelf matched the system exactly.');
    },
    onError: (e) => setErr((e as ApiError).message),
  });

  return (
    <Modal title={`Stock count · ${q.data ? when(q.data.count.counted_at) : ''}`}
           onClose={onClose} wide>
      {err && <div className="note crit" style={{ marginBottom: 14 }} role="alert">{err}</div>}

      {q.isLoading ? <Loading rows={6} />
        : q.isError ? <ErrorNote error={q.error} />
        : (
          <>
            <div className="grid g3" style={{ marginBottom: 14 }}>
              <Tile label="Lines" value={q.data!.lines.length} sub="Every active catalogue item" />
              <Tile label="Variances" value={varianceCount}
                    tone={varianceCount ? 'warn' : 'ok'}
                    sub={varianceCount ? 'Shelf differs from the system' : 'Shelf matches'} />
              <Tile label="Net value" value={naira(varianceKobo)}
                    tone={varianceKobo < 0 ? 'crit' : varianceKobo > 0 ? 'acc' : undefined}
                    sub={varianceKobo < 0 ? 'Stock missing against the book' : 'At average cost'} />
            </div>

            <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
              <button className={`btn sm ${onlyVariances ? 'on' : ''}`}
                      onClick={() => setOnlyVariances(!onlyVariances)}>
                Only lines that differ
              </button>
              {!editable && (
                <Chip tone={open ? 'warn' : 'ok'}>
                  {open ? 'Read only — needs the stock.adjust permission' : 'Posted'}
                </Chip>
              )}
            </div>

            <div className="tw">
              <table className="wide">
                <thead><tr><th>Item</th><th>Bin</th><th className="num">System</th>
                  <th className="num" style={{ width: 110 }}>Counted</th>
                  <th className="num">Variance</th><th style={{ width: '22%' }}>Why</th></tr></thead>
                <tbody>
                  {view.map(({ line, counted, variance, reason }) => (
                    <tr key={line.id}>
                      <td><span className="ttl">{line.name}</span>
                          <span className="sub">{line.code}</span></td>
                      <td className="mono">{line.bin_location ?? '—'}</td>
                      <td className="num mono">{line.system_qty} {line.unit}</td>
                      <td className="num">
                        {editable
                          ? <input className="inp" inputMode="decimal"
                                   style={{ minHeight: 32, padding: '5px 8px', textAlign: 'right' }}
                                   aria-label={`Counted quantity for ${line.name}`}
                                   value={draft[line.id]?.qty ?? String(counted)}
                                   onChange={(e) => setDraft((d) => ({
                                     ...d, [line.id]: { ...d[line.id], qty: e.target.value } }))} />
                          : <span className="mono">{counted}</span>}
                      </td>
                      <td className="num mono"
                          style={{ color: variance < 0 ? 'var(--crit)'
                                          : variance > 0 ? 'var(--ok)' : undefined }}>
                        {variance > 0 ? '+' : ''}{variance || '—'}
                      </td>
                      <td>
                        {Math.abs(variance) > 0.0001 && (
                          editable
                            ? <input className="inp" style={{ minHeight: 32, padding: '5px 8px' }}
                                     placeholder="Broken, miscount, issued off-system…"
                                     aria-label={`Reason for ${line.name}`}
                                     value={reason}
                                     onChange={(e) => setDraft((d) => ({
                                       ...d, [line.id]: { ...d[line.id], reason: e.target.value } }))} />
                            : <span className="sub">{reason || '—'}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {open && (
              <div className="note" style={{ marginTop: 14 }}>
                Posting writes one <b>count movement per line that differs</b> — the balance moves
                because the ledger says so, never by a direct edit, so it can always be rebuilt.
                Lines you never touched post nothing.
              </div>
            )}

            {editable && (
              <div className="modal-foot">
                <Btn onClick={onClose}>Close</Btn>
                <Btn disabled={dirty.length === 0 || save.isPending} onClick={() => save.mutate()}>
                  {save.isPending ? 'Saving…'
                    : dirty.length ? `Save ${dirty.length} line${dirty.length === 1 ? '' : 's'}`
                    : 'Nothing to save'}
                </Btn>
                <Btn tone="pri" icon="check" disabled={dirty.length > 0 || post.isPending}
                     title={dirty.length ? 'Save your changes first' : undefined}
                     onClick={() => post.mutate()}>
                  {post.isPending ? 'Posting…' : `Post ${varianceCount} adjustment${varianceCount === 1 ? '' : 's'}`}
                </Btn>
              </div>
            )}
          </>
        )}
    </Modal>
  );
}

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qk, ApiError } from '../lib/api';
import { useSession } from '../lib/session';
import { naira, titleCase, when } from '../lib/format';
import { Card, Chip, Tile, Loading, Empty, ErrorNote, Btn, Modal, Field, Tabs, Flash, BudgetBar,
         MonthBar } from '../components/Bits';
import { useMonth } from '../lib/month';
import { Photos } from '../components/Photos';

interface CostCentre { id: string; code: string; name: string; is_active: number }
interface BudgetLine { code: string; name: string; budget_kobo: number; actual_kobo: number }
interface Vendor {
  id: string; name: string; category: string | null; contact_person: string | null;
  phone: string | null; email: string | null;
}
interface Contract {
  id: string; title: string; type: string; vendor_name: string; start_date: string;
  end_date: string; value_kobo: number;
}
interface Purchase {
  id: string; ref: string; purchased_at: string; description: string; amount_kobo: number;
  vendor_name: string | null; cost_centre: string | null; wo_ref: string | null;
}
interface Expense {
  id: string; spent_at: string; description: string; amount_kobo: number; status: string;
  category: string | null; cost_centre: string | null; vendor_name: string | null;
  wo_ref: string | null; raised_by: string; raised_by_name: string | null;
  approved_by_name: string | null;
}

type Tab = 'budget' | 'spend' | 'vendors';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'];

/** Naira in the box, kobo on the wire. Anything that is not a clean number is rejected. */
function toKobo(input: string): number | null {
  const n = Number(input.replace(/[, ]/g, ''));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

export function Money() {
  const { me, can } = useSession();
  const qc = useQueryClient();
  const now = new Date();
  // A supervisor records purchases without seeing the department's budget, so the page
  // opens on the first tab their role can actually read rather than on an empty one.
  const reads = can('finance.read');
  const [tab, setTab] = useState<Tab>(reads ? 'budget' : 'vendors');
  // One month drives the whole screen — budget, purchases and expenses together. Reading
  // September's spend against October's budget is the mistake this prevents by
  // construction, and it lives in the URL so the view is linkable.
  const period = useMonth();
  const year = Number(period.month.slice(0, 4));
  const month = Number(period.month.slice(5, 7));
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [modal, setModal] = useState<'expense' | 'purchase' | 'vendor' | 'contract' | 'budget' | null>(null);
  const [receipt, setReceipt] = useState<Expense | null>(null);

  const budget = useQuery<{ year: number; month: number; lines: BudgetLine[] }>({
    queryKey: qk.budgets(year, month),
    queryFn: () => api.get(`/api/budgets/vs-actual?year=${year}&month=${month}`),
    enabled: reads,
  });
  const centres = useQuery<{ costCentres: CostCentre[] }>({
    queryKey: qk.costCentres, queryFn: () => api.get('/api/cost-centres'), enabled: reads,
  });
  const vendors = useQuery<{ vendors: Vendor[]; contracts: Contract[];
                             expiringSoon: { id: string; title: string; vendor: string; end_date: string }[] }>({
    queryKey: qk.vendors, queryFn: () => api.get('/api/vendors'), enabled: can('vendor.read'),
  });
  const purchases = useQuery<{ purchases: Purchase[] }>({
    queryKey: [...qk.purchases, period.month],
    queryFn: () => api.get(`/api/purchases?${period.param}`), enabled: reads,
  });
  const expenses = useQuery<{ expenses: Expense[] }>({
    queryKey: [...qk.expenses, period.month],
    queryFn: () => api.get(`/api/expenses?${period.param}`), enabled: reads,
  });

  const approve = useMutation({
    mutationFn: (id: string) => api.post(`/api/expenses/${id}/approve`),
    onSuccess: async () => {
      setMsg({ text: 'Expense approved. It now counts against the budget.' });
      await qc.invalidateQueries({ queryKey: ['expenses'] });
      await qc.invalidateQueries({ queryKey: ['budgets'] });
    },
    onError: (e) => setMsg({ text: (e as ApiError).message, bad: true }),
  });

  const lines = budget.data?.lines ?? [];
  const totalBudget = lines.reduce((n, l) => n + l.budget_kobo, 0);
  const totalActual = lines.reduce((n, l) => n + l.actual_kobo, 0);
  const over = lines.filter((l) => l.budget_kobo > 0 && l.actual_kobo > l.budget_kobo);
  const pending = (expenses.data?.expenses ?? []).filter((e) => e.status === 'pending');

  function done(text: string) { setModal(null); setMsg({ text }); }

  return (
    <main className="view">
      <div className="vhead">
        <div>
          <p className="eyebrow">Departmental cost tracking</p>
          <h1>Costs &amp; Budget</h1>
          <p>This reconciles with nothing outside the department. It answers one question honestly:
             what did maintenance spend, and on what.</p>
        </div>
        <div className="acts">
          {can('finance.expense.create') && (
            <Btn icon="doc" onClick={() => setModal('expense')}>Raise an expense</Btn>)}
          {can('purchase.record') && (
            <Btn icon="plus" tone="pri" onClick={() => setModal('purchase')}>Record a purchase</Btn>)}
        </div>
      </div>

      {/* Only somebody who reads the budget has anything on this screen that a month
          changes — a supervisor sees vendors and contracts, which have no month. */}
      {reads && (
        <MonthBar month={period.month} label={period.label} isCurrent={period.isCurrent}
                  onStep={period.step} onSet={period.set} onReset={period.reset}
                  note="budget, purchases and expenses together" />
      )}

      <Flash msg={msg} />

      {!reads && (
        <div className="note" style={{ marginBottom: 14 }}>
          Your role records spend but does not read the departmental budget. You can add
          vendors and contracts here, and record a purchase from the button above.
        </div>
      )}

      {reads && <div className="grid g4" style={{ marginBottom: 16 }}>
        <Tile label={`Budget · ${MONTHS[month - 1]}`} value={naira(totalBudget, { compact: true })}
              sub={`${lines.length} cost centre${lines.length === 1 ? '' : 's'}`} />
        <Tile label="Spent so far" value={naira(totalActual, { compact: true })}
              tone={totalBudget > 0 && totalActual > totalBudget ? 'crit' : undefined}
              sub="Purchases plus approved expenses" />
        <Tile label="Remaining" value={naira(totalBudget - totalActual, { compact: true })}
              tone={totalActual > totalBudget ? 'crit' : totalActual > totalBudget * 0.85 ? 'warn' : 'ok'}
              sub={totalBudget > 0 ? `${Math.round((totalActual / totalBudget) * 100)}% used` : 'No budget set'} />
        <Tile label="Waiting on approval" value={pending.length}
              tone={pending.length ? 'warn' : undefined}
              sub={pending.length ? naira(pending.reduce((n, e) => n + e.amount_kobo, 0)) : 'Nothing outstanding'} />
      </div>}

      {over.length > 0 && (
        <div className="note crit" style={{ marginBottom: 14 }}>
          <b>{over.length} cost centre{over.length === 1 ? ' is' : 's are'} over budget this month</b>
          <div style={{ marginTop: 6 }}>
            {over.map((l) => `${l.code} ${l.name} — ${naira(l.actual_kobo)} against ${naira(l.budget_kobo)}`).join(' · ')}
          </div>
        </div>
      )}

      <Tabs<Tab> value={tab} onChange={setTab} items={[
        ...(reads ? [
          { key: 'budget' as const, label: 'Budget vs actual' },
          { key: 'spend' as const, label: 'Purchases & expenses',
            count: (purchases.data?.purchases.length ?? 0) + (expenses.data?.expenses.length ?? 0) },
        ] : []),
        { key: 'vendors', label: 'Vendors & contracts', count: vendors.data?.vendors.length ?? 0 },
      ]} />

      {tab === 'budget' && (
        <Card flush title="Budget against actual"
              right={<>
                <Chip>{MONTHS[month - 1]} {year}</Chip>
                {can('finance.budget.edit') && (
                  <Btn size="sm" icon="plus" style={{ marginLeft: 8 }}
                       onClick={() => setModal('budget')}>Set a budget</Btn>)}
              </>}>
          {budget.isLoading ? <Loading rows={5} />
            : budget.isError ? <div style={{ padding: 15 }}><ErrorNote error={budget.error} /></div>
            : lines.length === 0
              ? <Empty title="No cost centres yet"
                       hint="Create a few — Electrical, Plumbing, HVAC, Generator — then set a monthly figure against each." />
              : (
                <div className="tw">
                  <table className="wide">
                    <thead><tr><th>Cost centre</th><th style={{ width: 180 }}>Used</th>
                      <th className="num">Budget</th><th className="num">Actual</th>
                      <th className="num">Variance</th></tr></thead>
                    <tbody>
                      {lines.map((l) => {
                        const variance = l.budget_kobo - l.actual_kobo;
                        return (
                          <tr key={l.code}>
                            <td><span className="ttl">{l.name}</span><span className="sub">{l.code}</span></td>
                            <td><BudgetBar budget={l.budget_kobo} actual={l.actual_kobo} /></td>
                            <td className="num">{naira(l.budget_kobo)}</td>
                            <td className="num">{naira(l.actual_kobo)}</td>
                            <td className="num" style={{ color: variance < 0 ? 'var(--crit)' : undefined }}>
                              {variance < 0 ? `over ${naira(-variance)}` : naira(variance)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
        </Card>
      )}

      {tab === 'spend' && (
        <div className="grid g2">
          <Card flush title="Expenses"
                right={<Chip tone={pending.length ? 'warn' : ''}>{pending.length} pending</Chip>}>
            {expenses.isLoading ? <Loading rows={4} />
              : expenses.isError ? <div style={{ padding: 15 }}><ErrorNote error={expenses.error} /></div>
              : (expenses.data?.expenses.length ?? 0) === 0
                ? <Empty title="No expenses raised" />
                : (
                  <div className="tw">
                    <table className="wide">
                      <thead><tr><th>What</th><th className="num">Amount</th><th>Status</th><th /></tr></thead>
                      <tbody>
                        {expenses.data!.expenses.map((e) => {
                          const mine = e.raised_by === me?.user.id;
                          return (
                            <tr key={e.id}>
                              <td>
                                <span className="ttl">{e.description}</span>
                                <span className="sub">
                                  {when(e.spent_at)}
                                  {e.cost_centre ? ` · ${e.cost_centre}` : ''}
                                  {e.wo_ref ? ` · ${e.wo_ref}` : ''}
                                  {e.raised_by_name ? ` · ${e.raised_by_name}` : ''}
                                </span>
                              </td>
                              <td className="num">{naira(e.amount_kobo)}</td>
                              <td>
                                <Chip tone={e.status === 'approved' || e.status === 'paid' ? 'ok'
                                            : e.status === 'rejected' ? 'crit' : 'warn'} lamp>
                                  {titleCase(e.status)}</Chip>
                              </td>
                              <td className="num" style={{ whiteSpace: 'nowrap' }}>
                                <Btn size="sm" icon="cam" aria-label={`Receipt for ${e.description}`}
                                     onClick={() => setReceipt(e)} />
                                {e.status === 'pending' && can('finance.expense.approve') && (
                                  mine
                                    ? <Chip>yours</Chip>
                                    : <Btn size="sm" style={{ marginLeft: 6 }} disabled={approve.isPending}
                                           onClick={() => approve.mutate(e.id)}>Approve</Btn>
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

          <Card flush title="Purchases">
            {purchases.isLoading ? <Loading rows={4} />
              : purchases.isError ? <div style={{ padding: 15 }}><ErrorNote error={purchases.error} /></div>
              : (purchases.data?.purchases.length ?? 0) === 0
                ? <Empty title="Nothing purchased yet"
                         hint="Recording a purchase against a job number is what makes a job cost true." />
                : (
                  <div className="tw">
                    <table className="wide">
                      <thead><tr><th>Ref</th><th>What</th><th className="num">Amount</th></tr></thead>
                      <tbody>
                        {purchases.data!.purchases.map((p) => (
                          <tr key={p.id}>
                            <td className="mono">{p.ref}</td>
                            <td>
                              <span className="ttl">{p.description}</span>
                              <span className="sub">
                                {when(p.purchased_at)}
                                {p.vendor_name ? ` · ${p.vendor_name}` : ''}
                                {p.wo_ref ? ` · ${p.wo_ref}` : ''}
                                {p.cost_centre ? ` · ${p.cost_centre}` : ''}
                              </span>
                            </td>
                            <td className="num">{naira(p.amount_kobo)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
          </Card>
        </div>
      )}

      {tab === 'vendors' && (
        <>
          {(vendors.data?.expiringSoon.length ?? 0) > 0 && (
            <div className="note warn" style={{ marginBottom: 14 }}>
              <b>Contracts ending within 60 days</b>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {vendors.data!.expiringSoon.map((c) => (
                  <li key={c.id}>{c.title} — {c.vendor}, ends {c.end_date}</li>))}
              </ul>
            </div>
          )}
          <div className="grid g2">
            <Card flush title="Vendors"
                  right={can('vendor.manage') && (
                    <Btn size="sm" icon="plus" onClick={() => setModal('vendor')}>Add</Btn>)}>
              {!can('vendor.read') ? <Empty title="Your role cannot read the vendor list" />
                : vendors.isLoading ? <Loading rows={4} />
                : (vendors.data?.vendors.length ?? 0) === 0
                  ? <Empty title="No vendors on file" />
                  : (
                    <div className="tw">
                      <table className="wide">
                        <thead><tr><th>Vendor</th><th>Contact</th></tr></thead>
                        <tbody>
                          {vendors.data!.vendors.map((v) => (
                            <tr key={v.id}>
                              <td><span className="ttl">{v.name}</span>
                                  <span className="sub">{v.category ?? 'uncategorised'}</span></td>
                              <td>{v.contact_person ?? '—'}
                                  <span className="sub">{v.phone ?? v.email ?? ''}</span></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
            </Card>

            <Card flush title="Contracts"
                  right={can('vendor.manage') && (
                    <Btn size="sm" icon="plus" onClick={() => setModal('contract')}>Add</Btn>)}>
              {!can('vendor.read') ? <Empty title="Restricted" />
                : (vendors.data?.contracts.length ?? 0) === 0
                  ? <Empty title="No contracts recorded"
                           hint="AMCs and service agreements go here so a renewal never surprises anyone." />
                  : (
                    <div className="tw">
                      <table className="wide">
                        <thead><tr><th>Contract</th><th>Ends</th><th className="num">Value</th></tr></thead>
                        <tbody>
                          {vendors.data!.contracts.map((c) => {
                            const days = Math.round((new Date(c.end_date).getTime() - Date.now()) / 86_400_000);
                            return (
                              <tr key={c.id}>
                                <td><span className="ttl">{c.title}</span>
                                    <span className="sub">{c.vendor_name} · {c.type}</span></td>
                                <td>{days < 0 ? <Chip tone="crit" lamp>expired</Chip>
                                      : days < 60 ? <Chip tone="warn" lamp>{days}d</Chip>
                                      : <span className="mono">{c.end_date}</span>}</td>
                                <td className="num">{naira(c.value_kobo)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
            </Card>
          </div>
        </>
      )}

      {receipt && (
        <Modal title={`Receipt · ${receipt.description}`} onClose={() => setReceipt(null)}>
          <dl className="kv" style={{ marginBottom: 14 }}>
            <dt>Amount</dt><dd>{naira(receipt.amount_kobo)}</dd>
            <dt>Spent</dt><dd>{when(receipt.spent_at)}</dd>
            <dt>Raised by</dt><dd>{receipt.raised_by_name ?? '—'}</dd>
          </dl>
          <Photos entityType="expense" entityId={receipt.id}
                  canUpload={can('finance.expense.create')} title="Receipt or invoice" />
        </Modal>
      )}
      {modal === 'expense' && <ExpenseForm centres={centres.data?.costCentres ?? []}
                                           onClose={() => setModal(null)} onDone={done} />}
      {modal === 'purchase' && <PurchaseForm centres={centres.data?.costCentres ?? []}
                                             vendors={vendors.data?.vendors ?? []}
                                             onClose={() => setModal(null)} onDone={done} />}
      {modal === 'vendor' && <VendorForm onClose={() => setModal(null)} onDone={done} />}
      {modal === 'contract' && <ContractForm vendors={vendors.data?.vendors ?? []}
                                             onClose={() => setModal(null)} onDone={done} />}
      {modal === 'budget' && <BudgetForm centres={centres.data?.costCentres ?? []} year={year} month={month}
                                         onClose={() => setModal(null)} onDone={done} />}
    </main>
  );
}

function ExpenseForm({ centres, onClose, onDone }: {
  centres: CostCentre[]; onClose: () => void; onDone: (msg: string) => void;
}) {
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const [costCentreId, setCostCentreId] = useState(centres[0]?.id ?? '');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [spentAt, setSpentAt] = useState(new Date().toISOString().slice(0, 10));

  const kobo = toKobo(amount);
  const save = useMutation({
    mutationFn: () => api.post('/api/expenses', {
      costCentreId, amountKobo: kobo, description: description.trim(),
      category: category.trim() || undefined,
      spentAt: new Date(`${spentAt}T12:00`).toISOString(),
    }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['expenses'] });
      onDone(`Expense raised for ${naira(kobo)}. Someone else has to approve it before it counts.`);
    },
    onError: (e) => setErr((e as ApiError).message),
  });

  return (
    <Modal title="Raise an expense" onClose={onClose}>
      {err && <div className="note crit" style={{ marginBottom: 14 }} role="alert">{err}</div>}
      <Field label="What was it for">
        <input className="inp" value={description} autoFocus placeholder="e.g. Emergency plumber call-out, block C"
               onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <div className="grid g3">
        <Field label="Amount in naira">
          <input className="inp" inputMode="decimal" value={amount} placeholder="0.00"
                 onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Cost centre">
          <select className="inp" value={costCentreId} onChange={(e) => setCostCentreId(e.target.value)}>
            <option value="">Choose…</option>
            {centres.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
          </select>
        </Field>
        <Field label="Date">
          <input className="inp" type="date" value={spentAt} onChange={(e) => setSpentAt(e.target.value)} />
        </Field>
      </div>
      <Field label="Category" hint="Optional free text — fuel, consumables, call-out.">
        <input className="inp" value={category} onChange={(e) => setCategory(e.target.value)} />
      </Field>
      <div className="note">
        You cannot approve your own expense. The database enforces that, not just this screen.
      </div>
      <div className="modal-foot">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn tone="pri" icon="check"
             disabled={!costCentreId || kobo == null || description.trim().length < 2 || save.isPending}
             onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : `Raise ${kobo != null ? naira(kobo) : ''}`}
        </Btn>
      </div>
    </Modal>
  );
}

function PurchaseForm({ centres, vendors, onClose, onDone }: {
  centres: CostCentre[]; vendors: Vendor[]; onClose: () => void; onDone: (msg: string) => void;
}) {
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [vendorId, setVendorId] = useState('');
  const [costCentreId, setCostCentreId] = useState('');
  const [woId, setWoId] = useState('');

  const jobs = useQuery<{ jobs: { id: string; ref: string; title: string; status: string }[] }>({
    queryKey: qk.jobs('purchase'), queryFn: () => api.get('/api/jobs?limit=80'),
  });
  const kobo = toKobo(amount);

  const save = useMutation({
    mutationFn: () => api.post<{ ref: string }>('/api/purchases', {
      description: description.trim(), amountKobo: kobo,
      vendorId: vendorId || undefined, costCentreId: costCentreId || undefined,
      woId: woId || undefined,
    }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['purchases'] });
      await qc.invalidateQueries({ queryKey: ['budgets'] });
      if (woId) await qc.invalidateQueries({ queryKey: qk.job(woId) });
      onDone(`Purchase ${r.ref} recorded${woId ? ' and rolled into the job cost' : ''}.`);
    },
    onError: (e) => setErr((e as ApiError).message),
  });

  return (
    <Modal title="Record a purchase" onClose={onClose}>
      {err && <div className="note crit" style={{ marginBottom: 14 }} role="alert">{err}</div>}
      <Field label="What was bought">
        <input className="inp" value={description} autoFocus placeholder="e.g. 2 × 1.5 hp pump seals"
               onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <div className="grid g3">
        <Field label="Amount in naira">
          <input className="inp" inputMode="decimal" value={amount} placeholder="0.00"
                 onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Vendor">
          <select className="inp" value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
            <option value="">Not recorded</option>
            {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </Field>
        <Field label="Cost centre">
          <select className="inp" value={costCentreId} onChange={(e) => setCostCentreId(e.target.value)}>
            <option value="">Unallocated</option>
            {centres.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Against which job"
             hint="A verified job has its costs frozen and will be refused — reopen it first.">
        <select className="inp" value={woId} onChange={(e) => setWoId(e.target.value)}>
          <option value="">No job</option>
          {(jobs.data?.jobs ?? []).map((j) => (
            <option key={j.id} value={j.id}>{j.ref} · {j.title}</option>))}
        </select>
      </Field>
      <div className="modal-foot">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn tone="pri" icon="check"
             disabled={kobo == null || description.trim().length < 2 || save.isPending}
             onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : 'Record purchase'}
        </Btn>
      </div>
    </Modal>
  );
}

function VendorForm({ onClose, onDone }: { onClose: () => void; onDone: (msg: string) => void }) {
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const [f, setF] = useState({ name: '', category: '', contactPerson: '', phone: '', email: '' });
  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }));

  const save = useMutation({
    mutationFn: () => api.post('/api/vendors', {
      name: f.name.trim(), category: f.category.trim() || undefined,
      contactPerson: f.contactPerson.trim() || undefined,
      phone: f.phone.trim() || undefined, email: f.email.trim() || undefined,
    }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.vendors });
      onDone(`${f.name.trim()} added to the vendor list.`);
    },
    onError: (e) => setErr((e as ApiError).message),
  });

  return (
    <Modal title="Add a vendor" onClose={onClose}>
      {err && <div className="note crit" style={{ marginBottom: 14 }} role="alert">{err}</div>}
      <div className="grid g2">
        <Field label="Company name">
          <input className="inp" value={f.name} autoFocus onChange={(e) => set('name')(e.target.value)} />
        </Field>
        <Field label="Trade or category">
          <input className="inp" value={f.category} placeholder="e.g. Generator servicing"
                 onChange={(e) => set('category')(e.target.value)} />
        </Field>
      </div>
      <div className="grid g3">
        <Field label="Contact person">
          <input className="inp" value={f.contactPerson} onChange={(e) => set('contactPerson')(e.target.value)} />
        </Field>
        <Field label="Phone">
          <input className="inp" value={f.phone} inputMode="tel" onChange={(e) => set('phone')(e.target.value)} />
        </Field>
        <Field label="Email">
          <input className="inp" value={f.email} onChange={(e) => set('email')(e.target.value)} />
        </Field>
      </div>
      <div className="modal-foot">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn tone="pri" icon="check" disabled={f.name.trim().length < 1 || save.isPending}
             onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Add vendor'}</Btn>
      </div>
    </Modal>
  );
}

function ContractForm({ vendors, onClose, onDone }: {
  vendors: Vendor[]; onClose: () => void; onDone: (msg: string) => void;
}) {
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const today = new Date().toISOString().slice(0, 10);
  const nextYear = new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);
  const [f, setF] = useState({
    vendorId: vendors[0]?.id ?? '', title: '', type: 'AMC',
    startDate: today, endDate: nextYear, value: '', scope: '',
  });
  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }));
  const kobo = f.value ? toKobo(f.value) : 0;

  const save = useMutation({
    mutationFn: () => api.post('/api/contracts', {
      vendorId: f.vendorId, title: f.title.trim(), type: f.type,
      startDate: f.startDate, endDate: f.endDate,
      valueKobo: kobo ?? 0, scope: f.scope.trim() || undefined,
    }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.vendors });
      onDone(`Contract “${f.title.trim()}” recorded.`);
    },
    onError: (e) => setErr((e as ApiError).message),
  });

  return (
    <Modal title="Add a contract" onClose={onClose}>
      {err && <div className="note crit" style={{ marginBottom: 14 }} role="alert">{err}</div>}
      <Field label="Title">
        <input className="inp" value={f.title} autoFocus placeholder="e.g. Lift AMC — two passenger cars"
               onChange={(e) => set('title')(e.target.value)} />
      </Field>
      <div className="grid g3">
        <Field label="Vendor">
          <select className="inp" value={f.vendorId} onChange={(e) => set('vendorId')(e.target.value)}>
            <option value="">Choose…</option>
            {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </Field>
        <Field label="Type">
          <select className="inp" value={f.type} onChange={(e) => set('type')(e.target.value)}>
            <option value="AMC">AMC</option>
            <option value="service">Service</option>
            <option value="supply">Supply</option>
          </select>
        </Field>
        <Field label="Annual value in naira">
          <input className="inp" inputMode="decimal" value={f.value} placeholder="0.00"
                 onChange={(e) => set('value')(e.target.value)} />
        </Field>
      </div>
      <div className="grid g2">
        <Field label="Starts">
          <input className="inp" type="date" value={f.startDate} onChange={(e) => set('startDate')(e.target.value)} />
        </Field>
        <Field label="Ends" hint="A reminder appears here 60 days before this date.">
          <input className="inp" type="date" value={f.endDate} onChange={(e) => set('endDate')(e.target.value)} />
        </Field>
      </div>
      <Field label="Scope">
        <textarea className="inp" rows={3} value={f.scope}
                  placeholder="What the contract actually covers, and what it does not."
                  onChange={(e) => set('scope')(e.target.value)} />
      </Field>
      <div className="modal-foot">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn tone="pri" icon="check"
             disabled={!f.vendorId || f.title.trim().length < 2 || f.endDate <= f.startDate || save.isPending}
             onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Add contract'}</Btn>
      </div>
    </Modal>
  );
}

function BudgetForm({ centres, year, month, onClose, onDone }: {
  centres: CostCentre[]; year: number; month: number;
  onClose: () => void; onDone: (msg: string) => void;
}) {
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<'budget' | 'centre'>('budget');
  const [costCentreId, setCostCentreId] = useState(centres[0]?.id ?? '');
  const [amount, setAmount] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const kobo = toKobo(amount);

  const saveBudget = useMutation({
    mutationFn: () => api.post('/api/budgets', {
      costCentreId, fiscalYear: year, periodMonth: month, amountKobo: kobo,
    }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['budgets'] });
      onDone(`Budget of ${naira(kobo)} set for ${MONTHS[month - 1]} ${year}.`);
    },
    onError: (e) => setErr((e as ApiError).message),
  });

  const saveCentre = useMutation({
    mutationFn: () => api.post('/api/cost-centres', { code: code.trim().toUpperCase(), name: name.trim() }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.costCentres });
      await qc.invalidateQueries({ queryKey: ['budgets'] });
      onDone(`Cost centre ${code.trim().toUpperCase()} created.`);
    },
    onError: (e) => setErr((e as ApiError).message),
  });

  return (
    <Modal title={`Budget · ${MONTHS[month - 1]} ${year}`} onClose={onClose}>
      {err && <div className="note crit" style={{ marginBottom: 14 }} role="alert">{err}</div>}
      <Tabs<'budget' | 'centre'> value={mode} onChange={setMode} items={[
        { key: 'budget', label: 'Set a figure' },
        { key: 'centre', label: 'New cost centre' },
      ]} />

      {mode === 'budget' ? (
        <>
          <div className="grid g2">
            <Field label="Cost centre">
              <select className="inp" value={costCentreId} onChange={(e) => setCostCentreId(e.target.value)}>
                <option value="">Choose…</option>
                {centres.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
              </select>
            </Field>
            <Field label="Monthly budget in naira">
              <input className="inp" inputMode="decimal" value={amount} autoFocus placeholder="0.00"
                     onChange={(e) => setAmount(e.target.value)} />
            </Field>
          </div>
          <div className="note">
            Setting the same month twice replaces the figure rather than adding to it.
          </div>
          <div className="modal-foot">
            <Btn onClick={onClose}>Cancel</Btn>
            <Btn tone="pri" icon="check" disabled={!costCentreId || kobo == null || saveBudget.isPending}
                 onClick={() => saveBudget.mutate()}>
              {saveBudget.isPending ? 'Saving…' : 'Set budget'}</Btn>
          </div>
        </>
      ) : (
        <>
          <div className="grid g2">
            <Field label="Code" hint="Short and stable — it appears on every purchase.">
              <input className="inp" value={code} autoFocus placeholder="e.g. ELEC"
                     onChange={(e) => setCode(e.target.value)} />
            </Field>
            <Field label="Name">
              <input className="inp" value={name} placeholder="e.g. Electrical"
                     onChange={(e) => setName(e.target.value)} />
            </Field>
          </div>
          <div className="modal-foot">
            <Btn onClick={onClose}>Cancel</Btn>
            <Btn tone="pri" icon="check"
                 disabled={code.trim().length < 1 || name.trim().length < 1 || saveCentre.isPending}
                 onClick={() => saveCentre.mutate()}>
              {saveCentre.isPending ? 'Saving…' : 'Create cost centre'}</Btn>
          </div>
        </>
      )}
    </Modal>
  );
}

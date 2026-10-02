import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qk, ApiError } from '../lib/api';
import { useSession } from '../lib/session';
import { titleCase, when } from '../lib/format';
import { Card, Chip, Tile, Loading, Empty, ErrorNote, Btn, Modal, Field, Tabs, Flash } from '../components/Bits';

interface Schedule {
  id: string; name: string; scope_type: 'asset' | 'category' | 'location';
  asset_name: string | null; category_name: string | null; location_name: string | null;
  trigger_type: 'calendar' | 'meter'; interval_value: number; interval_unit: string;
  lead_days: number; priority: string; next_due_at: string | null; next_due_meter: number | null;
  last_completed_at: string | null; is_active: number; auto_generate: number;
}
interface ChecklistItem {
  id: string; seq: number; task: string; expected_value: string | null;
  requires_reading: number; requires_photo: number; is_critical: number;
}
interface Template {
  id: string; name: string; category_name: string | null; item_count: number; items: ChecklistItem[];
}
interface Compliance {
  from: string; to: string; generated: number; onTime: number; late: number;
  open: number; overdue: number; judged: number; compliancePct: number | null;
}

type Tab = 'schedules' | 'checklists';

/** Days until a date, negative when it has already passed. */
function daysTo(iso: string | null): number | null {
  if (!iso) return null;
  return Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

function dueChip(s: Schedule) {
  if (!s.is_active) return <Chip>Paused</Chip>;
  if (s.trigger_type === 'meter') {
    return <Chip tone="acc" lamp>at {s.next_due_meter?.toLocaleString('en-NG') ?? '—'} h</Chip>;
  }
  const d = daysTo(s.next_due_at);
  if (d == null) return <Chip>Not scheduled</Chip>;
  if (d < 0) return <Chip tone="crit" lamp>{Math.abs(d)}d overdue</Chip>;
  if (d <= s.lead_days) return <Chip tone="warn" lamp>due in {d}d</Chip>;
  return <Chip tone="ok" lamp>in {d}d</Chip>;
}

export function Ppm() {
  const { can } = useSession();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('schedules');
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [adding, setAdding] = useState(false);
  const [newList, setNewList] = useState(false);

  const schedules = useQuery<{ schedules: Schedule[] }>({
    queryKey: qk.ppmSchedules, queryFn: () => api.get('/api/ppm/schedules'),
  });
  const compliance = useQuery<Compliance>({
    queryKey: qk.ppmCompliance, queryFn: () => api.get('/api/ppm/compliance'),
  });
  const lists = useQuery<{ templates: Template[] }>({
    queryKey: qk.checklists, queryFn: () => api.get('/api/ppm/checklists'),
  });

  const generate = useMutation({
    mutationFn: () => api.post<{
      considered: number; created: { ref: string; schedule: string; asset: string }[];
    }>('/api/ppm/generate'),
    onSuccess: async (r) => {
      const n = r.created.length;
      setMsg({
        text: n
          ? `${n} planned job${n === 1 ? '' : 's'} raised — ${
              r.created.slice(0, 5).map((j) => `${j.ref} ${j.asset}`).join(', ')}${
              n > 5 ? ` and ${n - 5} more` : ''}.`
          : `Nothing is due within its lead time yet, so no jobs were raised. ${
              r.considered} schedule${r.considered === 1 ? '' : 's'} checked.`,
      });
      await qc.invalidateQueries({ queryKey: qk.ppmSchedules });
      // Prefix match: every job list refreshes, not just the one the nav badge reads.
      await qc.invalidateQueries({ queryKey: ['jobs'] });
      await qc.invalidateQueries({ queryKey: qk.dashboard });
    },
    onError: (e) => setMsg({ text: (e as ApiError).message, bad: true }),
  });

  const rows = schedules.data?.schedules ?? [];
  const overdue = useMemo(
    () => rows.filter((s) => s.is_active && s.trigger_type === 'calendar' && (daysTo(s.next_due_at) ?? 1) < 0),
    [rows]
  );

  return (
    <main className="view">
      <div className="vhead">
        <div>
          <p className="eyebrow">Planned maintenance · {rows.filter((s) => s.is_active).length} live schedules</p>
          <h1>Planned Work</h1>
          <p>The next service is counted from the date it was <b>due</b>, not the date it was done —
             so a late job never quietly pushes the whole year backwards.</p>
        </div>
        {can('ppm.manage') && (
          <div className="acts">
            <Btn icon="repeat" onClick={() => generate.mutate()} disabled={generate.isPending}>
              {generate.isPending ? 'Checking…' : 'Generate due now'}
            </Btn>
            <Btn icon="plus" tone="pri" onClick={() => (tab === 'checklists' ? setNewList(true) : setAdding(true))}>
              {tab === 'checklists' ? 'New checklist' : 'New schedule'}
            </Btn>
          </div>
        )}
      </div>

      <Flash msg={msg} />

      <div className="grid g4" style={{ marginBottom: 16 }}>
        {/* Nothing judged yet is not the same as nothing done well — show a dash, not a zero. */}
        <Tile label="Compliance · 90 days"
              value={compliance.data?.compliancePct == null ? '—' : `${compliance.data.compliancePct}`}
              unit={compliance.data?.compliancePct == null ? '' : '%'}
              tone={compliance.data?.compliancePct == null ? undefined
                    : compliance.data.compliancePct < 80 ? 'warn' : 'ok'}
              sub={compliance.data?.compliancePct == null
                ? 'Nothing has fallen due yet'
                : `On time across ${compliance.data.judged} job${compliance.data.judged === 1 ? '' : 's'} judged`} />
        <Tile label="Raised" value={compliance.data?.generated ?? '—'} sub="Planned jobs in the window" />
        <Tile label="Late" value={compliance.data?.late ?? '—'}
              tone={(compliance.data?.late ?? 0) > 0 ? 'warn' : undefined} sub="Done, but after the due date" />
        <Tile label="Open" value={compliance.data?.open ?? '—'}
              tone={(compliance.data?.overdue ?? 0) > 0 ? 'crit'
                    : (compliance.data?.open ?? 0) > 0 ? 'acc' : undefined}
              sub={(compliance.data?.overdue ?? 0) > 0
                ? `${compliance.data!.overdue} already past due`
                : 'Raised, none past due yet'} />
      </div>

      {overdue.length > 0 && (
        <div className="note crit" style={{ marginBottom: 14 }}>
          <b>{overdue.length} schedule{overdue.length === 1 ? ' is' : 's are'} past due</b>
          <div style={{ marginTop: 6 }}>
            {overdue.slice(0, 4).map((s) => s.name).join(' · ')}
            {overdue.length > 4 ? ` and ${overdue.length - 4} more` : ''}
            {can('ppm.manage') ? ' — press Generate due now to raise the jobs.' : ''}
          </div>
        </div>
      )}

      <Tabs<Tab> value={tab} onChange={setTab} items={[
        { key: 'schedules', label: 'Schedules', count: rows.length },
        { key: 'checklists', label: 'Checklists', count: lists.data?.templates.length ?? 0 },
      ]} />

      {tab === 'schedules' ? (
        <Card flush title="Every recurring job in the building">
          {schedules.isLoading ? <Loading rows={5} />
            : schedules.isError ? <div style={{ padding: 15 }}><ErrorNote error={schedules.error} /></div>
            : rows.length === 0
              ? <Empty title="No schedules yet"
                       hint="Add one per asset, category or location — a genset service, a monthly AC filter clean, a quarterly pump check." />
              : (
                <div className="tw">
                  <table className="wide">
                    <thead><tr><th>Schedule</th><th>Applies to</th><th>Every</th>
                      <th>Priority</th><th>Next due</th><th>Last done</th></tr></thead>
                    <tbody>
                      {rows.map((s) => (
                        <tr key={s.id} style={s.is_active ? undefined : { opacity: 0.55 }}>
                          <td>
                            <span className="ttl">{s.name}</span>
                            <span className="sub">{titleCase(s.scope_type)}
                              {s.trigger_type === 'meter' ? ' · meter-driven' : ''}</span>
                          </td>
                          <td>{s.asset_name ?? s.category_name ?? s.location_name ?? '—'}</td>
                          <td className="mono">{s.interval_value} {s.interval_unit}</td>
                          <td><span className={`pri-cell ${s.priority}`}>{s.priority}</span></td>
                          <td>{dueChip(s)}
                            {s.trigger_type === 'calendar' && s.next_due_at && (
                              <span className="sub">{when(s.next_due_at)}</span>)}</td>
                          <td className="mono">{s.last_completed_at ? when(s.last_completed_at) : 'never'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
        </Card>
      ) : (
        <ChecklistPanel q={lists} />
      )}

      {adding && <NewSchedule onClose={() => setAdding(false)}
                              onDone={(t) => { setAdding(false); setMsg({ text: t }); }} />}
      {newList && <NewChecklist onClose={() => setNewList(false)}
                                onDone={(t) => { setNewList(false); setMsg({ text: t }); }} />}
    </main>
  );
}

function ChecklistPanel({ q }: { q: ReturnType<typeof useQuery<{ templates: Template[] }>> }) {
  const [open, setOpen] = useState<string | null>(null);
  if (q.isLoading) return <Card><Loading rows={4} /></Card>;
  if (q.isError) return <Card><ErrorNote error={q.error} /></Card>;
  const templates = q.data?.templates ?? [];
  if (templates.length === 0) {
    return <Card><Empty title="No checklists yet"
      hint="A checklist turns a planned job from “serviced the genset” into a signed record of what was actually checked." /></Card>;
  }
  return (
    <div className="grid g2">
      {templates.map((t) => (
        <Card key={t.id} title={t.name}
              right={<Chip>{t.item_count} step{t.item_count === 1 ? '' : 's'}</Chip>}>
          {t.category_name && (
            <p style={{ margin: '0 0 10px', fontSize: '0.7812rem', color: 'var(--text-3)' }}>
              Applies to {t.category_name}</p>
          )}
          <ol style={{ margin: 0, paddingLeft: 18, fontSize: '0.8125rem', color: 'var(--text-2)' }}>
            {(open === t.id ? t.items : t.items.slice(0, 5)).map((i) => (
              <li key={i.id} style={{ marginBottom: 6 }}>
                {i.task}
                {i.is_critical ? <Chip tone="crit">critical</Chip> : null}
                {i.requires_reading ? <Chip tone="acc">reading</Chip> : null}
                {i.requires_photo ? <Chip tone="acc">photo</Chip> : null}
                {i.expected_value && (
                  <span className="sub">expected {i.expected_value}</span>)}
              </li>
            ))}
          </ol>
          {t.items.length > 5 && (
            <Btn size="sm" style={{ marginTop: 10 }}
                 onClick={() => setOpen(open === t.id ? null : t.id)}>
              {open === t.id ? 'Show less' : `Show all ${t.items.length}`}
            </Btn>
          )}
        </Card>
      ))}
    </div>
  );
}

const UNITS: Record<string, string[]> = {
  calendar: ['day', 'week', 'month', 'year'],
  meter: ['hours', 'kwh'],
};

function NewSchedule({ onClose, onDone }: { onClose: () => void; onDone: (msg: string) => void }) {
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const [f, setF] = useState({
    name: '', scopeType: 'asset' as 'asset' | 'category' | 'location', targetId: '',
    triggerType: 'calendar' as 'calendar' | 'meter', intervalValue: '3', intervalUnit: 'month',
    leadDays: '7', priority: 'P4', estimatedMinutes: '', checklistTemplateId: '', firstDueAt: '',
  });
  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }));

  const assets = useQuery<{ assets: { id: string; asset_tag: string; name: string }[] }>({
    queryKey: qk.assets, queryFn: () => api.get('/api/assets'),
  });
  const cats = useQuery<{ categories: { id: string; name: string }[] }>({
    queryKey: qk.assetCategories, queryFn: () => api.get('/api/asset-categories'),
  });
  const locs = useQuery<{ locations: { id: string; name: string }[] }>({
    queryKey: qk.locations, queryFn: () => api.get('/api/locations'),
  });
  const lists = useQuery<{ templates: Template[] }>({
    queryKey: qk.checklists, queryFn: () => api.get('/api/ppm/checklists'),
  });

  const save = useMutation({
    mutationFn: () => api.post('/api/ppm/schedules', {
      name: f.name.trim(),
      scopeType: f.scopeType,
      assetId: f.scopeType === 'asset' ? f.targetId : undefined,
      assetCategoryId: f.scopeType === 'category' ? f.targetId : undefined,
      locationId: f.scopeType === 'location' ? f.targetId : undefined,
      triggerType: f.triggerType,
      intervalValue: Number(f.intervalValue),
      intervalUnit: f.intervalUnit,
      leadDays: Number(f.leadDays) || 0,
      priority: f.priority,
      estimatedMinutes: f.estimatedMinutes ? Number(f.estimatedMinutes) : undefined,
      checklistTemplateId: f.checklistTemplateId || undefined,
      firstDueAt: f.triggerType === 'calendar' && f.firstDueAt
        ? new Date(`${f.firstDueAt}T08:00`).toISOString() : undefined,
    }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.ppmSchedules });
      onDone(`“${f.name.trim()}” is now on the schedule.`);
    },
    onError: (e) => setErr((e as ApiError).message),
  });

  const targets = f.scopeType === 'asset'
    ? (assets.data?.assets ?? []).map((a) => ({ id: a.id, label: `${a.asset_tag} · ${a.name}` }))
    : f.scopeType === 'category'
      ? (cats.data?.categories ?? []).map((c) => ({ id: c.id, label: c.name }))
      : (locs.data?.locations ?? []).map((l) => ({ id: l.id, label: l.name }));

  const ready = f.name.trim().length >= 2 && !!f.targetId && Number(f.intervalValue) > 0;

  return (
    <Modal title="New maintenance schedule" onClose={onClose}>
      {err && <div className="note crit" style={{ marginBottom: 14 }} role="alert">{err}</div>}

      <Field label="What is this job called">
        <input className="inp" value={f.name} autoFocus onChange={(e) => set('name')(e.target.value)}
               placeholder="e.g. Generator 250-hour service" />
      </Field>

      <div className="grid g2">
        <Field label="Applies to">
          <select className="inp" value={f.scopeType}
                  onChange={(e) => { set('scopeType')(e.target.value); set('targetId')(''); }}>
            <option value="asset">One asset</option>
            <option value="category">Every asset in a category</option>
            <option value="location">A location</option>
          </select>
        </Field>
        <Field label={f.scopeType === 'category' ? 'Category' : f.scopeType === 'location' ? 'Location' : 'Asset'}>
          <select className="inp" value={f.targetId} onChange={(e) => set('targetId')(e.target.value)}>
            <option value="">Choose…</option>
            {targets.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </Field>
      </div>

      <div className="grid g3">
        <Field label="Triggered by">
          <select className="inp" value={f.triggerType}
                  onChange={(e) => {
                    const v = e.target.value as 'calendar' | 'meter';
                    setF((s) => ({ ...s, triggerType: v, intervalUnit: UNITS[v]![0]! }));
                  }}>
            <option value="calendar">The calendar</option>
            <option value="meter">Running hours / kWh</option>
          </select>
        </Field>
        <Field label="Every">
          <input className="inp" type="number" min={1} value={f.intervalValue}
                 onChange={(e) => set('intervalValue')(e.target.value)} />
        </Field>
        <Field label="Unit">
          <select className="inp" value={f.intervalUnit} onChange={(e) => set('intervalUnit')(e.target.value)}>
            {UNITS[f.triggerType]!.map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
        </Field>
      </div>

      <div className="grid g3">
        <Field label="Raise the job this early" hint="Days of warning before the due date.">
          <input className="inp" type="number" min={0} max={90} value={f.leadDays}
                 onChange={(e) => set('leadDays')(e.target.value)} />
        </Field>
        <Field label="Priority">
          <select className="inp" value={f.priority} onChange={(e) => set('priority')(e.target.value)}>
            <option value="P1">P1 · emergency</option>
            <option value="P2">P2 · urgent</option>
            <option value="P3">P3 · routine</option>
            <option value="P4">P4 · planned</option>
          </select>
        </Field>
        <Field label="Expected minutes">
          <input className="inp" type="number" min={1} value={f.estimatedMinutes}
                 placeholder="optional" onChange={(e) => set('estimatedMinutes')(e.target.value)} />
        </Field>
      </div>

      <div className="grid g2">
        <Field label="Checklist to attach" hint="The technician fills this in on the job card.">
          <select className="inp" value={f.checklistTemplateId}
                  onChange={(e) => set('checklistTemplateId')(e.target.value)}>
            <option value="">None</option>
            {(lists.data?.templates ?? []).map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>))}
          </select>
        </Field>
        {f.triggerType === 'calendar' && (
          <Field label="First one due on" hint="Leave blank to count one interval from today.">
            <input className="inp" type="date" value={f.firstDueAt}
                   onChange={(e) => set('firstDueAt')(e.target.value)} />
          </Field>
        )}
      </div>

      <div className="modal-foot">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn tone="pri" icon="check" disabled={!ready || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : 'Create schedule'}
        </Btn>
      </div>
    </Modal>
  );
}

interface DraftItem { task: string; expectedValue: string; requiresReading: boolean; requiresPhoto: boolean; isCritical: boolean }
const BLANK: DraftItem = { task: '', expectedValue: '', requiresReading: false, requiresPhoto: false, isCritical: false };

function NewChecklist({ onClose, onDone }: { onClose: () => void; onDone: (msg: string) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [items, setItems] = useState<DraftItem[]>([{ ...BLANK }, { ...BLANK }, { ...BLANK }]);
  const [err, setErr] = useState<string | null>(null);

  const cats = useQuery<{ categories: { id: string; name: string }[] }>({
    queryKey: qk.assetCategories, queryFn: () => api.get('/api/asset-categories'),
  });

  function edit(i: number, patch: Partial<DraftItem>) {
    setItems((s) => s.map((it, n) => (n === i ? { ...it, ...patch } : it)));
  }

  const filled = items.filter((i) => i.task.trim().length >= 2);

  const save = useMutation({
    mutationFn: () => api.post('/api/ppm/checklists', {
      name: name.trim(),
      assetCategoryId: categoryId || undefined,
      items: filled.map((i) => ({
        task: i.task.trim(),
        expectedValue: i.expectedValue.trim() || undefined,
        requiresReading: i.requiresReading, requiresPhoto: i.requiresPhoto, isCritical: i.isCritical,
      })),
    }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.checklists });
      onDone(`Checklist “${name.trim()}” saved with ${filled.length} step${filled.length === 1 ? '' : 's'}.`);
    },
    onError: (e) => setErr((e as ApiError).message),
  });

  return (
    <Modal title="New checklist" onClose={onClose} wide>
      {err && <div className="note crit" style={{ marginBottom: 14 }} role="alert">{err}</div>}
      <div className="grid g2">
        <Field label="Checklist name">
          <input className="inp" value={name} autoFocus onChange={(e) => setName(e.target.value)}
                 placeholder="e.g. Generator 250-hour service sheet" />
        </Field>
        <Field label="Asset category" hint="Optional — helps the right sheet appear on the right job.">
          <select className="inp" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">Any</option>
            {(cats.data?.categories ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
      </div>

      <p style={{ fontFamily: 'var(--mono)', fontSize: '0.5938rem', letterSpacing: '.12em',
                  textTransform: 'uppercase', color: 'var(--text-3)', margin: '4px 0 8px' }}>
        Steps</p>
      <div className="tw">
        <table className="wide">
          <thead><tr><th style={{ width: '44%' }}>Task</th><th>Expected</th>
            <th className="num">Reading</th><th className="num">Photo</th><th className="num">Critical</th>
            <th /></tr></thead>
          <tbody>
            {items.map((it, i) => (
              <tr key={i}>
                <td>
                  <input className="inp" value={it.task} placeholder={`Step ${i + 1}`}
                         onChange={(e) => edit(i, { task: e.target.value })} />
                </td>
                <td>
                  <input className="inp" value={it.expectedValue} placeholder="e.g. 4.5–5.5 bar"
                         onChange={(e) => edit(i, { expectedValue: e.target.value })} />
                </td>
                <td className="num">
                  <input type="checkbox" checked={it.requiresReading} aria-label={`Step ${i + 1} needs a reading`}
                         onChange={(e) => edit(i, { requiresReading: e.target.checked })} />
                </td>
                <td className="num">
                  <input type="checkbox" checked={it.requiresPhoto} aria-label={`Step ${i + 1} needs a photo`}
                         onChange={(e) => edit(i, { requiresPhoto: e.target.checked })} />
                </td>
                <td className="num">
                  <input type="checkbox" checked={it.isCritical} aria-label={`Step ${i + 1} is critical`}
                         onChange={(e) => edit(i, { isCritical: e.target.checked })} />
                </td>
                <td className="num">
                  {/* A step added by mistake could only be cleared by abandoning the whole
                      sheet and starting again. The last one stays, because a checklist with
                      no steps is not a checklist. */}
                  <Btn size="sm" aria-label={`Remove step ${i + 1}`}
                       disabled={items.length <= 1}
                       title={items.length <= 1 ? 'A checklist needs at least one step' : undefined}
                       onClick={() => setItems((st) => st.filter((_, n) => n !== i))}>Remove</Btn>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Btn size="sm" icon="plus" style={{ marginTop: 10 }}
           onClick={() => setItems((s) => [...s, { ...BLANK }])}>Add a step</Btn>

      <div className="note" style={{ marginTop: 14 }}>
        <b>Critical</b> steps are the ones that stop the job. A failed critical step is worth a
        follow-up job on its own rather than a note in the comments.
      </div>

      <div className="modal-foot">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn tone="pri" icon="check"
             disabled={name.trim().length < 2 || filled.length === 0 || save.isPending}
             onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : `Save ${filled.length || ''} step${filled.length === 1 ? '' : 's'}`}
        </Btn>
      </div>
    </Modal>
  );
}


/** Admin → Property settings, response times, who is alerted, and the rules that override them. */
import { Fragment, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { titleCase, duration } from '../../lib/format';
import { preview } from '../../lib/sound';
import { Card, Chip, Loading, Empty, ErrorNote, Btn, Modal, Field, Flash } from '../../components/Bits';

interface SlaRow {
  priority: string; label: string; respondMinutes: number; resolveMinutes: number; escalateToRole: string;
}

export function Settings() {
  const qc = useQueryClient();
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [draft, setDraft] = useState<SlaRow[] | null>(null);
  const [tolerance, setTolerance] = useState<string>('');

  const settings = useQuery<{ settings: { sla_matrix: SlaRow[] | null; trades: string[] | null;
                                          fuel_variance_tolerance_pct: number | null } }>({
    queryKey: ['admin-settings'], queryFn: () => api.get('/api/admin/settings'),
  });

  const sla = draft ?? settings.data?.settings.sla_matrix ?? [];
  // Who a breach can go to. Read from the roles that exist, so a renamed or new role is
  // offered without a code change; falls back to showing the key if roles cannot be read.
  const roles = useQuery<{ roles: { key: string; name: string }[] }>({
    queryKey: ['admin-roles-brief'], queryFn: () => api.get('/api/admin/roles'), retry: false,
  });
  const roleList = roles.data?.roles ?? [];
  const roleName = (key: string) => roleList.find((r) => r.key === key)?.name ?? titleCase(key);

  const put = useMutation({
    mutationFn: (v: { key: string; value: unknown }) => api.post('/api/admin/settings', v),
    onSuccess: async (_r, v) => {
      setMsg({ text: v.key === 'sla_matrix'
        ? 'SLA targets saved. They apply to jobs raised from now on — deadlines already set do not move.'
        : 'Saved.' });
      setDraft(null);
      await qc.invalidateQueries({ queryKey: ['admin-settings'] });
    },
    onError: (e) => setMsg({ text: (e as ApiError).message, bad: true }),
  });

  if (settings.isLoading) return <Card><Loading rows={5} /></Card>;
  if (settings.isError) return <ErrorNote error={settings.error} />;

  return (
    <>
      {msg && <div className={`note ${msg.bad ? 'crit' : ''} mb-6`} role="status">{msg.text}</div>}

      <Card title="Response and resolve targets" flush
            right={<Btn size="sm" tone="pri" disabled={!draft || put.isPending}
                        onClick={() => put.mutate({ key: 'sla_matrix', value: sla })}>Save</Btn>}>
        <div className="tw">
          <table className="wide">
            <thead><tr><th>Priority</th><th>Label</th><th className="num">Respond (min)</th>
              <th className="num">Resolve (min)</th><th>Escalates to</th></tr></thead>
            <tbody>
              {sla.map((row, i) => (
                <tr key={row.priority}>
                  <td className="mono">{row.priority}</td>
                  <td>
                    <input className="inp py-2 px-4 compact" value={row.label}
                           onChange={(e) => {
                             const next = sla.map((r, j) => j === i ? { ...r, label: e.target.value } : r);
                             setDraft(next);
                           }} />
                  </td>
                  {(['respondMinutes', 'resolveMinutes'] as const).map((field) => (
                    <td className="num" key={field}>
                      <input className="inp py-2 px-4 tar compact"
                             inputMode="numeric" value={row[field]}
                             onChange={(e) => {
                               const n = Number(e.target.value);
                               const next = sla.map((r, j) => j === i ? { ...r, [field]: Number.isFinite(n) ? n : 0 } : r);
                               setDraft(next);
                             }} />
                    </td>
                  ))}
                  <td>
                    {roleList.length ? (
                      <select className="inp py-2 px-4 compact" value={row.escalateToRole}
                              aria-label={`${row.priority} escalates to`}
                              onChange={(e) => setDraft(sla.map((r, j) => j === i ? { ...r, escalateToRole: e.target.value } : r))}>
                        {!roleList.some((r) => r.key === row.escalateToRole) && (
                          <option value={row.escalateToRole}>{row.escalateToRole}</option>)}
                        {roleList.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
                      </select>
                    ) : <span className="mono">{row.escalateToRole}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="note mt-6 mb-6">
        A job's deadline is computed once when it is raised and stored on the job. Changing these
        targets shapes future work — <b>it never rewrites a deadline somebody was already judged against.</b>
      </div>

      <SlaRules base={settings.data?.settings.sla_matrix ?? []}
                trades={settings.data?.settings.trades ?? []}
                roles={roleList} roleName={roleName} />

      <Card title="Fuel variance tolerance"
            right={<Btn size="sm" tone="pri" disabled={!tolerance || put.isPending}
                        onClick={() => put.mutate({ key: 'fuel_variance_tolerance_pct', value: Number(tolerance) })}>
                     Save</Btn>}>
        <div className="row gap-5 bottom">
          <div className="fld mb-0 w-sm">
            <label>Percent</label>
            <input className="inp" inputMode="decimal"
                   value={tolerance || String(settings.data?.settings.fuel_variance_tolerance_pct ?? 2)}
                   onChange={(e) => setTolerance(e.target.value)} />
          </div>
          <p className="sub wrap mb-3 measure">
            Measured against throughput, not the tank balance. Below about 2% you will be chasing
            measurement noise from the dip stick rather than losses.
          </p>
        </div>
      </Card>

      <AlertRoutingCard />
    </>
  );
}

/* ------------------------------------------------------------- who is alerted -- */
type AlertLevel = 'quiet' | 'chime' | 'good' | 'urgent';
interface AlertEvent {
  key: string; group: string; label: string; when: string;
  contextLabels: { key: string; label: string }[];
  routing: { roles: string[]; context: string[]; level: AlertLevel; off: boolean };
  isDefault: boolean;
}
const LEVEL_WORDS: Record<AlertLevel, string> = {
  quiet: 'Bell only', chime: 'Chime', good: 'Good-news chime', urgent: 'Urgent tone',
};
const LEVEL_TONE: Record<AlertLevel, 'crit' | 'ok' | 'acc' | ''> = {
  quiet: '', chime: 'acc', good: 'ok', urgent: 'crit',
};

function AlertRoutingCard() {
  const [editing, setEditing] = useState<AlertEvent | null>(null);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const q = useQuery<{ events: AlertEvent[] }>({
    queryKey: ['alert-routing'], queryFn: () => api.get('/api/admin/alert-routing'),
  });
  const roles = useQuery<{ roles: { key: string; name: string }[] }>({
    queryKey: ['admin-roles-brief'], queryFn: () => api.get('/api/admin/roles'), retry: false,
  });
  const roleName = (k: string) => roles.data?.roles.find((r) => r.key === k)?.name ?? titleCase(k);
  const groups = new Map<string, AlertEvent[]>();
  for (const e of q.data?.events ?? []) (groups.get(e.group) ?? groups.set(e.group, []).get(e.group)!).push(e);

  return (
    <div className="mt-6">
      <Flash msg={msg} />
      <Card title="Who is alerted" flush right={<Chip>Bell and browser sound</Chip>}>
        {q.isLoading ? <div className="p-6"><Loading rows={4} /></div>
          : q.isError ? <div className="p-6"><ErrorNote error={q.error} /></div>
          : (
            <div className="tw">
              <table className="wide">
                <thead><tr><th>Event</th><th>Who is told</th><th>How loud</th><th /></tr></thead>
                <tbody>
                  {[...groups.entries()].map(([group, events]) => (
                    <Fragment key={group}>
                      <tr className="grouprow"><td colSpan={4} className="eyebrow">{group}</td></tr>
                      {events.map((e) => {
                        const who = [...e.routing.roles.map(roleName),
                          ...e.routing.context.map((c) => e.contextLabels.find((x) => x.key === c)?.label ?? c)];
                        return (
                          <tr key={e.key}>
                            <td><b>{e.label}</b><span className="sub wrap">{e.when}</span></td>
                            <td>{e.routing.off ? <span className="c-3">Switched off</span>
                                 : <span className="row gap-2">{who.map((w) => <Chip key={w}>{w}</Chip>)}</span>}</td>
                            <td>{!e.routing.off && <Chip tone={LEVEL_TONE[e.routing.level]}>{LEVEL_WORDS[e.routing.level]}</Chip>}</td>
                            <td className="tar">
                              {!e.isDefault && <><Chip tone="warn">Changed</Chip>{' '}</>}
                              <Btn size="sm" onClick={() => setEditing(e)}>Edit</Btn>
                            </td>
                          </tr>
                        );
                      })}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </Card>
      <div className="note mt-6 mb-6">
        Nobody is told about something they did themselves. A person who has several of these roles
        is told once.
      </div>
      {editing && (
        <AlertRoutingDialog event={editing} roles={roles.data?.roles ?? []}
                            onClose={() => setEditing(null)}
                            onDone={(text, bad) => { setEditing(null); setMsg({ text, bad }); }} />
      )}
    </div>
  );
}

function AlertRoutingDialog({ event, roles, onClose, onDone }: {
  event: AlertEvent; roles: { key: string; name: string }[];
  onClose: () => void; onDone: (text: string, bad?: boolean) => void;
}) {
  const qc = useQueryClient();
  const [r, setR] = useState(event.routing);
  const [err, setErr] = useState<string | null>(null);
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const save = useMutation({
    mutationFn: () => api.put(`/api/admin/alert-routing/${encodeURIComponent(event.key)}`, r),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['alert-routing'] });
      onDone(`“${event.label}” saved.`);
    },
    onError: (e) => setErr((e as ApiError).message),
  });
  const reset = useMutation({
    mutationFn: () => api.del(`/api/admin/alert-routing/${encodeURIComponent(event.key)}`),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['alert-routing'] });
      onDone(`“${event.label}” is back to its default.`);
    },
    onError: (e) => setErr((e as ApiError).message),
  });
  const nobody = !r.off && r.roles.length === 0 && r.context.length === 0;

  return (
    <Modal title={event.label} onClose={onClose}
           actions={<>
             {!event.isDefault && <Btn disabled={reset.isPending} onClick={() => reset.mutate()}>Reset to default</Btn>}
             <span className="fill" />
             <Btn onClick={onClose}>Cancel</Btn>
             <Btn tone="pri" disabled={save.isPending || nobody} onClick={() => { setErr(null); save.mutate(); }}>
               {save.isPending ? 'Saving…' : 'Save'}
             </Btn>
           </>}>
      {err && <div className="note crit" role="alert">{err}</div>}
      <p className="t-ui c-2 mt-0">{event.when}</p>
      <label className="row gap-4 clickable">
        <input type="checkbox" checked={!r.off} onChange={(e) => setR({ ...r, off: !e.target.checked })} />
        <span>Send this alert</span>
      </label>
      {!r.off && (
        <>
          <p className="eyebrow mt-6 mb-3">Roles</p>
          <div className="grid g2 gap-3">
            {roles.map((x) => (
              <label key={x.key} className="row gap-4 clickable t-ui">
                <input type="checkbox" checked={r.roles.includes(x.key)}
                       onChange={() => setR({ ...r, roles: toggle(r.roles, x.key) })} />
                <span>{x.name}</span>
              </label>
            ))}
          </div>
          {event.contextLabels.length > 0 && (
            <>
              <p className="eyebrow mt-6 mb-3">And the people involved</p>
              <div className="grid gap-3">
                {event.contextLabels.map((c) => (
                  <label key={c.key} className="row gap-4 clickable t-ui">
                    <input type="checkbox" checked={r.context.includes(c.key)}
                           onChange={() => setR({ ...r, context: toggle(r.context, c.key) })} />
                    <span>{c.label}</span>
                  </label>
                ))}
              </div>
            </>
          )}
          <p className="eyebrow mt-6 mb-3">How loud</p>
          <div className="row gap-3">
            {(['quiet', 'chime', 'good', 'urgent'] as const).map((l) => (
              <button key={l} type="button" className={`btn sm ${r.level === l ? 'on' : ''}`}
                      aria-pressed={r.level === l}
                      onClick={() => { setR({ ...r, level: l }); if (l !== 'quiet') preview(l === 'urgent' ? 'urgent' : l === 'good' ? 'done' : 'notify'); }}>
                {LEVEL_WORDS[l]}
              </button>
            ))}
          </div>
          {nobody && <div className="note warn mt-5">This would reach nobody. Tick at least one role or person, or switch the alert off.</div>}
        </>
      )}
    </Modal>
  );
}

/* ------------------------------------------------- specific target rules -- */
interface SlaRuleRow {
  id: string; priority: 'P1' | 'P2' | 'P3' | 'P4'; trade: string | null;
  location_id: string | null; location_name: string | null;
  respond_minutes: number | null; resolve_minutes: number | null;
  escalate_to_role: string | null; note: string | null;
  updated_at: string; updated_by_name: string | null;
}
interface RulePlace { id: string; parent_id: string | null; type: string; name: string; is_active: number }

/** Places as an indented list, parents before children, for a select. */
function placeOptions(places: RulePlace[]): { id: string; label: string }[] {
  const kids = new Map<string | null, RulePlace[]>();
  for (const p of places) (kids.get(p.parent_id) ?? kids.set(p.parent_id, []).get(p.parent_id)!).push(p);
  const known = new Set(places.map((p) => p.id));
  const out: { id: string; label: string }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const p of kids.get(parent) ?? []) {
      // Apartments are thousands of rows and are covered by their block or floor.
      if (p.type === 'apartment') continue;
      out.push({ id: p.id, label: `${' '.repeat(depth)}${p.name}` });
      if (depth < 12) walk(p.id, depth + 1);
    }
  };
  walk(null, 0);
  // Anything whose parent is outside the list still gets offered, at the top level.
  for (const p of places) if (p.parent_id && !known.has(p.parent_id) && p.type !== 'apartment') {
    if (!out.some((o) => o.id === p.id)) out.push({ id: p.id, label: p.name });
  }
  return out;
}

function appliesTo(r: { trade: string | null; location_name: string | null }): string {
  if (r.trade && r.location_name) return `${titleCase(r.trade)} in ${r.location_name}`;
  if (r.trade) return `${titleCase(r.trade)}, anywhere`;
  return `Any trade in ${r.location_name ?? 'a place that no longer exists'}`;
}

function SlaRules({ base, trades, roles, roleName }: {
  base: SlaRow[]; trades: string[]; roles: { key: string; name: string }[];
  roleName: (key: string) => string;
}) {
  const [editing, setEditing] = useState<SlaRuleRow | 'new' | null>(null);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const rules = useQuery<{ rules: SlaRuleRow[] }>({
    queryKey: ['sla-rules'], queryFn: () => api.get('/api/admin/sla-rules'),
  });
  const list = rules.data?.rules ?? [];
  const baseFor = (p: string) => base.find((b) => b.priority === p);

  return (
    <>
      <Flash msg={msg} />
      <Card title="Specific rules" flush
            right={<Btn size="sm" tone="pri" icon="plus" onClick={() => setEditing('new')}>Add a rule</Btn>}>
        {rules.isLoading ? <div className="p-6"><Loading rows={2} /></div>
          : rules.isError ? <div className="p-6"><ErrorNote error={rules.error} /></div>
          : list.length === 0 ? (
            <Empty title="No specific rules"
                   hint="Every job takes its priority's targets from the table above. Add a rule when one trade or one place needs its own — electrical faster, the plant room escalating to the head of department." />
          ) : (
            <div className="tw">
              <table className="wide">
                <thead><tr><th>Priority</th><th>Applies to</th><th className="num">Respond</th>
                  <th className="num">Resolve</th><th>Escalates to</th><th /></tr></thead>
                <tbody>
                  {list.map((r) => {
                    const d = baseFor(r.priority);
                    return (
                      <tr key={r.id}>
                        <td className="mono">{r.priority}</td>
                        <td>
                          {appliesTo(r)}
                          {r.note && <span className="sub">{r.note}</span>}
                        </td>
                        <td className="num">
                          {r.respond_minutes != null ? <b>{duration(r.respond_minutes)}</b>
                            : <span className="c-3">{duration(d?.respondMinutes)}</span>}
                        </td>
                        <td className="num">
                          {r.resolve_minutes != null ? <b>{duration(r.resolve_minutes)}</b>
                            : <span className="c-3">{duration(d?.resolveMinutes)}</span>}
                        </td>
                        <td>
                          {r.escalate_to_role ? <b>{roleName(r.escalate_to_role)}</b>
                            : <span className="c-3">{d ? roleName(d.escalateToRole) : '—'}</span>}
                        </td>
                        <td className="tar">
                          <Btn size="sm" onClick={() => setEditing(r)}>Edit</Btn>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
      </Card>
      <div className="note mt-6 mb-6">
        <b>The most specific rule wins.</b> A rule naming both a trade and a place, then one naming
        a place — the nearest place first, so a floor beats its block — then one naming a trade.
        Anything a rule leaves blank (shown grey) comes from the priority's row above.
      </div>

      {editing && (
        <RuleModal rule={editing === 'new' ? null : editing} base={base} trades={trades}
                   roles={roles} roleName={roleName}
                   onClose={() => setEditing(null)}
                   onDone={(text) => { setEditing(null); setMsg({ text }); }} />
      )}
    </>
  );
}

function RuleModal({ rule, base, trades, roles, roleName, onClose, onDone }: {
  rule: SlaRuleRow | null; base: SlaRow[]; trades: string[];
  roles: { key: string; name: string }[]; roleName: (key: string) => string;
  onClose: () => void; onDone: (text: string) => void;
}) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    priority: rule?.priority ?? 'P2',
    trade: rule?.trade ?? '',
    locationId: rule?.location_id ?? '',
    respond: rule?.respond_minutes != null ? String(rule.respond_minutes) : '',
    resolve: rule?.resolve_minutes != null ? String(rule.resolve_minutes) : '',
    role: rule?.escalate_to_role ?? '',
    note: rule?.note ?? '',
  });
  const [err, setErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const places = useQuery<{ locations: RulePlace[] }>({
    queryKey: ['locations'], queryFn: () => api.get('/api/locations'),
  });
  const options = placeOptions(places.data?.locations ?? []);
  const d = base.find((b) => b.priority === f.priority);
  const num = (v: string) => (v.trim() === '' ? null : Number(v));

  const body = {
    priority: f.priority, trade: f.trade || null, locationId: f.locationId || null,
    respondMinutes: num(f.respond), resolveMinutes: num(f.resolve),
    escalateToRole: f.role || null, note: f.note.trim() || null,
  };
  const save = useMutation({
    mutationFn: () => (rule ? api.patch(`/api/admin/sla-rules/${rule.id}`, body)
                            : api.post('/api/admin/sla-rules', body)),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['sla-rules'] });
      onDone(rule ? 'Rule saved. It applies to jobs raised from now on.'
                  : 'Rule added. It applies to jobs raised from now on.');
    },
    onError: (e) => setErr((e as ApiError).message),
  });
  const remove = useMutation({
    mutationFn: () => api.del<{ jobsKeepTheirDeadlines: number }>(`/api/admin/sla-rules/${rule!.id}`),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['sla-rules'] });
      const n = r.jobsKeepTheirDeadlines;
      onDone(n > 0
        ? `Rule deleted. New jobs take the default again; the ${n} job${n === 1 ? '' : 's'} it already set keep their deadlines.`
        : 'Rule deleted.');
    },
    onError: (e) => setErr((e as ApiError).message),
  });

  const badNumber = [f.respond, f.resolve].some((v) => v.trim() !== '' && !(Number.isInteger(Number(v)) && Number(v) > 0));
  const noScope = !f.trade && !f.locationId;
  const noChange = f.respond.trim() === '' && f.resolve.trim() === '' && !f.role;
  const effRespond = num(f.respond) ?? d?.respondMinutes ?? 0;
  const effResolve = num(f.resolve) ?? d?.resolveMinutes ?? 0;
  const placeName = options.find((o) => o.id === f.locationId)?.label.trim();

  return (
    <Modal title={rule ? 'Edit rule' : 'Add a rule'} onClose={onClose}
           actions={<>
             {rule && !confirmDelete && (
               <Btn tone="danger" onClick={() => setConfirmDelete(true)}>Delete</Btn>)}
             {rule && confirmDelete && (
               <Btn tone="danger" disabled={remove.isPending} onClick={() => remove.mutate()}>
                 {remove.isPending ? 'Deleting…' : 'Yes, delete this rule'}
               </Btn>)}
             <span className="fill" />
             <Btn onClick={onClose}>Cancel</Btn>
             <Btn tone="pri" disabled={save.isPending || badNumber || noScope || noChange}
                  onClick={() => { setErr(null); save.mutate(); }}>
               {save.isPending ? 'Saving…' : rule ? 'Save rule' : 'Add rule'}
             </Btn>
           </>}>
      {err && <div className="note crit" role="alert">{err}</div>}
      {confirmDelete && (
        <div className="note warn">
          Jobs this rule already set keep their deadlines. New jobs go back to the {f.priority} default.
        </div>
      )}
      <Field label="Priority">
        <select className="inp" value={f.priority}
                onChange={(e) => setF({ ...f, priority: e.target.value as typeof f.priority })}>
          {base.map((b) => <option key={b.priority} value={b.priority}>{b.priority} · {b.label}</option>)}
        </select>
      </Field>
      <div className="g2">
        <Field label="Trade">
          <select className="inp" value={f.trade} onChange={(e) => setF({ ...f, trade: e.target.value })}>
            <option value="">Any trade</option>
            {trades.map((t) => <option key={t} value={t.toLowerCase()}>{titleCase(t)}</option>)}
          </select>
        </Field>
        <Field label="Place" hint="Covers everything under it: a block includes its floors and units.">
          <select className="inp" value={f.locationId} onChange={(e) => setF({ ...f, locationId: e.target.value })}>
            <option value="">Anywhere</option>
            {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </Field>
      </div>
      <div className="g2">
        <Field label="Respond within (minutes)" hint={`Blank keeps the ${f.priority} default, ${duration(d?.respondMinutes)}.`}>
          <input className="inp" inputMode="numeric" value={f.respond} placeholder={`default ${d?.respondMinutes ?? ''}`}
                 onChange={(e) => setF({ ...f, respond: e.target.value.replace(/[^0-9]/g, '') })} />
        </Field>
        <Field label="Resolve within (minutes)" hint={`Blank keeps the ${f.priority} default, ${duration(d?.resolveMinutes)}.`}>
          <input className="inp" inputMode="numeric" value={f.resolve} placeholder={`default ${d?.resolveMinutes ?? ''}`}
                 onChange={(e) => setF({ ...f, resolve: e.target.value.replace(/[^0-9]/g, '') })} />
        </Field>
      </div>
      <Field label="Escalates to">
        <select className="inp" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
          <option value="">{d ? `As ${f.priority} does — ${roleName(d.escalateToRole)}` : 'As the priority does'}</option>
          {roles.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
        </select>
      </Field>
      <Field label="Note (optional)" hint="Why this rule exists, for whoever reads it next year.">
        <input className="inp" value={f.note} maxLength={200} onChange={(e) => setF({ ...f, note: e.target.value })} />
      </Field>

      {noScope ? (
        <div className="note">Pick a trade, a place, or both. A rule for every {f.priority} job is just the {f.priority} row in the table.</div>
      ) : noChange ? (
        <div className="note">Change at least one of respond, resolve or escalates to.</div>
      ) : (
        <div className={`note ${effResolve < effRespond ? 'crit' : 'ok'}`}>
          A {f.priority} {f.trade ? titleCase(f.trade).toLowerCase() + ' ' : ''}job
          {placeName ? ` in ${placeName}` : ''} would get: respond in <b>{duration(effRespond)}</b>,
          resolve in <b>{duration(effResolve)}</b>, escalate to <b>{roleName(f.role || d?.escalateToRole || '')}</b>.
          {effResolve < effRespond && ' Resolve has to be at least as long as respond.'}
        </div>
      )}
    </Modal>
  );
}

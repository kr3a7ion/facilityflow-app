import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qk, ApiError } from '../lib/api';
import { useSession } from '../lib/session';
import { compact, naira, slaLabel, slaTone, titleCase, when } from '../lib/format';
import { Card, Chip, Loading, ErrorNote, Btn, PrintBtn, SignOff } from '../components/Bits';
import { Photos } from '../components/Photos';
import { Icon, type IconName } from '../components/Icon';

interface Detail {
  job: {
    id: string; ref: string; title: string; description: string | null; priority: string;
    status: string; trade: string | null; source: string; hold_reason: string | null;
    unit_no?: string | null; reported_at: string; respond_by: string | null; due_at: string | null;
    responded_at: string | null; started_at: string | null; completed_at: string | null;
    verified_at: string | null; reopened_count: number; held_minutes_total: number;
    resolution_notes: string | null; failure_cause: string | null; costs_frozen: number;
    labour_minutes: number; assigned_to_staff_id: string | null;
  };
  sla: { state: string; minutesRemaining: number | null; effectiveDueAt: string | null; heldMinutes: number };
  history: { id: string; at: string; actor_name: string | null; event_type: string;
             note: string | null; from_status: string | null; to_status: string | null }[];
  parts: { id: string; description: string; qty: number; total_kobo?: number }[];
  labour: { id: string; minutes: number; cost_kobo: number }[];
  cost: { labourKobo: number; partsKobo: number; vendorKobo: number; totalKobo: number; frozen: boolean } | null;
  checklist: Checklist | null;
}

export interface ChecklistItem {
  id: string; seq: number; task: string; expected_value: string | null;
  requires_reading: number; requires_photo: number; is_critical: number;
  result: 'pass' | 'fail' | 'na' | null; value: string | null; note: string | null;
  recorded_at: string | null; recorded_by_name: string | null;
}
interface Checklist {
  templateId: string; name: string; items: ChecklistItem[];
  done: number; total: number; failedCritical: number;
}

const DOT: Record<string, { icon: IconName; tone: string }> = {
  created: { icon: 'clip', tone: '' },
  assigned: { icon: 'user', tone: 'acc' },
  accepted: { icon: 'check', tone: 'ok' },
  started: { icon: 'clock', tone: 'acc' },
  hold: { icon: 'clock', tone: '' },
  resume: { icon: 'clock', tone: 'acc' },
  part_issued: { icon: 'wrench', tone: '' },
  labour_logged: { icon: 'clock', tone: '' },
  comment: { icon: 'clip', tone: '' },
  escalated: { icon: 'alert', tone: 'crit' },
  completed: { icon: 'check', tone: 'ok' },
  verified: { icon: 'check', tone: 'ok' },
  reopened: { icon: 'alert', tone: 'crit' },
  closed: { icon: 'check', tone: '' },
  cancelled: { icon: 'alert', tone: '' },
};

export function JobCard() {
  const { id = '' } = useParams();
  const { can, me } = useSession();
  const qc = useQueryClient();
  const [banner, setBanner] = useState<{ text: string; bad?: boolean } | null>(null);

  const detail = useQuery<Detail>({
    queryKey: qk.job(id), queryFn: () => api.get(`/api/jobs/${id}`), enabled: !!id,
  });

  const act = useMutation({
    mutationFn: (v: { path: string; body?: unknown }) => api.post(`/api/jobs/${id}/${v.path}`, v.body),
    onSuccess: async (_r, v) => {
      setBanner({ text: `${titleCase(v.path)} recorded.` });
      await qc.invalidateQueries({ queryKey: qk.job(id) });
      await qc.invalidateQueries({ queryKey: ['jobs'] });
      await qc.invalidateQueries({ queryKey: qk.dashboard });
      await qc.invalidateQueries({ queryKey: qk.plant });
    },
    onError: (e) => setBanner({ text: (e as ApiError).message, bad: true }),
  });

  if (detail.isLoading) return <main className="view"><Card><Loading rows={6} /></Card></main>;
  if (detail.isError) return <main className="view"><ErrorNote error={detail.error} /></main>;

  const { job, sla, history, parts, cost, checklist } = detail.data!;
  const mine = !!me?.user.staffId && job.assigned_to_staff_id === me.user.staffId;
  const busy = act.isPending;

  const actions: { label: string; path: string; show: boolean; tone?: 'pri' | 'danger'; body?: unknown }[] = [
    { label: 'Accept', path: 'accept', show: can('wo.accept') && job.status === 'assigned' && mine, tone: 'pri' },
    { label: 'Start work', path: 'start', show: can('wo.update') && ['assigned', 'accepted'].includes(job.status), tone: 'pri' },
    { label: 'Resume', path: 'resume', show: can('wo.hold') && job.status === 'on_hold', tone: 'pri' },
    { label: 'Verify & close', path: 'verify', show: can('wo.verify') && job.status === 'completed', tone: 'pri' },
  ];

  return (
    <main className="view">
      <Link className="btn sm" to="/jobs" style={{ marginBottom: 14 }}>
        <Icon name="back" /> All jobs
      </Link>

      <div className="vhead">
        <div>
          <p className="eyebrow">
            {job.ref} · {titleCase(job.source)} · raised {compact(job.reported_at)}
          </p>
          <h1 style={{ fontFamily: 'var(--ui)', fontSize: '1.625rem', textTransform: 'none', letterSpacing: 0 }}>
            {job.title}
          </h1>
          <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginTop: 10 }}>
            <Chip tone={slaTone(sla.state)} lamp={sla.state !== 'paused'}>
              {job.priority} · {slaLabel(sla)}
            </Chip>
            <Chip tone="acc">{titleCase(job.status)}</Chip>
            {job.hold_reason && <Chip tone="warn">{titleCase(job.hold_reason)}</Chip>}
            {job.unit_no && <Chip>{job.unit_no}</Chip>}
            {job.trade && <Chip>{titleCase(job.trade)}</Chip>}
            {job.reopened_count > 0 && <Chip tone="crit">Reopened ×{job.reopened_count}</Chip>}
          </div>
        </div>
        <div className="acts">
          <PrintBtn label="Print job card" />
          {actions.filter((a) => a.show).map((a) => (
            <Btn key={a.path} tone={a.tone} disabled={busy}
                 onClick={() => act.mutate({ path: a.path, body: a.body })}>{a.label}</Btn>
          ))}
          {can('wo.hold') && ['accepted', 'in_progress'].includes(job.status) && <HoldButton act={act} />}
          {can('wo.assign') && !['closed', 'cancelled'].includes(job.status) && <AssignButton jobId={id} />}
          {can('wo.assign') && ['verified', 'completed'].includes(job.status) && <ReopenButton act={act} />}
        </div>
      </div>

      {banner && (
        <div className={`note ${banner.bad ? 'crit' : ''}`} style={{ marginBottom: 14 }} role="status">
          {banner.text}
        </div>
      )}

      <div className="grid g21">
        <div style={{ display: 'grid', gap: 14 }}>
          <Card title="Detail">
            <dl className="kv">
              <dt>Reported</dt><dd>{when(job.reported_at)}</dd>
              <dt>Response</dt>
              <dd>{job.responded_at ? when(job.responded_at)
                : <span style={{ color: 'var(--crit)' }}>not accepted yet</span>}</dd>
              <dt>Started</dt><dd>{when(job.started_at)}</dd>
              <dt>Due</dt>
              <dd style={sla.state === 'breached' ? { color: 'var(--crit)' } : undefined}>
                {when(sla.effectiveDueAt)}
                {sla.heldMinutes > 0 && (
                  <span className="sub" style={{ display: 'inline', marginLeft: 8 }}>
                    (extended by {sla.heldMinutes} min on hold)
                  </span>
                )}
              </dd>
              {job.description && (<><dt>Description</dt>
                <dd style={{ fontWeight: 400, whiteSpace: 'pre-wrap' }}>{job.description}</dd></>)}
              {job.resolution_notes && (<><dt>Resolution</dt>
                <dd style={{ fontWeight: 400, whiteSpace: 'pre-wrap' }}>{job.resolution_notes}</dd></>)}
              {job.failure_cause && (<><dt>Cause</dt><dd>{titleCase(job.failure_cause)}</dd></>)}
            </dl>
          </Card>

          <Photos entityType="work_order" entityId={job.id}
                  canUpload={can('wo.update') && !['closed', 'cancelled'].includes(job.status)} />

          {can('wo.complete') && ['in_progress', 'accepted'].includes(job.status) && (
            <CompleteCard act={act} busy={busy} />
          )}

          {checklist && (
            <ChecklistCard jobId={id} sheet={checklist}
                           canRecord={can('wo.update') && !job.costs_frozen}
                           onSaved={(t) => setBanner({ text: t })} />
          )}

          {(parts.length > 0 || job.labour_minutes > 0) && (
            <Card title="Parts &amp; labour" flush
                  right={cost?.frozen ? <Chip tone="ok">Costs frozen</Chip> : <Chip>Open</Chip>}>
              <div className="tw">
                <table className="wide">
                  {/* A column of dashes told a technician there was a number there that
                      they were not allowed to see. The column is simply not drawn now. */}
                  <thead><tr><th>Item</th><th className="num">Qty</th>
                    {cost && <th className="num">Cost</th>}</tr></thead>
                  <tbody>
                    {parts.map((p) => (
                      <tr key={p.id}><td>{p.description}</td>
                        <td className="num">{p.qty}</td>
                        {cost && <td className="num">{naira(p.total_kobo ?? 0)}</td>}</tr>
                    ))}
                    {job.labour_minutes > 0 && (
                      <tr><td>Labour</td>
                        <td className="num">{Math.round(job.labour_minutes / 6) / 10} h</td>
                        {cost && <td className="num">{naira(cost.labourKobo)}</td>}</tr>
                    )}
                    {cost && (
                      <tr><td style={{ fontWeight: 600 }}>Job cost</td><td />
                        <td className="num" style={{ fontWeight: 600, color: 'var(--text)' }}>
                          {naira(cost.totalKobo)}</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </div>

        <SignOff lines={[
          'Work carried out by — signature and date',
          'Verified by — signature and date',
        ]} />

        <Card title="History" right={<Chip>Append-only</Chip>}>
          <ul className="tl">
            {history.map((e) => {
              const d = DOT[e.event_type] ?? { icon: 'clip' as IconName, tone: '' };
              return (
                <li key={e.id}>
                  <span className={`dot ${d.tone}`}><Icon name={d.icon} /></span>
                  <div className="ev">
                    <b>{titleCase(e.event_type)}<span className="when">{when(e.at)}</span></b>
                    <p>{e.actor_name ?? 'System'}{e.note ? ` — ${e.note}` : ''}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      </div>
    </main>
  );
}

/** Just the slice of the mutation the sub-forms need — writing the full generic here
 *  ties every child to react-query's type surface for no benefit. */
interface Act {
  mutate: (v: { path: string; body?: unknown }) => void;
  isPending: boolean;
}

function CompleteCard({ act, busy }: { act: Act; busy: boolean }) {
  const [notes, setNotes] = useState('');
  const [cause, setCause] = useState('');
  return (
    <Card title="Complete this job">
      <div className="fld">
        <label>What did you do</label>
        <textarea className="inp" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)}
                  placeholder="Required — the next person reads this before they touch it." />
      </div>
      <div className="fld">
        <label>Cause</label>
        <select className="inp" value={cause} onChange={(e) => setCause(e.target.value)}>
          <option value="">Not recorded</option>
          {['wear', 'misuse', 'power', 'age', 'installation', 'no_fault_found'].map((c) =>
            <option key={c} value={c}>{titleCase(c)}</option>)}
        </select>
      </div>
      <Btn tone="pri" disabled={notes.trim().length < 3 || busy}
           onClick={() => act.mutate({ path: 'complete',
             body: { resolutionNotes: notes, failureCause: cause || undefined } })}>
        Mark complete
      </Btn>
      <p className="sub" style={{ marginTop: 10 }}>Someone else has to verify it — never you.</p>
    </Card>
  );
}

function HoldButton({ act }: { act: Act }) {
  const [open, setOpen] = useState(false);
  if (!open) return <Btn onClick={() => setOpen(true)}>Put on hold</Btn>;
  return (
    <select className="inp" style={{ width: 200 }} autoFocus defaultValue=""
            onChange={(e) => { if (e.target.value) { act.mutate({ path: 'hold', body: { reason: e.target.value } }); setOpen(false); } }}>
      <option value="" disabled>Why is it held?</option>
      <option value="awaiting_parts">Awaiting parts</option>
      <option value="awaiting_access">Awaiting access</option>
      <option value="awaiting_vendor">Awaiting vendor</option>
      <option value="awaiting_approval">Awaiting approval</option>
    </select>
  );
}

function ReopenButton({ act }: { act: Act }) {
  const [reason, setReason] = useState<string | null>(null);
  if (reason === null) return <Btn tone="danger" onClick={() => setReason('')}>Reopen</Btn>;
  return (
    <span style={{ display: 'flex', gap: 6 }}>
      <input className="inp" style={{ width: 220 }} autoFocus placeholder="Why is it being reopened?"
             value={reason} onChange={(e) => setReason(e.target.value)} />
      <Btn tone="danger" disabled={reason.trim().length < 3}
           onClick={() => act.mutate({ path: 'reopen', body: { reason } })}>Confirm</Btn>
    </span>
  );
}

function AssignButton({ jobId }: { jobId: string }) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const available = useQuery<{ staff: { staff_id: string; first_name: string; last_name: string;
                                        trade: string | null; shift_name: string | null }[]; note?: string }>({
    queryKey: qk.assignable, queryFn: () => api.get('/api/jobs/assignable'), enabled: open,
  });

  const assign = useMutation({
    mutationFn: (staffId: string) => api.post(`/api/jobs/${jobId}/assign`, { staffId }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.job(jobId) });
      await qc.invalidateQueries({ queryKey: ['jobs'] });
      setOpen(false); setError(null);
    },
    onError: (e) => setError((e as ApiError).message),
  });

  if (!open) return <Btn onClick={() => setOpen(true)}>Assign</Btn>;

  const staff = available.data?.staff ?? [];
  return (
    <span style={{ display: 'grid', gap: 6, minWidth: 260 }}>
      <select className="inp" autoFocus defaultValue=""
              onChange={(e) => e.target.value && assign.mutate(e.target.value)}>
        <option value="" disabled>
          {available.isLoading ? 'Loading…' : staff.length ? 'Who is taking it?' : 'Nobody is on shift'}
        </option>
        {staff.map((s) => (
          <option key={s.staff_id} value={s.staff_id}>
            {s.first_name} {s.last_name}{s.trade ? ` · ${s.trade}` : ''}{s.shift_name ? ` · ${s.shift_name}` : ''}
          </option>
        ))}
      </select>
      {/* Only people marked present today appear — that is the entire reason shifts exist here. */}
      {staff.length === 0 && available.data?.note && (
        <span className="sub" style={{ whiteSpace: 'normal' }}>{available.data.note}</span>
      )}
      {error && <span className="sub" style={{ color: 'var(--crit)', whiteSpace: 'normal' }}>{error}</span>}
    </span>
  );
}

/**
 * The sheet the technician actually fills in. Results are held locally until Save so a weak
 * wifi signal mid-service does not lose half a checklist, and the whole set posts at once.
 */
function ChecklistCard({ jobId, sheet, canRecord, onSaved }: {
  jobId: string;
  sheet: { templateId: string; name: string; items: ChecklistItem[];
           done: number; total: number; failedCritical: number };
  canRecord: boolean;
  onSaved: (msg: string) => void;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Record<string, { result?: string; value?: string; note?: string }>>({});
  const [err, setErr] = useState<string | null>(null);

  function set(itemId: string, patch: { result?: string; value?: string; note?: string }) {
    setDraft((d) => ({ ...d, [itemId]: { ...d[itemId], ...patch } }));
  }
  /** What the row shows: the unsaved edit if there is one, otherwise what is on file. */
  function state(i: ChecklistItem) {
    const d = draft[i.id];
    return {
      result: d?.result ?? i.result ?? '',
      value: d?.value ?? i.value ?? '',
      note: d?.note ?? i.note ?? '',
    };
  }

  const pending = Object.entries(draft).filter(([, v]) => v.result);
  const merged = sheet.items.map((i) => ({ item: i, ...state(i) }));
  const recorded = merged.filter((m) => m.result).length;
  const failed = merged.filter((m) => m.result === 'fail');
  const criticalOutstanding = merged.filter((m) => m.item.is_critical && !m.result);

  const save = useMutation({
    mutationFn: () => api.post<{ recorded: number; failed: number }>(`/api/jobs/${jobId}/checklist`, {
      results: pending.map(([itemId, v]) => ({
        itemId,
        result: v.result,
        value: (v.value ?? '').trim() || undefined,
        note: (v.note ?? '').trim() || undefined,
      })),
    }),
    onSuccess: async (r) => {
      setDraft({}); setErr(null);
      await qc.invalidateQueries({ queryKey: qk.job(jobId) });
      onSaved(`${r.recorded} step${r.recorded === 1 ? '' : 's'} recorded${
        r.failed ? ` — ${r.failed} failed, worth a follow-up job` : ''}.`);
    },
    onError: (e) => setErr((e as ApiError).message),
  });

  return (
    <Card title={sheet.name}
          right={<Chip tone={recorded === sheet.total ? 'ok' : recorded ? 'warn' : ''} lamp>
                   {recorded} of {sheet.total}
                 </Chip>}>
      {err && <div className="note crit" style={{ marginBottom: 12 }} role="alert">{err}</div>}

      <ol className="sheet">
        {merged.map(({ item, result, value, note }) => (
          <li key={item.id} className={result === 'fail' ? 'bad' : result ? 'set' : ''}>
            <div className="task">
              <b>{item.task}</b>
              {item.is_critical ? <Chip tone="crit">critical</Chip> : null}
              {item.expected_value && <span className="exp">expect {item.expected_value}</span>}
              {item.recorded_by_name && !draft[item.id] && (
                <span className="exp">{item.recorded_by_name}, {when(item.recorded_at)}</span>
              )}
            </div>

            <div className="marks" role="group" aria-label={item.task}>
              {(['pass', 'fail', 'na'] as const).map((r) => (
                <button key={r} type="button" disabled={!canRecord}
                        className={`mark ${r} ${result === r ? 'on' : ''}`}
                        aria-pressed={result === r}
                        onClick={() => set(item.id, { result: result === r ? undefined : r })}>
                  {r === 'na' ? 'N/A' : titleCase(r)}
                </button>
              ))}
            </div>

            {(item.requires_reading || result === 'fail' || value || note) && (
              <div className="extra">
                {(item.requires_reading || value) && (
                  <input className="inp" value={value} disabled={!canRecord}
                         placeholder={item.expected_value ? `Reading (${item.expected_value})` : 'Reading'}
                         aria-label={`Reading for ${item.task}`}
                         onChange={(e) => set(item.id, { value: e.target.value })} />
                )}
                {(result === 'fail' || note) && (
                  <input className="inp" value={note} disabled={!canRecord}
                         placeholder="What was wrong?"
                         aria-label={`Note for ${item.task}`}
                         onChange={(e) => set(item.id, { note: e.target.value })} />
                )}
              </div>
            )}
          </li>
        ))}
      </ol>

      {failed.length > 0 && (
        <div className="note warn" style={{ marginTop: 12 }}>
          <b>{failed.length} step{failed.length === 1 ? '' : 's'} failed.</b> A failed step is a
          fault you have found, not a note — raise a follow-up job for it rather than leaving it
          in this sheet.
        </div>
      )}

      {criticalOutstanding.length > 0 && (
        <div className="note" style={{ marginTop: 12 }}>
          {criticalOutstanding.length} critical step{criticalOutstanding.length === 1 ? '' : 's'} still
          to record. The job cannot be marked complete until {criticalOutstanding.length === 1 ? 'it is' : 'they are'} done.
        </div>
      )}

      {canRecord && (
        <Btn tone="pri" icon="check" style={{ marginTop: 14 }}
             disabled={pending.length === 0 || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…'
            : pending.length ? `Save ${pending.length} step${pending.length === 1 ? '' : 's'}`
            : 'Nothing to save'}
        </Btn>
      )}
    </Card>
  );
}

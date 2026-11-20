import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qk, ApiError } from '../lib/api';
import { useSession } from '../lib/session';
import { duration, hours, litres, titleCase, when } from '../lib/format';
import { Card, Chip, Loading, ErrorNote, Empty, Btn, PrintBtn, SignOff, Modal, Field } from '../components/Bits';

interface Person { id: string; name: string; onShift: boolean }
type Reason = 'shift' | 'attention';

interface Draft {
  at: string;
  people: Person[];
  plantState: {
    tanks: { name: string; current_level_l: number | null; capacity_l: number; min_level_l: number }[];
    gensets: { asset_tag: string; name: string; status: string; current_meter: number | null }[];
    utilityOffSince: string | null;
  };
  carriedJobs: { ref: string; title: string; priority: string; status: string; hold_reason: string | null }[];
  openPermits: { ref: string; type: string; valid_to: string }[];
}
interface Past {
  id: string; at: string; status: string; from_name: string | null; to_name: string | null; notes: string | null;
  tagged: number; seen: number; mine_unseen: 0 | 1 | null;
}

export function Handover() {
  const { can } = useSession();
  const qc = useQueryClient();
  const [notes, setNotes] = useState('');
  const [keys, setKeys] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [tags, setTags] = useState<Map<string, Reason>>(new Map());
  const [params, setParams] = useSearchParams();
  const openId = params.get('open');
  const open = (id: string | null) => setParams(id ? { open: id } : {}, { replace: true });
  const tag = (id: string, reason: Reason | null) => setTags((t) => {
    const next = new Map(t);
    if (reason) next.set(id, reason); else next.delete(id);
    return next;
  });

  const draft = useQuery<Draft>({ queryKey: qk.handoverDraft, queryFn: () => api.get('/api/handover/draft') });
  const past = useQuery<{ handovers: Past[] }>({
    queryKey: ['handovers'], queryFn: () => api.get('/api/handover'),
  });

  // Prefilled once from the draft, and never over something the person has typed.
  useEffect(() => {
    if (!draft.data) return;
    const suggested = draft.data.openPermits.map((p) => `${p.ref} · ${titleCase(p.type)}`).join(', ');
    setKeys((typed) => typed || suggested);
  }, [draft.data]);

  const submit = useMutation({
    mutationFn: () => api.post('/api/handover', {
      plantState: draft.data?.plantState, carriedJobs: draft.data?.carriedJobs,
      notes, keysHeld: keys || undefined,
      tags: [...tags].map(([userId, reason]) => ({ userId, reason })),
      openPermits: draft.data?.openPermits.map((p) => p.ref).join(', ') || undefined,
    }),
    onSuccess: async () => {
      setMsg('Handover submitted. The incoming shift has to acknowledge it before they can be assigned work'
        + (tags.size ? `, and the ${tags.size} ${tags.size === 1 ? 'person' : 'people'} you tagged have been told.` : '.'));
      setNotes('');
      setTags(new Map());
      await qc.invalidateQueries({ queryKey: ['handovers'] });
    },
  });

  const acknowledge = useMutation({
    mutationFn: (id: string) => api.post(`/api/handover/${id}/acknowledge`),
    onSuccess: async () => { setMsg('Acknowledged.'); await qc.invalidateQueries({ queryKey: ['handovers'] }); },
    onError: (e) => setMsg((e as ApiError).message),
  });

  if (draft.isLoading) return <main className="view"><Card><Loading rows={6} /></Card></main>;
  if (draft.isError) return <main className="view"><ErrorNote error={draft.error} /></main>;
  const d = draft.data!;

  return (
    <main className="view">
      <div className="vhead">
        <div>
          <p className="eyebrow">Shift handover · {when(d.at)}</p>
          <h1>Handover</h1>
          <p>The system fills in the facts it already holds, so you only write what it cannot know.</p>
        </div>
        <div className="acts">
          <PrintBtn label="Print the book" />
          <Btn tone="pri" disabled={submit.isPending || notes.trim().length < 5}
               onClick={() => submit.mutate()}>
            {submit.isPending ? 'Submitting…' : 'Submit handover'}
          </Btn>
        </div>
      </div>

      {msg && <div className="note mb-6" role="status">{msg}</div>}

      <div className="grid g21">
        <div className="grid gap-6">
          <Card title="Plant state at handover" right={<Chip tone="acc">Filled by the system</Chip>}>
            <ul className="m-0 t-ui c-2 pl-7">
              <li>
                Utility <b style={{ color: d.plantState.utilityOffSince ? 'var(--crit)' : 'var(--ok)' }}>
                  {d.plantState.utilityOffSince ? 'off' : 'on'}</b>
                {d.plantState.utilityOffSince &&
                  ` since ${when(d.plantState.utilityOffSince)} · ${duration(
                    (Date.now() - new Date(d.plantState.utilityOffSince).getTime()) / 60000)} elapsed`}
              </li>
              {d.plantState.gensets.map((g) => (
                <li key={g.asset_tag}>
                  {g.asset_tag} — {titleCase(g.status)} · {hours(g.current_meter)}
                </li>
              ))}
              {d.plantState.tanks.map((t) => (
                <li key={t.name}>
                  {t.name} {litres(t.current_level_l)} of {litres(t.capacity_l)}
                  {t.current_level_l != null && t.current_level_l < t.min_level_l && (
                    <b className="c-crit"> — below minimum</b>
                  )}
                </li>
              ))}
            </ul>
          </Card>

          <Card title="Jobs carried into the next shift"
                right={<Chip>{d.carriedJobs.length} open</Chip>}>
            {d.carriedJobs.length === 0 ? <Empty title="Nothing carried over" /> : (
              <ul className="m-0 t-ui c-2 pl-7">
                {d.carriedJobs.map((j) => (
                  <li className="mb-2" key={j.ref}>
                    <b className="c-1">{j.ref}</b> {j.priority} · {j.title}
                    {' — '}{titleCase(j.status)}{j.hold_reason ? ` (${titleCase(j.hold_reason)})` : ''}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="What the next shift must know">
            <div className="fld">
              <textarea className="inp" rows={5} value={notes} onChange={(e) => setNotes(e.target.value)}
                        placeholder="Access restrictions, what you tried, what to watch overnight, anything the system cannot see." />
            </div>
            <div className="fld">
              <label>Keys and permits held</label>
              <input className="inp" value={keys} onChange={(e) => setKeys(e.target.value)} />
            </div>
            <TagPicker people={d.people} tags={tags} onTag={tag} />
            <div className="note">
              A handover book fails in two ways: the outgoing shift writes too little, and the
              incoming shift never signs. <b>Acknowledgement here is a gate, not a courtesy.</b>
            </div>
          </Card>

          <SignOff lines={[
            'Handed over by — signature, name and time',
            'Taken over by — signature, name and time',
          ]} />
        </div>

        <Card className="no-print" title="Recent handovers" flush>
          {past.isLoading ? <Loading rows={3} />
            : (past.data?.handovers.length ?? 0) === 0 ? <Empty title="None yet" /> : (
              <table>
                <tbody>
                  {past.data!.handovers.map((h) => (
                    <tr key={h.id} className="clickable" onClick={() => open(h.id)}>
                      <td>
                        <span className="ttl">{when(h.at)}</span>
                        <span className="sub">
                          {h.from_name ?? '—'} → {h.to_name ?? 'next shift'}
                          {h.tagged > 0 && ` · ${h.seen} of ${h.tagged} tagged have seen it`}
                        </span>
                      </td>
                      <td className="tar">
                        {h.mine_unseen === 1 && <Chip tone="acc">You are tagged</Chip>}{' '}
                        {h.status === 'acknowledged'
                          ? <Chip tone="ok" lamp>Acknowledged</Chip>
                          : <Chip tone="warn" lamp>Awaiting</Chip>}{' '}
                        <Btn size="sm" onClick={(e) => { e.stopPropagation(); open(h.id); }}>Open</Btn>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </Card>
      </div>
      {openId && (
        <HandoverDetail id={openId} canAck={can('handover.acknowledge')}
                        onClose={() => open(null)}
                        onAck={(id) => acknowledge.mutate(id, { onSuccess: () => open(null) })}
                        acking={acknowledge.isPending} />
      )}
    </main>
  );
}

/**
 * Who should read this. People on today's roster come first and are tagged as the shift;
 * anyone else is added from the list, to have their attention called to it. Each is told
 * when it is submitted.
 */
function TagPicker({ people, tags, onTag }: {
  people: Person[]; tags: Map<string, Reason>; onTag: (id: string, r: Reason | null) => void;
}) {
  const shift = people.filter((p) => p.onShift);
  const others = people.filter((p) => !p.onShift);
  const added = others.filter((p) => tags.has(p.id));
  return (
    <div className="fld">
      <label>Tag people</label>
      {shift.length > 0 ? (
        <div className="row gap-3 mb-4">
          {shift.map((p) => (
            <Btn key={p.id} size="sm" tone={tags.has(p.id) ? 'pri' : undefined} aria-pressed={tags.has(p.id)}
                 onClick={() => onTag(p.id, tags.has(p.id) ? null : 'shift')}>{p.name}</Btn>
          ))}
          <Btn size="sm" onClick={() => shift.forEach((p) => onTag(p.id, 'shift'))}>Everyone on shift</Btn>
        </div>
      ) : <p className="sub mt-0 mb-4">Nobody is marked present on today's roster.</p>}
      {added.length > 0 && (
        <div className="row gap-3 mb-4">
          {added.map((p) => (
            <Btn key={p.id} size="sm" tone="pri" aria-label={`Remove ${p.name}`}
                 onClick={() => onTag(p.id, null)}>{p.name} ✕</Btn>
          ))}
        </div>
      )}
      <select className="inp" value="" aria-label="Call someone else's attention to it"
              onChange={(e) => e.target.value && onTag(e.target.value, 'attention')}>
        <option value="">Call someone else's attention to it…</option>
        {others.filter((p) => !tags.has(p.id)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
    </div>
  );
}

interface Detail {
  handover: {
    id: string; at: string; status: string; notes: string | null; keys_held: string | null;
    open_permits: string | null; from_name: string | null; to_name: string | null;
    acknowledged_at: string | null; acknowledged_by_name: string | null;
    carried_jobs: Draft['carriedJobs'] | null;
  };
  tags: { user_id: string; name: string; reason: Reason; seen_at: string | null }[];
}

/**
 * A handover after it is raised: what was written, who it was addressed to and who has
 * opened it, and the incoming shift's acknowledgement — the gate before they take work.
 * Opening it as somebody tagged marks it seen.
 */
function HandoverDetail({ id, canAck, onClose, onAck, acking }: {
  id: string; canAck: boolean; onClose: () => void; onAck: (id: string) => void; acking: boolean;
}) {
  const qc = useQueryClient();
  const { me } = useSession();
  const q = useQuery<Detail>({ queryKey: ['handover', id], queryFn: () => api.get(`/api/handover/${id}`) });
  const mine = q.data?.tags.find((t) => t.user_id === me?.user.id);
  const seen = useMutation({
    mutationFn: () => api.post(`/api/handover/${id}/seen`),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['handover', id] });
      await qc.invalidateQueries({ queryKey: ['handovers'] });
    },
  });
  useEffect(() => {
    if (mine && !mine.seen_at && !seen.isPending && !seen.isSuccess) seen.mutate();
  }, [mine, seen]);

  const h = q.data?.handover;
  return (
    <Modal title={h ? `Handover · ${when(h.at)}` : 'Handover'} onClose={onClose}>
      {q.isLoading ? <Loading rows={4} /> : q.isError ? <ErrorNote error={q.error} /> : h && (
        <>
          <p className="sub mt-0 mb-5">{h.from_name ?? '—'} → {h.to_name ?? 'next shift'}</p>
          <Field label="What the next shift must know">
            <p className="m-0 lh" style={{ whiteSpace: 'pre-wrap' }}>{h.notes || '—'}</p>
          </Field>
          {h.keys_held && <Field label="Keys and permits held"><p className="m-0">{h.keys_held}</p></Field>}
          {(h.carried_jobs?.length ?? 0) > 0 && (
            <Field label={`Jobs carried over (${h.carried_jobs!.length})`}>
              <ul className="m-0 t-ui c-2 pl-7">
                {h.carried_jobs!.map((j) => <li key={j.ref}><b className="c-1">{j.ref}</b> {j.priority} · {j.title}</li>)}
              </ul>
            </Field>
          )}
          {q.data!.tags.length > 0 && (
            <Field label="Tagged">
              <ul className="m-0 t-ui pl-7">
                {q.data!.tags.map((t) => (
                  <li key={t.user_id} className="mb-2">
                    {t.name} <span className="c-3">· {t.reason === 'shift' ? 'on shift' : 'attention'}</span>{' '}
                    {t.seen_at ? <Chip tone="ok">Seen {when(t.seen_at)}</Chip> : <Chip tone="warn">Not opened yet</Chip>}
                  </li>
                ))}
              </ul>
            </Field>
          )}
          {h.status === 'acknowledged'
            ? <div className="note ok">Acknowledged by <b>{h.acknowledged_by_name ?? '—'}</b> {when(h.acknowledged_at)}.</div>
            : <div className="note warn">Not acknowledged yet. The incoming shift signs for it here; the supervisor is alerted if nobody has after two hours.</div>}
          <div className="modal-foot">
            <Btn onClick={onClose}>Close</Btn>
            {h.status !== 'acknowledged' && canAck && (
              <Btn tone="pri" icon="check" disabled={acking} onClick={() => onAck(h.id)}>
                {acking ? 'Acknowledging…' : 'Acknowledge'}
              </Btn>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}

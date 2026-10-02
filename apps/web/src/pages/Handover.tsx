import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qk, ApiError } from '../lib/api';
import { useSession } from '../lib/session';
import { duration, hours, litres, titleCase, when } from '../lib/format';
import { Card, Chip, Loading, ErrorNote, Empty, Btn, PrintBtn, SignOff } from '../components/Bits';

interface Draft {
  at: string;
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
}

export function Handover() {
  const { can } = useSession();
  const qc = useQueryClient();
  const [notes, setNotes] = useState('');
  const [keys, setKeys] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  const draft = useQuery<Draft>({ queryKey: qk.handoverDraft, queryFn: () => api.get('/api/handover/draft') });
  const past = useQuery<{ handovers: Past[] }>({
    queryKey: ['handovers'], queryFn: () => api.get('/api/handover'),
  });

  useEffect(() => {
    if (draft.data && !keys) {
      setKeys(draft.data.openPermits.map((p) => `${p.ref} · ${titleCase(p.type)}`).join(', '));
    }
  }, [draft.data]);

  const submit = useMutation({
    mutationFn: () => api.post('/api/handover', {
      plantState: draft.data?.plantState, carriedJobs: draft.data?.carriedJobs,
      notes, keysHeld: keys || undefined,
      openPermits: draft.data?.openPermits.map((p) => p.ref).join(', ') || undefined,
    }),
    onSuccess: async () => {
      setMsg('Handover submitted. The incoming shift has to acknowledge it before they can be assigned work.');
      setNotes('');
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

      {msg && <div className="note" style={{ marginBottom: 14 }} role="status">{msg}</div>}

      <div className="grid g21">
        <div style={{ display: 'grid', gap: 14 }}>
          <Card title="Plant state at handover" right={<Chip tone="acc">Filled by the system</Chip>}>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: '0.8438rem', color: 'var(--text-2)' }}>
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
                    <b style={{ color: 'var(--crit)' }}> — below minimum</b>
                  )}
                </li>
              ))}
            </ul>
          </Card>

          <Card title="Jobs carried into the next shift"
                right={<Chip>{d.carriedJobs.length} open</Chip>}>
            {d.carriedJobs.length === 0 ? <Empty title="Nothing carried over" /> : (
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: '0.8438rem', color: 'var(--text-2)' }}>
                {d.carriedJobs.map((j) => (
                  <li key={j.ref} style={{ marginBottom: 5 }}>
                    <b style={{ color: 'var(--text)' }}>{j.ref}</b> {j.priority} · {j.title}
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
                    <tr key={h.id}>
                      <td>
                        <span className="ttl">{when(h.at)}</span>
                        <span className="sub">{h.from_name ?? '—'} → {h.to_name ?? 'next shift'}</span>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {h.status === 'acknowledged'
                          ? <Chip tone="ok" lamp>Acknowledged</Chip>
                          : can('handover.acknowledge')
                            ? <Btn size="sm" onClick={() => acknowledge.mutate(h.id)}>Acknowledge</Btn>
                            : <Chip tone="warn" lamp>Awaiting</Chip>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </Card>
      </div>
    </main>
  );
}

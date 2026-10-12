import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, qk, ApiError } from '../lib/api';
import { Modal, Field, Btn, Loading, Empty, ErrorNote, Chip } from './Bits';

/**
 * Ringing somebody, from wherever you are standing.
 *
 * The first version of this put the button in the account list under Admin — which a
 * supervisor cannot open. The person who most needs to reach a technician could not reach
 * the feature, which is a good reminder that a permission and a place to use it are two
 * different things.
 *
 * So it lives in the top bar, beside the emergency button, for everybody who holds
 * `alerts.ring`. The list it offers comes from the server and already respects scope: a
 * team lead sees their own team and nobody else.
 */

interface Person {
  id: string; display_name: string; role_name: string; staff_name: string | null;
}

export function RingSomebody({ onClose }: { onClose: () => void }) {
  const [picked, setPicked] = useState<Person | null>(null);
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<{ text: string; reached: number } | null>(null);
  const [q, setQ] = useState('');

  const people = useQuery<{ people: Person[]; scope: 'team' | 'all' }>({
    queryKey: qk.ringable, queryFn: () => api.get('/api/alerts/ringable'),
  });

  const ring = useMutation({
    mutationFn: () => api.post<{ reached: number; message: string }>(
      `/api/users/${picked!.id}/ring`, { reason: reason.trim() || undefined }),
    onSuccess: (r) => setResult({ text: r.message, reached: r.reached }),
  });
  const err = ring.error as ApiError | null;

  const list = (people.data?.people ?? []).filter((p) => {
    const needle = q.trim().toLowerCase();
    if (!needle) return true;
    return `${p.display_name} ${p.staff_name ?? ''} ${p.role_name}`.toLowerCase().includes(needle);
  });

  if (result) {
    return (
      <Modal title="Ringing" onClose={onClose}>
        {/* Reached nothing is the outcome worth shouting about: it means go and find them. */}
        <div className={`note ${result.reached === 0 ? 'warn' : ''} mb-6`}>
          {result.text}
        </div>
        {result.reached === 0 && (
          <p className="mt-0 mb-6 t-ui lh">
            Their phone app is not connected and they have no browser open. The ring is
            recorded either way, so it is on the record that you tried.
          </p>
        )}
        <div className="modal-foot">
          <Btn tone="pri" onClick={onClose}>Done</Btn>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={picked ? `Ring ${picked.display_name}` : 'Ring somebody'} onClose={onClose}>
      {!picked ? (
        people.isLoading ? <Loading rows={5} />
          : people.isError ? <ErrorNote error={people.error} />
          : list.length === 0 && !q
            ? <Empty title="Nobody to ring"
                     hint="There are no other active accounts on this property yet." />
            : (
              <>
                {people.data?.scope === 'team' && (
                  <div className="note mb-5">
                    You can ring the people in your own team. Ask a supervisor for anybody else.
                  </div>
                )}
                <Field label="Who">
                  <input className="inp" autoFocus value={q} placeholder="Type a name"
                         onChange={(e) => setQ(e.target.value)} />
                </Field>
                <div className="scrollbox">
                  {list.map((p) => (
                    <div className="ringrow" key={p.id}>
                      <span className="who">
                        <b>{p.display_name}</b>
                        <small>{p.staff_name ?? p.role_name}</small>
                      </span>
                      <Btn size="sm" onClick={() => setPicked(p)}>Ring</Btn>
                    </div>
                  ))}
                  {list.length === 0 && (
                    <p className="py-6 px-1 c-3 t-ui">
                      Nobody matches “{q}”.
                    </p>
                  )}
                </div>
              </>
            )
      ) : (
        <>
          <div className="note mb-6">
            Their device sounds on the alarm volume and keeps asking until they answer —
            whatever their notification sound is set to. Use it when you need them now.
          </div>
          <Field label="Why" hint="Optional, and worth the four words. They see it before they move.">
            <input className="inp" autoFocus value={reason} maxLength={200}
                   placeholder="e.g. Come to the generator room"
                   onChange={(e) => setReason(e.target.value)} />
          </Field>
          {err && (
            <div className="note crit mb-5" role="alert">{err.message}</div>
          )}
          <div className="modal-foot">
            <Btn onClick={() => setPicked(null)}>Back</Btn>
            <Btn tone="pri" icon="bell" disabled={ring.isPending} onClick={() => ring.mutate()}>
              {ring.isPending ? 'Ringing…' : `Ring ${picked.display_name}`}
            </Btn>
          </div>
          <p className="mt-5 mb-0">
            <Chip>Recorded</Chip>{' '}
            <span className="t-sm c-3">
              Who you rang and whether they answered goes in the log.
            </span>
          </p>
        </>
      )}
    </Modal>
  );
}

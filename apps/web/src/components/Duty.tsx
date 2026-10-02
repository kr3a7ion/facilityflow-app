import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useSession } from '../lib/session';
import { when } from '../lib/format';
import { play, deviceId } from '../lib/sound';
import { Btn, Chip, Modal, Field } from './Bits';
import { Icon } from './Icon';

/**
 * The screen that covers the shift.
 *
 * Everything else here alerts a person. This alerts the department — it rings for anything
 * nobody has accepted, whoever it belongs to — and it exists because of three failures the
 * phone app cannot fix: an iPhone, which cannot run the app at all; a handset whose
 * manufacturer froze the background service; and a phone left in a van.
 *
 * It does not replace anybody's phone. It means the department is never relying on one
 * handset behaving.
 */

interface Waiting {
  id: string; ref: string; title: string; priority: string; status: string;
  respond_by: string | null; assignee: string | null;
  unit_no: string | null; location_name: string | null;
}

interface Board {
  at: string;
  overdue: Waiting[];
  waiting: Waiting[];
  onShift: { n: number };
}

/** The strip along the bottom of a duty screen, and the noise it makes. */
export function DutyBar({ live }: { live: boolean }) {
  const { me } = useSession();
  const id = deviceId();

  const isDuty = useQuery<{ duty: boolean; label: string | null }>({
    queryKey: ['is-duty', id],
    queryFn: () => api.get(`/api/duty/is-duty?deviceId=${encodeURIComponent(id)}`),
    enabled: !!me,
    staleTime: 60_000,
  });

  const on = !!isDuty.data?.duty;

  /*
   * Polled on a short timer even when the live stream is up.
   *
   * Everywhere else in this app the stream is enough and polling would be waste. Not here:
   * this is the device the department falls back to when everything else has failed, and
   * a fallback that depends on one mechanism is not a fallback. Checking in is the same
   * call, so a screen that is reading is a screen that is reporting itself alive.
   */
  const board = useQuery<Board>({
    queryKey: ['duty-board'],
    queryFn: () => api.get(`/api/duty/board?deviceId=${encodeURIComponent(id)}`),
    enabled: on,
    refetchInterval: live ? 30_000 : 10_000,
  });

  const overdue = board.data?.overdue ?? [];
  const seen = useRef<Set<string>>(new Set());

  /*
   * Sounds while anything is overdue, and keeps sounding.
   *
   * Deliberately not gated on the sound preference: a duty screen that can be muted is a
   * duty screen that will be, and then the department thinks it is covered when it is not.
   */
  useEffect(() => {
    if (!on || overdue.length === 0) { seen.current = new Set(); return; }
    const fresh = overdue.some((w) => !seen.current.has(w.id));
    if (fresh) play('urgent');
    seen.current = new Set(overdue.map((w) => w.id));
    const timer = setInterval(() => play('urgent'), 60_000);
    return () => clearInterval(timer);
  }, [on, overdue.map((w) => w.id).join(',')]);

  if (!on) return null;

  const waiting = board.data?.waiting ?? [];

  return (
    <div className={`dutybar ${overdue.length ? 'late' : ''}`} role="status">
      <span className="badge">
        <Icon name="shield" size={13} /> Duty screen
        {isDuty.data?.label ? ` · ${isDuty.data.label}` : ''}
      </span>

      {overdue.length > 0 ? (
        <span className="what">
          <b>{overdue.length} job{overdue.length === 1 ? '' : 's'} nobody has picked up</b>
          {overdue.slice(0, 2).map((w) => (
            <Link key={w.id} to={`/jobs/${w.id}`} className="pill">
              {w.priority} · {w.ref} {w.unit_no ? `· ${w.unit_no}` : ''}
            </Link>
          ))}
        </span>
      ) : (
        <span className="what quiet">
          {waiting.length === 0
            ? 'Everything is accepted.'
            : `${waiting.length} waiting, all inside their response time.`}
        </span>
      )}

      <span className="right">
        <Chip tone={live ? 'ok' : 'warn'} lamp>{live ? 'listening' : 'reconnecting'}</Chip>
      </span>
    </div>
  );
}

/** Turning the screen you are on into the duty screen. */
export function DutySetup({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const id = deviceId();
  const [label, setLabel] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  const mine = useQuery<{ duty: boolean; label: string | null }>({
    queryKey: ['is-duty', id],
    queryFn: () => api.get(`/api/duty/is-duty?deviceId=${encodeURIComponent(id)}`),
  });
  const all = useQuery<{ devices: {
    device_id: string; label: string; claimed_by_name: string | null;
    signed_in_as: string | null; last_seen_at: string | null;
  }[]; at: string }>({
    queryKey: ['duty-devices'], queryFn: () => api.get('/api/duty/devices'),
  });

  const claim = useMutation({
    mutationFn: () => api.post('/api/duty/claim', { deviceId: id, label: label.trim() }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['is-duty', id] });
      await qc.invalidateQueries({ queryKey: ['duty-devices'] });
      setMsg('This screen is now the duty screen. Leave it signed in and awake.');
    },
  });
  const release = useMutation({
    mutationFn: (dev: string) => api.post('/api/duty/release', { deviceId: dev }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['is-duty', id] });
      await qc.invalidateQueries({ queryKey: ['duty-devices'] });
      setMsg('Released.');
    },
  });
  const err = (claim.error ?? release.error) as ApiError | null;

  const stale = (seenAt: string | null, now: string): boolean =>
    !seenAt || new Date(now).getTime() - new Date(seenAt).getTime() > 5 * 60_000;

  return (
    <Modal title="The duty screen" onClose={onClose} wide>
      <div className="note" style={{ marginBottom: 14 }}>
        <b>One screen that rings for the whole department.</b> Not instead of anybody's
        phone — underneath it. An iPhone cannot run the alert app at all, some Android
        handsets freeze it, and phones get left in vans. The duty screen is the thing that
        is still listening when one of those happens.
      </div>

      {mine.data?.duty ? (
        <div className="note" style={{ marginBottom: 14, borderLeftColor: 'var(--ok)' }}>
          <b>This screen is the duty screen{mine.data.label ? ` — ${mine.data.label}` : ''}.</b>{' '}
          Leave it signed in, plugged in, and set to never sleep. It cannot be muted while
          it is, which is the point of it.
          <div style={{ marginTop: 10 }}>
            <Btn size="sm" onClick={() => release.mutate(id)}>Stop being the duty screen</Btn>
          </div>
        </div>
      ) : (
        <Field label="What to call this screen"
               hint="Where it is, so somebody knows which one stopped reporting. e.g. Plant room tablet.">
          <div style={{ display: 'flex', gap: 8 }}>
            <input className="inp" autoFocus value={label} maxLength={60}
                   placeholder="Plant room tablet"
                   onChange={(e) => setLabel(e.target.value)} />
            <Btn tone="pri" disabled={label.trim().length < 2 || claim.isPending}
                 onClick={() => claim.mutate()}>
              {claim.isPending ? 'Setting…' : 'Use this screen'}
            </Btn>
          </div>
        </Field>
      )}

      {msg && <div className="note" style={{ marginBottom: 12 }}>{msg}</div>}
      {err && <div className="note crit" style={{ marginBottom: 12 }} role="alert">{err.message}</div>}

      {(all.data?.devices.length ?? 0) > 0 && (
        <>
          <p className="eyebrow" style={{ marginBottom: 8 }}>Duty screens on this property</p>
          <div className="tw">
            <table className="wide">
              <thead><tr><th>Screen</th><th>Signed in as</th><th>Last heard from</th><th /></tr></thead>
              <tbody>
                {all.data!.devices.map((d) => {
                  const quiet = stale(d.last_seen_at, all.data!.at);
                  return (
                    <tr key={d.device_id}>
                      <td><span className="ttl">{d.label}</span>
                          <span className="sub">set up by {d.claimed_by_name ?? '—'}</span></td>
                      <td>{d.signed_in_as ?? '—'}</td>
                      <td>
                        {/* A duty screen that stopped checking in looks exactly like a
                            quiet night. This is the difference. */}
                        {quiet
                          ? <Chip tone="crit" lamp>
                              {d.last_seen_at ? when(d.last_seen_at) : 'never'} — not reporting
                            </Chip>
                          : <Chip tone="ok" lamp>just now</Chip>}
                      </td>
                      <td className="num">
                        <Btn size="sm" onClick={() => release.mutate(d.device_id)}>Release</Btn>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}

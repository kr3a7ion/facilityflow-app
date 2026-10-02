import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qk, ApiError } from '../lib/api';
import { useSession } from '../lib/session';
import { when } from '../lib/format';
import { play } from '../lib/sound';
import { Btn, Chip } from './Bits';
import { Icon } from './Icon';

/**
 * The two things that take over the screen: somebody ringing this device, and an
 * emergency alert.
 *
 * Both deliberately ignore the alert-silence setting. A person who has turned their
 * notification sound off has turned off *being told about work* — they have not opted out
 * of a supervisor trying to reach them or of a fire. That distinction is the whole reason
 * these are separate from the notification bell.
 *
 * Neither can be dismissed. They can only be **acknowledged**, because the acknowledgement
 * is the product: the sender needs to know who heard, and "I closed it" and "I saw it" have
 * to be the same action or the roll call is a guess.
 */

interface Ring {
  id: string; reason: string | null; at: string; rung_by_name: string;
}

interface RollCallEntry {
  userId: string; name: string; acknowledgedAt: string | null; via: string | null;
}

export interface EmergencyAlert {
  id: string; category: string; message: string; created_at: string;
  raised_by_name: string; location_name: string | null;
  rollCall: RollCallEntry[]; acknowledged: number; outstanding: number;
}

const CATEGORY_WORD: Record<string, string> = {
  fire: 'Fire', power: 'Power', water: 'Water', security: 'Security',
  medical: 'Medical', other: 'Emergency',
};

export function Alarm({ live }: { live: boolean }) {
  const { me, can } = useSession();
  const qc = useQueryClient();

  /*
   * Polled as well as pushed.
   *
   * The event stream is how this normally arrives and it is fast. But the one message
   * that must not be missed is the one that must not depend on a single mechanism, so a
   * slow poll runs underneath — more often when the stream is down.
   */
  const rings = useQuery<{ rings: Ring[] }>({
    queryKey: qk.rings, queryFn: () => api.get('/api/me/rings'),
    enabled: !!me, refetchInterval: live ? 60_000 : 15_000,
  });
  const emergencies = useQuery<{ active: EmergencyAlert[] }>({
    queryKey: qk.emergency, queryFn: () => api.get('/api/alerts/emergency'),
    enabled: !!me, refetchInterval: live ? 60_000 : 15_000,
  });

  const ring = rings.data?.rings?.[0] ?? null;
  const alert = emergencies.data?.active?.[0] ?? null;

  /*
   * Keep sounding until it is answered.
   *
   * A single chime for "the building is on fire" is not enough, and a sound that never
   * stops is one people mute. It repeats on a fixed interval while the thing is still
   * unanswered, and stops the moment it is acknowledged — by this device or any other.
   */
  const lastPlayed = useRef(0);
  useEffect(() => {
    if (!ring && !alert) { lastPlayed.current = 0; return; }
    const sound = () => {
      // Deliberately not gated on the sound preference: see the note at the top.
      play('urgent');
      lastPlayed.current = Date.now();
    };
    sound();
    const every = alert ? 8_000 : 12_000;
    const timer = setInterval(sound, every);
    return () => clearInterval(timer);
  }, [ring?.id, alert?.id]);

  const ackRing = useMutation({
    mutationFn: (id: string) => api.post(`/api/me/rings/${id}/ack`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.rings }),
  });
  const ackAlert = useMutation({
    mutationFn: (id: string) => api.post(`/api/alerts/emergency/${id}/ack`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.emergency }),
  });
  const standDown = useMutation({
    mutationFn: (id: string) => api.post(`/api/alerts/emergency/${id}/stand-down`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.emergency }),
  });

  const mine = alert?.rollCall.find((r) => r.userId === me?.user.id);
  const iHaveSeenIt = !!mine?.acknowledgedAt;
  const [showRoll, setShowRoll] = useState(false);

  // The emergency outranks a ring: if both are live, the building comes first.
  if (alert) {
    return (
      <div className="alarm emergency" role="alertdialog" aria-live="assertive"
           aria-label={`${CATEGORY_WORD[alert.category] ?? 'Emergency'} alert`}>
        <div className="alarmcard">
          <p className="kind">
            <Icon name="alert" size={18} /> {CATEGORY_WORD[alert.category] ?? 'Emergency'}
          </p>
          <h1>{alert.message}</h1>
          <p className="by">
            Raised by {alert.raised_by_name}
            {alert.location_name ? ` · ${alert.location_name}` : ''} · {when(alert.created_at)}
          </p>

          {!iHaveSeenIt ? (
            <Btn tone="pri" size="sm" disabled={ackAlert.isPending}
                 onClick={() => ackAlert.mutate(alert.id)}>
              {ackAlert.isPending ? 'Sending…' : 'I have seen this'}
            </Btn>
          ) : (
            <>
              <p className="seen"><Icon name="check" size={14} /> You acknowledged this at {when(mine!.acknowledgedAt!)}</p>
              {/* Once you have answered, the screen stops shouting and starts being
                  useful: who else has, and who has not. */}
              <div className="tally">
                <Chip tone="ok">{alert.acknowledged} acknowledged</Chip>
                <Chip tone={alert.outstanding ? 'warn' : 'ok'}>
                  {alert.outstanding} not yet
                </Chip>
                <button className="btn sm" onClick={() => setShowRoll((v) => !v)}>
                  {showRoll ? 'Hide names' : 'Who has not answered'}
                </button>
              </div>
              {showRoll && (
                <ul className="rollcall">
                  {alert.rollCall.map((p) => (
                    <li key={p.userId} className={p.acknowledgedAt ? 'in' : 'out'}>
                      <span>{p.name}</span>
                      <span className="mono">
                        {p.acknowledgedAt ? when(p.acknowledgedAt) : 'no answer'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {can('alerts.emergency') && (
                <div className="standdown">
                  <Btn size="sm" disabled={standDown.isPending}
                       onClick={() => standDown.mutate(alert.id)}>
                    {standDown.isPending ? 'Standing down…' : 'Stand down'}
                  </Btn>
                  <small>Clears it from every screen and closes the record.</small>
                </div>
              )}
            </>
          )}
          {(ackAlert.error || standDown.error) && (
            <p className="bad" role="alert">
              {((ackAlert.error ?? standDown.error) as ApiError).message}
            </p>
          )}
        </div>
      </div>
    );
  }

  if (!ring) return null;

  return (
    <div className="alarm ringing" role="alertdialog" aria-live="assertive"
         aria-label="Somebody is ringing your device">
      <div className="alarmcard">
        <p className="kind"><Icon name="bell" size={18} /> Someone needs you</p>
        <h1>{ring.rung_by_name} is ringing your device</h1>
        {ring.reason && <p className="why">“{ring.reason}”</p>}
        <p className="by">{when(ring.at)}</p>
        <Btn tone="pri" size="sm" disabled={ackRing.isPending}
             onClick={() => ackRing.mutate(ring.id)}>
          {ackRing.isPending ? 'Answering…' : 'I am here'}
        </Btn>
        {ackRing.error && (
          <p className="bad" role="alert">{(ackRing.error as ApiError).message}</p>
        )}
      </div>
    </div>
  );
}

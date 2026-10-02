import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qk } from '../lib/api';
import { useSession } from '../lib/session';
import { play } from '../lib/sound';
import { Btn, Chip } from './Bits';
import { Icon } from './Icon';

interface Unaccepted {
  id: string; ref: string; title: string; priority: string;
  assigned_at: string | null; respond_by: string | null;
}

/**
 * How often it asks again, by how much the job matters.
 *
 * A P1 is somebody standing in a dark lobby. A P4 is a scheduled job that can wait for
 * the person to look up. Ringing at one cadence for both teaches the department that the
 * sound means nothing, which is the failure this whole feature exists to prevent.
 */
const EVERY_MS: Record<string, number> = {
  P1: 45_000,
  P2: 150_000,
  P3: 600_000,
  P4: 1_800_000,
};

/**
 * Work handed to you that you have not picked up — and the sound that keeps asking.
 *
 * Being told once is not enough when the phone is in a pocket and the chime happened
 * while it was in a toolbag. So it asks again, on a cadence set by the priority, until
 * the job is accepted, moved to somebody else, or cancelled.
 *
 * Two deliberate limits, both to keep this from becoming the thing people silence:
 *
 *  - **It stops at the response deadline.** Past that the job escalates to a team lead
 *    and then a supervisor — a human who can ring a phone, walk to a riser, or send
 *    somebody else. A tablet that rings all night is a tablet in a drawer by morning, and
 *    the escalation is a better answer than volume.
 *  - **Snooze is ten minutes and says so.** Somebody with their hands inside a panel
 *    cannot accept a job, and refusing them any relief at all is how a system earns
 *    contempt. The banner stays; only the noise pauses.
 */
export function Outstanding() {
  const { can } = useSession();
  const qc = useQueryClient();
  const [snoozedUntil, setSnoozedUntil] = useState(0);
  const lastPlayed = useRef<Record<string, number>>({});

  // Only people who are handed work. A supervisor's own board is not a dispatch queue.
  const enabled = can('wo.accept');

  const q = useQuery<{ unaccepted: Unaccepted[] }>({
    queryKey: ['outstanding'],
    queryFn: () => api.get('/api/me/outstanding'),
    enabled,
    // The live stream drives this; the interval is the floor under a dead connection.
    refetchInterval: 120_000,
    refetchOnWindowFocus: true,
  });

  const accept = useMutation({
    mutationFn: (id: string) => api.post(`/api/jobs/${id}/accept`),
    onSuccess: async () => {
      play('done');
      await qc.invalidateQueries({ queryKey: ['outstanding'] });
      await qc.invalidateQueries({ queryKey: qk.jobs('board') });
    },
  });

  const jobs = q.data?.unaccepted ?? [];

  useEffect(() => {
    if (!enabled || jobs.length === 0) return;
    const tick = (): void => {
      if (Date.now() < snoozedUntil) return;
      const now = Date.now();
      for (const j of jobs) {
        // Past the response deadline the job is a person's problem, not a chime's.
        if (j.respond_by && new Date(j.respond_by).getTime() < now) continue;
        const every = EVERY_MS[j.priority] ?? EVERY_MS.P3!;
        const last = lastPlayed.current[j.id] ?? 0;
        if (now - last < every) continue;
        lastPlayed.current[j.id] = now;
        play(j.priority === 'P1' ? 'urgent' : 'notify');
        // One sound per round however many are waiting: four jobs arriving together
        // should not produce four overlapping alarms.
        return;
      }
    };
    tick();
    const timer = setInterval(tick, 15_000);
    return () => clearInterval(timer);
  }, [jobs, enabled, snoozedUntil]);

  // Forget jobs that have gone, so one that comes back later rings again rather than
  // being suppressed by a timestamp from an hour ago.
  useEffect(() => {
    const live = new Set(jobs.map((j) => j.id));
    for (const id of Object.keys(lastPlayed.current)) {
      if (!live.has(id)) delete lastPlayed.current[id];
    }
  }, [jobs]);

  if (!enabled || jobs.length === 0) return null;

  const worst = jobs.some((j) => j.priority === 'P1') ? 'P1' : jobs[0]!.priority;
  const snoozed = Date.now() < snoozedUntil;

  return (
    <div className={`waiting ${worst === 'P1' ? 'p1' : ''}`} role="alert">
      <span className="wicon"><Icon name="alert" size={18} /></span>
      <div className="wbody">
        <b>{jobs.length === 1 ? 'A job is waiting for you' : `${jobs.length} jobs are waiting for you`}</b>
        <ul>
          {jobs.slice(0, 3).map((j) => (
            <li key={j.id}>
              <Chip tone={j.priority === 'P1' ? 'crit' : j.priority === 'P2' ? 'warn' : ''}>
                {j.priority}
              </Chip>
              <Link to={`/jobs/${j.id}`}>{j.title}</Link>
              <span className="sub">{j.ref}</span>
              <Btn size="sm" tone="pri" disabled={accept.isPending}
                   onClick={() => accept.mutate(j.id)}>Accept</Btn>
            </li>
          ))}
          {jobs.length > 3 && <li className="sub">and {jobs.length - 3} more on your board</li>}
        </ul>
      </div>
      <div className="wact">
        {snoozed
          ? <span className="sub">Quiet for{' '}
              {Math.max(1, Math.round((snoozedUntil - Date.now()) / 60_000))} min</span>
          : <Btn size="sm" onClick={() => setSnoozedUntil(Date.now() + 600_000)}>
              Quiet for 10 min
            </Btn>}
      </div>
    </div>
  );
}

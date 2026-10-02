import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Icon } from './Icon';
import { Chip } from './Bits';

export interface Step {
  key: string; title: string; why: string;
  state: 'done' | 'todo' | 'attention';
  detail: string | null; to: string; essential: boolean; needs: string;
}
export interface Progress {
  ready: boolean; doneCount: number; totalCount: number; essentialRemaining: number;
  steps: Step[]; visibleCount: number; canAct: boolean;
}

const KEY = 'ff-starthere-hidden';

/**
 * The panel a fresh install opens on.
 *
 * Eleven admin tabs and no opinion about which to open is how a system that works ends
 * up unused. This says what is missing, why it matters, and where to go — in the order
 * the software actually requires, because staff really do have to exist before anybody
 * can be given a job.
 *
 * It only ever shows steps the reader could act on, so a technician never sees a list of
 * things only an administrator can do. Once nothing essential is left it collapses to a
 * line: a checklist that keeps shouting after it is finished is one people stop reading.
 */
export function StartHere({ compact }: { compact?: boolean }) {
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(KEY) === 'yes'; } catch { return false; }
  });

  const q = useQuery<Progress>({
    queryKey: ['setup-progress'],
    queryFn: () => api.get('/api/setup/progress'),
    // Cheap, and it has to notice the moment somebody finishes a step in another tab.
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  const d = q.data;
  if (!d || !d.canAct) return null;

  const todo = d.steps.filter((s) => s.state !== 'done');
  const essentialLeft = d.steps.filter((s) => s.essential && s.state !== 'done');
  const finished = todo.length === 0;

  // Nothing left to do, and they have said they do not want the summary line either.
  if (finished && dismissed) return null;

  const pct = Math.round((d.doneCount / Math.max(1, d.totalCount)) * 100);

  if (finished || compact) {
    return (
      <div className="startcard">
        <div className="starthead" style={{ borderBottom: 0 }}>
          <span className="tick" style={{ width: 20, height: 20, borderRadius: '50%',
                 background: finished ? 'var(--ok)' : 'var(--accent)', color: '#fff',
                 display: 'grid', placeItems: 'center', flex: 'none' }}>
            <Icon name="check" size={12} />
          </span>
          <h2>{finished ? 'Set up and running' : 'Setting up'}</h2>
          <span className="r">
            <span className="progress" aria-hidden="true">
              <i className={finished ? 'done' : ''} style={{ width: `${pct}%` }} />
            </span>
            <Chip tone={finished ? 'ok' : ''}>{d.doneCount} of {d.totalCount}</Chip>
            {!finished && <Link className="btn sm" to="/admin?tab=start">Finish setup</Link>}
            {finished && (
              <button className="btn sm" onClick={() => {
                setDismissed(true);
                try { localStorage.setItem(KEY, 'yes'); } catch { /* private mode */ }
              }}>Hide</button>
            )}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className={`startcard ${essentialLeft.length ? 'urgent' : ''}`}>
      <div className="starthead">
        <h2>Start here</h2>
        <span className="r">
          <span className="progress" aria-hidden="true"><i style={{ width: `${pct}%` }} /></span>
          <Chip>{d.doneCount} of {d.totalCount}</Chip>
        </span>
        <span className="sub">
          {essentialLeft.length > 0
            ? <>Until these are done, <b>jobs cannot be assigned to anybody</b>. Work down the list —
                each one takes a few minutes.</>
            : <>The essentials are in place. What is left unlocks a module each, in whatever order
                suits the department.</>}
        </span>
      </div>

      <ul className="steps">
        {d.steps.map((s) => (
          <li key={s.key}
              className={s.state === 'done' ? 'is-done' : s.state === 'attention' ? 'is-attention' : ''}>
            <span className="tick">
              {s.state === 'done' ? <Icon name="check" size={12} />
                : s.state === 'attention' ? <Icon name="alert" size={12} /> : null}
            </span>
            <span className="ttl">
              {s.title}
              {s.detail && <span className="sub" style={{ fontWeight: 400 }}>{s.detail}</span>}
              {s.essential && s.state !== 'done' && <Chip tone="crit">needed</Chip>}
            </span>
            {s.state !== 'done' && <span className="why">{s.why}</span>}
            <span className="go">
              {s.state === 'done'
                ? <Link className="btn sm" to={s.to}>Review</Link>
                : <Link className="btn sm pri" to={s.to}>Open</Link>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

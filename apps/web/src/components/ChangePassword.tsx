import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, qk } from '../lib/api';
import { useSession } from '../lib/session';
import { Btn, Modal } from './Bits';
import { LogoTile } from './Logo';

const MIN = 10;

/**
 * Two ways in, one form.
 *
 * `forced` is the wall a new account hits on its first sign-in. Every account is created
 * with a temporary password somebody else chose and typed — into a chat message, onto a
 * sticky note, out loud across the plant room — so until it is changed the audit trail is
 * a guess about who did what. The Users tab promises this happens; this is what keeps the
 * promise. It cannot be dismissed, because an administrator who could skip it would.
 *
 * `forced={false}` is the same form reached from the sidebar by somebody who simply wants
 * to change their password, which until now was impossible without asking an
 * administrator to reset it — and a reset is visible, logged, and hands your new password
 * to a third person.
 */
export function ChangePassword({ forced, onClose }: { forced?: boolean; onClose?: () => void }) {
  const qc = useQueryClient();
  const { me } = useSession();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [done, setDone] = useState(false);

  const save = useMutation({
    mutationFn: () => api.post('/api/auth/password', { currentPassword: current, newPassword: next }),
    onSuccess: async () => {
      setDone(true);
      // The session's mustChangePassword flag is what this screen is gating on.
      await qc.invalidateQueries({ queryKey: qk.me });
      if (!forced) onClose?.();
    },
  });

  const err = save.error as ApiError | null;
  const mismatch = again.length > 0 && next !== again;
  const reused = next.length > 0 && next === current;
  const ready = current.length > 0 && next.length >= MIN && next === again && !reused;

  const body = (
    <>
      {forced && (
        <div className="note warn" style={{ marginBottom: 14 }}>
          <b>Choose your own password before you start.</b>
          <div style={{ marginTop: 5 }}>
            The one you signed in with was typed by somebody else, so until you change it the
            audit log cannot honestly say that a job was closed by you.
          </div>
        </div>
      )}

      <div className="fld"><label htmlFor="cp-cur">
        {forced ? 'The password you were given' : 'Current password'}</label>
        <input id="cp-cur" className="inp" type="password" autoComplete="current-password" autoFocus
               value={current} onChange={(e) => setCurrent(e.target.value)} /></div>

      <div className="fld"><label htmlFor="cp-new">New password</label>
        <input id="cp-new" className="inp" type="password" autoComplete="new-password"
               value={next} onChange={(e) => setNext(e.target.value)} />
        <p className="sub" style={{ marginTop: 5, whiteSpace: 'normal' }}>
          At least {MIN} characters. Length beats punctuation — three unrelated words you will
          actually remember beat one word with a digit stuck on the end.
        </p></div>

      <div className="fld"><label htmlFor="cp-again">New password again</label>
        <input id="cp-again" className="inp" type="password" autoComplete="new-password"
               value={again} onChange={(e) => setAgain(e.target.value)} />
        {mismatch && <p className="sub" style={{ marginTop: 5, color: 'var(--crit)' }}>
          These two do not match.</p>}
        {reused && <p className="sub" style={{ marginTop: 5, color: 'var(--crit)' }}>
          That is the password you are replacing.</p>}
      </div>

      {err && <div className="note crit" style={{ marginBottom: 12 }} role="alert">{err.message}</div>}

      <div className="note" style={{ marginBottom: 12 }}>
        Saving signs you out on every other device — a tablet left signed in on the floor
        stops being your account the moment you do this.
      </div>

      <Btn tone="pri" style={{ width: '100%' }} disabled={!ready || save.isPending}
           onClick={() => save.mutate()}>
        {save.isPending ? 'Saving…' : 'Change password'}
      </Btn>
      {!forced && (
        <Btn style={{ width: '100%', marginTop: 8 }} onClick={onClose}>Cancel</Btn>
      )}
    </>
  );

  // The forced version is not a dialog: there is nothing behind it to go back to, and a
  // modal with no way out is a trap that looks like a mistake.
  if (forced) {
    return (
      <div className="center">
        <div className="panel-form">
          <div className="brand" style={{ padding: 0, border: 0, marginBottom: 18 }}>
            <LogoTile size={34} />
            <span><b>{me?.user.displayName ?? 'FacilityFlow'}</b>
              <small>{me?.user.roleName ?? 'Maintenance & FM'}</small></span>
          </div>
          {done
            ? <div className="note" role="status">Password changed. Loading your screens…</div>
            : body}
        </div>
      </div>
    );
  }

  return <Modal title="Change your password" onClose={onClose ?? (() => {})}>{body}</Modal>;
}

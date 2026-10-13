/** Admin → Snapshots, the second copy off this PC, and restoring one. */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { useSession } from '../../lib/session';
import { when } from '../../lib/format';
import { humanBytes } from '../../lib/image';
import { Card, Chip, Loading, Empty, Btn, DownloadLink, Modal, Field } from '../../components/Bits';

interface BackupFile { file: string; bytes: number; at: string }

export function Backups() {
  const qc = useQueryClient();
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [restoring, setRestoring] = useState<BackupFile | null>(null);

  const backups = useQuery<{ directory: string; keep: number; pending: boolean;
                             backups: BackupFile[]; mirror: MirrorInfo }>({
    queryKey: ['admin-backups'], queryFn: () => api.get('/api/admin/backups'),
    // While a copy runs, watch it finish.
    refetchInterval: (q) => (q.state.data?.mirror.running ? 3000 : false),
  });
  const run = useMutation({
    mutationFn: () => api.post('/api/admin/backup'),
    onSuccess: async (r) => {
      const res = r as { bytes: number; integrity: string };
      setMsg({ text: `Backup written and verified — ${humanBytes(res.bytes)}, integrity ${res.integrity}.` });
      await qc.invalidateQueries({ queryKey: ['admin-backups'] });
    },
    onError: (e) => setMsg({ text: (e as ApiError).message, bad: true }),
  });
  const cancel = useMutation({
    mutationFn: () => api.del('/api/admin/restore'),
    onSuccess: async () => {
      setMsg({ text: 'Staged restore cancelled. The server will come back up on the current database.' });
      await qc.invalidateQueries({ queryKey: ['admin-backups'] });
    },
    onError: (e) => setMsg({ text: (e as ApiError).message, bad: true }),
  });

  return (
    <>
      {msg && <div className={`note ${msg.bad ? 'crit' : ''} mb-6`} role="status">{msg.text}</div>}

      {backups.data?.pending && (
        <div className="note crit mb-6">
          <b>A restore is staged and waiting.</b> The next time this server restarts it will
          come up on that snapshot instead of the current database. Nothing has changed yet.
          <div className="mt-5">
            <Btn size="sm" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
              Cancel the restore
            </Btn>
          </div>
        </div>
      )}

      <Card title="Snapshots" flush
            right={<Btn size="sm" tone="pri" disabled={run.isPending}
                        onClick={() => run.mutate()}>{run.isPending ? 'Running…' : 'Back up now'}</Btn>}>
        {backups.isLoading ? <Loading rows={3} />
          : (backups.data?.backups.length ?? 0) === 0
            ? <Empty title="No snapshots yet" hint="Run one now, then download it and keep it elsewhere." />
            : (
              <div className="tw">
                <table className="wide">
                  <thead><tr><th>Taken</th><th className="num">Size</th><th /></tr></thead>
                  <tbody>
                    {backups.data!.backups.map((b) => (
                      <tr key={b.file}>
                        <td><span className="ttl">{when(b.at)}</span>
                            <span className="sub mono">{b.file}</span></td>
                        <td className="num">{humanBytes(b.bytes)}</td>
                        <td className="num nw">
                          <DownloadLink href={`/api/admin/backups/${encodeURIComponent(b.file)}`}
                                        aria-label={`Download ${b.file}`}>Download</DownloadLink>
                          <Btn className="ml-3" size="sm" tone="danger"
                               onClick={() => setRestoring(b)}>Restore</Btn>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
      </Card>

      {backups.data && <SecondCopy mirror={backups.data.mirror} keep={backups.data.keep} />}

      <div className="note warn mt-6">
        Keeping the last {backups.data?.keep ?? 14} in <code>{backups.data?.directory ?? 'the data folder'}</code>.
        Every snapshot is reopened and integrity-checked as it is written.
        <b> Download one and keep it somewhere other than this PC.</b> A snapshot on the same
        disk as the database survives a mistake, but not a dead machine, a theft or a fire —
        and those are the cases the department actually needs to survive.
      </div>

      {restoring && (
        <RestoreDialog backup={restoring} onClose={() => setRestoring(null)}
                       onDone={async (text) => {
                         setRestoring(null); setMsg({ text });
                         await qc.invalidateQueries({ queryKey: ['admin-backups'] });
                       }} />
      )}
    </>
  );
}

interface MirrorInfo {
  folder: string | null;
  running: boolean;
  last: { at: string; ok: boolean; message: string; photosThere: number } | null;
}

/**
 * The copy that survives this PC.
 *
 * Every snapshot above sits on the same disk as the database, and none of them hold the
 * photographs. A folder named here — a USB drive left in the PC, a share on another
 * machine — gets the newest snapshot and every attachment, once a day, on its own.
 */
function SecondCopy({ mirror, keep }: { mirror: MirrorInfo; keep: number }) {
  const qc = useQueryClient();
  const { can } = useSession();
  const [folder, setFolder] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const done = async (text: string) => {
    setMsg({ text });
    setFolder(null);
    await qc.invalidateQueries({ queryKey: ['admin-backups'] });
  };
  const save = useMutation({
    mutationFn: (next: string | null) =>
      api.put<{ message: string }>('/api/admin/backups/mirror', { folder: next }),
    onSuccess: (r) => done(r.message),
    onError: (e) => setMsg({ text: (e as ApiError).message, bad: true }),
  });
  const run = useMutation({
    mutationFn: () => api.post<{ message: string }>('/api/admin/backups/mirror/run'),
    onSuccess: (r) => done(r.message),
    onError: (e) => setMsg({ text: (e as ApiError).message, bad: true }),
  });
  const value = folder ?? mirror.folder ?? '';

  return (
    <Card title="A second copy, off this PC" className="mt-6"
          right={mirror.folder && (
            <Btn size="sm" disabled={run.isPending || mirror.running} onClick={() => run.mutate()}>
              {mirror.running ? 'Copying…' : 'Copy now'}
            </Btn>
          )}>
      {msg && <div className={`note ${msg.bad ? 'crit' : ''} mb-5`} role="status">{msg.text}</div>}
      <Field label="Folder"
             hint={`A USB drive or a share on another machine. Gets the newest snapshot and every photo once a day, and keeps the last ${keep} snapshots.`}>
        <input className="inp mono" placeholder="e.g. E:\FacilityFlow or \\NAS\backups"
               value={value} disabled={!can('admin.settings.manage')}
               onChange={(e) => setFolder(e.target.value)} />
      </Field>
      {can('admin.settings.manage') && (
        <div className="mt-4">
          <Btn size="sm" tone="pri" disabled={save.isPending || folder === null}
               onClick={() => save.mutate(value.trim() || null)}>Save</Btn>
          {mirror.folder && (
            <Btn className="ml-3" size="sm" disabled={save.isPending}
                 onClick={() => save.mutate(null)}>Stop copying</Btn>
          )}
        </div>
      )}
      {mirror.folder && (
        <p className="t-sm mt-5 mb-0">
          {mirror.running ? 'Copying now…'
            : mirror.last
              ? <>
                  <Chip tone={mirror.last.ok ? 'ok' : 'crit'}>{mirror.last.ok ? 'copied' : 'failed'}</Chip>{' '}
                  {when(mirror.last.at)} — {mirror.last.message}
                  {mirror.last.ok && ` ${mirror.last.photosThere} file${mirror.last.photosThere === 1 ? '' : 's'} in the copy.`}
                </>
              : 'Not copied yet.'}
        </p>
      )}
      {!mirror.folder && (
        <p className="t-sm c-3 mt-5 mb-0">
          No second copy is set. Until there is one, a dead disk, a theft or a fire takes every
          record and every photo with it.
        </p>
      )}
    </Card>
  );
}

/**
 * Restoring replaces every record the department has, so it asks for the word rather than
 * a second button. Nothing happens on the live database here — the snapshot is staged and
 * applied on the next restart.
 */
function RestoreDialog({ backup, onClose, onDone }: {
  backup: BackupFile; onClose: () => void; onDone: (msg: string) => void;
}) {
  const [typed, setTyped] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const stage = useMutation({
    mutationFn: () => api.post<{ safetyCopy: string; integrity: string }>(
      '/api/admin/restore', { file: backup.file, confirm: 'RESTORE' }),
    onSuccess: (r) => onDone(
      `Restore staged from ${backup.file}. Restart the server to apply it. `
      + `The database as it stands right now was saved to ${r.safetyCopy}.`),
    onError: (e) => setErr((e as ApiError).message),
  });

  return (
    <Modal title="Restore this snapshot" onClose={onClose}>
      {err && <div className="note crit mb-6" role="alert">{err}</div>}

      <dl className="kv mb-6">
        <dt>Snapshot</dt><dd className="mono">{backup.file}</dd>
        <dt>Taken</dt><dd>{when(backup.at)}</dd>
        <dt>Size</dt><dd>{humanBytes(backup.bytes)}</dd>
      </dl>

      <div className="note crit">
        <b>Every job, reading, photo record and audit entry made since {when(backup.at)} will be
        gone.</b> The database as it stands now is copied to the backups folder first, so this
        is reversible — but only if somebody notices.
      </div>

      <div className="note mt-5">
        The snapshot is integrity-checked before it is staged, and applied on the next
        restart rather than swapped underneath the running server. Nothing changes until
        you restart.
      </div>

      <Field label="Type RESTORE to confirm">
        <input className="inp" value={typed} autoFocus autoComplete="off"
               placeholder="RESTORE" onChange={(e) => setTyped(e.target.value)} />
      </Field>

      <div className="modal-foot">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn tone="danger" disabled={typed !== 'RESTORE' || stage.isPending}
             onClick={() => stage.mutate()}>
          {stage.isPending ? 'Staging…' : 'Stage the restore'}
        </Btn>
      </div>
    </Modal>
  );
}

import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { prepareForUpload, humanBytes } from '../lib/image';
import { when } from '../lib/format';
import { Card, Chip, Empty } from './Bits';
import { Icon } from './Icon';

interface Attachment {
  id: string; filename: string; mime: string; bytes: number;
  created_at: string; uploaded_by_name: string | null;
}

/**
 * Capture uses a file input with `capture`, not getUserMedia. The camera API needs a
 * secure origin and the host is reached over plain HTTP on a LAN address, so
 * getUserMedia works on a developer laptop at localhost and fails on every phone.
 */
export function Photos({ entityType, entityId, canUpload, title = 'Photos' }:
  { entityType: string; entityId: string; canUpload: boolean; title?: string }) {
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Attachment | null>(null);

  const key = ['attachments', entityType, entityId];
  const list = useQuery<{ attachments: Attachment[] }>({
    queryKey: key,
    queryFn: () => api.get(`/api/attachments?entityType=${entityType}&entityId=${entityId}`),
  });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      setError(null);
      setStatus('Preparing…');
      const prepared = await prepareForUpload(file);
      setStatus(prepared.bytes < prepared.originalBytes
        ? `Uploading ${humanBytes(prepared.bytes)} (from ${humanBytes(prepared.originalBytes)})…`
        : `Uploading ${humanBytes(prepared.bytes)}…`);

      const form = new FormData();
      form.append('entityType', entityType);
      form.append('entityId', entityId);
      form.append('file', prepared.blob, prepared.filename);

      const res = await fetch('/api/attachments', { method: 'POST', body: form, credentials: 'same-origin' });
      const text = await res.text();
      const data = text ? JSON.parse(text) : {};
      if (!res.ok) throw new ApiError(res.status, String(data.error), String(data.message ?? 'Upload failed.'));
      return data as Attachment;
    },
    onSuccess: async () => {
      setStatus(null);
      await qc.invalidateQueries({ queryKey: key });
      if (entityType === 'work_order') await qc.invalidateQueries({ queryKey: ['job', entityId] });
    },
    onError: (e) => { setStatus(null); setError((e as ApiError).message); },
  });

  const photos = list.data?.attachments ?? [];

  return (
    <Card className="no-print" title={title}
          right={<Chip>{photos.length} file{photos.length === 1 ? '' : 's'}</Chip>}>
      {photos.length === 0 && !canUpload
        ? <Empty title="No photos yet" />
        : (
          <div className="photos">
            {photos.map((a) => (
              <button key={a.id} className="photo" onClick={() => setPreview(a)}
                      title={`${a.filename} · ${humanBytes(a.bytes)}`}>
                {a.mime.startsWith('image/')
                  ? <img src={`/api/attachments/${a.id}`} alt={a.filename} loading="lazy" />
                  : <Icon name="clip" />}
                <span>{when(a.created_at).slice(0, 6)}</span>
              </button>
            ))}
            {canUpload && (
              <button className="photo add" onClick={() => inputRef.current?.click()}
                      disabled={upload.isPending}>
                <Icon name="cam" />
                <span>{upload.isPending ? 'Working' : 'Add'}</span>
              </button>
            )}
          </div>
        )}

      <input ref={inputRef} type="file" accept="image/*,application/pdf" capture="environment"
             style={{ display: 'none' }}
             onChange={(e) => {
               const f = e.target.files?.[0];
               if (f) upload.mutate(f);
               e.target.value = '';
             }} />

      {status && <p className="sub" style={{ marginTop: 10 }}>{status}</p>}
      {error && <div className="note crit" style={{ marginTop: 10 }} role="alert">{error}</div>}
      {canUpload && !status && !error && (
        <p className="sub" style={{ marginTop: 10, whiteSpace: 'normal' }}>
          Photos are resized to {1600}px before upload, so they move quickly on the office wifi.
        </p>
      )}

      {preview && (
        <div className="lightbox" role="dialog" aria-label={preview.filename}
             onClick={() => setPreview(null)}>
          <img src={`/api/attachments/${preview.id}`} alt={preview.filename} />
          <div className="lb-bar">
            <span>{preview.filename} · {humanBytes(preview.bytes)}
              {preview.uploaded_by_name ? ` · ${preview.uploaded_by_name}` : ''}</span>
            <button className="btn sm" onClick={() => setPreview(null)}>Close</button>
          </div>
        </div>
      )}
    </Card>
  );
}

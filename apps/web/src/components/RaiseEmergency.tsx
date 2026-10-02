import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qk, ApiError } from '../lib/api';
import { Modal, Field, Btn } from './Bits';

/**
 * Raising an emergency alert.
 *
 * A button that takes over every screen in the building needs a moment of friction, and
 * the right friction is not "are you sure" — it is being made to say **what** and
 * **where**, because that is what the people receiving it need in order to act. A
 * confirmation dialog teaches people to click through; a form that asks a useful question
 * does not.
 */

const CATEGORIES = [
  { key: 'fire', label: 'Fire', hint: 'Smoke, flame, alarm sounding' },
  { key: 'power', label: 'Power', hint: 'Total loss, or a set that will not start' },
  { key: 'water', label: 'Water', hint: 'Flood, burst, pump failure' },
  { key: 'security', label: 'Security', hint: 'Intrusion, threat, lockdown' },
  { key: 'medical', label: 'Medical', hint: 'Injury, collapse, first aid needed' },
  { key: 'other', label: 'Other', hint: 'Anything else the whole team must know now' },
] as const;

interface Place { id: string; name: string }

export function RaiseEmergency({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [category, setCategory] = useState<string>('');
  const [message, setMessage] = useState('');
  const [locationId, setLocationId] = useState('');

  const places = useQuery<{ locations: Place[] }>({
    queryKey: qk.locations, queryFn: () => api.get('/api/locations'),
  });

  const raise = useMutation({
    mutationFn: () => api.post<{ reached: number; message: string }>('/api/alerts/emergency', {
      category, message: message.trim(), locationId: locationId || undefined,
    }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.emergency });
      onClose();
    },
  });
  const err = raise.error as ApiError | null;
  const ready = !!category && message.trim().length >= 3;

  return (
    <Modal title="Alert everybody" onClose={onClose}>
      <div className="note warn" style={{ marginBottom: 14 }}>
        This takes over the screen of <b>every person signed in</b> and every paired phone,
        sounds on repeat until it is acknowledged, and ignores anybody's sound setting. It
        stays up until somebody stands it down.
      </div>

      <p className="eyebrow" style={{ marginBottom: 8 }}>What kind</p>
      <div className="emgpick">
        {CATEGORIES.map((c) => (
          <button key={c.key} type="button"
                  className={`emgopt ${category === c.key ? 'on' : ''}`}
                  onClick={() => setCategory(c.key)}>
            <b>{c.label}</b>
            <small>{c.hint}</small>
          </button>
        ))}
      </div>

      <Field label="What is happening"
             hint="One line, written for somebody reading it on a phone while walking.">
        <input className="inp" autoFocus value={message} maxLength={300}
               placeholder="e.g. Fire alarm sounding in Block C, evacuating now"
               onChange={(e) => setMessage(e.target.value)} />
      </Field>

      <Field label="Where" hint="Optional, but it is the first thing people will ask.">
        <select className="inp" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
          <option value="">Not specified</option>
          {(places.data?.locations ?? []).map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>))}
        </select>
      </Field>

      {err && <div className="note crit" style={{ marginBottom: 12 }} role="alert">{err.message}</div>}

      <div className="modal-foot">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn tone="pri" icon="alert" disabled={!ready || raise.isPending}
             onClick={() => raise.mutate()}>
          {raise.isPending ? 'Sending…' : 'Alert everybody now'}
        </Btn>
      </div>
    </Modal>
  );
}

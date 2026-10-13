/** Admin → Shift patterns the roster is built from. */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { Card, Chip, Loading, Empty, Btn } from '../../components/Bits';

export function Shifts() {
  const qc = useQueryClient();
  const [f, setF] = useState({ name: '', startTime: '06:00', endTime: '14:00' });
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);

  const patterns = useQuery<{ patterns: { id: string; name: string; start_time: string;
                                          end_time: string; crosses_midnight: number }[] }>({
    queryKey: ['patterns'], queryFn: () => api.get('/api/shift-patterns'),
  });
  const add = useMutation({
    mutationFn: () => api.post('/api/shift-patterns', f),
    onSuccess: async (r) => {
      const res = r as { crossesMidnight: boolean };
      setMsg({ text: `${f.name} added${res.crossesMidnight ? ' — detected as crossing midnight.' : '.'}` });
      setF({ name: '', startTime: '06:00', endTime: '14:00' });
      await qc.invalidateQueries({ queryKey: ['patterns'] });
    },
    onError: (e) => setMsg({ text: (e as ApiError).message, bad: true }),
  });

  return (
    <>
      {msg && <div className={`note ${msg.bad ? 'crit' : ''} mb-6`} role="status">{msg.text}</div>}
      <div className="grid g21">
        <Card title="Shift patterns" flush>
          {patterns.isLoading ? <Loading rows={3} />
            : (patterns.data?.patterns.length ?? 0) === 0 ? <Empty title="No shifts defined yet" />
            : (
              <table>
                <tbody>
                  {patterns.data!.patterns.map((p) => (
                    <tr key={p.id}>
                      <td><span className="ttl">{p.name}</span>
                          <span className="sub">{p.start_time}–{p.end_time}</span></td>
                      <td className="tar">
                        {p.crosses_midnight ? <Chip tone="acc">Crosses midnight</Chip> : <Chip>Same day</Chip>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </Card>

        <Card title="Add a pattern">
          <div className="fld"><label>Name</label>
            <input className="inp" value={f.name} placeholder="Morning"
                   onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <div className="grid g2 gap-5">
            <div className="fld"><label>Starts</label>
              <input className="inp" type="time" value={f.startTime}
                     onChange={(e) => setF({ ...f, startTime: e.target.value })} /></div>
            <div className="fld"><label>Ends</label>
              <input className="inp" type="time" value={f.endTime}
                     onChange={(e) => setF({ ...f, endTime: e.target.value })} /></div>
          </div>
          <Btn full tone="pri" disabled={f.name.length < 2 || add.isPending}
               onClick={() => add.mutate()}>{add.isPending ? 'Adding…' : 'Add pattern'}</Btn>
          <p className="sub mt-5 wrap">
            Any number of patterns, any times. An end time earlier than the start is detected as
            crossing midnight — nothing about morning, afternoon or night is built in.
          </p>
        </Card>
      </div>
    </>
  );
}

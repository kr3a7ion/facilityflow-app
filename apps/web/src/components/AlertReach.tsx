/** Who can actually hear an alert: every browser and paired phone, and what is wrong with each. */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { when } from '../lib/format';
import { Card, Chip, Loading, Btn } from './Bits';

type Problem = 'volume_off' | 'battery_saver' | 'notifications_off' | 'no_full_screen' | 'volume_low';

interface Reach {
  id: string; display_name: string; username: string; role_name: string;
  may_silence: number; devices: number; listening: number; muted: number;
  last_seen: string | null;
  phones: number; phones_live: number; phone_last_seen: string | null;
  /** What the phone this person is most likely to hear last said about itself. */
  phone: {
    app_version: string | null; checked_at: string | null;
    alarm_volume: number | null; problems: Problem[];
  } | null;
  state: 'phone' | 'phone_silent' | 'phone_offline' | 'unreported' | 'muted' | 'listening' | 'not_ready';
}

/** What each problem means for the person holding the phone, in the order the server ranks them. */
function problemText(p: Problem, volume: number | null): string {
  switch (p) {
    case 'volume_off': return 'Alarm volume is off — it will only vibrate';
    case 'battery_saver': return 'Battery saver may stop the app';
    case 'notifications_off': return 'Notifications blocked — no Accept button';
    case 'no_full_screen': return 'Will not light up the screen';
    case 'volume_low': return `Alarm volume is low (${volume ?? 0}%)`;
  }
}

/**
 * Who can actually be reached.
 *
 * The alert sound lives in each browser's own storage, so before this the department had
 * no way to know whether a technician's phone would make a noise when a P1 landed on it.
 * A tablet sitting silently in the plant room looked exactly like a tablet that was
 * listening.
 *
 * Three silences, kept apart because they need different answers: an account that has
 * never signed in anywhere, one whose browser will not play audio until somebody touches
 * it, and one that was deliberately switched off by somebody entitled to. A paired phone
 * adds two more: one that has stopped holding its connection, and one that holds it with
 * its alarm volume at zero.
 *
 * It sits on the Users tab and on the roster, because the person who needs it is the
 * supervisor or team lead about to hand somebody a job, and they cannot open Admin.
 */
export function AlertReach() {
  const [open, setOpen] = useState(false);
  const q = useQuery<{ people: Reach[]; scope: 'team' | 'all' }>({
    queryKey: ['alert-reach'], queryFn: () => api.get('/api/admin/alerts'), enabled: open,
  });

  const people = q.data?.people ?? [];
  const problems = people.filter((p) =>
    p.state === 'muted' || p.state === 'not_ready' || p.state === 'phone_offline'
    || p.state === 'phone_silent');

  return (
    <Card title={q.data?.scope === 'team' ? 'Who in your team can hear an alert' : 'Who can hear an alert'} flush
          right={<Btn size="sm" onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide' : 'Check'}
          </Btn>}>
      {!open ? (
        <div className="note m-5">
          Alert sounds are set on each device, so this is the only way to see whether a phone
          will actually make a noise when a job lands on it. Technicians and team leads
          cannot turn theirs off — everybody else can.
        </div>
      ) : q.isLoading ? <Loading rows={4} /> : (
        <>
          {problems.length > 0 && (
            <div className="note warn m-5">
              <b>{problems.length} {problems.length === 1 ? 'account' : 'accounts'} may not hear you.</b>
              {' '}Ring them rather than assuming the chime did its job.
            </div>
          )}
          <div className="tw">
            <table className="wide">
              <thead><tr><th>Name</th><th>Role</th><th>Alerts</th>
                         <th className="num">Devices</th><th>Last seen</th></tr></thead>
              <tbody>
                {people.map((p) => (
                  <tr key={p.id}>
                    <td><span className="ttl">{p.display_name}</span>
                        <span className="sub">{p.username}</span></td>
                    <td>{p.role_name}
                        {p.may_silence === 0 && <span className="sub">cannot be silenced</span>}</td>
                    <td>
                      {p.state === 'phone' ? <Chip tone="ok" lamp>Phone will ring</Chip>
                        : p.state === 'phone_silent'
                          ? <Chip tone="crit" lamp>Phone is silent</Chip>
                          : p.state === 'phone_offline'
                            ? <Chip tone="crit" lamp>Phone app not running</Chip>
                            : p.state === 'listening' ? <Chip tone="ok" lamp>Will hear it</Chip>
                              : p.state === 'muted' ? <Chip tone="crit" lamp>Turned off</Chip>
                                : p.state === 'not_ready'
                                  ? <Chip tone="warn" lamp>Screen not touched yet</Chip>
                                  : <Chip>No device yet</Chip>}
                      {p.phone && (p.state === 'phone' || p.state === 'phone_silent') && (
                        p.phone.checked_at === null
                          ? <span className="sub">App too old to say how the phone is set up</span>
                          : p.phone.problems.map((x) => (
                            <span key={x} className="sub">{problemText(x, p.phone!.alarm_volume)}</span>
                          ))
                      )}
                    </td>
                    <td className="num">{p.phones > 0
                      ? <span title={`${p.phones_live} of ${p.phones} phones connected`
                                     + (p.phone?.app_version ? ` · app ${p.phone.app_version}` : '')}>
                          {p.phones_live}/{p.phones} app
                        </span>
                      : p.devices}</td>
                    <td className="mono">{p.last_seen ? when(p.last_seen) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {people.some((p) => p.state === 'phone_offline') && (
            <div className="note crit m-5">
              <b>"Phone app not running" is the one to chase.</b> That person paired a phone,
              so it should be ringing with the screen off — and it has stopped holding its
              connection. Almost always the handset's own battery manager killing it:
              Tecno, Infinix, Xiaomi and Oppo all do this. The fix is on the phone, under
              battery settings, and it is in the manual.
            </div>
          )}
          {people.some((p) => p.state === 'phone_silent') && (
            <div className="note crit m-5">
              <b>"Phone is silent" is connected and listening, and will not be heard.</b> The
              app rings on the phone's <i>alarm</i> volume, so that a phone set to silent
              still rings — and that volume has been turned all the way down. It is under
              Sound in the phone's settings, next to the ringer volume.
            </div>
          )}
          <div className="note m-5">
            <b>"Screen not touched yet"</b> is not somebody ignoring you. A browser refuses to
            play any sound until the page has been tapped at least once since it loaded, so a
            phone in a pocket since this morning is silent whatever its setting says. The bell
            and the job board still show the work — only the noise is missing.
          </div>
        </>
      )}
    </Card>
  );
}

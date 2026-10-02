import { useQuery } from '@tanstack/react-query';
import { api, qk } from '../lib/api';
import { duration, hours, titleCase } from '../lib/format';

/**
 * Every section is optional: the host sends only the parts this person is allowed to
 * see, so a requester gets an object with almost nothing in it rather than a full one
 * the client has to remember to hide.
 */
interface Plant {
  utility?: { state: 'on' | 'off'; since: string | null; minutes: number | null };
  gensets: { tag: string; name: string; status: string; hours: number | null; lastLph: number | null }[];
  tanks: { id: string; name: string; kind: string; litres: number | null; capacity: number;
           pctFull: number | null; belowMinimum: boolean }[];
  openP1?: { total: number; breached: number };
  onShift?: { present: number; scheduled: number; shiftNames: string[] };
  load?: { kw: number | null; kva: number | null; stale: boolean; recommendedTag: string | null;
           worstImbalancePct: number | null };
}

const lampFor = (status: string) =>
  status === 'in_service' ? 'ok' : status === 'faulty' || status === 'under_repair' ? 'crit' : 'idle';
const labelFor = (status: string) =>
  status === 'in_service' ? 'Running' : status === 'standby' ? 'Standby' : titleCase(status);

/**
 * The status strip. It sits above every screen, the way a mimic panel sits above a
 * switchboard: utility, each genset, tank levels, open P1s, who is on the floor.
 */
export function Mimic() {
  const { data } = useQuery<Plant>({
    queryKey: qk.plant,
    queryFn: () => api.get<Plant>('/api/status/plant'),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  if (!data) return <div className="mimic" style={{ height: 51 }} aria-hidden="true" />;

  // Nothing this person may see. On a phone that strip was 51px of blank chrome above
  // every screen, so it goes entirely rather than sitting there empty.
  const empty = !data.utility && !data.openP1 && !data.onShift
    && data.gensets.length === 0 && data.tanks.length === 0;
  if (empty) return null;

  const utilityOff = data.utility?.state === 'off';

  return (
    <div className="mimic" role="status" aria-label="Plant status">
      {data.utility && (
        <div className="mcell">
          <span className="mlab">Utility</span>
          <span className="mval"><i className={`lamp ${utilityOff ? 'crit' : 'ok'}`} />{utilityOff ? 'Off' : 'On'}</span>
          <span className="msub">{utilityOff ? `${duration(data.utility.minutes)} elapsed` : 'no active outage'}</span>
        </div>
      )}

      {data.gensets.map((g) => (
        <div className="mcell" key={g.tag}>
          <span className="mlab">{g.tag}</span>
          <span className="mval">
            <i className={`lamp ${lampFor(g.status)} ${g.status === 'in_service' && utilityOff ? 'live' : ''}`} />
            {labelFor(g.status)}
          </span>
          <span className="msub">
            {hours(g.hours)}{g.lastLph != null ? ` · ${g.lastLph} L/h` : ''}
          </span>
        </div>
      ))}

      {/* The load, next to the sets it decides between. During an outage this is the
          number somebody is walking to the switchroom to find out. */}
      {data.load && (
        <div className="mcell">
          <span className="mlab">Load</span>
          <span className="mval">
            {data.load.worstImbalancePct != null && data.load.worstImbalancePct >= 20 &&
              <i className="lamp warn" />}
            {data.load.kw == null ? '—' : Math.round(data.load.kw)}<em>kW</em>
          </span>
          <span className="msub">
            {data.load.kw == null
              ? (data.load.stale ? 'no current reading' : 'not clamped yet')
              : data.load.recommendedTag
                ? `run ${data.load.recommendedTag}`
                : `${Math.round(data.load.kva ?? 0)} kVA`}
          </span>
        </div>
      )}

      {data.tanks.map((t) => (
        <div className="mcell" key={t.id}>
          <span className="mlab">{t.name}</span>
          <span className="mval">{t.pctFull ?? '—'}<em>%</em></span>
          <span className="minibar">
            <i className={t.belowMinimum ? 'crit' : (t.pctFull ?? 0) < 40 ? 'warn' : ''}
               style={{ width: `${Math.max(0, Math.min(100, t.pctFull ?? 0))}%` }} />
          </span>
        </div>
      ))}

      {data.openP1 && (
        <div className="mcell">
          <span className="mlab">Open P1</span>
          <span className="mval">
            {data.openP1.total > 0 && <i className={`lamp ${data.openP1.breached ? 'crit' : 'warn'}`} />}
            {data.openP1.total}
          </span>
          <span className="msub">{data.openP1.breached} breached</span>
        </div>
      )}

      {data.onShift && (
        <div className="mcell">
          <span className="mlab">On shift</span>
          <span className="mval">{data.onShift.present} <em>of {data.onShift.scheduled}</em></span>
          <span className="msub">{data.onShift.shiftNames.join(' · ') || 'nobody marked present'}</span>
        </div>
      )}
    </div>
  );
}

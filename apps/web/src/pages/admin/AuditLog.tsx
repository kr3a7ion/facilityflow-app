/** Admin → The audit log. */
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { when } from '../../lib/format';
import { useMonth } from '../../lib/month';
import { Card, Chip, Loading, MonthBar } from '../../components/Bits';

export function AuditLog() {
  // The fastest-growing table in the database, and the one nobody ever deletes from.
  // A month at a time is not a nicety here; it is what keeps this screen openable in
  // year three on an office PC.
  const month = useMonth();
  const entries = useQuery<{ entries: { id: string; at: string; actor_name: string | null;
                                        action: string; entity_type: string; ip: string | null }[];
                             truncated: boolean; limit: number }>({
    queryKey: ['admin-audit', month.month],
    queryFn: () => api.get(`/api/admin/audit?limit=300&${month.param}`),
  });
  return (
    <>
      <MonthBar month={month.month} label={month.label} isCurrent={month.isCurrent}
                onStep={month.step} onSet={month.set} onReset={month.reset} />
      {entries.data?.truncated && (
        <div className="note warn mb-6">
          More than {entries.data.limit} entries this month — this is the most recent
          {' '}{entries.data.limit}. Export the month for the whole trail.
        </div>
      )}
      <Card title="Recent activity" flush right={<Chip>Append-only</Chip>}>
        {entries.isLoading ? <Loading rows={5} /> : (
          <div className="tw">
            <table className="wide">
              <thead><tr><th>When</th><th>Who</th><th>Action</th><th>On</th><th className="mono">From</th></tr></thead>
              <tbody>
                {(entries.data?.entries ?? []).map((e) => (
                  <tr key={e.id}>
                    <td className="mono">{when(e.at)}</td>
                    <td>{e.actor_name ?? 'System'}</td>
                    <td className="mono">{e.action}</td>
                    <td className="mono">{e.entity_type}</td>
                    <td className="mono">{e.ip ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <div className="note mt-6">
        The audit table refuses <code>UPDATE</code> and <code>DELETE</code> at the database level, not
        by convention. Nobody — including an administrator — can edit this list.
      </div>
    </>
  );
}

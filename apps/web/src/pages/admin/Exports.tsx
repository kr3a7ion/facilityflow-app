/** Admin → CSV exports. */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { titleCase } from '../../lib/format';
import { useMonth } from '../../lib/month';
import { Card, Loading, Empty, ErrorNote, DownloadLink } from '../../components/Bits';

interface ExportSpec { kind: string; what: string; columns: number; dated: boolean }

/**
 * The server decides what this person may export, so the list here is never a set of
 * buttons that turn out to be forbidden when pressed.
 */
export function Exports() {
  // Whole-history by default, because an export is usually going into a pivot table.
  // A month is a deliberate choice, and when it is made the filename says so.
  const [scoped, setScoped] = useState(false);
  const month = useMonth();
  const q = useQuery<{ exports: ExportSpec[] }>({
    queryKey: ['exports'], queryFn: () => api.get('/api/exports'),
  });

  if (q.isLoading) return <Card><Loading rows={4} /></Card>;
  if (q.isError) return <Card><ErrorNote error={q.error} /></Card>;
  const rows = q.data?.exports ?? [];

  return (
    <Card flush title="Download a CSV"
          right={<>
            <label className="row gap-3 t-ui">
              <input type="checkbox" checked={scoped} onChange={(e) => setScoped(e.target.checked)} />
              One month only
            </label>
            {scoped && (
              <input type="month" className="inp py-2 px-4 t-sm compact" value={month.month}
                     max={new Date().toISOString().slice(0, 7)} aria-label="Which month" 
                     onChange={(e) => { if (/^\d{4}-\d{2}$/.test(e.target.value)) month.set(e.target.value); }} />
            )}
          </>}>
      {rows.length === 0
        ? <Empty title="Your role can export nothing"
                 hint="An export also needs the read permission for the screen its data comes from." />
        : (
          <div className="tw">
            <table className="wide">
              <thead><tr><th>Export</th><th>What is in it</th>
                <th className="num">Columns</th><th /></tr></thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.kind}>
                    <td><span className="ttl">{titleCase(e.kind.replace(/-/g, ' '))}</span>
                        <span className="sub mono">{e.kind}</span></td>
                    <td>{e.what}</td>
                    <td className="num">{e.columns}</td>
                    <td className="num">
                      <DownloadLink
                        href={scoped && e.dated
                          ? `/api/exports/${e.kind}?${month.param}`
                          : `/api/exports/${e.kind}`}
                        aria-label={`Download the ${e.kind} export`}>
                        Download
                      </DownloadLink>
                      {scoped && !e.dated && (
                        <span className="sub t-sm">register — always current</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      <div className="note m-6">
        <b>Money leaves as naira, not kobo</b>, so a column sums straight away. Files open in
        Excel with the right characters — the ₦ sign and Nigerian names survive intact — and a
        cell beginning with <span className="mono">=</span> is escaped so opening an export can
        never run something somebody typed into a job title.
      </div>
    </Card>
  );
}

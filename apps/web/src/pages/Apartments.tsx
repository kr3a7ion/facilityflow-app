import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qk, ApiError } from '../lib/api';
import { useSession } from '../lib/session';
import { titleCase, when } from '../lib/format';
import { Card, Chip, Loading, ErrorNote, Empty, Btn, Modal, Field, Tabs, Flash, Tile } from '../components/Bits';

interface Apartment {
  id: string; unit_no: string; block: string | null; floor: string | null; unit_type: string | null;
  status: string; open_jobs: number; occupant_ref: string | null;
  last_inspection_at: string | null; notes: string | null;
}

const TONE: Record<string, 'ok' | 'warn' | 'crit' | 'acc' | ''> = {
  occupied: 'ok', vacant_ready: 'acc', under_maintenance: 'warn', out_of_service: 'crit', vacant_dirty: '',
};
const STATUSES = ['occupied', 'vacant_ready', 'vacant_dirty', 'under_maintenance', 'out_of_service'] as const;

export function Apartments() {
  const { can } = useSession();
  const [filter, setFilter] = useState<string>('');
  const [open, setOpen] = useState<Apartment | null>(null);
  const [modal, setModal] = useState<'add' | 'import' | null>(null);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);

  const q = useQuery<{ apartments: Apartment[]; summary: { status: string; n: number }[] }>({
    queryKey: qk.apartments, queryFn: () => api.get('/api/apartments'),
  });

  const blocks = useMemo(() => {
    const list = (q.data?.apartments ?? []).filter((a) => !filter || a.status === filter);
    const map = new Map<string, Apartment[]>();
    for (const a of list) {
      const key = a.block ?? 'Unassigned';
      (map.get(key) ?? map.set(key, []).get(key)!).push(a);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [q.data, filter]);

  const total = q.data?.apartments.length ?? 0;
  function done(text: string) { setModal(null); setOpen(null); setMsg({ text }); }

  return (
    <main className="view">
      <div className="vhead">
        <div>
          <p className="eyebrow">Places · {total} unit{total === 1 ? '' : 's'}</p>
          <h1>Apartments</h1>
          <p>Every unit carries its own job history, appliance list and inspection record.</p>
        </div>
        {can('apartment.manage') && (
          <div className="acts">
            {can('apartment.import') && (
              <Btn icon="doc" onClick={() => setModal('import')}>Import a unit list</Btn>)}
            <Btn icon="plus" tone="pri" onClick={() => setModal('add')}>Add units</Btn>
          </div>
        )}
      </div>

      <Flash msg={msg} />

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        <button className={`btn sm ${filter === '' ? 'on' : ''}`} onClick={() => setFilter('')}>
          All · {total}
        </button>
        {(q.data?.summary ?? []).map((s) => (
          <button key={s.status} className={`btn sm ${filter === s.status ? 'on' : ''}`}
                  onClick={() => setFilter(filter === s.status ? '' : s.status)}>
            {titleCase(s.status)} · {s.n}
          </button>
        ))}
      </div>

      {q.isLoading ? <Card><Loading rows={4} /></Card>
        : q.isError ? <ErrorNote error={q.error} />
        : total === 0
          ? <Card><Empty title="No units on the register yet"
                         hint={can('apartment.manage')
                           ? 'Add them by hand, or import the unit list from Day Book as a CSV.'
                           : 'An administrator has to load the unit list first.'} /></Card>
        : blocks.length === 0 ? <Card><Empty title="No units match that filter" /></Card>
        : blocks.map(([block, units]) => (
          <Card key={block} title={block === 'Unassigned' ? 'Unassigned to a block' : `Block ${block}`}
                right={<>
                  <Chip>{units.length} units</Chip>
                  {units.some((u) => u.open_jobs > 0) && (
                    <Chip tone="warn" lamp>
                      {units.reduce((s, u) => s + u.open_jobs, 0)} open jobs
                    </Chip>
                  )}
                </>}>
            <div className="units">
              {units.map((u) => (
                <button key={u.id} className={`unit ${u.status}`} onClick={() => setOpen(u)}
                        style={{ width: '100%' }}>
                  <b>{u.unit_no}</b>
                  <span>{titleCase(u.status)}</span>
                  {u.open_jobs > 0 && <i>{u.open_jobs} job{u.open_jobs > 1 ? 's' : ''}</i>}
                </button>
              ))}
            </div>
          </Card>
        ))}

      {open && <UnitDetail unit={open} onClose={() => setOpen(null)} onDone={done} />}
      {modal === 'add' && <AddUnits onClose={() => setModal(null)} onDone={done} />}
      {modal === 'import' && <ImportUnits onClose={() => setModal(null)} onDone={done} />}
    </main>
  );
}

function UnitDetail({ unit, onClose, onDone }: {
  unit: Apartment; onClose: () => void; onDone: (msg: string) => void;
}) {
  const { can } = useSession();
  const qc = useQueryClient();
  const [status, setStatus] = useState(unit.status);
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => api.post(`/api/apartments/${unit.id}/status`,
                               { status, note: note.trim() || undefined }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.apartments });
      onDone(`${unit.unit_no} is now ${titleCase(status).toLowerCase()}.`);
    },
    onError: (e) => setErr((e as ApiError).message),
  });

  return (
    <Modal title={`Unit ${unit.unit_no}`} onClose={onClose}>
      {err && <div className="note crit" style={{ marginBottom: 14 }} role="alert">{err}</div>}

      <dl className="kv" style={{ marginBottom: 16 }}>
        <dt>Status</dt><dd><Chip tone={TONE[unit.status] ?? ''} lamp>{titleCase(unit.status)}</Chip></dd>
        <dt>Block</dt><dd>{unit.block ?? '—'}{unit.floor ? ` · floor ${unit.floor}` : ''}</dd>
        <dt>Type</dt><dd>{unit.unit_type ?? '—'}</dd>
        <dt>Open jobs</dt><dd>{unit.open_jobs || 'none'}</dd>
        <dt>Last inspected</dt><dd>{unit.last_inspection_at ? when(unit.last_inspection_at) : 'never'}</dd>
      </dl>

      {can('apartment.manage') ? (
        <>
          <div className="grid g2">
            <Field label="Change status to">
              <select className="inp" value={status} onChange={(e) => setStatus(e.target.value)}>
                {STATUSES.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
              </select>
            </Field>
            <Field label="Why" hint="Recorded in the audit log against your name.">
              <input className="inp" value={note} placeholder="e.g. Taken off for a bathroom refit"
                     onChange={(e) => setNote(e.target.value)} />
            </Field>
          </div>
          {status === 'out_of_service' && (
            <div className="note warn">
              Out of service takes the unit off the lettable list. Use <b>under maintenance</b> for
              work that finishes this week.
            </div>
          )}
        </>
      ) : (
        <div className="note">Changing a unit's status needs the apartment.manage permission.</div>
      )}

      <div className="modal-foot">
        <Link className="btn" to={`/jobs?q=${encodeURIComponent(unit.unit_no)}`} onClick={onClose}>
          See its jobs
        </Link>
        {can('apartment.manage') && (
          <Btn tone="pri" icon="check" disabled={status === unit.status || save.isPending}
               onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : 'Update status'}
          </Btn>
        )}
      </div>
    </Modal>
  );
}

interface Row { unitNo: string; block: string; floor: string; unitType: string; status: string }
const BLANK: Row = { unitNo: '', block: '', floor: '', unitType: '', status: 'vacant_ready' };

function AddUnits({ onClose, onDone }: { onClose: () => void; onDone: (msg: string) => void }) {
  const qc = useQueryClient();
  const [rows, setRows] = useState<Row[]>([{ ...BLANK }, { ...BLANK }, { ...BLANK }]);
  const [err, setErr] = useState<string | null>(null);

  function edit(i: number, patch: Partial<Row>) {
    setRows((s) => s.map((r, n) => (n === i ? { ...r, ...patch } : r)));
  }
  const filled = rows.filter((r) => r.unitNo.trim());

  const save = useMutation({
    mutationFn: () => api.post<{ created: number; skipped: number }>('/api/apartments/import', {
      source: 'manual',
      units: filled.map((r) => ({
        unitNo: r.unitNo.trim(),
        block: r.block.trim() || undefined,
        floor: r.floor.trim() || undefined,
        unitType: r.unitType.trim() || undefined,
        status: r.status,
      })),
    }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: qk.apartments });
      onDone(`${r.created} unit${r.created === 1 ? '' : 's'} added${
        r.skipped ? `, ${r.skipped} skipped because they were already on the register` : ''}.`);
    },
    onError: (e) => setErr((e as ApiError).message),
  });

  return (
    <Modal title="Add units" onClose={onClose} wide>
      {err && <div className="note crit" style={{ marginBottom: 14 }} role="alert">{err}</div>}
      <div className="tw">
        <table className="wide">
          <thead><tr><th style={{ width: '24%' }}>Unit number</th><th>Block</th><th>Floor</th>
            <th>Type</th><th>Status</th><th /></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>
                  <input className="inp" value={r.unitNo} placeholder="e.g. A-1204"
                         autoFocus={i === 0}
                         onChange={(e) => edit(i, { unitNo: e.target.value })} />
                </td>
                <td>
                  <input className="inp" value={r.block} placeholder="A"
                         onChange={(e) => edit(i, { block: e.target.value })} />
                </td>
                <td>
                  <input className="inp" value={r.floor} placeholder="12"
                         onChange={(e) => edit(i, { floor: e.target.value })} />
                </td>
                <td>
                  <input className="inp" value={r.unitType} placeholder="2-bed"
                         onChange={(e) => edit(i, { unitType: e.target.value })} />
                </td>
                <td>
                  <select className="inp" value={r.status}
                          onChange={(e) => edit(i, { status: e.target.value })}>
                    {STATUSES.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
                  </select>
                </td>
                <td className="num">
                  <Btn size="sm" aria-label={`Remove row ${i + 1}`}
                       disabled={rows.length <= 1}
                       title={rows.length <= 1 ? 'Keep at least one row' : undefined}
                       onClick={() => setRows((st) => st.filter((_, n) => n !== i))}>Remove</Btn>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Btn size="sm" icon="plus" style={{ marginTop: 10 }}
           onClick={() => setRows((s) => [...s, { ...BLANK }])}>Another row</Btn>

      <div className="note" style={{ marginTop: 14 }}>
        Each unit also becomes a location, so jobs can be raised against it straight away. A unit
        number that already exists is skipped rather than duplicated.
      </div>

      <div className="modal-foot">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn tone="pri" icon="check" disabled={filled.length === 0 || save.isPending}
             onClick={() => save.mutate()}>
          {save.isPending ? 'Adding…' : `Add ${filled.length || ''} unit${filled.length === 1 ? '' : 's'}`}
        </Btn>
      </div>
    </Modal>
  );
}

interface ReadResult {
  format: 'csv' | 'json';
  headers: string[];
  fields: string[];
  mapping: Record<string, string>;
  missing: string[];
  ignored: string[];
  rowsRead: number;
  wouldCreate: number;
  alreadyHere: string[];
  repeatedInFile: string[];
  rejected: { line: number; reason: string; raw: string }[];
  blocks: string[];
  sample: Unit[];
}

interface Unit {
  unitNo: string; block?: string; name?: string;
  floor?: string; unitType?: string; bedrooms?: number;
}

const FIELD_LABEL: Record<string, string> = {
  block: 'Block or building',
  unit_no: 'Unit number',
  name: 'Unit name',
  floor: 'Floor',
  bedrooms: 'Bedrooms',
  type: 'Type',
};

const FIELD_HINT: Record<string, string> = {
  block: 'The wing or building. Unit numbers only have to be unique inside one.',
  unit_no: 'Required. What is written on the door.',
  name: 'What staff call it — Seville, Kyoto. Shown on every job card.',
  floor: 'Ground, First, 2 — whatever the file says.',
  bedrooms: 'A number. Studios count as 0.',
  type: 'Studio, 2-bedroom, Service.',
};

/**
 * Importing the unit list the department already has.
 *
 * The first version of this read columns **by position** — unit, block, floor, type, in
 * that order — and a real unit list has never once arrived in that order. The department's
 * own file put the building first, had two different floor columns, and carried four
 * columns of door-lock data that mean nothing to maintenance.
 *
 * So: open the file, let the system say what it thinks each column is, correct it if it
 * guessed wrong, and see exactly what would land before anything is written. The file is
 * read in the browser and sent as text — a few hundred rows of short strings does not
 * need an upload path, and this works with no internet in the building.
 */
function ImportUnits({ onClose, onDone }: { onClose: () => void; onDone: (msg: string) => void }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [read, setRead] = useState<ReadResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showSkipped, setShowSkipped] = useState(false);

  const look = useMutation({
    mutationFn: (override?: Record<string, string>) =>
      api.post<ReadResult>('/api/apartments/import/read', {
        text, mapping: override ?? undefined,
      }),
    onSuccess: (r) => { setRead(r); setMapping(r.mapping); setErr(null); },
    onError: (e) => { setErr((e as ApiError).message); setRead(null); },
  });

  async function onFile(file: File | undefined) {
    if (!file) return;
    setErr(null);
    setFileName(file.name);
    const body = await file.text();
    setText(body);
    // Look immediately: making somebody press a second button to see their own file is
    // a step with no decision in it.
    setTimeout(() => look.mutate(undefined), 0);
  }

  const commit = useMutation({
    mutationFn: async () => {
      // Ask the server for the full list under the confirmed mapping, then send it back
      // to be written. One source of parsing truth, used twice.
      const full = await api.post<ReadResult & { sample: Unit[] }>(
        '/api/apartments/import/read', { text, mapping, all: true });
      return api.post<{ created: number; skipped: number }>('/api/apartments/import', {
        source: read?.format === 'json' ? 'json' : 'csv',
        sourceRef: fileName || undefined,
        units: full.sample,
      });
    },
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: qk.apartments });
      await qc.invalidateQueries({ queryKey: qk.locations });
      onDone(`${r.created} unit${r.created === 1 ? '' : 's'} imported`
        + (r.skipped ? `, ${r.skipped} already here` : '') + '.');
    },
    onError: (e) => setErr((e as ApiError).message),
  });

  const ready = !!read && read.missing.length === 0 && read.wouldCreate > 0;

  return (
    <Modal title="Import units" onClose={onClose} wide>
      {!text ? (
        <>
          <Field label="The file"
                 hint="A CSV from Excel, or a JSON export. The first row should name the columns.">
            <input className="inp" type="file" accept=".csv,.txt,.json,text/csv,application/json"
                   onChange={(e) => void onFile(e.target.files?.[0])} />
          </Field>
          <div className="note" style={{ marginTop: 14 }}>
            <b>Column order does not matter.</b> The system reads the header row and works
            out which column is which — you get to correct it before anything is written.
            Columns it does not need are listed and left alone.
          </div>
        </>
      ) : (
        <>
          <p className="eyebrow" style={{ marginBottom: 10 }}>
            {fileName || 'pasted list'} · {read?.rowsRead ?? '…'} rows
            <button className="btn sm" style={{ marginLeft: 10 }}
                    onClick={() => { setText(''); setRead(null); setFileName(''); setErr(null); }}>
              Choose another file
            </button>
          </p>

          {err && <div className="note crit" style={{ marginBottom: 12 }} role="alert">{err}</div>}

          {look.isPending && <Loading rows={4} />}

          {read && (
            <>
              <p className="eyebrow" style={{ marginBottom: 8 }}>Which column is which</p>
              <div className="mapgrid">
                {read.fields.map((f) => (
                  <label key={f} className={`maprow ${read.missing.includes(f) ? 'bad' : ''}`}>
                    <span className="lbl">
                      <b>{FIELD_LABEL[f] ?? f}</b>
                      <small>{FIELD_HINT[f]}</small>
                    </span>
                    <select className="inp" value={mapping[f] ?? ''}
                            onChange={(e) => {
                              const next = { ...mapping, [f]: e.target.value };
                              setMapping(next);
                              look.mutate(next);
                            }}>
                      <option value="">— not in this file —</option>
                      {read.headers.filter(Boolean).map((h) => (
                        <option key={h} value={h}>{h}</option>))}
                    </select>
                  </label>
                ))}
              </div>

              {read.missing.length > 0 && (
                <div className="note crit" style={{ marginTop: 12 }}>
                  Tell it which column holds the <b>unit number</b> before going on.
                </div>
              )}

              {read.ignored.length > 0 && (
                <p style={{ fontSize: '0.8125rem', color: 'var(--text-3)', marginTop: 12 }}>
                  Left alone: {read.ignored.join(', ')}. Nothing is read from these.
                </p>
              )}

              {read.missing.length === 0 && (
                <>
                  <div className="grid g3" style={{ margin: '16px 0 12px' }}>
                    <Tile label="Will be added" value={read.wouldCreate}
                          tone={read.wouldCreate ? 'ok' : 'warn'}
                          sub={`of ${read.rowsRead} rows`} />
                    <Tile label="Already here"
                          value={read.alreadyHere.length + read.repeatedInFile.length}
                          sub={read.alreadyHere.length || read.repeatedInFile.length
                            ? 'skipped, not duplicated' : 'nothing to skip'} />
                    <Tile label="Blocks" value={read.blocks.length}
                          sub={read.blocks.slice(0, 2).join(', ') + (read.blocks.length > 2 ? '…' : '')} />
                  </div>

                  {(read.rejected.length > 0 || read.alreadyHere.length > 0
                    || read.repeatedInFile.length > 0) && (
                    <>
                      <button className="btn sm" style={{ marginBottom: 10 }}
                              onClick={() => setShowSkipped((v) => !v)}>
                        {showSkipped ? 'Hide' : 'Show'} what is being skipped
                      </button>
                      {showSkipped && (
                        <div className="note warn" style={{ marginBottom: 12 }}>
                          {read.rejected.length > 0 && (
                            <p style={{ margin: '0 0 6px' }}>
                              <b>Could not read:</b>{' '}
                              {read.rejected.map((r) => `line ${r.line} (${r.reason})`).join(', ')}
                            </p>
                          )}
                          {read.alreadyHere.length > 0 && (
                            <p style={{ margin: '0 0 6px' }}>
                              <b>Already on the system:</b> {read.alreadyHere.join(', ')}
                            </p>
                          )}
                          {read.repeatedInFile.length > 0 && (
                            <p style={{ margin: 0 }}>
                              <b>Repeated in the file:</b> {read.repeatedInFile.join(', ')}
                            </p>
                          )}
                        </div>
                      )}
                    </>
                  )}

                  <p className="eyebrow" style={{ marginBottom: 8 }}>The first few, as they will land</p>
                  <div className="tw">
                    <table className="wide">
                      <thead><tr><th>Block</th><th>Unit</th><th>Name</th>
                        <th>Floor</th><th className="num">Beds</th><th>Type</th></tr></thead>
                      <tbody>
                        {read.sample.map((u, i) => (
                          <tr key={i}>
                            <td>{u.block ?? '—'}</td>
                            <td className="mono">{u.unitNo}</td>
                            <td>{u.name ?? '—'}</td>
                            <td>{u.floor ?? '—'}</td>
                            <td className="num">{u.bedrooms ?? '—'}</td>
                            <td>{u.unitType ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="note" style={{ marginTop: 14 }}>
                    Each unit also becomes a place, so a job can be raised against it straight
                    away. A unit already on the system is skipped rather than duplicated —
                    and a unit number that appears in more than one block is kept in each,
                    because on most properties those are different flats.
                  </div>
                </>
              )}
            </>
          )}

          <div className="modal-foot">
            <Btn onClick={onClose}>Cancel</Btn>
            <Btn tone="pri" icon="check" disabled={!ready || commit.isPending}
                 onClick={() => commit.mutate()}>
              {commit.isPending ? 'Importing…' : `Import ${read?.wouldCreate ?? ''}`}
            </Btn>
          </div>
        </>
      )}
    </Modal>
  );
}

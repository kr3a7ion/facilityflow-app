import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qk, ApiError } from '../lib/api';
import { useSession } from '../lib/session';
import { initials, titleCase } from '../lib/format';
import { Card, Chip, Tile, Loading, ErrorNote, Empty, Btn, Modal, Field, Flash } from '../components/Bits';

interface Entry {
  id: string; staff_id: string; work_date: string; status: string;
  shift_pattern_id: string | null; published_at: string | null;
  shift_name: string | null; colour: string | null; absence_reason: string | null;
  first_name: string; last_name: string; trade: string | null;
}
interface RosterData {
  from: string; to: string; today: string; entries: Entry[];
  onShiftToday: { staff_id: string }[];
}
interface Pattern {
  id: string; name: string; start_time: string; end_time: string; crosses_midnight: number;
}
interface Person { staff_id: string; first_name: string; last_name: string; trade: string | null }

const DAY_MS = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const parse = (s: string) => new Date(`${s}T00:00:00Z`);
const shift = (s: string, days: number) => iso(new Date(parse(s).getTime() + days * DAY_MS));

function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const d = parse(from); const end = parse(to);
  while (d <= end && out.length < 42) { out.push(iso(d)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}
/** "02 Sep" — long enough to be unambiguous, short enough for an eyebrow. */
function short(s: string): string {
  return parse(s).toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
}

/** Monday of the week containing this date — rosters are read Monday to Sunday. */
function weekStart(s: string): string {
  const d = parse(s);
  return iso(new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY_MS));
}

export function Roster() {
  const { can } = useSession();
  const qc = useQueryClient();
  const [anchor, setAnchor] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [editing, setEditing] = useState(false);
  const [brush, setBrush] = useState<string>('');
  const [filling, setFilling] = useState(false);

  const range = anchor
    ? { from: anchor, to: shift(anchor, 6) }
    : null;
  const qs = range ? `?from=${range.from}&to=${range.to}` : '';

  const roster = useQuery<RosterData>({
    queryKey: [...qk.roster, qs], queryFn: () => api.get(`/api/roster${qs}`),
  });
  const patterns = useQuery<{ patterns: Pattern[] }>({
    queryKey: ['patterns'], queryFn: () => api.get('/api/shift-patterns'),
  });
  // Somebody with no entries at all must still appear, or they can never be rostered.
  const roll = useQuery<{ staff: { id: string; first_name: string; last_name: string; trade: string | null }[] }>({
    queryKey: qk.staff, queryFn: () => api.get('/api/staff'), enabled: can('staff.read'),
  });

  const write = useMutation({
    mutationFn: (entries: { staffId: string; workDate: string; shiftPatternId?: string | null; status?: string }[]) =>
      api.post<{ written: number }>('/api/roster', { entries }),
    onSuccess: async (r) => {
      setMsg({ text: `${r.written} day${r.written === 1 ? '' : 's'} saved. Publish when the week is right.` });
      await qc.invalidateQueries({ queryKey: qk.roster });
      await qc.invalidateQueries({ queryKey: qk.assignable });
    },
    onError: (e) => setMsg({ text: (e as ApiError).message, bad: true }),
  });

  const publish = useMutation({
    // Publishes exactly the window on screen, so what gets released is what was reviewed.
    mutationFn: (v: { from: string; to: string }) =>
      api.post<{ published: number }>('/api/roster/publish', v),
    onSuccess: async (r) => {
      setMsg({ text: r.published
        ? `${r.published} day${r.published === 1 ? '' : 's'} published — the team can see this week now.`
        : 'Everything in this week was already published.' });
      await qc.invalidateQueries({ queryKey: qk.roster });
    },
    onError: (e) => setMsg({ text: (e as ApiError).message, bad: true }),
  });

  const mark = useMutation({
    mutationFn: (v: { staffId: string; workDate: string; status: 'present' | 'absent'; reason?: string }) =>
      api.post('/api/roster/mark', v),
    onSuccess: async (_r, v) => {
      setMsg({ text: v.status === 'present' ? 'Marked present.' : 'Marked absent.' });
      await qc.invalidateQueries({ queryKey: qk.roster });
      await qc.invalidateQueries({ queryKey: qk.assignable });
      await qc.invalidateQueries({ queryKey: qk.plant });
    },
    onError: (e) => setMsg({ text: (e as ApiError).message, bad: true }),
  });

  const data = roster.data;
  const people: Person[] = useMemo(() => {
    if (roll.data?.staff.length) {
      return roll.data.staff.map((s) => ({
        staff_id: s.id, first_name: s.first_name, last_name: s.last_name, trade: s.trade,
      })).sort((a, b) => a.first_name.localeCompare(b.first_name));
    }
    const seen = new Map<string, Person>();
    for (const e of data?.entries ?? []) {
      if (!seen.has(e.staff_id)) {
        seen.set(e.staff_id, { staff_id: e.staff_id, first_name: e.first_name,
                               last_name: e.last_name, trade: e.trade });
      }
    }
    return [...seen.values()].sort((a, b) => a.first_name.localeCompare(b.first_name));
  }, [roll.data, data]);

  if (roster.isLoading) return <main className="view"><Card><Loading rows={6} /></Card></main>;
  if (roster.isError) return <main className="view"><ErrorNote error={roster.error} /></main>;

  const d = data!;
  const days = datesBetween(d.from, d.to);
  const byKey = new Map(d.entries.map((e) => [`${e.staff_id}|${e.work_date}`, e]));
  const pats = patterns.data?.patterns ?? [];

  const today = d.entries.filter((e) => e.work_date === d.today);
  const present = today.filter((e) => e.status === 'present').length;
  const absent = today.filter((e) => e.status === 'absent').length;
  const unmarked = today.filter((e) => e.status === 'scheduled').length;
  const unpublished = d.entries.filter((e) => !e.published_at).length;

  const canEdit = can('roster.edit');
  const thisWeek = weekStart(d.today);
  // anchor === null is the server's default window, which always contains today.
  const label = anchor === null || d.from === thisWeek ? 'This week'
    : d.from === shift(thisWeek, 7) ? 'Next week'
    : d.from === shift(thisWeek, -7) ? 'Last week'
    : 'Week of ' + short(d.from);

  /** Clicking a cell in edit mode paints the chosen shift, or clears it back to a rest day. */
  function paint(staffId: string, date: string) {
    write.mutate([{ staffId, workDate: date,
                    shiftPatternId: brush || null, status: brush ? 'scheduled' : 'off' }]);
  }

  return (
    <main className="view">
      <div className="vhead">
        <div>
          <p className="eyebrow">{label} · {short(d.from)} – {short(d.to)}</p>
          <h1>Roster</h1>
          <p>Shifts are whatever you define them to be. The roster answers one question the job
             board needs: who is on the floor right now.</p>
        </div>
        <div className="acts">
          <Btn icon="back" aria-label="Previous week"
               onClick={() => setAnchor(shift(d.from, -7))} />
          <Btn disabled={anchor === null} onClick={() => setAnchor(null)}>Today</Btn>
          <Btn aria-label="Next week" onClick={() => setAnchor(shift(d.from, 7))}>
            <span style={{ display: 'inline-block', transform: 'rotate(180deg)' }}>
              <Chevron />
            </span>
          </Btn>
          {canEdit && (
            <>
              <Btn icon="cal" onClick={() => setFilling(true)}>Fill a pattern</Btn>
              <Btn tone={editing ? 'on' : undefined} icon={editing ? 'check' : 'wrench'}
                   onClick={() => setEditing(!editing)}>
                {editing ? 'Done editing' : 'Edit'}
              </Btn>
            </>
          )}
          {can('roster.publish') && unpublished > 0 && (
            <Btn tone="pri" icon="check" disabled={publish.isPending} onClick={() => publish.mutate({ from: d.from, to: d.to })}>
              Publish {unpublished}
            </Btn>
          )}
        </div>
      </div>

      <Flash msg={msg} />

      <div className="grid g4" style={{ marginBottom: 16 }}>
        <Tile label="Present today" value={present} tone={present > 0 ? 'ok' : undefined}
              sub={`of ${today.filter((e) => e.status !== 'off').length} scheduled`} />
        <Tile label="Absent today" value={absent} tone={absent > 0 ? 'crit' : undefined}
              sub={today.filter((e) => e.status === 'absent')
                .map((e) => `${e.first_name} · ${e.absence_reason ?? 'unexplained'}`).join(', ') || 'nobody'} />
        <Tile label="Not yet marked" value={unmarked} tone={unmarked > 0 ? 'warn' : undefined}
              sub={unmarked ? 'these people cannot be assigned work' : 'the whole shift is confirmed'} />
        {/* "0 unpublished — this week is published" was being shown for a week with no
            entries at all, which reads as reassurance where none is owed. */}
        <Tile label="Unpublished" value={unpublished} tone={unpublished > 0 ? 'acc' : undefined}
              sub={unpublished ? 'drafted but not visible to the team'
                : d.entries.length === 0 ? 'nothing rostered this week'
                  : 'this week is published'} />
      </div>

      {editing && (
        <Card title="Painting shifts"
              right={<Chip tone="acc">Click any day to set it</Chip>}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {pats.map((p) => (
              <button key={p.id} className={`btn sm ${brush === p.id ? 'on' : ''}`}
                      onClick={() => setBrush(p.id)}>
                {p.name} · {p.start_time}–{p.end_time}
              </button>
            ))}
            <button className={`btn sm ${brush === '' ? 'on' : ''}`} onClick={() => setBrush('')}>
              Rest day
            </button>
          </div>
          <div className="note" style={{ marginTop: 12 }}>
            Changes save as you click and stay unpublished until you press Publish, so a
            half-built week is never visible to the team.
          </div>
        </Card>
      )}

      {!editing && (
        <Card title="Shift patterns" right={<Chip>Nothing here is hard-coded</Chip>}>
          {pats.length === 0 ? (
            // Without this the card was a blank strip and the grid below read OFF for
            // everybody, with nothing anywhere saying why a shift could not be set.
            <Empty title="No shift patterns yet"
                   hint="A roster entry points at a pattern — Morning 07:00–15:00, Night 22:00–06:00 — so the patterns have to exist before anybody can be put on a shift. They are yours to name; nothing here is fixed."
                   action={can('admin.settings.manage')
                     ? <Link className="btn pri" to="/admin?tab=shifts">Set the patterns</Link> : undefined}
                   ask="Ask an administrator to define the shift patterns under Admin → Shifts." />
          ) : (
            <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>
              {pats.map((p) => (
                <span key={p.id} className={`chip ${p.crosses_midnight ? '' : 'acc'}`}
                      style={{ padding: '6px 11px', fontSize: '0.6875rem' }}>
                  {p.name} · {p.start_time}–{p.end_time}{p.crosses_midnight ? ' · crosses midnight' : ''}
                </span>
              ))}
            </div>
          )}
        </Card>
      )}

      <div style={{ marginTop: 14, overflowX: 'auto' }}>
        {people.length === 0 ? <Card><Empty
          title="No staff on the books"
          hint="A roster is a grid of people against days, so the people have to exist first. Nothing can be assigned to anybody until they do."
          action={can('staff.manage')
            ? <Link className="btn pri" to="/admin?tab=people">Add the team</Link> : undefined}
          ask="Ask an administrator to add the team under Admin → Staff." /></Card> : (
          <div className="rgrid">
            <div className="rrow head">
              <div className="rcell">Technician</div>
              {days.map((day) => (
                <div key={day} className={`rcell ${day === d.today ? 'today' : ''}`}>
                  {parse(day).toLocaleDateString(undefined, { weekday: 'short' })}
                  <b>{day.slice(-2)}</b>
                </div>
              ))}
            </div>
            {people.map((s) => (
              <div className="rrow" key={s.staff_id}>
                <div className="rcell">
                  <div className="who2">
                    <span className="av">{initials(`${s.first_name} ${s.last_name}`)}</span>
                    <span style={{ minWidth: 0 }}>
                      <span className="nm">{s.first_name} {s.last_name}</span>
                      <span className="tr">{s.trade ?? '—'}</span>
                    </span>
                  </div>
                </div>
                {days.map((day) => {
                  const e = byKey.get(`${s.staff_id}|${day}`);
                  const isToday = day === d.today;
                  const cls = !e || e.status === 'off' ? 'off'
                    : e.status === 'present' ? 'present'
                    : e.status === 'absent' ? 'absent'
                    : e.shift_name?.toLowerCase().includes('night') ? 'n' : 'd';
                  const canMark = can('roster.mark') && isToday && e && e.status !== 'off';
                  const active = editing ? canEdit : canMark;
                  return (
                    <div key={day} className={`rcell ${isToday ? 'today' : ''}`}>
                      <button className={`sh ${cls}`} disabled={!active || write.isPending}
                              title={editing ? 'Click to paint this day'
                                    : canMark ? 'Click to mark present or absent' : undefined}
                              onClick={() => {
                                if (editing) return paint(s.staff_id, day);
                                if (!canMark || !e) return;
                                const next = e.status === 'present' ? 'absent' : 'present';
                                mark.mutate({ staffId: s.staff_id, workDate: day, status: next,
                                              reason: next === 'absent' ? 'unexplained' : undefined });
                              }}>
                        {!e || e.status === 'off' ? 'Off'
                          : e.status === 'absent' ? 'Absent'
                          : e.shift_name ?? titleCase(e.status)}
                        {e?.status === 'present' && <span className="mk">✓</span>}
                        {e?.status === 'absent' && <span className="mk">{e.absence_reason ?? ''}</span>}
                        {e && !e.published_at && e.status !== 'off' && <span className="mk">draft</span>}
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="note" style={{ marginTop: 14 }}>
        <b>The tick is the whole point.</b> A published roster is a plan; a supervisor marks present or
        absent on the day, and the assignment screen only offers people marked present. No clock-in
        device, no late minutes, no overtime approval — availability is all this stores.
      </div>

      {filling && (
        <FillPattern people={people} patterns={pats} from={d.from}
                     onClose={() => setFilling(false)}
                     onDone={(text) => { setFilling(false); setMsg({ text }); }} />
      )}
    </main>
  );
}

function Chevron() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 5l-7 7 7 7" />
    </svg>
  );
}

/**
 * Setting a month by hand is eight people times thirty days of clicking, which is how a
 * roster ends up living in a spreadsheet instead. This writes the whole block in one call.
 */
function FillPattern({ people, patterns, from, onClose, onDone }: {
  people: Person[]; patterns: Pattern[]; from: string;
  onClose: () => void; onDone: (msg: string) => void;
}) {
  const qc = useQueryClient();
  const [staffIds, setStaffIds] = useState<string[]>(people.map((p) => p.staff_id));
  const [start, setStart] = useState(from);
  const [end, setEnd] = useState(shift(from, 13));
  const [mode, setMode] = useState<'same' | 'rotate'>('same');
  const [patternId, setPatternId] = useState(patterns[0]?.id ?? '');
  const [rotation, setRotation] = useState<string[]>(patterns.map((p) => p.id));
  const [restDays, setRestDays] = useState<number[]>([0]); // Sunday
  const [err, setErr] = useState<string | null>(null);

  const days = start && end && end >= start ? datesBetween(start, end) : [];

  // Built here rather than on the server so the count below is exactly what gets written.
  const entries = useMemo(() => {
    const out: { staffId: string; workDate: string; shiftPatternId: string | null; status: string }[] = [];
    staffIds.forEach((id, personIndex) => {
      let worked = 0;
      for (const day of days) {
        const dow = parse(day).getUTCDay();
        if (restDays.includes(dow)) {
          out.push({ staffId: id, workDate: day, shiftPatternId: null, status: 'off' });
          continue;
        }
        let pid: string | null = null;
        if (mode === 'same') pid = patternId || null;
        else if (rotation.length) {
          // Offset by person so the team is spread across shifts instead of all on mornings.
          pid = rotation[(personIndex + Math.floor(worked / 7)) % rotation.length] ?? null;
        }
        out.push({ staffId: id, workDate: day, shiftPatternId: pid, status: pid ? 'scheduled' : 'off' });
        worked++;
      }
    });
    return out;
  }, [staffIds, days, restDays, mode, patternId, rotation]);

  const tooMany = entries.length > 500;

  const save = useMutation({
    mutationFn: () => api.post<{ written: number }>('/api/roster', { entries }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: qk.roster });
      onDone(`${r.written} days written across ${staffIds.length} `
             + `${staffIds.length === 1 ? 'person' : 'people'}. Nothing is visible to the team until you publish.`);
    },
    onError: (e) => setErr((e as ApiError).message),
  });

  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return (
    <Modal title="Fill a pattern" onClose={onClose} wide>
      {err && <div className="note crit" style={{ marginBottom: 14 }} role="alert">{err}</div>}

      <div className="grid g2">
        <Field label="From">
          <input className="inp" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <Field label="To" hint="Two weeks at a time keeps it under the 500-day write limit.">
          <input className="inp" type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
        </Field>
      </div>

      <Field label="Who">
        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
          {people.map((p) => {
            const on = staffIds.includes(p.staff_id);
            return (
              <button key={p.staff_id} className={`btn sm ${on ? 'on' : ''}`}
                      onClick={() => setStaffIds((s) => on ? s.filter((x) => x !== p.staff_id)
                                                          : [...s, p.staff_id])}>
                {p.first_name} {p.last_name[0]}.
              </button>
            );
          })}
          <button className="btn sm"
                  onClick={() => setStaffIds(staffIds.length === people.length
                    ? [] : people.map((p) => p.staff_id))}>
            {staffIds.length === people.length ? 'None' : 'Everyone'}
          </button>
        </div>
      </Field>

      <Field label="Rest days" hint="Left off the rota entirely — nobody is scheduled on these.">
        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
          {DOW.map((name, i) => (
            <button key={name} className={`btn sm ${restDays.includes(i) ? 'on' : ''}`}
                    onClick={() => setRestDays((s) => s.includes(i) ? s.filter((x) => x !== i) : [...s, i])}>
              {name}
            </button>
          ))}
        </div>
      </Field>

      <div className="grid g2">
        <Field label="Pattern">
          <select className="inp" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            <option value="same">Same shift every working day</option>
            <option value="rotate">Rotate weekly through shifts</option>
          </select>
        </Field>
        {mode === 'same' ? (
          <Field label="Which shift">
            <select className="inp" value={patternId} onChange={(e) => setPatternId(e.target.value)}>
              {patterns.map((p) => (
                <option key={p.id} value={p.id}>{p.name} · {p.start_time}–{p.end_time}</option>))}
            </select>
          </Field>
        ) : (
          <Field label="Shifts in the rotation" hint="Each person starts on a different one.">
            <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
              {patterns.map((p) => (
                <button key={p.id} className={`btn sm ${rotation.includes(p.id) ? 'on' : ''}`}
                        onClick={() => setRotation((s) => s.includes(p.id)
                          ? s.filter((x) => x !== p.id) : [...s, p.id])}>
                  {p.name}
                </button>
              ))}
            </div>
          </Field>
        )}
      </div>

      <div className={`note ${tooMany ? 'crit' : ''}`}>
        {days.length === 0 ? 'Pick a date range.'
          : staffIds.length === 0 ? 'Pick at least one person.'
          : tooMany
            ? `${entries.length} days is over the 500 the server writes at once — shorten the range or pick fewer people.`
            : <>Writes <b>{entries.length} days</b> — {staffIds.length} {staffIds.length === 1 ? 'person' : 'people'} across{' '}
               {days.length} {days.length === 1 ? 'day' : 'days'}. Existing days in that range are overwritten.</>}
      </div>

      <div className="modal-foot">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn tone="pri" icon="check"
             disabled={entries.length === 0 || tooMany || save.isPending}
             onClick={() => save.mutate()}>
          {save.isPending ? 'Writing…' : 'Fill the roster'}
        </Btn>
      </div>
    </Modal>
  );
}

/** Admin → The place tree: sites, buildings, floors, rooms. */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { titleCase } from '../../lib/format';
import { Card, Chip, Loading, Empty, ErrorNote, Btn, Modal, Field, Flash, RetireBtn,
         DeleteBtn } from '../../components/Bits';

interface Place {
  id: string; parent_id: string | null; type: string; code: string; name: string; sort_order: number;
  is_active?: number;
}

const PLACE_TYPES = [
  ['block', 'Block'], ['floor', 'Floor'], ['plant_room', 'Plant room'],
  ['common_area', 'Common area'], ['external', 'External'],
] as const;

/**
 * Blocks, floors, plant rooms — everywhere a job can be raised against that is not
 * somebody's apartment.
 *
 * The first-run wizard creates the site itself, because a database with no location at
 * all cannot accept a single common-area job. Everything below it is the department's
 * own geography and gets typed in here: the generator house, the roof plant, the pump
 * room, the block risers.
 */
export function Places() {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Place | null>(null);
  const [showRetired, setShowRetired] = useState(false);
  const [placeMsg, setPlaceMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  // Invalidating the prefix refreshes every picker in the app as well as this list.
  const refreshPlaces = () => qc.invalidateQueries({ queryKey: ['locations'] });

  // Retired places come too, so they can be brought back; they are only drawn on request.
  const q = useQuery<{ locations: Place[] }>({
    queryKey: ['locations', 'all'], queryFn: () => api.get('/api/locations?all=1'),
  });
  const everything = q.data?.locations ?? [];
  const retiredCount = everything.filter((l) => l.is_active === 0).length;
  const all = showRetired ? everything : everything.filter((l) => l.is_active !== 0);
  const live = everything.filter((l) => l.is_active !== 0);
  const site = all.find((l) => l.type === 'site');
  // With retired places hidden, a live place under a retired parent is drawn at the top
  // level rather than vanishing along with it.
  const shown = new Set(all.map((l) => l.id));
  const byParent = (id: string | null) =>
    all.filter((l) => (id === null ? !l.parent_id || !shown.has(l.parent_id) : l.parent_id === id));

  const rows: { place: Place; depth: number }[] = [];
  const walk = (parent: string | null, depth: number): void => {
    for (const place of byParent(parent)) { rows.push({ place, depth }); walk(place.id, depth + 1); }
  };
  walk(null, 0);

  return (
    <>
      <Flash msg={placeMsg} />
      <Card flush title="Places"
            right={<>
              {retiredCount > 0 && (
                <Btn size="sm" tone={showRetired ? 'on' : undefined}
                     onClick={() => setShowRetired((v) => !v)}>
                  {showRetired ? 'Hide retired' : `Show retired (${retiredCount})`}
                </Btn>
              )}
              <Btn size="sm" icon="plus" onClick={() => setAdding(true)}>Add a place</Btn>
            </>}>
        {q.isLoading ? <Loading rows={4} />
          : q.isError ? <div className="p-6"><ErrorNote error={q.error} /></div>
          : rows.length === 0
            ? <Empty title="No places yet" hint="The site should have been created at setup. Add one to continue." />
            : (
              <div className="tw">
                <table className="wide">
                  <thead><tr><th>Place</th><th>Kind</th><th className="mono">Code</th><th /></tr></thead>
                  <tbody>
                    {rows.map(({ place, depth }) => (
                      <tr key={place.id}>
                        <td style={{ paddingLeft: 15 + depth * 22 }}>
                          <span className="ttl">{place.name}
                            {place.is_active === 0 && <> <Chip tone="warn">Retired</Chip></>}</span>
                          {isSiteRoot(place) && <span className="sub">the property itself</span>}
                        </td>
                        <td>{titleCase(place.type)}</td>
                        <td className="mono">{place.code}</td>
                        <td className="num nw">
                          <Btn size="sm" onClick={() => setEditing(place)}>Edit</Btn>{' '}
                          {/* The property itself is neither retirable nor deletable —
                              everything hangs off it. */}
                          {!isSiteRoot(place) && <>
                            <RetireBtn kind="location" id={place.id} label={place.name}
                                       active={place.is_active !== 0}
                                       onDone={async (m) => { setPlaceMsg({ text: m }); await refreshPlaces(); }} />{' '}
                            <DeleteBtn kind="location" id={place.id} label={place.name}
                                       onDone={async (m) => { setPlaceMsg({ text: m }); await refreshPlaces(); }} />
                          </>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        <div className="note m-6">
          A job has to hang off <b>something</b> — an asset, an apartment or a place. Plant
          rooms earn their place here: "generator house" on a job is the difference between a
          history you can read in a year and a list of jobs that happened somewhere.
        </div>
      </Card>

      {adding && (
        <PlaceDialog places={live} defaultParent={site?.id ?? null}
                     onClose={() => setAdding(false)}
                     onSaved={async () => {
                       setAdding(false);
                       await refreshPlaces();
                     }} />
      )}
      {editing && (
        <PlaceDialog places={everything} place={editing} defaultParent={editing.parent_id}
                     onClose={() => setEditing(null)}
                     onSaved={async () => {
                       setPlaceMsg({ text: `${editing.name} saved.` });
                       setEditing(null);
                       await refreshPlaces();
                     }} />
      )}
    </>
  );
}

/** The site at the root of the tree: renamed, never moved, retired or deleted. */
function isSiteRoot(p: Place): boolean {
  return p.type === 'site' && !p.parent_id;
}

/** Everything below a place, so the "sits inside" list can leave out moves that would loop. */
function descendantsOf(id: string, places: Place[]): Set<string> {
  const out = new Set<string>([id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of places) {
      if (p.parent_id && out.has(p.parent_id) && !out.has(p.id)) { out.add(p.id); grew = true; }
    }
  }
  return out;
}

function PlaceDialog({ places, place, defaultParent, onClose, onSaved }:
  { places: Place[]; place?: Place; defaultParent: string | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    name: place?.name ?? '', code: place?.code ?? '', type: place?.type ?? 'plant_room',
    parentId: defaultParent ?? '',
  });
  const isRoot = !!place && isSiteRoot(place);

  // Typing a code by hand is a job nobody wants and a duplicate waiting to happen.
  const suggested = f.name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20);
  const code = f.code.trim() || suggested;
  // A place cannot sit inside itself or anything inside it; the server refuses it too.
  const blocked = place ? descendantsOf(place.id, places) : new Set<string>();
  const parents = places.filter((p) => !blocked.has(p.id));
  // Kinds the add list does not offer (the site, an apartment) still show when editing one.
  const types: readonly (readonly [string, string])[] =
    place && !PLACE_TYPES.some(([v]) => v === place.type)
      ? [[place.type, titleCase(place.type)], ...PLACE_TYPES]
      : PLACE_TYPES;

  const save = useMutation({
    mutationFn: () => place
      ? api.patch(`/api/locations/${place.id}`, {
          name: f.name.trim(), code,
          ...(isRoot ? {} : { type: f.type, parentId: f.parentId || null }),
        })
      : api.post('/api/locations', {
          name: f.name.trim(), code, type: f.type,
          parentId: f.parentId || undefined,
        }),
    onSuccess: onSaved,
  });
  const err = save.error as ApiError | null;

  return (
    <Modal title={place ? `Edit ${place.name}` : 'Add a place'} onClose={onClose}>
      <Field label="Name" hint="What the team calls it out loud.">
        <input className="inp" autoFocus value={f.name}
               onChange={(e) => setF({ ...f, name: e.target.value })} />
      </Field>
      <div className="grid g2 gap-5">
        <Field label="Kind">
          <select className="inp" value={f.type} disabled={isRoot}
                  onChange={(e) => setF({ ...f, type: e.target.value })}>
            {types.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>
        <Field label="Sits inside">
          <select className="inp" value={f.parentId} disabled={isRoot}
                  onChange={(e) => setF({ ...f, parentId: e.target.value })}>
            <option value="">Nothing — top level</option>
            {parents.map((p) => (
              <option key={p.id} value={p.id}>{p.name}{p.is_active === 0 ? ' (retired)' : ''}</option>))}
          </select>
        </Field>
      </div>
      <Field label="Code" hint={suggested ? `Leave blank to use ${suggested}` : 'A short unique code.'}>
        <input className="inp" value={f.code} placeholder={suggested}
               onChange={(e) => setF({ ...f, code: e.target.value })} />
      </Field>
      {err && <div className="note crit mb-5" role="alert">{err.message}</div>}
      <Btn full tone="pri"
           disabled={f.name.trim().length < 2 || !code || save.isPending}
           onClick={() => save.mutate()}>
        {save.isPending ? 'Saving…' : place ? 'Save changes' : 'Add place'}
      </Btn>
    </Modal>
  );
}

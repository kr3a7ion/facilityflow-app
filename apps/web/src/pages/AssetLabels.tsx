import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { api, qk } from '../lib/api';
import { titleCase } from '../lib/format';
import { Loading, ErrorNote, Empty, Btn, Field, PrintBtn } from '../components/Bits';

interface Asset {
  id: string; asset_tag: string; name: string; status: string;
  category_name: string | null; location_name: string | null; unit_no?: string | null;
}

const SIZES = {
  large: { label: '4 across — 48 mm codes', perRow: 4, qr: 150 },
  medium: { label: '5 across — 38 mm codes', perRow: 5, qr: 120 },
  small: { label: '7 across — 26 mm codes', perRow: 7, qr: 90 },
} as const;
type SizeKey = keyof typeof SIZES;

/**
 * Printable QR stickers for asset tags.
 *
 * The code encodes a full URL because that is the only thing a phone camera will act on
 * — a bare tag string just shows the person some text. That URL has to name the host, so
 * the address is editable here: the labels are physical objects that outlive any change
 * of IP, and printing a batch against a DHCP address that moves next month is how a wall
 * of stickers becomes decoration. A hostname or a reserved address is worth the trouble.
 *
 * Codes are generated in the browser with no network call, which matters because the
 * property this prints in has no route to the internet.
 */
export function AssetLabels({ onClose }: { onClose: () => void }) {
  const [size, setSize] = useState<SizeKey>('medium');
  const [base, setBase] = useState(() => window.location.origin);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const list = useQuery<{ assets: Asset[] }>({
    queryKey: qk.assets, queryFn: () => api.get('/api/assets'),
  });
  const assets = list.data?.assets ?? [];

  // Everything is selected to begin with: printing the whole register is the common case,
  // and deselecting a handful is less work than picking sixty.
  useEffect(() => {
    if (assets.length && picked.size === 0) setPicked(new Set(assets.map((a) => a.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets.length]);

  const chosen = useMemo(() => assets.filter((a) => picked.has(a.id)), [assets, picked]);
  const cleanBase = base.replace(/\/+$/, '');

  useEffect(() => {
    let cancelled = false;
    if (!chosen.length) { setCodes({}); return; }
    setBusy(true);
    (async () => {
      const next: Record<string, string> = {};
      for (const a of chosen) {
        // Medium error correction: a sticker in a plant room collects dust and scuffs,
        // and M recovers about 15% of the code without making it noticeably denser.
        next[a.id] = await QRCode.toString(
          `${cleanBase}/assets?tag=${encodeURIComponent(a.asset_tag)}`,
          { type: 'svg', errorCorrectionLevel: 'M', margin: 0,
            color: { dark: '#000000', light: '#ffffff' } }
        );
      }
      if (!cancelled) { setCodes(next); setBusy(false); }
    })().catch(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [chosen, cleanBase]);

  const spec = SIZES[size];

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Asset labels">
      <div className="modal-card" style={{ width: 'min(1100px,96vw)' }}
           onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Asset labels</h2>
          <div className="r">
            <PrintBtn label="Print the sheet" />
            <button className="icobtn no-print" onClick={onClose} aria-label="Close">✕</button>
          </div>
        </header>

        <div className="body">
          <div className="no-print">
            <div className="grid g2">
              <Field label="Address the codes point at"
                     hint="Whatever a phone must type to reach this system. Use a fixed address — a sticker outlives a DHCP lease.">
                <input className="inp" value={base} onChange={(e) => setBase(e.target.value)} />
              </Field>
              <Field label="Sticker size">
                <select className="inp" value={size} onChange={(e) => setSize(e.target.value as SizeKey)}>
                  {Object.entries(SIZES).map(([k, v]) => (
                    <option key={k} value={k}>{v.label}</option>))}
                </select>
              </Field>
            </div>

            {list.isLoading ? <Loading rows={3} />
              : list.isError ? <ErrorNote error={list.error} />
              : (
                <>
                  <p className="eyebrow" style={{ marginBottom: 8 }}>
                    Which assets · {chosen.length} of {assets.length}
                  </p>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                    <button className="btn sm"
                            onClick={() => setPicked(new Set(assets.map((a) => a.id)))}>All</button>
                    <button className="btn sm" onClick={() => setPicked(new Set())}>None</button>
                    {assets.map((a) => (
                      <button key={a.id} className={`btn sm ${picked.has(a.id) ? 'on' : ''}`}
                              onClick={() => setPicked((s) => {
                                const n = new Set(s);
                                if (n.has(a.id)) n.delete(a.id); else n.add(a.id);
                                return n;
                              })}>
                        {a.asset_tag}
                      </button>
                    ))}
                  </div>
                </>
              )}

            <div className="note" style={{ marginBottom: 14 }}>
              <b>Print on plain A4 and stick them on with clear tape</b>, or use adhesive label
              stock. Scanning a code opens that asset's job history straight away — no searching,
              no typing a tag with oily hands.
              {cleanBase.includes('localhost') && (
                <div style={{ marginTop: 6, color: 'var(--warn)' }}>
                  That address says <b>localhost</b>, which only works on this PC. Change it to the
                  host's network address before printing, or every sticker will fail on a phone.
                </div>
              )}
            </div>
          </div>

          {busy && <div className="note no-print">Drawing {chosen.length} codes…</div>}

          {chosen.length === 0
            ? <Empty title="Nothing selected" hint="Pick at least one asset to print." />
            : (
              <div className="labels"
                   style={{ gridTemplateColumns: `repeat(${spec.perRow}, minmax(0, 1fr))` }}>
                {chosen.map((a) => (
                  <div className="label" key={a.id}>
                    <div className="qr" style={{ width: spec.qr, height: spec.qr }}
                         dangerouslySetInnerHTML={{ __html: codes[a.id] ?? '' }} />
                    <b>{a.asset_tag}</b>
                    <span>{a.name}</span>
                    <i>{a.unit_no ?? a.location_name ?? titleCase(a.status)}</i>
                  </div>
                ))}
              </div>
            )}
        </div>
      </div>
    </div>
  );
}

/** Shown on the Assets page header. Kept separate so the sheet only mounts when opened. */
export function LabelButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Btn icon="tag" onClick={() => setOpen(true)}>Print labels</Btn>
      {open && <AssetLabels onClose={() => setOpen(false)} />}
    </>
  );
}

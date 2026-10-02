import { useEffect, useState } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { api, ApiError } from '../lib/api';

export type Tone = 'ok' | 'warn' | 'crit' | 'acc' | '';

export function Chip({ tone = '', lamp, children }:
  { tone?: Tone; lamp?: boolean; children: ReactNode }) {
  return (
    <span className={`chip ${tone}`}>
      {lamp && <i className={`lamp ${tone || 'idle'}`} />}
      {children}
    </span>
  );
}

export function Card({ title, right, flush, className, children }:
  { title?: string; right?: ReactNode; flush?: boolean; className?: string; children: ReactNode }) {
  return (
    <section className={`card ${className ?? ''}`}>
      {(title || right) && (
        <header>
          {title && <h2>{title}</h2>}
          {right && <div className="r">{right}</div>}
        </header>
      )}
      <div className={flush ? 'body flush' : 'body'}>{children}</div>
    </section>
  );
}

export function Tile({ label, value, unit, sub, tone }:
  { label: string; value: ReactNode; unit?: string; sub?: ReactNode; tone?: Tone }) {
  return (
    <div className="tile">
      <div className="t-lab">{label}</div>
      <div className="t-val" style={tone ? { color: `var(--${tone === 'acc' ? 'accent' : tone})` } : undefined}>
        {value}{unit && <u>{unit}</u>}
      </div>
      {sub && <div className="t-sub">{sub}</div>}
    </div>
  );
}

/**
 * An empty screen is the one moment a person is guaranteed to be reading, and for most of
 * this system it is also the first thing they ever see. So it gets a reason and a way out
 * rather than the word "None": `hint` says why it is empty, `action` is the single next
 * step, and `need` is the permission that step requires — passed so that a technician is
 * told who to ask instead of being handed a button the server would refuse.
 */
export function Empty({ title, hint, action, ask }:
  { title: string; hint?: ReactNode; action?: ReactNode; ask?: string }) {
  return (
    <div className="empty">
      <b>{title}</b>
      {hint}
      {action && <div className="act">{action}</div>}
      {!action && ask && <div className="ask">{ask}</div>}
    </div>
  );
}

export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div style={{ display: 'grid', gap: 8, padding: 15 }} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ height: 34, opacity: 1 - i * 0.18 }} />
      ))}
    </div>
  );
}

export function ErrorNote({ error, hint }: { error: unknown; hint?: string }) {
  const message = error instanceof Error ? error.message : 'Something went wrong.';
  return (
    <div className="note crit err">
      <b>{message}</b>
      {hint && <div style={{ marginTop: 6 }}>{hint}</div>}
    </div>
  );
}

export function Btn({ icon, tone, size, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> &
  { icon?: IconName; tone?: 'pri' | 'danger' | 'on'; size?: 'sm' }) {
  const { children, className, ...button } = rest;
  return (
    <button className={`btn ${tone ?? ''} ${size ?? ''} ${className ?? ''}`} {...button}>
      {icon && <Icon name={icon} />}
      {children}
    </button>
  );
}

export function Gauge({ name, litres, capacity, minLevel }:
  { name: string; litres: number | null; capacity: number; minLevel?: number }) {
  const pct = litres == null ? 0 : Math.max(0, Math.min(100, (litres / capacity) * 100));
  const low = minLevel != null && litres != null && litres < minLevel;
  const tone = low ? 'crit' : pct < 40 ? 'warn' : '';
  return (
    <div className="gauge">
      <div className="tube">
        <i className={tone} style={{ height: `${pct}%` }} />
        {minLevel != null && (
          <div className="mn" style={{ bottom: `${(minLevel / capacity) * 100}%` }}><span>MIN</span></div>
        )}
      </div>
      <div className="gv">
        {litres == null ? '—' : Math.round(litres).toLocaleString('en-NG')}<u> L</u>
      </div>
      <div className="gn">{name} · {capacity.toLocaleString('en-NG')} L</div>
    </div>
  );
}

/**
 * One modal for every form in the app. On a phone it becomes a bottom sheet, because a
 * centred dialog with a keyboard open leaves nothing visible to type into.
 */
export function Modal({ title, onClose, wide, actions, children }:
  { title: string; onClose: () => void; wide?: boolean; actions?: ReactNode; children: ReactNode }) {
  // The print stylesheet needs to know a dialog is open so it can print the dialog and
  // not the screen behind it. A body class does that in every browser; :has() does not.
  useEffect(() => {
    document.body.classList.add('modal-open');
    return () => document.body.classList.remove('modal-open');
  }, []);

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={title}
         onClick={onClose}
         onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
      <div className="modal-card" style={wide ? { width: 'min(980px,95vw)' } : undefined}
           onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>{title}</h2>
          <div className="r">
            {actions}
            <button className="icobtn no-print" onClick={onClose} aria-label="Close">
              <Icon name="x" size={15} />
            </button>
          </div>
        </header>
        <div className="body">{children}</div>
      </div>
    </div>
  );
}

export function Field({ label, hint, children }:
  { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="fld">
      <label>{label}</label>
      {children}
      {hint && <div style={{ marginTop: 5, fontSize: '0.7188rem', color: 'var(--text-3)' }}>{hint}</div>}
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, items }:
  { value: T; onChange: (v: T) => void; items: { key: T; label: string; count?: number }[] }) {
  return (
    <div className="tabs" role="tablist">
      {items.map((t) => (
        <button key={t.key} role="tab" aria-selected={value === t.key}
                className={value === t.key ? 'on' : ''} onClick={() => onChange(t.key)}>
          {t.label}
          {t.count != null && t.count > 0 && <span className="cnt">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Spend against budget. Over 100% the bar stays full and turns red rather than overflowing. */
export function BudgetBar({ budget, actual }: { budget: number; actual: number }) {
  const pct = budget > 0 ? (actual / budget) * 100 : actual > 0 ? 100 : 0;
  const tone = pct > 100 ? 'crit' : pct > 85 ? 'warn' : '';
  return (
    <div className="bbar" title={`${Math.round(pct)}% of budget`}>
      <i className={tone} style={{ width: `${Math.min(100, pct)}%` }} />
      <span className="cap">{budget > 0 ? `${Math.round(pct)}%` : 'no budget'}</span>
    </div>
  );
}

/** A short-lived line under the page head; every mutation on these screens reports here. */
export function Flash({ msg }: { msg: { text: string; bad?: boolean } | null }) {
  if (!msg) return null;
  return (
    <div className={`note ${msg.bad ? 'crit' : ''}`} style={{ marginBottom: 14 }}
         role={msg.bad ? 'alert' : 'status'}>{msg.text}</div>
  );
}

/**
 * Sends the page to the printer. The print stylesheet decides what actually comes out —
 * this is only the trigger, and it hides itself from the printed copy.
 */
export function PrintBtn({ label = 'Print' }: { label?: string }) {
  return (
    <Btn className="no-print" icon="doc" onClick={() => window.print()}>{label}</Btn>
  );
}

/** Signature lines. Hidden on screen, laid out for paper by the print stylesheet. */
export function SignOff({ lines }: { lines: string[] }) {
  return (
    <div className="signoff" aria-hidden="true">
      {lines.map((l) => <div key={l}>{l}</div>)}
    </div>
  );
}

/**
 * A download of a server-rendered file. A plain <a download> is the whole mechanism:
 * fetching it into memory first would double the peak memory of a big export and lose
 * the filename the server already chose.
 */
export function DownloadLink({ href, children, ...rest }:
  { href: string; children: ReactNode } & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  return (
    <a className="btn no-print" href={href} download {...rest}>
      <Icon name="doc" />{children}
    </a>
  );
}

/**
 * The month a screen is scoped to, with a step either way.
 *
 * Forward stops at the current month: there is no data in October yet, and a picker that
 * lets somebody walk into an empty future is a picker that gets reported as a bug. The
 * eyebrow says plainly when the view is not "now", because a screen showing March's
 * numbers that looks exactly like a screen showing today's is how a decision gets made
 * on the wrong figures.
 */
export function MonthBar({ month, label, isCurrent, onStep, onSet, onReset, note, right }: {
  month: string; label: string; isCurrent: boolean;
  onStep: (by: number) => void; onSet: (month: string) => void; onReset: () => void;
  note?: ReactNode; right?: ReactNode;
}) {
  return (
    <div className="monthbar no-print">
      <button className="icobtn" onClick={() => onStep(-1)} aria-label="Previous month">
        <Icon name="left" />
      </button>
      <b>{label}</b>
      <button className="icobtn" onClick={() => onStep(1)} disabled={isCurrent}
              aria-label="Next month" title={isCurrent ? 'This is the current month' : undefined}>
        <Icon name="right" />
      </button>
      {!isCurrent && <button className="btn sm" onClick={onReset}>This month</button>}
      {note && <span className="mnote">{note}</span>}
      <span className="spacer" />
      {right}
      {/* Jumping eleven months back one click at a time is nobody's idea of a good time. */}
      <input type="month" className="inp mpick" value={month} max={thisMonthValue()}
             aria-label="Jump to a month"
             onChange={(e) => { if (/^\d{4}-\d{2}$/.test(e.target.value)) onSet(e.target.value); }} />
    </div>
  );
}

function thisMonthValue(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Take a record out of use.
 *
 * The department's complaint was simple: you could add a tank, a place, a supply, a stock
 * item — and never take one away. This is the one control for all of them.
 *
 * It says "Retire", not "Delete", because that is what happens: nothing is removed from
 * the database, because a row that a movement or an audit entry points at has to keep
 * existing. The confirm names the thing, and a refusal from the server (something live is
 * still attached to it) is shown as a sentence rather than swallowed.
 */
export function RetireBtn({ kind, id, label, active = true, onDone, size = 'sm' }: {
  kind: string; id: string; label: string; active?: boolean;
  onDone: (message: string) => void; size?: 'sm';
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  async function go(makeActive: boolean) {
    setBusy(true); setErr(null);
    try {
      const r = await api.post<{ message: string }>(`/api/retire/${kind}/${id}`, { active: makeActive });
      setAsking(false);
      onDone(r.message);
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  if (!active) {
    return (
      <Btn size={size} disabled={busy} onClick={() => void go(true)}>
        {busy ? 'Restoring…' : 'Bring back'}
      </Btn>
    );
  }
  return (
    <>
      <Btn size={size} onClick={() => { setErr(null); setAsking(true); }}>Retire</Btn>
      {asking && (
        <Modal title={`Retire ${label}?`} onClose={() => setAsking(false)}>
          <p style={{ margin: '0 0 12px', lineHeight: 1.55 }}>
            <b>{label}</b> stops appearing in lists and pickers from now on.
          </p>
          <div className="note" style={{ marginBottom: 14 }}>
            Nothing is deleted. Every job, movement and record that already refers to it keeps
            working and keeps reading correctly — and you can bring it back at any time.
          </div>
          {err && <div className="note crit" style={{ marginBottom: 12 }} role="alert">{err}</div>}
          <div className="modal-foot">
            <Btn onClick={() => setAsking(false)}>Cancel</Btn>
            <Btn tone="pri" disabled={busy} onClick={() => void go(false)}>
              {busy ? 'Retiring…' : 'Retire it'}
            </Btn>
          </div>
        </Modal>
      )}
    </>
  );
}

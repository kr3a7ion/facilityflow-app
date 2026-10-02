/** Money is integer kobo on the wire, and it stays integer here. */
export function naira(kobo: number | null | undefined, opts: { compact?: boolean } = {}): string {
  if (kobo == null) return '—';
  const sign = kobo < 0 ? '-' : '';
  const abs = Math.abs(kobo);
  if (opts.compact && abs >= 100_000_00) {
    const m = abs / 100_000_000;
    if (m >= 1) return `${sign}₦${m.toFixed(2)}m`;
    return `${sign}₦${(abs / 100_000).toFixed(0)}k`;
  }
  return `${sign}₦${Math.floor(abs / 100).toLocaleString('en-NG')}`;
}

export function litres(n: number | null | undefined, dp = 0): string {
  return n == null ? '—' : `${n.toLocaleString('en-NG', { maximumFractionDigits: dp })} L`;
}

export function hours(n: number | null | undefined): string {
  return n == null ? '—' : `${n.toLocaleString('en-NG', { maximumFractionDigits: 1 })} h`;
}

/** "1h 40m late" reads better on a board than a timestamp. */
export function duration(minutes: number | null | undefined): string {
  if (minutes == null) return '—';
  const m = Math.abs(Math.round(minutes));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  // "14d" rather than "14d 0h" — a trailing zero unit reads like a truncated number.
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

export function slaLabel(sla: { state: string; minutesRemaining: number | null }): string {
  switch (sla.state) {
    case 'breached': return `Breached ${duration(sla.minutesRemaining)}`;
    case 'due_soon': return `Due in ${duration(sla.minutesRemaining)}`;
    case 'paused': return 'Clock paused';
    case 'settled': return 'Settled';
    default: return sla.minutesRemaining == null ? 'No deadline' : `Due in ${duration(sla.minutesRemaining)}`;
  }
}

export function slaTone(state: string): 'ok' | 'warn' | 'crit' | '' {
  return state === 'breached' ? 'crit' : state === 'due_soon' ? 'warn' : state === 'on_time' ? 'ok' : '';
}

export function when(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

export function timeOnly(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '—';
}

export function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');
}

export function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

/** Short enough to sit on one line in a page eyebrow. */
export function compact(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' })} ${
    d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}`;
}

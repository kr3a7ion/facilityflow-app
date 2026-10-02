import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * The month a screen is showing.
 *
 * Screens are scoped to a month because a property three years in has tens of thousands
 * of rows behind every list, and the host is one office PC. It lives in the URL rather
 * than in component state so a link somebody sends over WhatsApp — "look at August" —
 * opens on August, and so the back button steps through months the way people expect.
 */
export function thisMonth(at: Date = new Date()): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}`;
}

export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date((y ?? 1970), (m ?? 1) - 1 + by, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  if (!y || !m) return month;
  return new Date(y, m - 1, 15).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

export function monthShort(month: string): string {
  const [y, m] = month.split('-').map(Number);
  if (!y || !m) return month;
  return new Date(y, m - 1, 15).toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
}

export interface MonthState {
  month: string;
  /** True when the screen is showing the month the property is actually in. */
  isCurrent: boolean;
  label: string;
  set: (month: string) => void;
  step: (by: number) => void;
  reset: () => void;
  /** Ready to append to a request path that already has a query string. */
  param: string;
}

export function useMonth(): MonthState {
  const [params, setParams] = useSearchParams();
  const current = thisMonth();
  const raw = params.get('month');
  const month = raw && /^\d{4}-\d{2}$/.test(raw) ? raw : current;

  const set = useCallback((next: string) => {
    setParams((p) => {
      const n = new URLSearchParams(p);
      // The current month is the default, so it does not need to clutter the address.
      if (next === thisMonth()) n.delete('month'); else n.set('month', next);
      return n;
    }, { replace: true });
  }, [setParams]);

  return useMemo(() => ({
    month,
    isCurrent: month === current,
    label: monthLabel(month),
    set,
    step: (by: number) => set(shiftMonth(month, by)),
    reset: () => set(current),
    param: `month=${month}`,
  }), [month, current, set]);
}

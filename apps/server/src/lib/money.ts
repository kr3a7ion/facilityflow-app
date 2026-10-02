/**
 * Money is integer kobo. No floats in any monetary column, ever.
 * 100 kobo = 1 naira.
 */
export function nairaToKobo(naira: number): number {
  if (!Number.isFinite(naira)) throw new TypeError('naira must be a finite number');
  return Math.round(naira * 100);
}

export function koboToNaira(kobo: number): number {
  assertKobo(kobo);
  return kobo / 100;
}

export function assertKobo(value: number): void {
  if (!Number.isInteger(value)) {
    throw new TypeError(`money must be integer kobo, received ${value}`);
  }
}

export function formatNaira(kobo: number): string {
  assertKobo(kobo);
  const sign = kobo < 0 ? '-' : '';
  const abs = Math.abs(kobo);
  const naira = Math.floor(abs / 100).toLocaleString('en-NG');
  return `${sign}₦${naira}.${String(abs % 100).padStart(2, '0')}`;
}

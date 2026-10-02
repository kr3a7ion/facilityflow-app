/**
 * How big everything is.
 *
 * The department reads this on a phone held at arm's length in a plant room, in daylight
 * on a balcony, and on a store tablet by somebody who left their glasses upstairs. One
 * type size cannot serve all of that, and "just zoom the browser" is not an answer on a
 * home-screen shortcut with no address bar.
 *
 * Implemented as the root font size, with every type size in the interface expressed in
 * rem — both the stylesheet's and the forty-odd inline ones, which were converted for
 * this. The obvious alternative, `zoom` on the document, was tried first and measured:
 * it scales `position: fixed` bottom offsets along with everything else, which pushed the
 * phone's navigation bar twenty pixels below the bottom of the screen at the largest
 * setting. A text-size control that hides the navigation is not a text-size control.
 *
 * Scaling type and leaving the frame alone is also the better behaviour: the top bar, the
 * tab bar and the side rail stay where the thumb already expects them, and what grows is
 * the thing somebody is squinting at.
 */
export type TextSize = 'normal' | 'large' | 'larger';

const KEY = 'ff-text-size';

export const SCALE: Record<TextSize, number> = {
  normal: 1,
  large: 1.15,
  larger: 1.3,
};

export const LABEL: Record<TextSize, string> = {
  normal: 'Normal',
  large: 'Large',
  larger: 'Larger',
};

/** Per device, like the sound toggle and the theme: this is about eyes, not accounts. */
export function textSize(): TextSize {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'large' || v === 'larger' ? v : 'normal';
  } catch {
    return 'normal';
  }
}

/** The base every rem in the interface is a multiple of. */
export const BASE_PX = 16;

export function applyTextSize(size: TextSize): void {
  const root = document.documentElement;
  // Normal removes the property rather than setting 16px, so the browser's own default —
  // which somebody may have raised for exactly this reason — keeps working.
  if (size === 'normal') root.style.removeProperty('font-size');
  else root.style.setProperty('font-size', `${BASE_PX * SCALE[size]}px`);
  root.setAttribute('data-text-size', size);
}

export function setTextSize(size: TextSize): void {
  applyTextSize(size);
  try { localStorage.setItem(KEY, size); } catch { /* private mode */ }
}

export function nextTextSize(size: TextSize): TextSize {
  return size === 'normal' ? 'large' : size === 'large' ? 'larger' : 'normal';
}

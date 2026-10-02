import type { ReactElement } from 'react';

export type IconName =
  | 'gauge' | 'clip' | 'cal' | 'fuel' | 'bldg' | 'swap' | 'box' | 'search' | 'bell' | 'theme'
  | 'plus' | 'check' | 'back' | 'cam' | 'alert' | 'user' | 'wrench' | 'clock' | 'bolt' | 'out'
  | 'money' | 'shield' | 'repeat' | 'tag' | 'doc' | 'lock' | 'x' | 'sound' | 'muted'
  | 'left' | 'right' | 'grid' | 'rows' | 'amp' | 'text';

const P: Record<IconName, ReactElement> = {
  gauge: <><path d="M3 13a9 9 0 0 1 18 0"/><path d="M12 13l4-3"/><path d="M3 19h18"/></>,
  clip: <><rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4h6v3H9z"/><path d="M9 12h6M9 16h4"/></>,
  cal: <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></>,
  fuel: <><path d="M4 20V5a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v15"/><path d="M3 20h11"/><path d="M13 9h3a2 2 0 0 1 2 2v5a1.5 1.5 0 0 0 3 0V9l-2.5-3"/></>,
  bldg: <><rect x="4" y="3" width="16" height="18" rx="1.5"/><path d="M8 7h2M14 7h2M8 11h2M14 11h2M8 15h2M14 15h2"/><path d="M3 21h18"/></>,
  swap: <><path d="M4 8h13l-3-3M20 16H7l3 3"/></>,
  box: <><path d="M3 8l9-4 9 4v8l-9 4-9-4z"/><path d="M3 8l9 4 9-4M12 12v8"/></>,
  search: <><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></>,
  bell: <><path d="M18 15V10a6 6 0 1 0-12 0v5l-2 3h16z"/><path d="M10 21h4"/></>,
  theme: <><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/></>,
  plus: <><path d="M12 5v14M5 12h14"/></>,
  check: <><path d="M4 12.5l5 5L20 6.5"/></>,
  back: <><path d="M15 5l-7 7 7 7"/></>,
  cam: <><path d="M3 8h3l2-2.5h8L18 8h3v11H3z"/><circle cx="12" cy="13.5" r="3.5"/></>,
  alert: <><path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.2v.1"/></>,
  user: <><circle cx="12" cy="8" r="3.6"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/></>,
  wrench: <><path d="M15.5 3.5a5.5 5.5 0 0 0-6.9 6.9L3 16v5h5l5.6-5.6a5.5 5.5 0 0 0 6.9-6.9L17 12l-3-.5-.5-3z"/></>,
  clock: <><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></>,
  bolt: <><path d="M13 2L4 14h6l-1 8 9-12h-6z"/></>,
  out: <><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 16l-4-4 4-4M6 12h10"/></>,
  money: <><path d="M7 6v12M17 6v12"/><path d="M5 9h14M5 15h14"/><path d="M7 6l10 12"/></>,
  shield: <><path d="M12 3l8 3v6c0 4.4-3.2 7.9-8 9-4.8-1.1-8-4.6-8-9V6z"/><path d="M9 12l2 2 4-4"/></>,
  repeat: <><path d="M4 10a6 6 0 0 1 6-6h9l-3-3M20 14a6 6 0 0 1-6 6H5l3 3"/></>,
  tag: <><path d="M3 12.5V5a2 2 0 0 1 2-2h7.5L21 11.5 12.5 20z"/><circle cx="8" cy="8" r="1.4"/></>,
  doc: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></>,
  lock: <><rect x="4.5" y="10" width="15" height="10.5" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>,
  x: <><path d="M6 6l12 12M18 6L6 18"/></>,
  sound: <><path d="M11 5L6.5 9H3v6h3.5L11 19z"/><path d="M15.5 9.5a3.5 3.5 0 0 1 0 5"/><path d="M18 7a7 7 0 0 1 0 10"/></>,
  muted: <><path d="M11 5L6.5 9H3v6h3.5L11 19z"/><path d="M16 10l5 4M21 10l-5 4"/></>,
  left: <><path d="M14.5 5l-7 7 7 7"/></>,
  right: <><path d="M9.5 5l7 7-7 7"/></>,
  // A large A beside a small one: the control that makes type bigger, drawn as itself.
  text: <><path d="M2.5 19l5-13 5 13"/><path d="M4.2 15h6.6"/><path d="M14.5 19l3.6-9 3.6 9"/><path d="M15.7 16.2h4.8"/></>,
  grid: <><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></>,
  rows: <><path d="M4 6h16M4 12h16M4 18h16"/></>,
  amp: <><path d="M13 2L4 14h6l-1 8 9-12h-6z"/><path d="M2 20h4M18 20h4"/></>,
};

export function Icon({ name, size }: { name: IconName; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
         strokeLinecap="round" strokeLinejoin="round"
         width={size} height={size} aria-hidden="true">
      {P[name]}
    </svg>
  );
}

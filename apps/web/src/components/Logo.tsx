/**
 * The FacilityFlow mark.
 *
 * It is a single-line diagram, which happens to also be an F: a supply node entering at
 * the top, a busbar running down, two feeders branching off it. That is the drawing on
 * the inside of every distribution board door in the building this software runs in, and
 * it is the shape of the letter the product starts with — so the mark says what the
 * system is about without resorting to a spanner or a lightning bolt.
 *
 * Drawn rather than shipped as an image file: it has to render on a host with no route to
 * the internet, it has to stay crisp on a 16px browser tab and a printed permit alike, and
 * it has to take its colour from whatever surface it lands on.
 */
export function Logo({ size = 24, title }: { size?: number; title?: string }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} fill="none"
         role={title ? 'img' : undefined} aria-hidden={title ? undefined : true}
         aria-label={title}>
      {title && <title>{title}</title>}
      {/* The incomer. Filled, because a node on a schematic is filled. */}
      <circle cx="11" cy="6.4" r="3.1" fill="currentColor" />
      <g stroke="currentColor" strokeWidth="3.5" strokeLinecap="round">
        {/* Busbar */}
        <path d="M11 8.6V25.4" />
        {/* Two feeders, unequal, the way a real board is loaded */}
        <path d="M11 12.9H24.6" />
        <path d="M11 19.6H19.8" />
      </g>
    </svg>
  );
}

/** The mark on its accent tile — the sidebar, the tab icon, the sign-in screen. */
export function LogoTile({ size = 30, radius }: { size?: number; radius?: number }) {
  const r = radius ?? Math.round(size * 0.24);
  return (
    <span style={{
      width: size, height: size, borderRadius: r, background: 'var(--accent)',
      color: 'var(--on-accent)', display: 'grid', placeItems: 'center', flex: 'none',
    }}>
      <Logo size={Math.round(size * 0.62)} />
    </span>
  );
}

/**
 * Mark plus name, for the sign-in and first-run screens where there is no sidebar to
 * carry the identity.
 */
export function Wordmark({ size = 44 }: { size?: number }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 12 }}>
      <LogoTile size={size} />
      <span style={{ minWidth: 0 }}>
        <span style={{
          fontFamily: 'var(--cond)', fontSize: Math.round(size * 0.72), fontWeight: 700,
          letterSpacing: '.02em', textTransform: 'uppercase', lineHeight: 1, display: 'block',
        }}>
          FacilityFlow
        </span>
        <span style={{
          display: 'block', fontFamily: 'var(--mono)', fontSize: Math.max(9, Math.round(size * 0.21)),
          letterSpacing: '.16em', color: 'var(--text-3)', textTransform: 'uppercase',
          marginTop: 3,
        }}>
          Maintenance &amp; FM
        </span>
      </span>
    </span>
  );
}

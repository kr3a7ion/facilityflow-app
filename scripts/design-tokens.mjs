/**
 * The design system, checked rather than trusted.
 *
 * Two things rot in a stylesheet nobody guards. Contrast slips a few points at a time
 * until a label nobody tested is unreadable in daylight, and the scales grow back —
 * someone needs 15px, types 15px, and a year later there are 27 sizes again.
 *
 * So both are assertions here, and they run with the rest of the suite.
 *
 *   node scripts/design-tokens.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const CSS_PATH = join(here, '..', 'apps', 'web', 'src', 'styles', 'theme.css');
const css = readFileSync(CSS_PATH, 'utf8');

let failures = 0;
let checks = 0;
const fail = (msg) => { failures++; console.error(`  FAIL  ${msg}`); };
const pass = () => { checks++; };

/* ---------------------------------------------------------------- contrast ---- */

const srgb = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function luminance(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
}

function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Pull the hex tokens out of one `:root`-ish block. */
function tokensIn(block) {
  const out = {};
  for (const m of block.matchAll(/--([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*[;}]/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

// The light theme is the bare `:root{...}` block that carries --bg; dark is the
// explicit [data-theme="dark"] block. The media-query copy is asserted to match it.
const blocks = [...css.matchAll(/:root(\[data-theme="dark"\])?\s*\{([^}]*)\}/g)];
const light = tokensIn(blocks.find((b) => !b[1] && b[2].includes('--bg:'))?.[2] ?? '');
const dark = tokensIn(blocks.find((b) => b[1])?.[2] ?? '');

if (!light['bg'] || !dark['bg']) {
  fail('could not find the light and dark token blocks in theme.css');
}

const SURFACES = ['panel', 'panel-2', 'panel-3', 'bg'];
// Text and iconography placed directly on a surface. All of it has to be legible.
const ON_SURFACE = ['text', 'text-2', 'text-3', 'accent', 'accent-hi', 'ok', 'warn', 'crit', 'idle'];
// Tinted pills: a status colour on its own washed background.
const TINTS = [['ok', 'ok-bg'], ['warn', 'warn-bg'], ['crit', 'crit-bg'], ['idle', 'idle-bg'],
               ['accent', 'accent-soft']];

const AA = 4.5;

for (const [themeName, t] of [['light', light], ['dark', dark]]) {
  for (const fg of ON_SURFACE) {
    for (const bg of SURFACES) {
      if (!t[fg] || !t[bg]) { fail(`${themeName}: missing --${fg} or --${bg}`); continue; }
      const r = contrast(t[fg], t[bg]);
      if (r < AA) fail(`${themeName}: --${fg} (${t[fg]}) on --${bg} (${t[bg]}) is ${r.toFixed(2)}:1, needs ${AA}`);
      else pass();
    }
  }
  for (const [fg, bg] of TINTS) {
    const r = contrast(t[fg], t[bg]);
    if (r < AA) fail(`${themeName}: --${fg} on --${bg} is ${r.toFixed(2)}:1, needs ${AA}`);
    else pass();
  }
  // Text written *on* the accent — buttons, the active nav pill, the brand mark.
  const r = contrast(t['on-accent'], t['accent']);
  if (r < AA) fail(`${themeName}: --on-accent on --accent is ${r.toFixed(2)}:1, needs ${AA}`);
  else pass();
}

// The dark palette is written twice — once for the OS preference, once for the explicit
// switch. If they drift, one half of the users get a theme nobody checked.
const mediaDark = tokensIn(
  css.match(/@media \(prefers-color-scheme:dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{([^}]*)\}/)?.[1] ?? ''
);
for (const k of Object.keys(dark)) {
  if (mediaDark[k] !== dark[k]) {
    fail(`dark theme disagrees with itself on --${k}: [data-theme] says ${dark[k]}, @media says ${mediaDark[k]}`);
  } else pass();
}

/* ------------------------------------------------------------ scale drift ---- */

/*
 * Print is exempt. It is in points and millimetres against physical paper, and it is
 * black on white on purpose — a theme token there would be a bug, not a fix.
 */
const lines = css.split('\n');
const frozenStart = lines.findIndex((l) => l.includes('/* ---------------- print ----------------'));
const frozenEnd = lines.findIndex((l) => l.includes('/* ---------------- month scoping ----------------'));
const frozen = (i) => frozenStart >= 0 && i >= frozenStart && i < frozenEnd;

const SPACE_PROP = /\b(?:padding|margin|gap|row-gap|column-gap)(?:-(?:top|right|bottom|left))?\s*:\s*([^;}]+)/g;

lines.forEach((line, i) => {
  if (frozen(i)) return;
  const at = `theme.css:${i + 1}`;

  for (const m of line.matchAll(/font-size\s*:\s*([^;}!]+)/g)) {
    const v = m[1].trim();
    if (!v.startsWith('var(--fs-')) fail(`${at} font-size:${v} — use a step from the type scale`);
    else pass();
  }

  for (const m of line.matchAll(/border-radius\s*:\s*([^;}!]+)/g)) {
    const v = m[1].trim();
    // 50% is a circle, and 0 switches the radius off. Neither is a scale step.
    if (v === '50%' || v === '0') { pass(); continue; }
    if (!v.includes('var(--r')) fail(`${at} border-radius:${v} — use a step from the radius scale`);
    else pass();
  }

  for (const m of line.matchAll(SPACE_PROP)) {
    // 1px is optical alignment against a border; env() and calc() are layout.
    const stray = [...m[1].matchAll(/(?<![-.\w])(\d+)px/g)].map((x) => Number(x[1])).filter((n) => n !== 1);
    if (stray.length) fail(`${at} ${m[0].trim()} — ${stray.join('px, ')}px should come from the space scale`);
    else pass();
  }
});

/* The scales themselves stay short. These numbers are the point of the exercise. */
const countTokens = (prefix) =>
  new Set([...css.matchAll(new RegExp(`--${prefix}[a-z0-9-]*\\s*:`, 'g'))].map((m) => m[0])).size;

const LIMITS = { 'fs-': 8, 's-': 8, 'r': 5 };
for (const [prefix, max] of Object.entries(LIMITS)) {
  const n = prefix === 'r'
    ? new Set([...css.matchAll(/--r(?:-[a-z]+)?\s*:/g)].map((m) => m[0])).size
    : countTokens(prefix);
  if (n > max) fail(`${n} --${prefix}* tokens; the scale is meant to hold at ${max}`);
  else pass();
}

/* --------------------------------------------------------------- result ---- */

if (failures) {
  console.error(`\ndesign tokens: ${failures} failed, ${checks} passed\n`);
  process.exit(1);
}
console.log(`design tokens: ${checks} checks passed (contrast AA on every surface, both themes; no scale drift)`);

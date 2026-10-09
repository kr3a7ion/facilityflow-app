/**
 * Contrast, tap targets and overflow, measured in a real browser on the real pages.
 *
 * The token check (scripts/design-tokens.mjs) proves the palette is sound. This proves
 * the pages are, which is a different claim: a token that passes on --panel still fails
 * if a component puts it on a tinted row, and only a browser knows what the tint
 * resolved to.
 *
 * Two things this has to get right, and an earlier version of it got both wrong:
 *
 *  - Chromium reports a `color-mix()` result as `color(srgb 0.9 0.93 0.93)` — floats in
 *    0..1, not 0..255. Read naively, a near-white row reads as near-black and the whole
 *    report is noise.
 *  - A translucent background has to be composited over what is behind it. The
 *    emergency button is 10% red over the panel; treating it as solid red invents a
 *    failure that nobody can see.
 *
 *   node scripts/contrast-audit.mjs [--json]
 */
import { chromium } from 'playwright';

const BASE = process.env.FF_BASE ?? 'http://127.0.0.1:4700';
const USER = process.env.FF_USER ?? 'admin';
const PASS = process.env.FF_PASS ?? 'facilityflow-demo';
const SHOTS = process.env.FF_SHOTS ?? null;

const PAGES = [
  ['overview', '/'], ['jobs', '/jobs'], ['apartments', '/apartments'],
  ['power', '/power'], ['money', '/money'], ['admin', '/admin'],
];

const VIEWPORTS = [
  ['phone', { width: 390, height: 844 }, 'light'],
  ['phone-dark', { width: 390, height: 844 }, 'dark'],
  ['desktop', { width: 1440, height: 900 }, 'light'],
  ['desktop-dark', { width: 1440, height: 900 }, 'dark'],
];

/** Runs inside the page. */
function audit() {
  /* ---- colour ---- */

  // rgb(12, 20, 29) / rgba(…, .5) / color(srgb 0.9 0.93 0.93 / 0.1) / #rrggbb
  function parse(s) {
    if (!s) return null;
    let m = s.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)$/);
    if (m) return { r: +m[1] * 255, g: +m[2] * 255, b: +m[3] * 255, a: m[4] === undefined ? 1 : +m[4] };
    m = s.match(/^rgba?\(([\d.]+),?\s*([\d.]+),?\s*([\d.]+)(?:,?\s*\/?\s*([\d.%]+))?\s*\)$/);
    if (m) {
      const a = m[4] === undefined ? 1 : (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4]);
      return { r: +m[1], g: +m[2], b: +m[3], a };
    }
    m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (m) {
      let h = m[1];
      if (h.length === 3) h = [...h].map((c) => c + c).join('');
      return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
    }
    return null;
  }

  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });

  const srgb = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const lum = (c) => 0.2126 * srgb(c.r) + 0.7152 * srgb(c.g) + 0.0722 * srgb(c.b);
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)];
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };

  /** The colour actually behind an element: every translucent layer composited down. */
  function behind(el) {
    const layers = [];
    let n = el;
    while (n && n !== document.documentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0) {
        layers.push(c);
        if (c.a >= 0.999) break;      // opaque: nothing below it matters
      }
      n = n.parentElement;
    }
    const root = parse(getComputedStyle(document.documentElement).backgroundColor)
              ?? parse(getComputedStyle(document.body).backgroundColor)
              ?? { r: 255, g: 255, b: 255, a: 1 };
    layers.push({ ...root, a: 1 });
    // bottom-up
    let acc = layers[layers.length - 1];
    for (let i = layers.length - 2; i >= 0; i--) acc = over(layers[i], acc);
    return acc;
  }

  /* ---- walk ---- */

  const failures = [];
  const small = [];
  const seenTarget = new Set();

  for (const el of document.querySelectorAll('body *')) {
    const box = el.getBoundingClientRect();
    if (!box.width || !box.height) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue;

    // its own text, not its descendants'
    const own = [...el.childNodes].filter((n) => n.nodeType === 3)
      .map((n) => n.textContent.trim()).join(' ').trim();

    if (own) {
      const fg0 = parse(cs.color);
      if (fg0) {
        const bg = behind(el);
        const fg = fg0.a < 0.999 ? over(fg0, bg) : fg0;
        const px = parseFloat(cs.fontSize);
        const weight = parseInt(cs.fontWeight, 10) || 400;
        const large = px >= 24 || (px >= 18.66 && weight >= 700);
        const need = large ? 3 : 4.5;
        const r = ratio(fg, bg);
        if (r < need) {
          failures.push({
            text: own.slice(0, 40), sel: String(el.className || el.tagName).slice(0, 44),
            px: +px.toFixed(1), weight, ratio: +r.toFixed(2), need,
            color: cs.color, bg: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})`,
          });
        }
      }
    }

    /*
     * Two bars, because there genuinely are two.
     *
     *   24px — WCAG 2.2 AA (2.5.8 Target Size Minimum). Below this is a failure
     *          anywhere, on any device.
     *   44px — WCAG AAA / Apple HIG. On a desk with a mouse this is overkill; on the
     *          phone a technician is holding in a plant room, wearing gloves, with one
     *          hand on a ladder rail, it is the number that matters.
     *
     * So a small target is reported, but only one under 24, or one under 44 on a phone,
     * counts as a failure.
     */
    if (el.matches('a[href],button,input:not([type=hidden]),select,textarea,[role="button"],[role="tab"]')
        && !el.closest('[aria-hidden="true"]')) {
      const key = `${el.tagName}.${el.className}@${Math.round(box.x)},${Math.round(box.y)}`;
      const min = Math.min(box.width, box.height);
      if (!seenTarget.has(key) && min < 44) {
        seenTarget.add(key);
        small.push({
          sel: String(el.className || el.tagName).slice(0, 44),
          label: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 28),
          w: Math.round(box.width), h: Math.round(box.height),
          fails: min < 24,
        });
      }
    }
  }

  const de = document.documentElement;
  return {
    failures: failures.sort((a, b) => a.ratio - b.ratio),
    small: small.sort((a, b) => a.w * a.h - b.w * b.h),
    overflow: de.scrollWidth > de.clientWidth + 1
      ? { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth } : null,
  };
}

/* ------------------------------------------------------------------ driver ---- */

const browser = await chromium.launch({
  executablePath: process.env.FF_CHROMIUM ?? '/opt/pw-browsers/chromium',
  args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost,EXCLUDE 127.0.0.1'],
});

const results = {};
for (const [vpName, viewport, colorScheme] of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport, colorScheme, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.fill('input', USER);
  await page.fill('input[type=password]', PASS);
  await page.click('button[type=submit]');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(700);

  for (const [name, path] of PAGES) {
    await page.goto(BASE + path, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/${vpName}-${name}.png` });
    results[`${vpName}/${name}`] = await page.evaluate(audit);
  }
  await ctx.close();
}
await browser.close();

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(results, null, 1));
} else {
  let totalFail = 0, totalTargetFail = 0, totalSnug = 0, overflowed = 0;
  for (const [key, v] of Object.entries(results)) {
    const phone = key.startsWith('phone');
    // On a phone every one of these is a failure; on a desk only the ones under 24px.
    const bad = v.small.filter((s) => (phone ? true : s.fails));
    const snug = v.small.length - bad.length;
    totalFail += v.failures.length;
    totalTargetFail += bad.length;
    totalSnug += snug;
    if (v.overflow) overflowed++;

    const flags = [
      v.overflow ? `OVERFLOW ${v.overflow.scrollWidth}>${v.overflow.clientWidth}` : null,
      `${v.failures.length} contrast`,
      `${bad.length} target${bad.length === 1 ? '' : 's'} too small` + (snug ? ` (+${snug} snug)` : ''),
    ].filter(Boolean).join('  ·  ');
    console.log(`\n${key.padEnd(24)} ${flags}`);
    for (const f of v.failures.slice(0, 6)) {
      console.log(`   ${String(f.ratio).padStart(5)}:1 (needs ${f.need})  ${f.px}px  "${f.text}"  [${f.sel}]`);
      console.log(`           ${f.color} on ${f.bg}`);
    }
    for (const s of bad.slice(0, 6)) {
      console.log(`   ${s.w}x${s.h}  ${s.sel}  ${s.label ? `— ${s.label}` : ''}`);
    }
  }
  console.log(`\n${'='.repeat(64)}`);
  console.log(`contrast failures:  ${totalFail}`);
  console.log(`targets too small:  ${totalTargetFail}   (<44px on a phone, <24px anywhere)`);
  console.log(`            snug:   ${totalSnug}   (24-44px on a desk — fine with a mouse)`);
  console.log(`pages overflowing:  ${overflowed}/${Object.keys(results).length}`);
  process.exitCode = totalFail > 0 || totalTargetFail > 0 || overflowed > 0 ? 1 : 0;
}

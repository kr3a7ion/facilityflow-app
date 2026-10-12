/**
 * Move inline styles onto the design system.
 *
 * 577 `style={{…}}` blocks across 28 files, and almost all of them are one of six
 * shapes: a margin, a flex row, a full-width button, a thing that takes the slack, a
 * horizontal scroller, or a white-space override. This rewrites those six onto classes
 * that resolve from the token scales, and then PRINTS EVERYTHING IT DID NOT TOUCH.
 *
 * It is deliberately conservative. A style it does not recognise is left exactly as it
 * was and listed for a human to look at, because the failure mode of being clever here
 * is a screen that silently lays out wrong on a phone in a plant room.
 *
 *   node scripts/strip-inline-styles.mjs            # report only
 *   node scripts/strip-inline-styles.mjs --write    # apply
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WRITE = process.argv.includes('--write');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web', 'src');

/* px -> step on the space scale (2,4,6,8,12,16,24,32). Values between steps round to
 * the nearer one; 14 and 15 both mean "a section break", and now they say so. */
const STEP = {
  1: 1, 2: 1, 3: 1, 4: 2, 5: 2, 6: 3, 7: 3, 8: 4, 9: 4,
  10: 5, 11: 5, 12: 5, 13: 5, 14: 6, 15: 6, 16: 6,
  18: 7, 20: 7, 22: 7, 24: 7, 26: 7, 28: 8, 30: 8, 32: 8, 34: 8,
};

/* rem -> step on the type scale. Same bands as the theme.css rewrite, so a size that
 * was var(--fs-ui) in the stylesheet is .t-ui in the markup. */
const TYPE = {
  '0.5': 'micro', '0.5312': 'micro', '0.5625': 'micro', '0.5938': 'micro', '0.625': 'micro',
  '0.6562': 'sm', '0.6875': 'sm', '0.7188': 'sm', '0.75': 'sm',
  '0.7812': 'ui', '0.8125': 'ui', '0.8438': 'ui',
  '0.875': 'body', '0.9062': 'body', '0.9375': 'body', '0.9688': 'body',
  '1': 'lede', '1.0625': 'lede', '1.125': 'lede', '1.1875': 'lede',
  '1.3125': 'title', '1.375': 'title', '1.5': 'title', '1.875': 'title',
  '2.375': 'readout', '2.75': 'readout', '3.25': 'readout-lg',
};

/* The tokens that text is actually coloured with, and the class that says so. */
const COLOUR = {
  'text': 'c-1', 'text-2': 'c-2', 'text-3': 'c-3',
  'ok': 'c-ok', 'warn': 'c-warn', 'crit': 'c-crit', 'idle': 'c-idle',
  'accent': 'c-acc', 'accent-hi': 'c-acc', 'on-accent': 'c-on-acc',
};

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.tsx$/.test(name)) files.push(p);
  }
})(ROOT);

const unhandled = [];
let changed = 0;
let touchedFiles = 0;

/** Add class names to a JSX tag that may already have a className, in any of its forms. */
function addClasses(tag, classes) {
  if (!classes.length) return tag;
  const add = classes.join(' ');

  // className="a b"
  let m = tag.match(/className="([^"]*)"/);
  if (m) return tag.replace(m[0], `className="${m[1]} ${add}"`.replace(/\s+/g, ' ').replace(' "', '"'));

  // className={`a ${x}`}
  m = tag.match(/className=\{`([^`]*)`\}/);
  if (m) return tag.replace(m[0], `className={\`${m[1]} ${add}\`}`);

  // className={expr}  -> wrap it
  m = tag.match(/className=\{([^`][^}]*)\}/);
  if (m) return tag.replace(m[0], `className={\`\${${m[1].trim()}} ${add}\`}`);

  // no className at all: put one just after the tag name
  return tag.replace(/^<([A-Za-z][\w.]*)/, `<$1 className="${add}"`);
}

/**
 * Read one `style={{ ... }}` body into a list of [prop, value] pairs.
 * Returns null if the body has anything we cannot parse flatly (a nested object, a
 * ternary spanning braces, a template literal with a brace in it).
 */
function parseStyle(body) {
  if (/[{}]/.test(body)) return null;
  const parts = [];
  let depth = 0, cur = '';
  for (const ch of body) {
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  const out = [];
  for (const part of parts) {
    const i = part.indexOf(':');
    if (i < 0) return null;
    out.push([part.slice(0, i).trim(), part.slice(i + 1).trim()]);
  }
  return out;
}

/** The six shapes. Returns {classes, keep, flags} or null to leave the tag alone. */
function translate(pairs, tagName) {
  const classes = [];
  const keep = [];
  const flags = [];
  // Only the Btn COMPONENT takes full/grow as props. A plain <button> gets the class,
  // because React would pass an unknown prop straight through to the DOM.
  const isBtn = tagName === 'Btn';

  const px = (v) => {
    const n = Number(String(v).replace(/px$/, ''));
    return Number.isInteger(n) ? n : null;
  };

  let flex = pairs.find(([k]) => k === 'display')?.[1];
  const isRow = flex === "'flex'";
  const isGrid = flex === "'grid'";

  for (const [k, v] of pairs) {
    switch (k) {
      case 'display':
        if (isRow) classes.push('row');
        else if (isGrid) classes.push('grid');
        else if (v === "'none'") classes.push('hidden');
        else if (v === "'block'") classes.push('block');
        else if (v === "'inline-block'") classes.push('inline-block');
        else keep.push([k, v]);
        break;

      case 'marginBottom': {
        const n = px(v);
        if (n === 0) { classes.push('mb-0'); break; }
        if (n && STEP[n]) classes.push(`mb-${STEP[n]}`);
        else keep.push([k, v]);
        break;
      }
      case 'marginTop': {
        const n = px(v);
        if (n === 0) { classes.push('mt-0'); break; }
        if (n && STEP[n]) classes.push(`mt-${STEP[n]}`);
        else keep.push([k, v]);
        break;
      }
      case 'margin': {
        // only the two shorthand forms that actually appear: '0 0 Npx' and 'Npx 0 0'
        const mm = String(v).match(/^'(\d+)(?:px)? 0 (\d+)(?:px)?'$/);
        if (mm) {
          const [, top, bot] = mm;
          const t = Number(top), b = Number(bot);
          if ((t === 0 || STEP[t]) && (b === 0 || STEP[b])) {
            classes.push(t === 0 ? 'mt-0' : `mt-${STEP[t]}`);
            classes.push(b === 0 ? 'mb-0' : `mb-${STEP[b]}`);
            break;
          }
        }
        if (/^'0'$/.test(v) || /^0$/.test(v)) { classes.push('m-0'); break; }
        // margin: N — the same on all four sides
        const one = px(v);
        if (one !== null && STEP[one]) { classes.push(`m-${STEP[one]}`); break; }
        keep.push([k, v]);
        break;
      }

      case 'gap': {
        const n = px(v);
        if ((isRow || isGrid) && n && STEP[n]) classes.push(`gap-${STEP[n]}`);
        else if (n && STEP[n]) classes.push(`gap-${STEP[n]}`);
        else keep.push([k, v]);
        break;
      }

      case 'flexWrap':
        // wrapping is the default on .row, so only the opt-out is worth a class
        if (v === "'wrap'" && isRow) break;
        if (v === "'nowrap'" && isRow) { classes.push('nowrap'); break; }
        keep.push([k, v]);
        break;

      case 'alignItems':
        // On its own (no display:flex beside it) this is an override on a container that
        // is already a .row from the stylesheet — .vhead, .card>header, .who. Same
        // classes apply either way.
        if (v === "'center'" && (isRow || isGrid)) break;  // .row default
        if (v === "'flex-start'") { classes.push('start'); break; }
        if (v === "'baseline'") { classes.push('base'); break; }
        if (v === "'flex-end'") { classes.push('bottom'); break; }
        keep.push([k, v]);
        break;

      case 'justifyContent':
        if (!isRow) { keep.push([k, v]); break; }
        if (v === "'flex-end'") { classes.push('end'); break; }
        if (v === "'space-between'") { classes.push('between'); break; }
        keep.push([k, v]);
        break;

      case 'flexDirection':
        if (isRow && v === "'column'") {
          classes[classes.indexOf('row')] = 'col';
          break;
        }
        keep.push([k, v]);
        break;

      case 'width':
        if (v === "'100%'") { if (isBtn) flags.push('full'); else classes.push('w-full'); break; }
        keep.push([k, v]);
        break;

      case 'flex':
        if (v === '1' || v === "'1'") { if (isBtn) flags.push('grow'); else classes.push('fill'); break; }
        keep.push([k, v]);
        break;

      case 'minWidth':
        if (v === '0') { classes.push('fill'); break; }
        keep.push([k, v]);
        break;

      case 'overflowX':
        if (v === "'auto'") { classes.push('tw'); break; }
        keep.push([k, v]);
        break;

      case 'whiteSpace':
        if (v === "'nowrap'") { classes.push('nw'); break; }
        if (v === "'normal'") { classes.push('wrap'); break; }
        if (v === "'pre-wrap'") { classes.push('pre-wrap'); break; }
        keep.push([k, v]);
        break;

      case 'textAlign':
        if (v === "'center'") { classes.push('tac'); break; }
        if (v === "'right'") { classes.push('tar'); break; }
        if (v === "'left'") { classes.push('tal'); break; }
        keep.push([k, v]);
        break;

      case 'fontSize': {
        const fm = String(v).match(/^'([\d.]+)rem'$/);
        const step = fm && TYPE[fm[1]];
        if (step) { classes.push(`t-${step}`); break; }
        keep.push([k, v]);
        break;
      }

      case 'color': {
        const cm = String(v).match(/^'var\(--([a-z0-9-]+)\)'$/);
        if (cm && COLOUR[cm[1]]) { classes.push(COLOUR[cm[1]]); break; }
        keep.push([k, v]);
        break;
      }

      case 'fontFamily': {
        const fm = String(v).match(/^'var\(--(ui|cond|mono)\)'$/);
        if (fm) { classes.push(`f-${fm[1]}`); break; }
        keep.push([k, v]);
        break;
      }

      case 'fontWeight': {
        const n = Number(String(v).replace(/'/g, ''));
        if ([400, 500, 600, 700].includes(n)) { classes.push(`fw-${n / 100}`); break; }
        keep.push([k, v]);
        break;
      }

      case 'lineHeight': {
        const n = Number(v);
        if (n >= 1 && n <= 1.15) { classes.push('lh-1'); break; }
        if (n > 1.15 && n <= 1.38) { classes.push('lh-tight'); break; }
        if (n > 1.38 && n <= 1.56) { classes.push('lh'); break; }
        if (n > 1.56) { classes.push('lh-loose'); break; }
        keep.push([k, v]);
        break;
      }

      case 'padding': {
        const one = px(v);
        if (one !== null && (one === 0 || STEP[one])) {
          classes.push(one === 0 ? 'p-0' : `p-${STEP[one]}`);
          break;
        }
        const two = String(v).match(/^'(\d+)(?:px)? (\d+)(?:px)?'$/);
        if (two) {
          const y = Number(two[1]), x = Number(two[2]);
          if ((y === 0 || STEP[y]) && (x === 0 || STEP[x])) {
            classes.push(y === 0 ? 'py-0' : `py-${STEP[y]}`);
            classes.push(x === 0 ? 'px-0' : `px-${STEP[x]}`);
            break;
          }
        }
        keep.push([k, v]);
        break;
      }

      case 'marginLeft': {
        if (v === "'auto'") { classes.push('ml-auto'); break; }
        const n = px(v);
        if (n !== null && n >= 6 && STEP[n]) { classes.push(`ml-${STEP[n]}`); break; }
        keep.push([k, v]);
        break;
      }

      case 'paddingLeft': {
        const n = px(v);
        if (n === 0) { classes.push('pl-0'); break; }
        if (n !== null && n >= 12 && STEP[n]) { classes.push(`pl-${STEP[n]}`); break; }
        keep.push([k, v]);
        break;
      }

      case 'textTransform':
        if (v === "'uppercase'") { classes.push('caps'); break; }
        if (v === "'none'") break;                        // only ever undoing an inherit
        keep.push([k, v]);
        break;

      case 'letterSpacing': {
        // paired with textTransform:uppercase in every case; .caps carries both, and
        // .caps-wide is the looser of the two tracking values in use
        const lm = String(v).match(/^'\.(\d+)em'$/);
        if (lm) { classes.push(Number(lm[1]) >= 13 ? 'caps-wide' : 'caps'); break; }
        if (v === '0' || v === "'0'") break;
        keep.push([k, v]);
        break;
      }

      case 'fontVariantNumeric':
        if (v === "'tabular-nums'") { classes.push('tnum'); break; }
        keep.push([k, v]);
        break;

      case 'textDecoration':
        if (v === "'none'") { classes.push('plain-link'); break; }
        keep.push([k, v]);
        break;

      case 'cursor':
        if (v === "'pointer'") { classes.push('clickable'); break; }
        keep.push([k, v]);
        break;

      case 'wordBreak':
        if (v === "'break-all'") { classes.push('break-all'); break; }
        keep.push([k, v]);
        break;

      case 'background':
      case 'backgroundColor': {
        const bm = String(v).match(/^'var\(--(ok|warn|crit|idle|accent)\)'$/);
        if (bm) { classes.push(`bg-${bm[1] === 'accent' ? 'acc' : bm[1]}`); break; }
        keep.push([k, v]);
        break;
      }

      case 'border':
        if (v === '0' || v === "'0'") { classes.push('no-border'); break; }
        keep.push([k, v]);
        break;

      case 'borderBottom':
        if (v === '0' || v === "'0'") { classes.push('no-border-b'); break; }
        keep.push([k, v]);
        break;

      case 'transform':
        if (v === "'rotate(180deg)'") { classes.push('flip'); break; }
        keep.push([k, v]);
        break;

      case 'minHeight': {
        // 30-32px on a control means "this one sits in a table row"
        const n = px(v);
        if (n !== null && n >= 30 && n <= 34) { classes.push('compact'); break; }
        keep.push([k, v]);
        break;
      }


      default:
        keep.push([k, v]);
    }
  }
  // .fill already means flex:1;min-width:0 — don't say it twice
  const seen = new Set();
  const uniq = classes.filter((c) => (seen.has(c) ? false : (seen.add(c), true)));
  return { classes: uniq, keep, flags };
}

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  let out = src;
  let fileChanged = false;

  // every opening tag that carries a style={{ ... }} with no nested braces
  const re = /<([A-Za-z][\w.]*)((?:[^<>'"]|'[^']*'|"[^"]*"|\{[^{}]*\}|\{\{[^{}]*\}\})*?)(\/?)>/g;

  out = out.replace(re, (whole, tagName, attrs, selfClose) => {
    const sm = attrs.match(/\s*style=\{\{([^{}]*)\}\}/);
    if (!sm) return whole;

    const pairs = parseStyle(sm[1]);
    if (!pairs) {
      unhandled.push(`${relative(ROOT, file)}  <${tagName}>  (not flat) ${sm[1].trim().slice(0, 70)}`);
      return whole;
    }

    const { classes, keep, flags } = translate(pairs, tagName);
    if (!classes.length && !flags.length) {
      unhandled.push(`${relative(ROOT, file)}  <${tagName}>  ${sm[1].trim().slice(0, 70)}`);
      return whole;
    }
    if (keep.length) {
      unhandled.push(`${relative(ROOT, file)}  <${tagName}>  PARTIAL, left inline: ${keep.map(([k, v]) => `${k}:${v}`).join(', ').slice(0, 70)}`);
    }

    // rebuild the tag
    let newAttrs = attrs.replace(sm[0], keep.length
      ? ` style={{ ${keep.map(([k, v]) => `${k}: ${v}`).join(', ')} }}`
      : '');
    let tag = `<${tagName}${newAttrs}`;
    tag = addClasses(tag, classes);
    for (const f of flags) tag = tag.replace(/^<([A-Za-z][\w.]*)/, `<$1 ${f}`);
    changed++;
    fileChanged = true;
    return `${tag}${selfClose}>`;
  });

  if (fileChanged) {
    touchedFiles++;
    if (WRITE) writeFileSync(file, out, 'utf8');
  }
}

console.log(`\n${changed} inline style block(s) moved onto classes across ${touchedFiles} file(s)` +
            (WRITE ? '' : '  (dry run — pass --write to apply)'));
console.log(`${unhandled.length} left for a human:\n`);
for (const u of unhandled) console.log('  ' + u);

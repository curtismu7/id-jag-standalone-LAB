// Finds every CSS rule that can change how big text looks inside a diagram card, so a test can fail it. Not a CSS engine: it asks the DOM.
//
// A rule can matter for a card when one of its selectors matches the card, anything inside it (title, subtitle, list, items) or any element above it
// (the React Flow node, the viewport, the page wrapper, body, html): font sizes inherit downward, and a `zoom` or a scale transform on an ancestor
// shrinks everything inside. So the scan takes a real, rendered card, and for every state a card can be in (kind, dim, on, selected, dragged) asks
// `element.matches(selector)` for each selector part of each rule. Nothing is guessed from the selector's spelling: `.ijx li`, `.ijx *`, `.ijx .on li`,
// `[class~=card] li` and `:root` all match because the DOM says so.
//
// What it reports for a matching rule: a font size (`font-size`, or the size in the `font` shorthand) converted to px (null = a unit it cannot turn
// into px: em, %, a keyword, calc, var), a `zoom`, a scale in `transform`, or the `scale` property.

const NOT_RULES = /^@(-webkit-)?(keyframes|font-face|property|counter-style|page|namespace)\b/i;

/** Every style rule as { selector, body }, comments removed, rules inside @media / @supports / @layer included (all of them are taken as applying). */
export function parseRules(cssText) {
  const css = cssText.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@(import|charset|namespace)[^;]*;/gi, "");
  const out = [];
  const walk = (src) => {
    let i = 0;
    while (i < src.length) {
      const open = src.indexOf("{", i);
      if (open < 0) break;
      const prelude = src.slice(i, open).trim();
      let depth = 1, j = open + 1;
      while (j < src.length && depth) { if (src[j] === "{") depth += 1; else if (src[j] === "}") depth -= 1; j += 1; }
      const body = src.slice(open + 1, j - 1);
      if (prelude.startsWith("@")) { if (!NOT_RULES.test(prelude)) walk(body); } else out.push({ selector: prelude, body });
      i = j;
    }
  };
  walk(css);
  return out;
}

/** A selector list split at its top-level commas (a comma inside :is(), [attr="a,b"] or a string stays). */
export function splitSelectors(list) {
  const out = [];
  let depth = 0, quote = null, cur = "";
  for (const ch of list) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === "(" || ch === "[") depth += 1;
    if (ch === ")" || ch === "]") depth -= 1;
    if (ch === "," && !depth) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  out.push(cur.trim());
  return out.filter(Boolean);
}

// A rule that applies only while the pointer is over a card, or in a pseudo-element, still changes the card's text: read it as always applying.
const DYNAMIC = /::[\w-]+(\([^)]*\))?|:(hover|focus|focus-visible|focus-within|active|visited|link|any-link|fullscreen|target|disabled|enabled|checked|placeholder-shown|-webkit-[\w-]+|-moz-[\w-]+)(?![\w-])/g;
const staticForm = (part) => { const s = part.replace(DYNAMIC, "").trim(); return !s || /[>+~]$/.test(s) ? `${s}*` : s; };

const decls = (body, prop) => [...body.matchAll(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "gi"))].map((m) => m[1].replace(/!important/i, "").trim());
const IDENTITY = /^(none|normal|initial|unset|revert|inherit|1|1\.0*|100%)$/i;
const identityScale = (v) => /^(scale|scale3d|scalex|scaley|scalez)\(\s*1(\.0*)?(\s*,\s*1(\.0*)?)*\s*\)$/i.test(v.replace(/\s+/g, " ").trim());

/** The pixel size of a CSS length given the root size: px and rem only. em, %, keywords, calc() and var() depend on the parent, so null (cannot tell). */
export function toPx(value, rootPx = 16) {
  const m = /^([\d.]+)(rem|px)$/.exec(value.trim());
  return m ? Number(m[1]) * (m[2] === "px" ? 1 : rootPx) : null;
}
/** The root element's own size: em and % there are against the browser's 16px. 0 when it cannot be told (every rem size then reads as too small). */
const rootSize = (value) => { const m = /^([\d.]+)(rem|px|em|%)$/.exec(value.trim()); return m ? Number(m[1]) * (m[2] === "px" ? 1 : m[2] === "%" ? 0.16 : 16) : 0; };

/** The sizes a `font` shorthand and `font-size` declaration set, as raw values. */
const sizesIn = (body) => [
  ...decls(body, "font-size"),
  ...decls(body, "font").filter((v) => !/^(inherit|initial|unset|revert|caption|icon|menu|message-box|small-caption|status-bar)$/i.test(v)).map((v) => (/(?:^|\s)([\d.]+(?:rem|px|em|%))(?![\w%])/.exec(v) || [])[1] ?? v),
];

/** Every state a card can be in: the cards' kinds x dim/on/sel, with the React Flow node selected/dragged or not. Calls `visit()` with the classes set. */
function forEachState(card, kinds, visit) {
  const node = card.closest(".react-flow__node");
  const keep = { card: card.className, node: node?.className };
  for (const kind of kinds) for (let bits = 0; bits < 8; bits++) for (let nodeBits = 0; nodeBits < (node ? 4 : 1); nodeBits++) {
    card.className = ["card", kind && `k-${kind}`, bits & 1 && "dim", bits & 2 && "on", bits & 4 && "sel"].filter(Boolean).join(" ");
    if (node) node.className = [keep.node, nodeBits & 1 && "selected", nodeBits & 2 && "dragging"].filter(Boolean).join(" ");
    visit();
  }
  card.className = keep.card;
  if (node) node.className = keep.node;
}

/**
 * Everything in `cssText` that could change the look of text inside `card` (a rendered .card element in the live document), as
 *   [{ selector, type: "font-size" | "zoom" | "scale", value, px }]    px: the size on screen at zoom 1 (font-size only), null when it cannot be told.
 * `kinds` are the card kinds (the `k-*` classes) to try.
 * A `:root`/`html` font size sets the rem used for every other rule, so it is read first and returned as `rootPx`.
 */
const memo = new WeakMap();
export function scanCardCss(cssText, card, kinds = [""]) {
  const rules = parseRules(cssText).flatMap(({ selector, body }) => {
    const sizes = sizesIn(body), zooms = decls(body, "zoom"), scales = [...decls(body, "scale"), ...decls(body, "transform").filter((v) => /scale|matrix/i.test(v))];
    if (!sizes.length && !zooms.length && !scales.length) return [];
    return splitSelectors(selector).map((part) => ({ part, query: staticForm(part), body, sizes, zooms, scales }));
  });
  const reach = [card, ...card.querySelectorAll("*")];
  for (let e = card.parentElement; e; e = e.parentElement) reach.push(e);
  // whether a selector can match anything in `reach` in any card state: decided once per selector per card (the card does not change between calls)
  const known = (memo.get(card) ?? memo.set(card, new Map()).get(card));
  const queries = [...new Set(rules.map((r) => r.query))].filter((q) => !known.has(q));
  const safeMatches = (el, query) => { try { return el.matches(query); } catch { return true; } }; // a selector the DOM cannot parse is read as matching: fail closed
  const matchesAny = (query) => reach.some((el) => safeMatches(el, query));
  const todo = new Set(queries);
  forEachState(card, kinds, () => { for (const q of todo) if (matchesAny(q)) { known.set(q, true); todo.delete(q); } });
  for (const q of todo) known.set(q, false);
  const matched = new Set(rules.filter((r) => known.get(r.query)));
  const root = [...matched].filter((r) => safeMatches(document.documentElement, staticForm(r.part)) && r.sizes.length);
  const rootPx = root.length ? Math.min(...root.flatMap((r) => r.sizes.map(rootSize))) : 16;
  const out = [];
  for (const r of rules) {
    if (!matched.has(r)) continue;
    for (const v of r.sizes) out.push({ selector: r.part, type: "font-size", value: v, px: root.includes(r) ? rootSize(v) : toPx(v, rootPx) });
    for (const v of r.zooms) if (!IDENTITY.test(v)) out.push({ selector: r.part, type: "zoom", value: v, px: null });
    for (const v of r.scales) if (!IDENTITY.test(v) && !identityScale(v)) out.push({ selector: r.part, type: "scale", value: v, px: null });
  }
  return { rootPx, findings: out };
}

/** The findings that make text under `minPx` on screen at `zoom`: a size too small or one this scan cannot read, and every zoom / scale that is not the identity. */
export function tooSmall({ findings }, zoom, minPx = 10) {
  return findings.filter((f) => f.type !== "font-size" || f.px === null || f.px * zoom < minPx);
}

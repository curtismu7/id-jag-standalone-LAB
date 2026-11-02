// Finds the CSS rules that can change how big text looks inside the first diagram card the test renders, so a test can fail them. Not a CSS engine: it asks the DOM.
//
// What it does, in order:
//  1. Reads every style rule in the text it is given: rules inside @media / @supports / @layer / @container / @scope, native CSS nesting (`&`, bare `li{}`,
//     `> li{}`, nested @media), and it skips at-rule statements (`@layer a, b;`, `@custom-media ...;`, `@tailwind base;`).
//  2. For each selector, asks the DOM (`element.matches`) whether it can match the card, anything inside it, or any element above it (the React Flow node,
//     the viewport, the page wrapper, body, html), in every card state (each kind, dim, on, sel; node selected or dragging). Hover, focus, pseudo-elements
//     and structural pseudo-classes (`:nth-child`, `:last-child` ...) are read as always on. A selector with a pseudo-class this scan does not know
//     (`:lang()`, `:host`) counts as matching.
//  3. Page state on the ancestors is assumed possible: every attribute in the part of a selector before its last compound (`:root[data-theme="dark"]`,
//     `[data-id="pf"]`) is set on every ancestor, and every class or id there that no element in the document carries (`html.dark`, `body.presenter`)
//     is set on them too. So a rule that only applies in dark mode or presenter mode is read too.
//  4. For a matching rule it reports a font size (`font-size`, or the size in `font`; px, rem, and em or % where the parent size is known; calc(), min(),
//     max(), clamp() and var() of custom properties declared in the CSS are evaluated), a `zoom`, a scale in `transform`, the `scale` property, a
//     `text-size-adjust`, and the same things inside any @keyframes the rule names in `animation`.
// What it does NOT do: see CLAUDE.md, "Not covered".
//
// `appStylesheets(webDir)` collects the text to scan: every .css under src, every .css a script under src imports (`import "../x.css"`, `import("...")`),
// every .css one of those @imports, and what index.html links or writes in <style>, as long as the file is inside webDir and not under node_modules.
import fs from "node:fs";
import path from "node:path";

const NOT_RULES = /^@(-webkit-|-moz-)?(keyframes|font-face|property|counter-style|page|namespace|font-feature-values|font-palette-values|view-transition|position-try)\b/i;

/** Index of the first char of `chars` at bracket/paren depth 0 outside a string, from `i`; -1 when there is none. */
function findTop(src, i, chars) {
  let paren = 0, brack = 0, quote = null;
  for (let k = i; k < src.length; k++) {
    const ch = src[k];
    if (quote) { if (ch === "\\") k += 1; else if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") paren += 1;
    else if (ch === ")") paren = Math.max(0, paren - 1);
    else if (ch === "[") brack += 1;
    else if (ch === "]") brack = Math.max(0, brack - 1);
    else if (!paren && !brack && chars.includes(ch)) return k;
  }
  return -1;
}
/** The index just after the `}` that closes the `{` at `open`. */
function matchBrace(src, open) {
  let depth = 0, quote = null;
  for (let k = open; k < src.length; k++) {
    const ch = src[k];
    if (quote) { if (ch === "\\") k += 1; else if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "{") depth += 1;
    else if (ch === "}") { depth -= 1; if (!depth) return k + 1; }
  }
  return src.length;
}

/** A selector list split at its top-level commas (a comma inside :is(), [attr="a,b"] or a string stays). */
export function splitSelectors(list) {
  const out = [];
  let i = 0;
  for (;;) {
    const j = findTop(list, i, ",");
    if (j < 0) { out.push(list.slice(i).trim()); break; }
    out.push(list.slice(i, j).trim());
    i = j + 1;
  }
  return out.filter(Boolean);
}

// A nested selector inside `parents`: `&` stands for the parent; without one it is a descendant (`li`, `> li`).
const resolveNested = (parents, child) => parents.flatMap((pp) => splitSelectors(child).map((np) => (np.includes("&") ? np.replaceAll("&", pp) : `${pp} ${np}`)));

/** Every style rule as { selector, body }, comments removed. Rules inside at-rules and nested rules are flattened (all of them are taken as applying). */
export function parseRules(cssText) {
  const css = cssText.replace(/\/\*[\s\S]*?\*\//g, "");
  const parse = (src, parents) => {
    const rules = [], decls = [];
    let i = 0;
    while (i < src.length) {
      while (i < src.length && /\s/.test(src[i])) i += 1;
      if (i >= src.length) break;
      const j = findTop(src, i, ";{}");
      if (j < 0) { if (parents) decls.push(src.slice(i).trim()); break; }
      if (src[j] === "}") { i = j + 1; continue; } // a stray brace
      if (src[j] === ";") { const t = src.slice(i, j).trim(); if (parents && t && !t.startsWith("@")) decls.push(t); i = j + 1; continue; } // a declaration, or an at-rule statement
      const prelude = src.slice(i, j).trim(), end = matchBrace(src, j), inner = src.slice(j + 1, end - 1);
      i = end;
      if (prelude.startsWith("@")) {
        if (NOT_RULES.test(prelude)) continue;
        const child = parse(inner, parents);
        rules.push(...child.rules);
        decls.push(...child.decls); // declarations written straight inside a nested @media belong to the parent rule
      } else {
        const own = parents ? resolveNested(parents, prelude) : splitSelectors(prelude);
        const child = parse(inner, own);
        rules.push({ selector: parents ? own.join(",") : prelude, body: child.decls.join(";") }, ...child.rules);
      }
    }
    return { rules, decls };
  };
  return parse(css, null).rules;
}

/** A CSS name or property written with escapes (`font\\2d size`, `s\\68`) as the browser reads it. */
const unescapeCss = (s) => s.replace(/\\([0-9a-fA-F]{1,6})\s?|\\([^\n])/g, (_, hex, ch) => (hex ? String.fromCodePoint(parseInt(hex, 16)) : ch));
/** An animation name as the browser reads it: quotes removed, escapes decoded. */
const nameOf = (s) => unescapeCss(s.trim().replace(/^(["'])(.*)\1$/, "$2"));

/** name -> body text of every @keyframes. The name may be quoted or written with escapes. */
function parseKeyframes(cssText) {
  const css = cssText.replace(/\/\*[\s\S]*?\*\//g, ""), out = new Map();
  for (const m of css.matchAll(/@(?:-webkit-|-moz-)?keyframes\s+([^{}]+?)\s*\{/gi)) out.set(nameOf(m[1]), css.slice(m.index + m[0].length, matchBrace(css, m.index + m[0].length - 1) - 1));
  return out;
}

/** Declarations of a rule body as [property, value] (property decoded and lower-cased, !important removed). */
function splitDecls(body) {
  const out = [];
  let i = 0;
  for (;;) {
    const j = findTop(body, i, ";");
    const t = body.slice(i, j < 0 ? body.length : j), c = t.indexOf(":");
    if (c > 0) out.push([unescapeCss(t.slice(0, c).trim()).toLowerCase(), t.slice(c + 1).replace(/!\s*important/i, "").trim()]);
    if (j < 0) break;
    i = j + 1;
  }
  return out;
}
const decls = (body, ...props) => splitDecls(body).filter(([p]) => props.includes(p)).map(([, v]) => v);

// ---- selectors ------------------------------------------------------------------------------------------------------------------------------------
// A rule that applies only while the pointer is over a card, or in a pseudo-element, still changes the card's text: read it as always applying.
// Structural pseudo-classes depend on which sibling a card is (`:nth-child(3)`, `:last-child`): the scan cannot see the other cards, so they are dropped.
const STRUCTURAL = "(?:first-child|last-child|only-child|first-of-type|last-of-type|only-of-type|empty|nth-child\\([^)]*\\)|nth-last-child\\([^)]*\\)|nth-of-type\\([^)]*\\)|nth-last-of-type\\([^)]*\\))";
const NOT_STRUCTURAL = new RegExp(`:not\\(\\s*:${STRUCTURAL}\\s*\\)`, "gi");
const STRUCTURAL_RE = new RegExp(`:${STRUCTURAL}(?![\\w-])`, "gi");
const DYNAMIC = /::[\w-]+(\([^)]*\))?|:(hover|focus|focus-visible|focus-within|active|visited|link|any-link|fullscreen|target|disabled|enabled|checked|placeholder-shown|-webkit-[\w-]+|-moz-[\w-]+)(?![\w-])/gi;
const KNOWN_PSEUDO = ["root", "not", "is", "where", "has", "scope"];
// a pseudo-class this scan does not know (`:lang(en)`, `:dir(ltr)`, `:host`): the DOM engine here cannot be trusted on it, so it is dropped (read as always true)
const UNKNOWN_PSEUDO = new RegExp(`(?<!:):(?!(?:${KNOWN_PSEUDO.join("|")})(?![\\w-]))[a-z][\\w-]*(?:\\((?:[^()]|\\([^()]*\\))*\\))?`, "gi");

/**
 * The selector as the DOM can be asked about it: CSS escapes decoded, type selectors lower-cased, hover / focus / pseudo-elements / structural
 * pseudo-classes removed, and so is any pseudo-class this scan does not know. Dropping a condition only makes a selector match more.
 */
export function normalizeSelector(part) {
  let s = part.replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_, hex) => { const ch = String.fromCodePoint(parseInt(hex, 16)); return /[\w-]/.test(ch) ? ch : `\\${ch}`; });
  s = s.replace(/("[^"]*"|'[^']*'|\[[^\]]*\])|(^|[\s>+~(,])([A-Za-z][\w-]*)/g, (m, kept, pre, tag) => (kept ? m : pre + tag.toLowerCase())); // type selectors only
  s = s.replace(NOT_STRUCTURAL, "").replace(STRUCTURAL_RE, "").replace(DYNAMIC, "").trim();
  s = s.replace(UNKNOWN_PSEUDO, "").trim();
  if (!s || /[>+~]$/.test(s) || /^[>+~]/.test(s)) s = /^[>+~]/.test(s) ? `*${s}` : `${s}*`;
  return { query: s };
}

/** The compounds of a selector split at its top-level combinators: [before-the-last..., last]. */
function compounds(sel) {
  const out = [];
  let cur = "", paren = 0, brack = 0, quote = null;
  for (const ch of sel) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === "(") paren += 1; else if (ch === ")") paren -= 1; else if (ch === "[") brack += 1; else if (ch === "]") brack -= 1;
    if (!paren && !brack && /[\s>+~]/.test(ch)) { if (cur) out.push(cur); cur = ""; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
const ATTR = /\[\s*([\w:-]+)\s*(?:([~|^$*]?=)\s*("[^"]*"|'[^']*'|[^\]\s]+)(?:\s+[is])?)?\s*\]/g;
function tokensOf(text) {
  const attrs = [...text.matchAll(ATTR)].map((m) => [m[1], m[3] ? m[3].replace(/^["']|["']$/g, "") : ""]);
  const rest = text.replace(ATTR, "");
  return { attrs, classes: [...rest.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]), ids: [...rest.matchAll(/#([_a-zA-Z][\w-]*)/g)].map((m) => m[1]) };
}

// ---- lengths --------------------------------------------------------------------------------------------------------------------------------------
/** Every string `value` can stand for once its var(--x, fallback) are replaced by each value --x is declared with (at most 64 strings; [] when a var has none). */
function expandVars(value, vars) {
  let out = [value];
  for (let guard = 0; guard < 8 && out.some((v) => v.includes("var(")); guard++) {
    out = out.flatMap((v) => {
      const k = v.indexOf("var(");
      if (k < 0) return [v];
      let depth = 0, e = k + 3;
      for (; e < v.length; e++) { if (v[e] === "(") depth += 1; else if (v[e] === ")" && !--depth) break; }
      const arg = v.slice(k + 4, e), comma = findTop(arg, 0, ","), name = (comma < 0 ? arg : arg.slice(0, comma)).trim();
      const options = [...(vars.get(name) ?? []), ...(comma < 0 ? [] : [arg.slice(comma + 1).trim()])];
      return options.map((o) => v.slice(0, k) + o + v.slice(e + 1));
    }).slice(0, 64);
  }
  return out.filter((v) => !v.includes("var("));
}

/**
 * The px a font-size value is, or null when it cannot be told. Lengths in px and rem; em and % against `parentPx` (null when the parent's size is not
 * known); calc(), min(), max(), clamp() of those and of plain numbers. Anything else (a keyword, `inherit`) is null.
 */
export function lengthPx(value, { rootPx = 16, parentPx = null } = {}) {
  const src = value.trim().toLowerCase();
  let pos = 0;
  const ws = () => { while (src[pos] === " ") pos += 1; };
  const num = (v) => ({ v, px: false });
  const len = (v) => ({ v, px: true });
  const fail = () => { throw new Error("unreadable"); };
  const expr = () => {
    let a = term();
    for (ws(); src[pos] === "+" || src[pos] === "-"; ws()) {
      const op = src[pos++], b = term();
      if (a.px !== b.px) fail();
      a = { v: op === "+" ? a.v + b.v : a.v - b.v, px: a.px };
    }
    return a;
  };
  const term = () => {
    let a = factor();
    for (ws(); src[pos] === "*" || src[pos] === "/"; ws()) {
      const op = src[pos++], b = factor();
      if (op === "*") { if (a.px && b.px) fail(); a = { v: a.v * b.v, px: a.px || b.px }; } else { if (b.px) fail(); a = { v: a.v / b.v, px: a.px }; }
    }
    return a;
  };
  const args = () => {
    const list = [expr()];
    for (ws(); src[pos] === ","; ws()) { pos += 1; list.push(expr()); }
    return list;
  };
  const factor = () => {
    ws();
    const fn = /^(calc|min|max|clamp)?\(/.exec(src.slice(pos));
    if (fn) {
      pos += fn[0].length;
      const list = args();
      ws();
      if (src[pos++] !== ")") fail();
      if (fn[1] === "min") return list.reduce((a, b) => (b.v < a.v ? b : a));
      if (fn[1] === "max") return list.reduce((a, b) => (b.v > a.v ? b : a));
      if (fn[1] === "clamp") { if (list.length !== 3) fail(); return list[1].v < list[0].v ? list[0] : list[1].v > list[2].v ? list[2] : list[1]; }
      return list[0];
    }
    const m = /^([+-]?(?:\d+\.?\d*|\.\d+))(rem|px|em|%)?/.exec(src.slice(pos));
    if (!m) fail();
    pos += m[0].length;
    const n = Number(m[1]);
    if (!m[2]) return num(n);
    if (m[2] === "px") return len(n);
    if (m[2] === "rem") return len(n * rootPx);
    if (parentPx === null) fail();
    return len(m[2] === "em" ? n * parentPx : (n * parentPx) / 100);
  };
  try {
    const r = expr();
    ws();
    return pos === src.length && r.px ? r.v : null;
  } catch { return null; }
}

/** The sizes a `font` shorthand and `font-size` declaration set, as raw values. */
const sizesIn = (body) => [
  ...decls(body, "font-size"),
  ...decls(body, "font").filter((v) => !/^(inherit|initial|unset|revert|caption|icon|menu|message-box|small-caption|status-bar)$/i.test(v)).map((v) => (/(?:^|\s)([\d.]+(?:rem|px|em|%))(?![\w%])/.exec(v) || [])[1] ?? v),
];
const IDENTITY = /^(none|normal|initial|unset|revert|inherit|1|1\.0*|100%)$/i;
const identityScale = (v) => /^(scale|scale3d|scalex|scaley|scalez)\(\s*1(\.0*)?(\s*,\s*1(\.0*)?)*\s*\)$/i.test(v.replace(/\s+/g, " ").trim());
const SAFE_ADJUST = /^(none|auto|100%|initial|unset|revert|inherit)$/i;
const effectsIn = (body) => ({
  sizes: sizesIn(body),
  zooms: decls(body, "zoom"),
  scales: [...decls(body, "scale"), ...decls(body, "transform").filter((v) => /scale|matrix/i.test(v))],
  adjusts: decls(body, "text-size-adjust", "-webkit-text-size-adjust", "-moz-text-size-adjust", "font-size-adjust"),
});
const animationNames = (body) => decls(body, "animation", "-webkit-animation", "animation-name", "-webkit-animation-name").flatMap((v) => v.split(/[\s,]+/)).map(nameOf);

// ---- states ---------------------------------------------------------------------------------------------------------------------------------------
const STATE_CLASS = /^(selected|dragging|dim|on|sel|k-[\w-]+)$/; // set by the loop below, never assumed on an ancestor

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

/** Runs `fn` with `attrs` and `classes` set on `els`, then puts every element back as it was. */
function withTokens(els, attrs, classes, ids, fn) {
  const saved = els.map((el) => ({ el, attrs: attrs.map(([n]) => [n, el.getAttribute(n)]), cls: el.className, id: el.id }));
  try {
    for (const el of els) {
      for (const [n, v] of attrs) el.setAttribute(n, v);
      for (const c of classes) el.classList.add(c);
      if (ids.length && !el.id) el.id = ids[0];
    }
    return fn();
  } finally {
    for (const s of saved) {
      for (const [n, v] of s.attrs) { if (v === null) s.el.removeAttribute(n); else s.el.setAttribute(n, v); }
      s.el.className = s.cls; s.el.id = s.id;
    }
  }
}

const memo = new WeakMap(); // card -> Map(query -> { how: "plain" | "state" | null, html, body, other })

/**
 * Everything in `cssText` that could change the look of text inside `card` (a rendered .card element in the live document), as
 *   [{ selector, type: "font-size" | "zoom" | "scale" | "text-size-adjust", value, px }]    px: the size on screen at zoom 1 (font-size only), null when it cannot be told.
 * `kinds` are the card kinds (the `k-*` classes) to try. The root's font size sets the rem used for every other rule, so it is read first and returned as
 * `rootPx` (the smallest the page can have: its own, or a size a data-theme / data-present state sets).
 */
export function scanCardCss(cssText, card, kinds = [""]) {
  const parsed = parseRules(cssText);
  const keyframes = parseKeyframes(cssText);
  const vars = new Map();
  for (const { body } of parsed) for (const [p, v] of splitDecls(body)) if (p.startsWith("--")) vars.set(p, [...(vars.get(p) ?? []), v]);
  const rules = parsed.flatMap(({ selector, body }) => {
    const fx = effectsIn(body), anims = animationNames(body).filter((n) => keyframes.has(n));
    if (!fx.sizes.length && !fx.zooms.length && !fx.scales.length && !fx.adjusts.length && !anims.length) return [];
    return splitSelectors(selector).map((part) => ({ part, ...normalizeSelector(part), fx, anims }));
  });

  const html = document.documentElement, body = document.body;
  const above = []; // the ancestors, nearest first
  for (let e = card.parentElement; e; e = e.parentElement) above.push(e);
  const inner = [card, ...card.querySelectorAll("*"), ...above.filter((e) => e !== html && e !== body)];
  const seenClasses = new Set([...document.querySelectorAll("[class]")].flatMap((e) => [...e.classList]));
  const safe = (el, q) => { try { return el.matches(q); } catch { return true; } }; // a selector the DOM cannot parse is read as matching: fail closed
  const known = memo.get(card) ?? memo.set(card, new Map()).get(card);

  const decide = (r) => {
    if (known.has(r.query)) return known.get(r.query);
    const res = { how: null, html: false, body: false, other: false };
    const scan = () => {
      if (safe(html, r.query)) res.html = true;
      if (safe(body, r.query)) res.body = true;
      if (!res.other) forEachState(card, kinds, () => { if (!res.other && inner.some((el) => safe(el, r.query))) res.other = true; });
    };
    scan();
    if (res.html || res.body || res.other) res.how = "plain";
    else {
      // page state is assumed possible on the ancestors (see the top of this file): set what the selector asks of them, then look again
      const cs = compounds(r.query), before = cs.slice(0, -1).map(tokensOf), last = tokensOf(cs.at(-1) ?? "");
      // the last compound counts too when it names the document itself (`:root[data-present="1"]`, `html.dark`, `body.presenter`)
      const docLast = /^(html|body|:root)/i.test(cs.at(-1) ?? "");
      const grab = docLast ? [...before, last] : before;
      const attrs = grab.flatMap((t) => t.attrs);
      const classes = [...new Set(grab.flatMap((t) => t.classes))].filter((c) => !seenClasses.has(c) && !STATE_CLASS.test(c));
      const ids = [...new Set(grab.flatMap((t) => t.ids))].filter((c) => !document.getElementById(c));
      const byName = new Map();
      for (const [n, v] of attrs) byName.set(n, [...new Set([...(byName.get(n) ?? []), v])]);
      let combos = [[]];
      for (const [n, vs] of byName) combos = combos.flatMap((c) => vs.map((v) => [...c, [n, v]])).slice(0, 16);
      const onAncestors = attrs.length || classes.length || ids.length;
      if (onAncestors || last.attrs.length) {
        for (const combo of combos) {
          if (onAncestors) withTokens(above, combo, classes, ids, () => scan());
          // an attribute written on the last compound (`li[data-kind=a]`) can be set on the card's own elements
          if (!res.html && !res.body && !res.other && last.attrs.length) withTokens([card, ...card.querySelectorAll("*")], last.attrs, [], [], () => scan());
        }
        if (res.html || res.body || res.other) res.how = "state";
      }
    }
    known.set(r.query, res);
    return res;
  };

  // the root's size first: every rem hangs on it
  const resolved = rules.map((r) => ({ r, d: decide(r) })).filter(({ d }) => d.how);
  const rootCtx = { rootPx: 16, parentPx: 16 };
  const px = (value, ctx) => { const list = expandVars(value, vars).map((v) => lengthPx(v, ctx)); return list.length && list.every((x) => x !== null) ? Math.min(...list) : null; };
  const plainRoot = [], stateRoot = [];
  for (const { r, d } of resolved) if (d.html && r.fx.sizes.length) (d.how === "plain" ? plainRoot : stateRoot).push(...r.fx.sizes.map((v) => px(v, rootCtx) ?? 0));
  const rootPx = Math.min(plainRoot.length ? Math.min(...plainRoot) : 16, ...stateRoot);

  const out = [];
  const effects = (selector, fx, d) => {
    // em and % are against the parent's size: known for html (16) and body (the root's), not for anything else
    const parentPx = d.other ? null : d.body ? rootPx : 16;
    for (const v of fx.sizes) out.push({ selector, type: "font-size", value: v, px: d.html && !d.other && !d.body ? px(v, rootCtx) ?? 0 : px(v, { rootPx, parentPx }) });
    for (const v of fx.zooms) if (!IDENTITY.test(v)) out.push({ selector, type: "zoom", value: v, px: null });
    for (const v of fx.scales) if (!IDENTITY.test(v) && !identityScale(v)) out.push({ selector, type: "scale", value: v, px: null });
    for (const v of fx.adjusts) if (!SAFE_ADJUST.test(v)) out.push({ selector, type: "text-size-adjust", value: v, px: null });
  };
  for (const { r, d } of resolved) {
    effects(r.part, r.fx, d);
    for (const name of r.anims) effects(`${r.part} @keyframes ${name}`, effectsIn(keyframes.get(name).replace(/[^{};]*\{/g, ";").replace(/\}/g, ";")), d);
  }
  return { rootPx, findings: out };
}

/** The findings that make text under `minPx` on screen at `zoom`: a size too small or one this scan cannot read, and every zoom / scale / text-size-adjust that is not the identity. */
export function tooSmall({ findings }, zoom, minPx = 10) {
  return findings.filter((f) => f.type !== "font-size" || f.px === null || f.px * zoom < minPx);
}

// ---- which stylesheets there are ------------------------------------------------------------------------------------------------------------------
const SCRIPT = /\.(?:[cm]?[jt]sx?)$/;
const CSS_IN_SCRIPT = /(?:\bimport\s*(?:[^'"()]*?\bfrom\s*)?|\bimport\s*\(\s*|\brequire\s*\(\s*|\bnew\s+URL\s*\(\s*)["']([^"']+?\.css)(?:\?[^"']*)?["']/g;
const CSS_IMPORT = /@import\s+(?:url\(\s*)?["']?([^"')\s;]+)/gi;

/**
 * { files, css }: the stylesheets of the app in `webDir` and their text. files are relative to webDir ("<style> in index.html" for inline ones).
 * Not read: stylesheets under node_modules (React Flow's, @fontsource's) and anything outside webDir.
 */
export function appStylesheets(webDir) {
  const root = fs.realpathSync(path.resolve(webDir)), texts = new Map();
  const inside = (f) => { const rel = path.relative(root, f); return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel) && !rel.split(path.sep).includes("node_modules"); };
  const add = (file) => {
    let f;
    try { f = fs.realpathSync(file); } catch { return; }
    if (texts.has(f) || !inside(f) || !fs.statSync(f).isFile()) return;
    const text = fs.readFileSync(f, "utf8");
    texts.set(f, text);
    for (const m of text.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(CSS_IMPORT)) add(m[1].startsWith("/") ? path.join(root, m[1]) : path.resolve(path.dirname(f), m[1]));
  };
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(f); } else if (e.name.endsWith(".css")) add(f);
      else if (SCRIPT.test(e.name)) {
        for (const m of fs.readFileSync(f, "utf8").matchAll(CSS_IN_SCRIPT)) {
          if (m[1].startsWith(".")) add(path.resolve(dir, m[1])); else if (m[1].startsWith("/")) add(path.join(root, m[1])); // a bare name is a package: node_modules
        }
      }
    }
  };
  if (fs.existsSync(path.join(root, "src"))) walk(path.join(root, "src"));
  const inline = [];
  const indexHtml = path.join(root, "index.html");
  if (fs.existsSync(indexHtml)) {
    const html = fs.readFileSync(indexHtml, "utf8");
    for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
      const href = /\brel\s*=\s*["']?stylesheet/i.test(m[0]) && /\bhref\s*=\s*["']([^"']+)["']/i.exec(m[0]);
      if (href) { const h = href[1].split(/[?#]/)[0]; add(h.startsWith("/") ? path.join(root, h) : path.resolve(root, h)); add(path.join(root, "public", h)); }
    }
    for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) inline.push(m[1]);
  }
  const entries = [...texts].map(([f, t]) => [path.relative(root, f), t]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return { files: [...entries.map(([f]) => f), ...(inline.length ? ["<style> in index.html"] : [])], css: [...entries.map(([, t]) => t), ...inline].join("\n") };
}

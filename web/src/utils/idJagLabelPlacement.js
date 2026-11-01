import { labelPoint } from "./orthoRoute";

// Where the step badge and its words sit on the playground diagrams. Pure functions, no DOM: the sizes of
// the words come in through `measure`, so the placement can be unit tested without a browser.
//
// Labels keep one size on screen whatever the zoom (the page counter-scales them), so everything here is
// computed in SCREEN pixels: a route point p becomes (p.x * zoom + tx, p.y * zoom + ty). The result is
// converted back to flow pixels, where the label's anchor lives.
//
// A label is a badge (24px circle with the step number) that sits ON its arrow, plus optional words in a
// pill beside it. The words show while the arrow is lit by the step (or on hover). The pill grows to the
// right or left of the badge (side r|l) and sits level with it, or just above or below it (valign c|u|d).
// An arrow that found no way round the boxes (one dragged onto another) is drawn as a plain line and gets a badge only, placed on that line.
// A lit label whose words cannot be placed without covering a box or another label is NOT drawn with its
// words (ok: false): its badge stays on the arrow and the words stay in the step list and on hover.

export const BADGE = 24;       // badge diameter
const AIR = 3;                 // clear air kept around every box and label
const BADGE_GAP = 30;          // two badge centres closer than this collide
const GAP = 4;                 // between badge and words
const WORDS_PAD = 18;          // padding + border inside the words box, both sides
const LINE_H = 14.4;           // line height of the words (11.52px * 1.25)
const WORDS_V = 8;             // vertical padding + border of the words box
const MAX_W = 420;             // widest label (badge + words); matches the page
const CHAR = 6.6;              // default px per character when no measure is given
const SLACK = 1.04;            // room for a font that measures a little narrower than it draws
const STEP = 10;               // spacing of candidate badge spots along an arrow
const MAX_SPOTS = 48;
const CLEAN = 250;             // a label that costs less than this is placed well enough; looser spots are tried only above it
const HOVER_TRIES = 8;         // spots checked for a clear hover place, among the best ones
const NO_HOVER = 60;           // extra cost of a spot whose words have no clear place on hover
const HARD = 400;              // a cost at or above this means a label covers a box or another label, or its words are not visible

/** The words of an edge label without its leading step circle (the badge shows the number). */
export const stripLabel = (label) => label.replace(/^[\u2460-\u2468\u2013]+\s*/, "");

const hit = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/**
 * Sizes the label can take for `text` (the words, without the step circle): one line when it fits MAX_W, else
 * narrower and taller. `measure(str)` is the width of a string in px (default: a flat estimate). Returns
 * [{ w, h }] widest first; w is the whole label (badge + words), h the height of the words box.
 */
export function pillSizes(text, measure = (s) => s.length * CHAR) {
  const m = (s) => measure(s) * SLACK;
  const words = text.split(/\s+/).filter(Boolean);
  const full = m(text) + WORDS_PAD;
  const widest = Math.min(MAX_W - BADGE - GAP, Math.ceil(full));
  const tries = [...new Set([widest, 300, 240, 190, 150, 120].filter((w) => w <= widest))];
  const out = [];
  for (const ww of tries) {
    const room = ww - WORDS_PAD;
    let lines = 1, cur = 0, longest = 0;
    for (const w of words) {
      const wl = m(w), sp = cur ? m(" ") : 0;
      if (cur && cur + sp + wl > room) { lines += 1; longest = Math.max(longest, cur); cur = 0; }
      if (wl > room) { lines += Math.ceil(wl / room) - 1; cur = wl % room; longest = room; } // an unbreakable word wraps anywhere
      else cur += (cur ? sp : 0) + wl;
    }
    longest = Math.max(longest, cur);
    const w = Math.min(ww, Math.ceil(longest + WORDS_PAD));
    if (!out.some((o) => o.w === w + BADGE + GAP && o.lines === lines)) out.push({ w: w + BADGE + GAP, h: Math.ceil(lines * LINE_H + WORDS_V), lines });
  }
  return out;
}

/** The label's box with its badge centre at p. side r: words to the right, l: to the left. valign c: level, u: above, d: below the badge. */
export function labelRect(p, side, valign, size) {
  const w = size ? size.w : BADGE, h = Math.max(BADGE, size ? size.h : BADGE);
  const x = side === "r" ? p.x - BADGE / 2 : p.x + BADGE / 2 - w;
  const y = valign === "u" ? p.y + BADGE / 2 - h : valign === "d" ? p.y - BADGE / 2 : p.y - h / 2;
  return { x, y, w, h };
}
const badgeRect = (p) => ({ x: p.x - BADGE / 2, y: p.y - BADGE / 2, w: BADGE, h: BADGE });

/** Points along an arrow where a badge may sit: `clear` px away from both ends (the boxes) and `bend` px from corners. `mids` adds the middle of every run. */
export function badgeSpots(pts, { clear = 26, bend = 14, step = 8, mids = false } = {}) {
  const out = [];
  let run = 0;
  const total = pts.slice(1).reduce((s, q, i) => s + Math.abs(q.x - pts[i].x) + Math.abs(q.y - pts[i].y), 0);
  pts.slice(1).forEach((q, i) => {
    const a = pts[i], len = Math.abs(q.x - a.x) + Math.abs(q.y - a.y);
    // `mids`: the middle of each run is a candidate too, so a short run between two boxes can hold its badge in the centre of the gap, not on the grid
    const ts = []; for (let t = 0; t <= len; t += step) ts.push(t);
    if (mids && len > 0) ts.push(len / 2);
    for (const t of ts) {
      const at = run + t;
      if (at < clear || total - at < clear || t < bend || len - t < bend) continue;
      out.push({ x: a.x + ((q.x - a.x) * t) / len, y: a.y + ((q.y - a.y) * t) / len });
    }
    run += len;
  });
  return out;
}

// Candidate spots in tiers: full clearance from the boxes and bends first, then less and less. The placer only
// looks at a looser tier when the tiers before it leave the label covering something.
const NUDGE = [5, 9];           // px a badge may sit off its line (see spotTiers)
const TIERS = [{ clear: 26, bend: 14 }, { clear: 18, bend: 10 }, { clear: 12, bend: 6 }, { clear: 0, bend: 0 }];
function spotTiers(pts) {
  const thin = (s) => (s.length > MAX_SPOTS ? Array.from({ length: MAX_SPOTS }, (_, i) => s[Math.round((i * (s.length - 1)) / (MAX_SPOTS - 1))]) : s);
  const tiers = [];
  for (const o of TIERS) {
    const s = thin(badgeSpots(pts, { ...o, step: STEP, mids: o.clear <= 12 }));
    if (s.length > (tiers.at(-1)?.length ?? 0)) tiers.push(s);
  }
  if (!tiers.length) tiers.push([labelPoint(pts)]);
  // Last resort: the badge may sit a few px off its line (it is 24px wide, so it still covers the arrow), to get clear of a box, a label or the canvas edge.
  const base = tiers.at(-1);
  const every = Math.max(1, Math.ceil(base.length / 24));
  tiers.push(base.filter((_, i) => i % every === 0).flatMap((p) => NUDGE.flatMap((n) => [{ x: p.x + n, y: p.y }, { x: p.x - n, y: p.y }, { x: p.x, y: p.y + n }, { x: p.x, y: p.y - n }])));
  return tiers;
}

/**
 * Place every routed edge's badge and words.
 *   routes  { [edgeId]: { pts, ok } } in flow pixels      rects  { [boxId]: { x, y, w, h } } in flow pixels
 *   edges   [{ id, label }]
 *   opts    zoom, tx, ty  the view (screen = flow * zoom + t)   view { w, h }  the canvas, so labels avoid its edge
 *           lit  Set of edge ids whose words are showing (they must not cover each other)    measure  see pillSizes
 *           avoid  screen rects (canvas coordinates) labels must stay clear of: the zoom buttons and tool buttons drawn over the canvas
 * Returns { [edgeId]: { x, y, side, valign, w, h, ok } }: x, y the badge centre in flow pixels; w, h the words
 * label in screen pixels; ok false = for a lit edge the words did not fit anywhere clear (show the badge only;
 * on hover the words still show here); for an unlit edge it is the hover placement.
 */
export function placeLabels(routes, rects, edges, opts = {}) {
  const { zoom = 1, tx = 0, ty = 0, view = null, lit = new Set(), measure, avoid = [] } = opts;
  const S = (p) => ({ x: p.x * zoom + tx, y: p.y * zoom + ty });
  const ext = (r) => ({ x0: r.x - AIR, y0: r.y - AIR, x1: r.x + r.w + AIR, y1: r.y + r.h + AIR });
  const real = [...Object.values(rects).map((r) => ({ x: r.x * zoom + tx, y: r.y * zoom + ty, w: r.w * zoom, h: r.h * zoom })), ...avoid];
  const boxes = real.map(ext);
  const ids = edges.filter((e) => routes[e.id]?.pts.length >= 2).map((e) => e.id); // an arrow with no route round the boxes has its plain line (routeEdges), so its badge is placed too
  const byId = Object.fromEntries(edges.map((e) => [e.id, e]));
  const screen = Object.fromEntries(ids.map((id) => [id, routes[id].pts.map(S)]));
  const mid = Object.fromEntries(ids.map((id) => [id, labelPoint(screen[id])]));
  const tiersOf = Object.fromEntries(ids.map((id) => [id, spotTiers(screen[id]).map((t) => t.map((p) => ({ p, d: Math.abs(p.x - mid[id].x) + Math.abs(p.y - mid[id].y) })))]));
  const sizes = Object.fromEntries(ids.map((id) => [id, pillSizes(stripLabel(byId[id].label ?? ""), measure)]));
  // every run of every arrow as its bounding box (the runs are straight and axis-aligned)
  const runs = Object.fromEntries(ids.map((id) => [id, screen[id].slice(1).map((q, i) => { const a = screen[id][i]; return { x0: Math.min(a.x, q.x), y0: Math.min(a.y, q.y), x1: Math.max(a.x, q.x), y1: Math.max(a.y, q.y) }; })]));
  let showing = new Set(ids.filter((id) => lit.has(id) && routes[id].ok !== false)); // edges currently drawn with their words (an arrow with no route never shows its words)
  const demoted = new Set();
  const overlap = (a, b) => a.x < b.x1 && a.x + a.w > b.x0 && a.y < b.y1 && a.y + a.h > b.y0; // rect vs extent

  // Cost of putting edge `id` at spot p with this word box (size null = the badge alone) against what the others hold now.
  // Stops adding as soon as the cost reaches `limit` (a candidate that is already no better than the best so far).
  const cost = (id, p, side, valign, size, placed, isLit, limit = Infinity) => {
    const rect = labelRect(p, side, valign, size);
    const badge = { x: p.x - BADGE / 2 - AIR, y: p.y - BADGE / 2 - AIR, w: BADGE + 2 * AIR, h: BADGE + 2 * AIR };
    let c = 0;
    if (size) {
      for (const bx of boxes) if (overlap(rect, bx)) { c += 1000; if (c >= limit) return c; }
    } else {
      // A badge alone is a circle. How far it reaches into a box counts (squared, so two small dips beat one deep one): where the gap between two boxes is
      // too narrow for it (24px) the centre of the gap wins over a spot that sits further into one box. Reaching only into the air kept around a box costs
      // less than any touch, but still enough (over CLEAN) that a looser tier is looked at.
      for (const r of real) {
        const d = Math.hypot(Math.max(r.x - p.x, 0, p.x - r.x - r.w), Math.max(r.y - p.y, 0, p.y - r.y - r.h));
        if (d < BADGE / 2) c += 600 + 60 * (BADGE / 2 - d) ** 2;
        else if (d < BADGE / 2 + AIR) c += 250 + 10 * (BADGE / 2 + AIR - d);
        if (c >= limit) return c;
      }
    }
    if (view) {
      const inside = rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= view.w && rect.y + rect.h <= view.h;
      if (!inside) { c += rect.x < view.w && rect.x + rect.w > 0 && rect.y < view.h && rect.y + rect.h > 0 ? (isLit ? 500 : 350) : (isLit ? HARD : 0); if (c >= limit) return c; } // cut by the canvas edge / words out of sight
    }
    for (const k of ids) {
      const o = placed[k];
      if (k === id || !o) continue;
      if (Math.abs(p.x - o.p.x) < BADGE_GAP && Math.abs(p.y - o.p.y) < BADGE_GAP) c += 400;                   // two badges
      if (isLit && o.words && hit(rect, o.rect)) c += 600;                                                    // two visible word boxes
      else if (size && hit({ x: rect.x - AIR, y: rect.y - AIR, w: rect.w + 2 * AIR, h: rect.h + 2 * AIR }, o.badge)) c += 400; // my words over their badge
      else if (o.words && hit(badge, o.rect)) c += 400;                                                       // my badge under their words
      if (c >= limit) return c;
    }
    let onArrows = 0;
    for (const k of ids) {
      if (k === id) continue;
      for (const r of runs[k]) {
        if (Math.hypot(Math.max(r.x0 - p.x, 0, p.x - r.x1), Math.max(r.y0 - p.y, 0, p.y - r.y1)) < 14) onArrows += 80; // badge on another arrow
        else if (size && rect.x < r.x1 + 1 && rect.x + rect.w > r.x0 - 1 && rect.y < r.y1 + 1 && rect.y + rect.h > r.y0 - 1) onArrows += 25;
      }
    }
    return c + Math.min(onArrows, 150); // a nuisance, never a reason to drop the words
  };
  const prefs = (size, side, valign) => (size ? (size.lines - 1) * 12 : 0) + (side === "l" ? 1 : 0) + (valign === "c" ? 0 : 4);
  const wordOptions = (id) => sizes[id].flatMap((size) => ["c", "d", "u"].flatMap((valign) => ["r", "l"].map((side) => ({ size, side, valign }))));
  const plain = [{ size: null, side: "r", valign: "c" }];
  const hoverClear = (id, p, placed) => wordOptions(id).some(({ size, side, valign }) => cost(id, p, side, valign, size, placed, true, HARD) < HARD);
  const mk = (c, p, side, valign, size, words) => ({ c, p, side, valign, size, words, rect: labelRect(p, side, valign, size), badge: { x: p.x - BADGE / 2, y: p.y - BADGE / 2, w: BADGE, h: BADGE } });

  const choose = (id, placed) => {
    const isLit = showing.has(id);
    const options = isLit ? wordOptions(id) : plain;
    let best = null;
    for (const tier of tiersOf[id]) {
      const tried = [];
      for (const { p, d } of tier) {
        for (const { size, side, valign } of options) {
          const extra = d * 0.05 + prefs(size, side, valign);
          const c = cost(id, p, side, valign, size, placed, isLit, isLit && best ? best.c - extra : Infinity) + extra; // an unlit spot keeps its true cost: the hover check below ranks by it
          if (!isLit) tried.push({ c, p });
          if (!best || c < best.c) best = mk(c, p, side, valign, size, isLit);
        }
      }
      // A badge with its words hidden should still have a clear place for them on hover: among the best few spots prefer one that has it.
      if (!isLit && best.c < CLEAN) {
        const top = tried.filter((t) => t.c < CLEAN).sort((x, y) => x.c - y.c).slice(0, HOVER_TRIES);
        let pick = null;
        for (const t of top) {
          const score = t.c + (hoverClear(id, t.p, placed) ? 0 : NO_HOVER);
          if (!pick || score < pick.score) pick = { ...t, score };
        }
        best = mk(pick.c, pick.p, "r", "c", null, false);
      }
      if (best.c < CLEAN) break;
    }
    return best;
  };

  let placed = {};
  for (let sweeps = 3; ; sweeps = 2) { // after a label loses its words the others settle again from where they were
    for (let sweep = 0; sweep < sweeps; sweep++) for (const id of ids) placed[id] = choose(id, placed);
    // a lit label that still covers something loses its words (the dearest first)
    const bad = [...showing].filter((id) => placed[id].c >= HARD).sort((a, b) => placed[b].c - placed[a].c || sizes[b][0].w * sizes[b][0].h - sizes[a][0].w * sizes[a][0].h);
    if (!bad.length) break;
    showing = new Set([...showing].filter((id) => id !== bad[0]));
    demoted.add(bad[0]);
  }

  // hover placement for an edge whose words are not showing: the badge stays, the words go where they are clear of boxes, badges and shown words
  const out = {};
  for (const id of ids) {
    const o = placed[id];
    let best = o;
    if (!showing.has(id)) {
      best = null;
      for (const { size, side, valign } of wordOptions(id)) {
        const c = cost(id, o.p, side, valign, size, placed, true, best ? best.c - prefs(size, side, valign) : Infinity) + prefs(size, side, valign);
        if (!best || c < best.c) best = { c, side, valign, size };
      }
    }
    out[id] = {
      x: (o.p.x - tx) / zoom, y: (o.p.y - ty) / zoom, side: best.side, valign: best.valign, w: best.size.w, h: best.size.h,
      ok: best.c < HARD && !demoted.has(id),
    };
  }
  return out;
}

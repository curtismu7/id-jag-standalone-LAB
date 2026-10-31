import { createRouter, labelPoint } from "./orthoRoute";

// Pure helpers behind the routed arrows on the playground diagrams: handle pixels, handle sides and the
// routing of every edge around every box (cards and callouts alike).

/** The words of an edge label without its leading step circle (the badge shows the number). */
export const stripLabel = (label) => label.replace(/^[\u2460-\u2468\u2013]+\s*/, "");

/** Handle id (T|B|L|R + 1..3) -> side letter used by the router (t|b|l|r). */
export const handleDir = (id) => id[0].toLowerCase();

/** Pixel of handle `id` on a box rect {x, y, w, h}: slot n sits n * 25% along its side (see Card). */
export function handlePoint({ x, y, w, h }, id) {
  const f = Number(id[1]) * 0.25;
  switch (id[0]) {
    case "T": return { x: x + w * f, y };
    case "B": return { x: x + w * f, y: y + h };
    case "L": return { x, y: y + h * f };
    default: return { x: x + w, y: y + h * f };
  }
}

/**
 * Route every edge ({ id, from, fh, to, th }) around all boxes in `rects` ({ [id]: {x, y, w, h} }).
 * Every box is an obstacle, an edge's own two included (the lead in/out reaches the handle). Edge order
 * decides lane assignment, so it is kept as given. Returns { routes: { [edgeId]: {pts, ok} }, fallbacks, places } (see separateRoutes, placeLabels).
 */
export function routeEdges(rects, edges) {
  const router = createRouter({ obstacles: Object.values(rects) });
  const routes = {};
  let fallbacks = 0;
  for (const e of edges) {
    const a = rects[e.from], b = rects[e.to];
    if (!a || !b) continue;
    const r = router.route({ start: handlePoint(a, e.fh), end: handlePoint(b, e.th), startDir: handleDir(e.fh), endDir: handleDir(e.th) });
    routes[e.id] = r;
    if (!r.ok) fallbacks += 1;
  }
  const apart = separateRoutes(routes, rects, edges);
  return { routes: apart, fallbacks, places: placeLabels(apart, rects, edges) };
}

// ---- Keeping arrows apart --------------------------------------------------------------------------------
// The router nudges a shared run by only a few px, which reads as one line. After routing, an interior run
// that still lies on another arrow's run is moved clear of it, when the move stays out of every box.

const GAP = 10;          // wanted distance between two parallel runs
const SAME = 6;          // closer than this counts as the same line
const OVERLAP = 12;      // shorter shared stretches are just a crossing
const isV = (a, b) => a.x === b.x;
const span = (a, b, c) => [Math.min(a[c], b[c]), Math.max(a[c], b[c])];
const hitsRect = (a, b, r, m) => { // does segment a-b enter rect r shrunk (m < 0: grown) by m
  const [x0, x1] = span(a, b, "x"), [y0, y1] = span(a, b, "y");
  return x1 > r.x + m && x0 < r.x + r.w - m && y1 > r.y + m && y0 < r.y + r.h - m;
};
/** Do two straight runs lie on the same line (within SAME) and share more than OVERLAP of it? */
function onSameLine(a, b, c, d) {
  if (isV(a, b) !== isV(c, d)) return false;
  const [ax, mv] = isV(a, b) ? ["x", "y"] : ["y", "x"];
  if (Math.abs(a[ax] - c[ax]) > SAME) return false;
  const [s0, s1] = span(a, b, mv), [t0, t1] = span(c, d, mv);
  return Math.min(s1, t1) - Math.max(s0, t0) > OVERLAP;
}

/**
 * Move interior runs that lie on another edge's run to a free parallel line GAP away. The first and last
 * runs stay pinned to their handles. Takes and returns { [edgeId]: {pts, ok} }; input is not mutated.
 */
export function separateRoutes(routes, rects, edges) {
  const out = {};
  for (const e of edges) if (routes[e.id]) out[e.id] = routes[e.id].ok ? { ...routes[e.id], pts: routes[e.id].pts.map((p) => ({ ...p })) } : routes[e.id];
  const boxes = Object.values(rects);
  const others = (id) => Object.entries(out).filter(([k, r]) => k !== id && r.ok);
  const clashes = (id, a, b) => others(id).some(([, r]) => r.pts.slice(1).some((q, i) => onSameLine(a, b, r.pts[i], q)));
  for (const e of edges) {
    const r = out[e.id];
    if (!r || !r.ok) continue;
    const p = r.pts, last = p.length - 2; // segment i runs p[i] -> p[i + 1]; 0 and last stay put
    for (let i = 1; i < last; i++) {
      let o = null; // the other edge's run this one lies on
      for (const [, r2] of others(e.id)) o ||= r2.pts.find((q, j) => j < r2.pts.length - 1 && onSameLine(p[i], p[i + 1], q, r2.pts[j + 1]));
      if (!o) continue;
      const ax = isV(p[i], p[i + 1]) ? "x" : "y";
      for (const c of [o[ax] + GAP, o[ax] - GAP, o[ax] + 2 * GAP, o[ax] - 2 * GAP]) {
        const a = { ...p[i], [ax]: c }, b = { ...p[i + 1], [ax]: c };
        const before = p[i - 1], after = p[i + 2];
        // neighbours must keep their direction and a visible length (the pinned lead a little less)
        const keeps = (from, old, nw, pinned) => (nw[ax] - from[ax]) * (old[ax] - from[ax]) > 0 && Math.abs(nw[ax] - from[ax]) >= (pinned ? 8 : 4);
        if (!keeps(before, p[i], a, i - 1 === 0) || !keeps(after, p[i + 1], b, i + 1 === last)) continue;
        if (boxes.some((bx) => hitsRect(a, b, bx, -4) || hitsRect(before, a, bx, 1) || hitsRect(b, after, bx, 1))) continue;
        if (clashes(e.id, a, b)) continue;
        p[i] = a; p[i + 1] = b;
        break;
      }
    }
  }
  return out;
}

// ---- Where the step badge and its words sit --------------------------------------------------------------
// The badge sits on the arrow. The words pill grows from the badge to its right or left. Both are put where
// the pill covers no box, no other badge and (for arrows of the same step) no other pill.

const BADGE = 30;        // badge box incl. air: two badges closer than this collide
const PILL_PAD = 36;     // badge + gap + padding inside the pill
const CHAR = 6.6;        // px per character of the words (bold, ~11.5px)
const WRAP = 1.15;       // words wrap on word ends, so a wrapped pill needs more room than the plain text width
const LINE = 16;
const MAX_W = 420;       // matches max-width of .elabel
const EDGE_CLEAR = 26;   // badge centre this far from a box (arrow end) and 14 from a bend
const STEP = 8;

/** Pill size options for a label of `text`: one line if it fits MAX_W, else narrower, taller pills. */
export function pillSizes(text) {
  const px = text.length * CHAR;
  const widths = [...new Set([Math.min(MAX_W, px + PILL_PAD), 300, 220, 170].filter((w) => w <= Math.min(MAX_W, px + PILL_PAD)))];
  return widths.map((w) => ({ w, h: Math.max(28, Math.ceil((px * WRAP) / (w - PILL_PAD)) * LINE + 8) }));
}

const rectOverlap = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const pillRect = (p, side, { w, h }) => ({ x: side === "r" ? p.x - 14 : p.x + 14 - w, y: p.y - h / 2, w, h });
const badgeRect = (p) => ({ x: p.x - BADGE / 2, y: p.y - BADGE / 2, w: BADGE, h: BADGE });
const distToSeg = (p, a, b) => {
  const [x0, x1] = span(a, b, "x"), [y0, y1] = span(a, b, "y");
  return Math.hypot(Math.max(x0 - p.x, 0, p.x - x1), Math.max(y0 - p.y, 0, p.y - y1));
};

/** Points along an arrow where a badge may sit: away from both boxes and from bends. */
export function badgeSpots(pts) {
  const out = [];
  let run = 0;
  const total = pts.slice(1).reduce((s, q, i) => s + Math.abs(q.x - pts[i].x) + Math.abs(q.y - pts[i].y), 0);
  pts.slice(1).forEach((q, i) => {
    const a = pts[i], len = Math.abs(q.x - a.x) + Math.abs(q.y - a.y);
    for (let t = 0; t <= len; t += STEP) {
      const at = run + t;
      if (at < EDGE_CLEAR || total - at < EDGE_CLEAR || t < 14 || len - t < 14) continue;
      out.push({ x: a.x + ((q.x - a.x) * t) / len, y: a.y + ((q.y - a.y) * t) / len });
    }
    run += len;
  });
  return out;
}

/**
 * Pick, for every routed edge ({ id, label, steps }), the badge point on its arrow plus the side and size of
 * its words pill. Edges are placed in order, then re-placed twice against everyone else's choice.
 * Returns { [edgeId]: { x, y, side, w } }.
 */
export function placeLabels(routes, rects, edges) {
  const boxes = Object.values(rects).map((r) => ({ x: r.x - 3, y: r.y - 3, w: r.w + 6, h: r.h + 6 }));
  const ids = edges.filter((e) => routes[e.id]?.ok && routes[e.id].pts.length > 2).map((e) => e.id);
  const byId = Object.fromEntries(edges.map((e) => [e.id, e]));
  const spots = Object.fromEntries(ids.map((id) => {
    const pts = routes[id].pts, mid = labelPoint(pts), s = badgeSpots(pts);
    return [id, (s.length ? s : [mid]).map((p) => ({ p, d: Math.abs(p.x - mid.x) + Math.abs(p.y - mid.y) }))];
  }));
  const segs = (skip) => ids.filter((k) => k !== skip).flatMap((k) => routes[k].pts.slice(1).map((q, i) => [routes[k].pts[i], q]));
  const placed = {};
  const cost = (id, p, side, size) => {
    const pill = pillRect(p, side, size), badge = badgeRect(p);
    let c = 0;
    for (const bx of boxes) if (rectOverlap(pill, bx)) c += 1000;
    for (const k of ids) {
      const o = placed[k];
      if (k === id || !o) continue;
      if (rectOverlap(badge, badgeRect(o))) c += 400;
      else if (rectOverlap(pill, badgeRect(o))) c += 200;
      if ((byId[k].steps ?? []).some((s) => (byId[id].steps ?? []).includes(s)) && rectOverlap(pill, pillRect(o, o.side, o))) c += 300;
    }
    for (const [a, b] of segs(id)) {
      if (distToSeg(p, a, b) < 14) c += 80; // badge body on another arrow
      else if (rectOverlap(pill, { x: Math.min(a.x, b.x) - 1, y: Math.min(a.y, b.y) - 1, w: Math.abs(a.x - b.x) + 2, h: Math.abs(a.y - b.y) + 2 })) c += 25; // pill over another arrow
    }
    return c;
  };
  for (let sweep = 0; sweep < 3; sweep++) {
    for (const id of ids) {
      let best = null;
      for (const { p, d } of spots[id]) {
        for (const size of pillSizes(stripLabel(byId[id].label ?? ""))) {
          for (const side of ["r", "l"]) {
            const c = cost(id, p, side, size) + d * 0.05 + (size.h > 28 ? 12 * (size.h / LINE - 1) : 0) + (side === "l" ? 1 : 0);
            if (!best || c < best.c) best = { c, x: p.x, y: p.y, side, w: size.w, h: size.h };
          }
        }
      }
      placed[id] = best;
    }
  }
  return Object.fromEntries(ids.map((id) => [id, { x: placed[id].x, y: placed[id].y, side: placed[id].side, w: placed[id].w, h: placed[id].h }]));
}

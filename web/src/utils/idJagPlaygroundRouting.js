import { createRouter } from "./orthoRoute";

// Pure helpers behind the routed arrows on the playground diagrams: handle pixels, handle sides and the
// routing of every edge around every box (cards and callouts alike).

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

/** An orthogonal line from `a` to `b` that leaves `a` along its side's axis and arrives along `b`'s: a straight run, an L or a Z. No box is avoided. */
export function plainRoute(a, b, aDir, bDir) {
  const horiz = (d) => d === "l" || d === "r";
  let mid;
  if (horiz(aDir) && horiz(bDir)) { const x = (a.x + b.x) / 2; mid = [{ x, y: a.y }, { x, y: b.y }]; }
  else if (!horiz(aDir) && !horiz(bDir)) { const y = (a.y + b.y) / 2; mid = [{ x: a.x, y }, { x: b.x, y }]; }
  else if (horiz(aDir)) mid = [{ x: b.x, y: a.y }];
  else mid = [{ x: a.x, y: b.y }];
  const pts = [a, ...mid, b];
  return pts.filter((p, i) => i === 0 || i === pts.length - 1 || !(pts[i - 1].x === p.x && p.x === pts[i + 1].x) && !(pts[i - 1].y === p.y && p.y === pts[i + 1].y));
}

/**
 * Route every edge ({ id, from, fh, to, th }) around all boxes in `rects` ({ [id]: {x, y, w, h} }).
 * Every box is an obstacle, an edge's own two included (the lead in/out reaches the handle). Edge order
 * decides lane assignment, so it is kept as given. Returns { routes: { [edgeId]: {pts, ok} }, fallbacks } (see separateRoutes; the badges are placed afterwards by placeLabels in idJagLabelPlacement.js).
 */
export function routeEdges(rects, edges) {
  const router = createRouter({ obstacles: Object.values(rects) });
  const routes = {};
  let fallbacks = 0;
  for (const e of edges) {
    const a = rects[e.from], b = rects[e.to];
    if (!a || !b) continue;
    const r = router.route({ start: handlePoint(a, e.fh), end: handlePoint(b, e.th), startDir: handleDir(e.fh), endDir: handleDir(e.th) });
    // No way round (boxes dragged onto each other): the arrow is still drawn, as a plain orthogonal line, so its badge can be placed ON that line
    // and kept off every box (see placeLabels). Left as [start, end] it was drawn by React Flow's own smooth step and its badge sat at that line's midpoint, often on a box.
    routes[e.id] = r.ok ? r : { ...r, pts: plainRoute(handlePoint(a, e.fh), handlePoint(b, e.th), handleDir(e.fh), handleDir(e.th)) };
    if (!r.ok) fallbacks += 1;
  }
  return { routes: separateRoutes(routes, rects, edges), fallbacks };
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

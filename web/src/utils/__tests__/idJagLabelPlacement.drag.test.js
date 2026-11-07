// Split out of idJagLabelPlacement.test.js: this sweep is most of that file's CPU time, and a separate file runs on its own worker, in parallel
// with the rest, instead of making one worker the long tail of the whole run.
import { PLAYGROUND_DIAGRAMS, PLAYGROUND_DIAGRAM_MODES, stepParts } from "../idJagPlaygroundDiagrams";
import { routeEdges } from "../idJagPlaygroundRouting";
import { READABLE_MIN_ZOOM } from "../../pages/IdJagPlaygroundDiagramPage";
import { BADGE, labelRect, placeLabels } from "../idJagLabelPlacement";

const hit = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
/** Give the event loop a turn, so a long sweep does not starve the test runner's messages to its worker (vitest drops the run on a 60 s reply timeout). */
const turn = () => new Promise((r) => setTimeout(r, 0));

// ---- after a box is dragged ---------------------------------------------------------------------------------------------
// A box dragged (by hand, or carried further by the canvas panning while it is held) can leave an arrow with no way round the boxes. Its badge
// must still not end up on a box. The checks run what the page runs: routeEdges, then placeLabels in the screen view, at the zoom floor.
describe("after a box is dragged, no badge or shown words sit on a box", () => {
  const Z = READABLE_MIN_ZOOM, VIEW = { w: 343, h: 486 }; // the 375px phone canvas, the tightest
  const AVOID = [{ x: VIEW.w - 243, y: 10, w: 233, h: 40 }, { x: 15, y: VIEW.h - 135, w: 26, h: 120 }]; // the tool buttons and the zoom controls
  const DRAGS = [[40, 30], [-40, -30], [100, 60], [-100, 60], [300, 200], [-300, 200], [300, -200], [-300, -200], [500, 0], [0, 400]]; // screen px
  const heightOf = (n) => 90 + 14 * (n.lines?.length ?? 2);
  // the share of a label's own area that lies on a box: diagram-overlap.js flags a label over 25%
  const onBox = (r, b) => { const w = Math.min(r.x + r.w, b.x + b.w) - Math.max(r.x, b.x), h = Math.min(r.y + r.h, b.y + b.h) - Math.max(r.y, b.y); return w > 0 && h > 0 ? (w * h) / (r.w * r.h) : 0; };

  // Is there any point on the arrow's line where a badge sits clear of every box? (An arrow that runs along the seam between two boxes has none: nothing to place.)
  const hasClearSpot = (pts, boxes) => pts.slice(1).some((q, i) => {
    const a = pts[i], len = Math.hypot(q.x - a.x, q.y - a.y);
    for (let t = 0; t <= len; t += 3) {
      const c = { x: a.x + ((q.x - a.x) * t) / (len || 1), y: a.y + ((q.y - a.y) * t) / (len || 1)};
      const r = { x: c.x - BADGE / 2 - 3, y: c.y - BADGE / 2 - 3, w: BADGE + 6, h: BADGE + 6 };
      if (!boxes.some((b) => hit(r, b))) return true;
    }
    return false;
  });

  it.each(PLAYGROUND_DIAGRAM_MODES.filter((m) => m !== "gateway-redeem" && m !== "aws-agentcore"))("%s: every arrow keeps a badge clear of every box after any one box is dragged, at three places on the canvas", async (mode) => {
    const d = PLAYGROUND_DIAGRAMS[mode];
    const bad = [];
    let checked = 0, unrouted = 0, judged = 0;
    for (const moved of d.nodes) for (const [sx, sy] of DRAGS) {
      await turn(); // one drag is a few ms to a few hundred; the sweep as a whole is tens of seconds of unbroken CPU on a busy machine
      const rects = Object.fromEntries(d.nodes.map((n) => [n.id, { x: n.x + (n.id === moved.id ? sx / Z : 0), y: n.y + (n.id === moved.id ? sy / Z : 0), w: 300, h: heightOf(n) }]));
      const m = rects[moved.id];
      // a box dropped ON another has no clear place for any badge between them: not a case the placement can solve
      if (Object.entries(rects).some(([k, r]) => k !== moved.id && r.x < m.x + m.w + 6 && r.x + r.w + 6 > m.x && r.y < m.y + m.h + 6 && r.y + r.h + 6 > m.y)) continue;
      const { routes } = routeEdges(rects, d.edges);
      for (const [fx, fy] of [[10, 60], [VIEW.w / 2 - 135, VIEW.h / 2 - 50], [VIEW.w - 280, VIEW.h - 120]]) { // where the dragged box shows on the canvas
        const tx = fx - m.x * Z, ty = fy - m.y * Z;
        const lit = new Set(stepParts(d, (checked % 5) + 1).edges); // a different step's arrows show their words each time
        const out = placeLabels(routes, rects, d.edges, { zoom: Z, tx, ty, view: VIEW, avoid: AVOID, lit });
        const boxes = Object.values(rects).map((r) => ({ x: r.x * Z + tx, y: r.y * Z + ty, w: r.w * Z, h: r.h * Z }));
        checked += 1;
        for (const e of d.edges) {
          const p = out[e.id];
          if (!p) { bad.push(`${moved.id} ${sx},${sy} ${e.id}: no place`); continue; }
          const c = { x: p.x * Z + tx, y: p.y * Z + ty };
          const badge = labelRect(c, "r", "c", null);
          const words = lit.has(e.id) && routes[e.id].ok && p.ok ? labelRect(c, p.side, p.valign, p) : null; // shown words must clear the boxes too
          if (words && boxes.some((b) => onBox(words, b) > 0.25)) bad.push(`${moved.id} ${sx},${sy} @${fx},${fy} ${e.id}: words on a box`);
          if (!hasClearSpot(routes[e.id].pts.map((q) => ({ x: q.x * Z + tx, y: q.y * Z + ty })), boxes)) continue;
          judged += 1;
          if (!routes[e.id].ok) unrouted += 1;
          if (boxes.some((b) => onBox(badge, b) > 0.25)) bad.push(`${moved.id} ${sx},${sy} @${fx},${fy} ${e.id}: badge on a box${routes[e.id].ok ? "" : " (no route)"}`);
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
    expect(judged).toBeGreaterThan(checked * 5);
    expect(unrouted, "the drags include ones that leave an arrow with no route, or this test pins nothing about them").toBeGreaterThan(0);
    expect(bad).toEqual([]);
  }, 0); // pure CPU, no timers: a test timeout cannot interrupt it, it can only fail a correct run that a busy machine made slow
});

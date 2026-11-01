import { PLAYGROUND_DIAGRAMS, PLAYGROUND_DIAGRAM_MODES, stepParts } from "../idJagPlaygroundDiagrams";
import { routeEdges } from "../idJagPlaygroundRouting";
import { READABLE_MIN_ZOOM } from "../../pages/IdJagPlaygroundDiagramPage";
import { BADGE, badgeSpots, labelRect, pillSizes, placeLabels, stripLabel } from "../idJagLabelPlacement";

const P = (x, y) => ({ x, y });
const hit = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const rectsOf = (d) => Object.fromEntries(d.nodes.map((n) => [n.id, { x: n.x, y: n.y, w: 300, h: 150 }]));

describe("pillSizes and stripLabel", () => {
  it("strips the step circle", () => {
    expect(stripLabel("③ RFC 7523 jwt-bearer")).toBe("RFC 7523 jwt-bearer");
    expect(stripLabel("①–⑤ POST /x")).toBe("POST /x");
  });
  it("sizes a long label as taller, narrower pills and a short one as a single line", () => {
    const sizes = pillSizes("word ".repeat(30).trim());
    expect(sizes[0].w).toBeLessThanOrEqual(420);
    expect(sizes.at(-1).w).toBeLessThan(sizes[0].w);
    expect(sizes.at(-1).h).toBeGreaterThan(sizes[0].h);
    expect(pillSizes("ok")).toHaveLength(1);
  });
  it("uses the measure it is given and wraps an unbreakable word anywhere", () => {
    const wide = pillSizes("aaa bbb", () => 400);   // every string measures 400px: far too wide for one line
    const narrow = pillSizes("aaa bbb", () => 10);
    expect(wide[0].h).toBeGreaterThan(narrow[0].h);
    const longWord = pillSizes("x".repeat(100)); // one 100-char word: only wrapping anywhere can fit it
    expect(longWord.at(-1).lines).toBeGreaterThan(2);
  });
});

describe("badgeSpots", () => {
  it("with mids, the middle of every run is offered too (a short run holds its badge in the centre)", () => {
    const pts = [P(0, 0), P(23, 0)];
    const plain = badgeSpots(pts, { clear: 0, bend: 0, step: 10 }).map((s) => s.x);
    const withMids = badgeSpots(pts, { clear: 0, bend: 0, step: 10, mids: true }).map((s) => s.x);
    expect(plain).not.toContain(11.5);
    expect(withMids).toContain(11.5);
    expect(withMids.filter((x) => x !== 11.5)).toEqual(plain);
    expect(badgeSpots(pts, { clear: 11, bend: 11, step: 10, mids: true }).map((s) => s.x)).toEqual([11.5]); // the same clearances still apply to it
  });
  it("offers spots only well away from both ends and from bends", () => {
    const pts = [P(0, 0), P(14, 0), P(14, 200), P(300, 200)];
    const spots = badgeSpots(pts);
    expect(spots.length).toBeGreaterThan(5);
    for (const s of spots) {
      expect(Math.abs(s.x) + Math.abs(s.y)).toBeGreaterThanOrEqual(26);
      expect(Math.abs(s.x - 300) + Math.abs(s.y - 200)).toBeGreaterThanOrEqual(26);
      expect(s.x === 14 || s.y === 200).toBe(true);
    }
  });
});

describe("placeLabels", () => {
  const boxA = { x: 0, y: 0, w: 100, h: 100 }, boxB = { x: 900, y: 0, w: 100, h: 100 };
  // The owner's case: four arrows run over one and the same path, so every label used to sit at the same midpoint.
  const shared = [P(100, 50), P(114, 50), P(114, 400), P(886, 400), P(886, 50), P(900, 50)];
  const same = ["e1", "e2", "e3", "e4"].map((id, i) => ({ id, label: `${i + 1} words for arrow ${i} · code_challenge`, steps: [1] }));
  const routes = Object.fromEntries(same.map((e) => [e.id, { ok: true, pts: shared }]));

  it("puts four arrows that share one path at four different places, none on another", () => {
    const out = placeLabels(routes, { a: boxA, b: boxB }, same);
    const centres = same.map((e) => out[e.id]);
    for (const [i, p] of centres.entries()) for (const q of centres.slice(i + 1)) expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThanOrEqual(BADGE);
  });

  it("with every label lit, no two words boxes, and no words box and badge, overlap; every badge stays on its arrow", () => {
    const out = placeLabels(routes, { a: boxA, b: boxB }, same, { lit: new Set(same.map((e) => e.id)) });
    const shown = same.filter((e) => out[e.id].ok).map((e) => ({ e, r: labelRect(out[e.id], out[e.id].side, out[e.id].valign, out[e.id]) }));
    expect(shown.length).toBeGreaterThan(0);
    for (const [i, a] of shown.entries()) for (const b of shown.slice(i + 1)) expect(hit(a.r, b.r), `${a.e.id} / ${b.e.id}`).toBe(false);
    for (const e of same) {
      const p = out[e.id];
      expect(shared.slice(1).some((q, i) => Math.min(shared[i].x, q.x) - 0.5 <= p.x && p.x <= Math.max(shared[i].x, q.x) + 0.5 && Math.min(shared[i].y, q.y) - 0.5 <= p.y && p.y <= Math.max(shared[i].y, q.y) + 0.5), `${e.id} on its arrow`).toBe(true);
    }
  });

  it("drops the words of a lit label that cannot fit clear, and keeps its badge on the arrow", () => {
    // two boxes 60px apart: a 200px words box cannot sit between them, above or below, without covering one
    const a = { x: 0, y: 0, w: 300, h: 300 }, b = { x: 360, y: 0, w: 300, h: 300 };
    const tight = { t: { ok: true, pts: [P(300, 150), P(314, 150), P(346, 150), P(360, 150)] } };
    const out = placeLabels(tight, { a, b }, [{ id: "t", label: "a long label that needs far more room than sixty pixels", steps: [1] }], { lit: new Set(["t"]) });
    expect(out.t.ok).toBe(false);
    expect(out.t.y).toBe(150);
  });

  it("keeps the label's screen size at any zoom: the box it asks for does not change, the anchor does", () => {
    const e = same.slice(0, 1);
    const at = (zoom) => placeLabels({ e1: routes.e1 }, { a: boxA, b: boxB }, e, { zoom, tx: 30, ty: 20, lit: new Set(["e1"]) }).e1;
    const one = at(1), half = at(0.5);
    expect(half.w).toBeLessThanOrEqual(420);
    expect(one.w).toBeLessThanOrEqual(420);
    // anchors are flow pixels: converted by the zoom they land on the same arrow
    const onArrow = (p, zoom) => shared.slice(1).some((q, i) => Math.min(shared[i].x, q.x) - 0.5 <= p.x && p.x <= Math.max(shared[i].x, q.x) + 0.5 && Math.min(shared[i].y, q.y) - 0.5 <= p.y && p.y <= Math.max(shared[i].y, q.y) + 0.5 && zoom > 0);
    expect(onArrow(half, 0.5)).toBe(true);
  });

  it("keeps clear of the canvas buttons it is told about", () => {
    const sh = { r: { ok: true, pts: [P(100, 50), P(114, 50), P(114, 400), P(886, 400), P(886, 50), P(900, 50)] } };
    const edge = [{ id: "r", label: "x", steps: [1] }];
    const free = placeLabels(sh, { a: boxA, b: boxB }, edge).r;
    const out = placeLabels(sh, { a: boxA, b: boxB }, edge, { avoid: [{ x: free.x - 40, y: free.y - 40, w: 80, h: 80 }] }).r;
    expect(Math.hypot(out.x - free.x, out.y - free.y)).toBeGreaterThan(20);
  });

  it("places the badge of an arrow with no route on its plain line, clear of the boxes", () => {
    // boxes 60px apart with a third box between them: the router finds no way, routeEdges hands back the plain line, and a lit label still shows its badge only
    const a = { x: 0, y: 0, w: 100, h: 100 }, b = { x: 400, y: 0, w: 100, h: 100 }, mid = { x: 150, y: -50, w: 200, h: 200 };
    const wall = { x: 330, y: -2000, w: 69, h: 4000 }; // abuts b's left side: nothing can arrive at b's left handle
    const rects = { a, b, mid, wall };
    const { routes } = routeEdges(rects, [{ id: "e", from: "a", fh: "R2", to: "b", th: "L2" }]);
    expect(routes.e.ok).toBe(false);
    expect(routes.e.pts.length).toBeGreaterThanOrEqual(2);
    const out = placeLabels(routes, rects, [{ id: "e", label: "x", steps: [1] }], { lit: new Set(["e"]) }).e;
    expect(out).toBeDefined();
    const r = labelRect({ x: out.x, y: out.y }, "r", "c", null);
    expect(hit(r, mid), "the badge is not on the box between them").toBe(false);
  });

  // An arrow with no route never takes room for its words: its badge is placed as if the arrow were not lit. The pin is a crowded pair, where a lit
  // arrow that did take room would push the other one's words and badge about (a lone label has room anyway, so it could not tell).
  describe("an arrow with no route never claims room for words", () => {
    const left = { x: 0, y: 0, w: 100, h: 100 }, right = { x: 800, y: 0, w: 100, h: 100 };
    const rects = { left, right };
    const text = "POST /token with the subject token and the requested token type";
    const edges = [{ id: "A", label: text }, { id: "B", label: text }];
    const line = (y) => [P(100, y), P(800, y)];
    const run = (a, litA) => placeLabels({ A: { ok: a, pts: line(30) }, B: { ok: true, pts: line(46) } }, rects, edges, { zoom: 1, tx: 0, ty: 0, view: { w: 1000, h: 300 }, lit: new Set(litA ? ["A", "B"] : ["B"]) });
    it("the pair places the same whether the unrouted arrow is lit or not", () => {
      expect(run(false, true)).toEqual(run(false, false));
    });
    it("control: the same pair with A routed does change when A is lit (the crowding is real), so the test above can tell", () => {
      expect(run(true, true)).not.toEqual(run(true, false));
    });
  });

  // A box dragged to end 22 to 40px from a neighbour leaves the arrow between them a short run. The badge is a 24px circle: from 24px up it sits in the
  // gap touching neither box; below that nothing fits, and the centre of the gap (the least reach into either box) is chosen.
  describe("a short run between two boxes", () => {
    const reach = (c, r) => Math.max(0, BADGE / 2 - Math.hypot(Math.max(r.x - c.x, 0, c.x - r.x - r.w), Math.max(r.y - c.y, 0, c.y - r.y - r.h)));
    const cases = [];
    for (let gap = 22; gap <= 40; gap += 1) for (const off of [0, 40, 90, -60, 7]) for (const zoom of [0.9, 1.2]) for (const across of [true, false]) cases.push([gap, off, zoom, across]);
    it("the badge never touches either box from a 24px gap up, and dips at most 1.5px into one in a 22 to 24px gap", () => {
      const worst = [];
      let tight = 0;
      for (const [gap, off, zoom, across] of cases) {
        // `across`: the boxes side by side (arrow runs left to right), else one above the other (arrow runs downwards)
        const a = { x: 0, y: 0, w: 300, h: 150 }, b = across ? { x: 300 + gap / zoom, y: off, w: 300, h: 150 } : { x: off, y: 150 + gap / zoom, w: 300, h: 150 };
        const edges = [{ id: "e", from: "a", fh: across ? "R2" : "B2", to: "b", th: across ? "L2" : "T2", label: "x" }];
        const { routes } = routeEdges({ a, b }, edges);
        const out = placeLabels(routes, { a, b }, edges, { zoom, tx: 30, ty: 30, view: { w: 1100, h: 800 } }).e;
        const c = { x: out.x * zoom + 30, y: out.y * zoom + 30 };
        const screen = [a, b].map((r) => ({ x: r.x * zoom + 30, y: r.y * zoom + 30, w: r.w * zoom, h: r.h * zoom }));
        const dip = Math.max(...screen.map((r) => reach(c, r)));
        if (gap < BADGE) tight += 1;
        if (dip > (gap >= BADGE ? 0.01 : 1.5)) worst.push({ gap, off, zoom, across, dip: +dip.toFixed(2) });
      }
      expect(tight, "the sweep includes gaps too narrow for the badge").toBeGreaterThan(10);
      expect(worst).toEqual([]);
    }, 60000);
  });

  it("is deterministic", () => {
    const a = placeLabels(routes, { a: boxA, b: boxB }, same, { lit: new Set(["e1", "e2"]) });
    const b = placeLabels(routes, { a: boxA, b: boxB }, same, { lit: new Set(["e1", "e2"]) });
    expect(a).toEqual(b);
  });
});

describe("the four diagrams, every step, at three zooms", () => {
  const cases = PLAYGROUND_DIAGRAM_MODES.flatMap((mode) => [0, 1, 2, 3, 4, 5].flatMap((step) => [1, 0.56, 0.4].map((zoom) => [mode, step, zoom])));
  it.each(cases)("%s step %i zoom %f: nothing shown covers a box or another label, and every badge is on its arrow", (mode, step, zoom) => {
    const d = PLAYGROUND_DIAGRAMS[mode];
    const rects = rectsOf(d);
    const { routes: rt } = routeEdges(rects, d.edges);
    const lit = new Set(step ? stepParts(d, step).edges : []);
    const out = placeLabels(rt, rects, d.edges, { zoom, lit });
    const boxes = Object.values(rects).map((r) => ({ x: r.x * zoom, y: r.y * zoom, w: r.w * zoom, h: r.h * zoom }));
    const shown = d.edges.map((e) => {
      const p = { x: out[e.id].x * zoom, y: out[e.id].y * zoom };
      const words = lit.has(e.id) && out[e.id].ok;
      return { id: e.id, p, r: words ? labelRect(p, out[e.id].side, out[e.id].valign, out[e.id]) : labelRect(p, "r", "c", null) };
    });
    for (const [i, a] of shown.entries()) {
      for (const b of boxes) expect(hit(a.r, b), `${a.id} covers a box`).toBe(false);
      for (const b of shown.slice(i + 1)) expect(hit(a.r, b.r), `${a.id} / ${b.id}`).toBe(false);
      const pts = rt[a.id].pts.map((q) => ({ x: q.x * zoom, y: q.y * zoom }));
      expect(pts.slice(1).some((q, k) => Math.min(pts[k].x, q.x) - 9.5 <= a.p.x && a.p.x <= Math.max(pts[k].x, q.x) + 9.5 && Math.min(pts[k].y, q.y) - 9.5 <= a.p.y && a.p.y <= Math.max(pts[k].y, q.y) + 9.5), `${a.id} badge on its arrow (within 9px: it is 24px wide)`).toBe(true);
    }
  });

  it.each(PLAYGROUND_DIAGRAM_MODES)("%s: most lit arrows keep their words on the diagram at the overview zoom", (mode) => {
    const d = PLAYGROUND_DIAGRAMS[mode];
    const rects = rectsOf(d);
    const { routes: rt } = routeEdges(rects, d.edges);
    let lit = 0, kept = 0;
    for (const step of [1, 2, 3, 4, 5]) {
      const ids = stepParts(d, step).edges;
      const out = placeLabels(rt, rects, d.edges, { zoom: 0.56, lit: new Set(ids) });
      lit += ids.length; kept += ids.filter((id) => out[id].ok).length;
    }
    expect(kept / lit).toBeGreaterThan(0.5);
  });
});

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

  it.each(PLAYGROUND_DIAGRAM_MODES.filter((m) => m !== "gateway-redeem"))("%s: every arrow keeps a badge clear of every box after any one box is dragged, at three places on the canvas", (mode) => {
    const d = PLAYGROUND_DIAGRAMS[mode];
    const bad = [];
    let checked = 0, unrouted = 0, judged = 0;
    for (const moved of d.nodes) for (const [sx, sy] of DRAGS) {
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
  }, 120000);
});

import { PLAYGROUND_DIAGRAMS, PLAYGROUND_DIAGRAM_MODES } from "../idJagPlaygroundDiagrams";
import { handleDir, handlePoint, routeEdges, separateRoutes, placeLabels, pillSizes, badgeSpots, stripLabel } from "../idJagPlaygroundRouting";

const box = { x: 100, y: 200, w: 300, h: 80 };

describe("handlePoint / handleDir", () => {
  it("puts slot n at n * 25% along its side, on the box edge", () => {
    expect(handlePoint(box, "T2")).toEqual({ x: 250, y: 200 });
    expect(handlePoint(box, "B1")).toEqual({ x: 175, y: 280 });
    expect(handlePoint(box, "L3")).toEqual({ x: 100, y: 260 });
    expect(handlePoint(box, "R2")).toEqual({ x: 400, y: 240 });
  });
  it("maps a handle id to the router's side letter", () => {
    expect(["T1", "B2", "L3", "R1"].map(handleDir)).toEqual(["t", "b", "l", "r"]);
  });
});

describe("routeEdges", () => {
  const rects = { a: { x: 0, y: 0, w: 300, h: 100 }, b: { x: 700, y: 0, w: 300, h: 100 }, wall: { x: 400, y: -200, w: 100, h: 500 } };
  const edge = { id: "e", from: "a", fh: "R2", to: "b", th: "L2" };

  it("routes around a box in the way with exact right-angle segments ending on the handles", () => {
    const { routes, fallbacks } = routeEdges(rects, [edge]);
    const { pts, ok } = routes.e;
    expect(ok).toBe(true);
    expect(fallbacks).toBe(0);
    expect(pts[0]).toEqual({ x: 300, y: 50 });
    expect(pts.at(-1)).toEqual({ x: 700, y: 50 });
    pts.slice(1).forEach((p, i) => expect(p.x === pts[i].x || p.y === pts[i].y).toBe(true));
    pts.slice(1).forEach((p, i) => { // no segment crosses the wall
      const q = pts[i];
      expect(Math.max(p.x, q.x) > 400 && Math.min(p.x, q.x) < 500 && Math.max(p.y, q.y) > -200 && Math.min(p.y, q.y) < 300).toBe(false);
    });
  });

  it("counts a fallback when an endpoint is boxed in, and skips edges with a missing box", () => {
    const boxed = { ...rects, wall: { x: 650, y: -300, w: 40, h: 700 }, w2: { x: 650, y: -300, w: 400, h: 20 }, w3: { x: 650, y: 380, w: 400, h: 20 }, w4: { x: 1010, y: -300, w: 40, h: 700 } };
    const r = routeEdges(boxed, [edge, { id: "x", from: "a", fh: "R1", to: "nope", th: "L1" }]);
    expect(r.routes.e.ok).toBe(false);
    expect(r.routes.e.pts).toHaveLength(2);
    expect(r.fallbacks).toBe(1);
    expect(r.routes.x).toBeUndefined();
  });
});

describe("the four diagrams route", () => {
  it.each(PLAYGROUND_DIAGRAM_MODES)("%s: every edge is routed from its declared handle sides with no fallback", (mode) => {
    const d = PLAYGROUND_DIAGRAMS[mode];
    const rects = {};
    for (const n of d.nodes) rects[n.id] = { x: n.x, y: n.y, w: 300, h: 150 };
    const { routes, fallbacks } = routeEdges(rects, d.edges);
    expect(fallbacks).toBe(0);
    for (const e of d.edges) {
      const { pts } = routes[e.id];
      expect(pts[0]).toEqual(handlePoint(rects[e.from], e.fh));
      expect(pts.at(-1)).toEqual(handlePoint(rects[e.to], e.th));
    }
  });
});

const P = (x, y) => ({ x, y });
const rectsOf = (d) => Object.fromEntries(d.nodes.map((n) => [n.id, { x: n.x, y: n.y, w: 300, h: 150 }]));

describe("separateRoutes", () => {
  // two arrows share the vertical run at x = 500; the second is moved GAP clear, its ends stay on the handles
  const rects = { a: { x: 0, y: 0, w: 100, h: 100 }, b: { x: 900, y: 0, w: 100, h: 100 } };
  const edges = [{ id: "e1" }, { id: "e2" }];
  const mk = (x) => ({ ok: true, pts: [P(100, 50), P(114, 50), P(x, 50), P(x, 300), P(886, 300), P(886, 50), P(900, 50)] });

  it("moves an interior run off another arrow's run and keeps the first and last runs", () => {
    const out = separateRoutes({ e1: mk(500), e2: mk(503) }, rects, edges);
    expect(Math.abs(out.e1.pts[2].x - out.e2.pts[2].x)).toBeGreaterThanOrEqual(10); // one of the two moved
    for (const { pts } of [out.e1, out.e2]) {
      expect(pts[3].x).toBe(pts[2].x);
      expect(pts[0]).toEqual(P(100, 50));
      expect(pts.at(-1)).toEqual(P(900, 50));
      pts.slice(1).forEach((q, i) => expect(q.x === pts[i].x || q.y === pts[i].y).toBe(true));
    }
  });
  it("does not mutate its input, and leaves fallback routes alone", () => {
    const input = { e1: mk(500), e2: mk(503), e3: { ok: false, pts: [P(0, 0), P(5, 5)] } };
    separateRoutes(input, rects, [...edges, { id: "e3" }]);
    expect(input.e2.pts[2].x).toBe(503);
    expect(separateRoutes(input, rects, [{ id: "e3" }]).e3).toBe(input.e3);
  });
  it("refuses a move that would enter a box", () => {
    const boxed = { ...rects, w1: { x: 506, y: 100, w: 60, h: 100 }, w2: { x: 434, y: 100, w: 60, h: 100 } };
    const out = separateRoutes({ e1: mk(500), e2: mk(503) }, boxed, edges);
    expect(Math.abs(out.e1.pts[2].x - out.e2.pts[2].x)).toBeLessThan(10); // the 10px lanes either side are walled off
  });
  it.each(["mock", "pf-as", "pf-pf", "byo"])("%s: no two arrows share a run any more", (mode) => {
    const d = PLAYGROUND_DIAGRAMS[mode];
    const { routes } = routeEdges(rectsOf(d), d.edges);
    const segs = d.edges.flatMap((e) => routes[e.id].pts.slice(1).map((q, i) => ({ id: e.id, a: routes[e.id].pts[i], b: q })));
    for (const [i, s] of segs.entries()) for (const t of segs.slice(i + 1)) {
      if (s.id === t.id || (s.a.x === s.b.x) !== (t.a.x === t.b.x)) continue;
      const [c, m] = s.a.x === s.b.x ? ["x", "y"] : ["y", "x"];
      const lap = Math.min(Math.max(s.a[m], s.b[m]), Math.max(t.a[m], t.b[m])) - Math.max(Math.min(s.a[m], s.b[m]), Math.min(t.a[m], t.b[m]));
      expect(lap > 12 && Math.abs(s.a[c] - t.a[c]) < 6, `${s.id} + ${t.id}`).toBe(false);
    }
  });
});

describe("label placement", () => {
  it("strips the step circle and sizes a long label as a taller, narrower pill", () => {
    expect(stripLabel("③ RFC 7523 jwt-bearer")).toBe("RFC 7523 jwt-bearer");
    expect(stripLabel("①–⑤ POST /x")).toBe("POST /x");
    const sizes = pillSizes("x".repeat(120));
    expect(sizes[0].w).toBe(420);
    expect(sizes.at(-1).w).toBeLessThan(sizes[0].w);
    expect(sizes.at(-1).h).toBeGreaterThan(sizes[0].h);
    expect(pillSizes("ok")).toHaveLength(1);
  });
  it("offers badge spots only well away from both boxes and from bends", () => {
    const pts = [P(0, 0), P(14, 0), P(14, 200), P(300, 200)];
    const spots = badgeSpots(pts);
    expect(spots.length).toBeGreaterThan(5);
    for (const s of spots) {
      expect(Math.abs(s.x) + Math.abs(s.y)).toBeGreaterThanOrEqual(26);
      expect(Math.abs(s.x - 300) + Math.abs(s.y - 200)).toBeGreaterThanOrEqual(26);
      expect(s.x === 14 || s.y === 200).toBe(true);
    }
  });
  it.each(["mock", "pf-as", "pf-pf", "byo"])("%s: every pill clears every box and every badge, and sits on its arrow", (mode) => {
    const d = PLAYGROUND_DIAGRAMS[mode];
    const rects = rectsOf(d);
    const { routes, places } = routeEdges(rects, d.edges);
    const pill = (p) => ({ x: p.side === "r" ? p.x - 14 : p.x + 14 - p.w, y: p.y - p.h / 2, w: p.w, h: p.h });
    const hit = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    for (const e of d.edges) {
      const p = places[e.id];
      expect(p, e.id).toBeDefined();
      const onLine = routes[e.id].pts.slice(1).some((q, i) => {
        const a = routes[e.id].pts[i];
        return Math.min(a.x, q.x) - 0.5 <= p.x && p.x <= Math.max(a.x, q.x) + 0.5 && Math.min(a.y, q.y) - 0.5 <= p.y && p.y <= Math.max(a.y, q.y) + 0.5;
      });
      expect(onLine, `${e.id} badge on its arrow`).toBe(true);
      for (const [id, r] of Object.entries(rects)) expect(hit(pill(p), r), `${e.id} pill covers ${id}`).toBe(false);
      for (const o of d.edges) if (o.id !== e.id) expect(hit(pill(p), { x: places[o.id].x - 12, y: places[o.id].y - 12, w: 24, h: 24 }), `${e.id} pill covers badge ${o.id}`).toBe(false);
    }
  });
  it("places nothing for a fallback (straight line) route", () => {
    const rects = { a: { x: 0, y: 0, w: 100, h: 100 }, b: { x: 500, y: 0, w: 100, h: 100 } };
    expect(placeLabels({ e: { ok: false, pts: [P(0, 0), P(5, 5)] } }, rects, [{ id: "e", label: "x", steps: [1] }])).toEqual({});
  });
});

describe("handles", () => {
  it.each(["mock", "pf-as", "pf-pf", "byo"])("%s: no card slot is used by two arrows (they would share a lead and read as one line)", (mode) => {
    const used = PLAYGROUND_DIAGRAMS[mode].edges.flatMap((e) => [`${e.from}.${e.fh}`, `${e.to}.${e.th}`]);
    expect(used.filter((h, i) => used.indexOf(h) !== i)).toEqual([]);
  });
});

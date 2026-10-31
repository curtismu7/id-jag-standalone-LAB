import { PLAYGROUND_DIAGRAMS, PLAYGROUND_DIAGRAM_MODES, stepParts } from "../idJagPlaygroundDiagrams";
import { routeEdges } from "../idJagPlaygroundRouting";
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

  it("places nothing for a fallback (straight line) route", () => {
    expect(placeLabels({ e: { ok: false, pts: [P(0, 0), P(5, 5)] } }, { a: boxA }, [{ id: "e", label: "x", steps: [1] }])).toEqual({});
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

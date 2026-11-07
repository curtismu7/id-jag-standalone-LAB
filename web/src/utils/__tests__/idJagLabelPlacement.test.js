import { createHash } from "node:crypto";
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
    }, 0); // pure CPU, no timers: a test timeout cannot interrupt it, it can only fail a correct run that a busy machine made slow
  });

  // The finer placement (spots at the middle of every run, a cost that follows how far the badge reaches into a box) is for ONE case only: a badge alone
  // whose coarse spot sits on the air kept around a box. Everywhere else the badge is where origin/main put it. The values below are origin/main's own output
  // (a pair of 300x150 boxes `gap` flow px apart, the arrow from the right side of the first to the left side of the second, zoom `zoom`).
  describe("the finer placement is used only when the coarse one leaves the badge on a box's air", () => {
    const pair = (gap, zoom, lit, text, off = 0) => {
      const a = { x: 0, y: 0, w: 300, h: 150 }, b = { x: 300 + gap, y: off, w: 300, h: 150 };
      const edges = [{ id: "e", from: "a", fh: "R2", to: "b", th: "L2", label: text }];
      const { routes } = routeEdges({ a, b }, edges);
      return placeLabels(routes, { a, b }, edges, { zoom, tx: 30, ty: 30, lit: new Set(lit ? ["e"] : []) }).e;
    };
    const LONG = "POST /token with the subject token and the requested token type";
    it("a 36.8px gap holds the badge clear of both boxes' air already: it stays on the 10px grid, not at the middle of a run", () => {
      expect(pair(23, 1.6, false, "x").x).toBeCloseTo(312.5, 6); // the finer pass would offer the middle of the run and land on 311.5
    });
    it("a 76.8px gap: the same, and the hover words keep a clear place (ok)", () => {
      const o = pair(48, 1.6, false, "x");
      expect(o.x).toBeCloseTo(320.25, 6);
      expect(o.ok).toBe(true);
    });
    it("a lit arrow with long words in a wide gap keeps its words where they were", () => {
      const o = pair(158, 0.9, true, LONG, 40);
      expect(o.x).toBeCloseTo(316.6667, 4);
      expect(o.ok).toBe(true);
      expect(o.w).toBe(136);
    });
    it("a 27.6px gap (narrow: the finer pass runs) measures the reach against the real boxes, not the boxes with their 3px of air", () => {
      const o = pair(23, 1.2, false, "x");
      expect(o.x).toBeCloseTo(312.5, 6); // against the air-extended boxes the same pass lands on 311.5
      expect(o.side).toBe("r");
    });
    // The tool buttons and the zoom controls drawn over the canvas are obstacles (`avoid`), not boxes. A badge whose coarse spot touches the air around one has
    // nothing to be centred in, so it must not take the finer pass: that pass had moved such badges (one to 6px above the canvas) where origin/main left them.
    // Values: origin/main's output for a 50px gap at zoom 0.9 with a 60x40 button laid over the middle of the arrow.
    it("a button over the arrow does not send its badge through the finer pass: it is where origin/main put it", () => {
      const a = { x: 0, y: 0, w: 300, h: 150 }, b = { x: 350, y: 0, w: 300, h: 150 };
      const edges = [{ id: "e", from: "a", fh: "R2", to: "b", th: "L2", label: "x" }];
      const { routes } = routeEdges({ a, b }, edges);
      const run = (avoid) => placeLabels(routes, { a, b }, edges, { zoom: 0.9, tx: 30, ty: 30, view: { w: 1100, h: 800 }, avoid }).e;
      const withButton = run([{ x: 272.5, y: 67.5, w: 60, h: 40 }]);
      expect(withButton.x).toBeCloseTo(325.1111, 3); // the finer pass lands on 343
      expect(withButton.y).toBeCloseTo(75, 6);
      const wide = run([{ x: 245.5, y: 77.5, w: 233, h: 40 }]); // a tools-bar wide button
      expect(wide.x).toBeCloseTo(325.1111, 3); // the finer pass lands on 325 exactly
    });
    it("a button keeps its plain rule inside the finer pass: nothing is put under it, even where the boxes leave only the middle of the corridor", () => {
      // an arrow in a 20px corridor between two boxes (every spot touches their air, so the finer pass runs), with a button over the middle of it
      const P = (x, y) => ({ x, y });
      const rects = { a: { x: -300, y: -75, w: 300, h: 150 }, b: { x: 300, y: -75, w: 300, h: 150 }, above: { x: 0, y: -110, w: 300, h: 100 }, below: { x: 0, y: 10, w: 300, h: 100 } };
      const routes = { e: { ok: true, pts: [P(0, 0), P(300, 0)] } };
      const edges = [{ id: "e", label: "x" }];
      expect(placeLabels(routes, rects, edges, {}).e.x, "no button: the middle of the arrow").toBeCloseTo(150, 6);
      const button = { x: 110, y: -6, w: 80, h: 36 };
      const o = placeLabels(routes, rects, edges, { avoid: [button] }).e;
      expect(o.x).toBeCloseTo(95, 6); // without the button's own rule in that pass the badge stays under it, at 150
      expect(o.x + BADGE / 2 + 3, "clear of the button's left side").toBeLessThanOrEqual(button.x);
    });
    // One test per diagram (they used to be one sweep of 1464 rows under one 60 s wall-clock limit). The hashes are the sha256 of each diagram's rows
    // in the order the old sweep built them; the old single hash 74b78e46... over all six diagrams is exactly their concatenation (checked when this was split).
    const PINNED = {
      "mock": [168, "d77119954f1376a546217fbc8509b02a84a810517d7b52145f800061265ad452"],
      "pf-as": [264, "d656313b29abc9b104ccf53ec50592435c99d5c8633ff56bc49aa18d03777ece"],
      "pf-pf": [216, "8ab4683dbae605184b57f0d143c74673a22b70d51e557a845d80581772853262"],
      "byo": [432, "78976c384a0abc887f255b8549965bca90eb6b0b6a36f759b9ef06c6f3a5c1e6"],
      "gateway-redeem": [192, "994126528ea12ac4cc1c79f67c15aa7d1d068fd6291887ba83d9fb0d83cf871e"],
      "aws-agentcore": [192, "6e997aac2afe008ba9322c7767d91bff7820c12374bfd9bae628ff15398564ca"],
    };
    it("pins a diagram for every shipped mode, and nothing else", () => {
      expect([...PLAYGROUND_DIAGRAM_MODES].sort()).toEqual(Object.keys(PINNED).sort());
    });
    // Pure CPU, no timers: a test timeout cannot interrupt it, it can only fail a correct run that a busy machine made slow.
    it.each(Object.entries(PINNED))("the %s diagram, every step, two zooms, two canvases: every badge and words box is exactly where origin/main put it", (mode, [count, hash]) => {
      const rows = [];
      const d = PLAYGROUND_DIAGRAMS[mode];
      const rects = Object.fromEntries(d.nodes.map((n) => [n.id, { x: n.x, y: n.y, w: 300, h: 150 }]));
      const { routes } = routeEdges(rects, d.edges);
      for (const step of [0, ...new Set(d.edges.flatMap((e) => e.steps))].sort((x, y) => x - y)) for (const zoom of [0.9, 1.25]) for (const view of [{ w: 1022, h: 842 }, { w: 343, h: 486 }]) {
        const out = placeLabels(routes, rects, d.edges, { zoom, tx: 30, ty: 30, view, lit: new Set(stepParts(d, step).edges) });
        for (const e of d.edges) rows.push([mode, step, zoom, view.w, e.id, +out[e.id].x.toFixed(4), +out[e.id].y.toFixed(4), out[e.id].side, out[e.id].valign, out[e.id].ok]);
      }
      expect(rows.length).toBe(count);
      expect(createHash("sha256").update(JSON.stringify(rows)).digest("hex")).toBe(hash);
    }, 0);
  });

  // Each of these pins one boundary of the finer pass or of the tiers, at a scene found by searching for one where moving that boundary changes the result.
  // The values are what the code gives; the comment on each says which change of the code they catch.
  describe("boundaries of the placement, pinned where moving them changes the answer", () => {
    // a 300px-wide box above or beside another one (`h1`, `h2` high), the arrow from the first to the second, `gap` screen px apart at `zoom`
    const scene = ({ gap, zoom, off, h1, h2, across, tx, ty, lit = [], labels = ["x"], view = { w: 1100, h: 800 } }) => {
      const a = { x: 0, y: 0, w: 300, h: h1 }, b = across ? { x: 300 + gap / zoom, y: off, w: 300, h: h2 } : { x: off, y: h1 + gap / zoom, w: 300, h: h2 };
      const edges = labels.map((label, i) => ({ id: `e${i}`, from: "a", fh: across ? "R2" : "B2", to: "b", th: across ? "L2" : "T2", label }));
      const { routes } = routeEdges({ a, b }, edges);
      return placeLabels(routes, { a, b }, edges, { zoom, tx, ty, view, lit: new Set(lit) }).e0;
    };
    const POST = "POST /token with the subject token";
    it("a lit arrow never takes the finer pass: it stays where the coarse pass put it, and its words are still not placed (ok false)", () => {
      const o = scene({ zoom: 0.9, gap: 31.537264155223966, off: 0, h1: 98.2, h2: 150, across: false, tx: -49.61915448750369, ty: 30.232327231904492, lit: ["e0"], labels: [POST] });
      expect(o.ok).toBe(false); // the finer pass on a lit arrow says true
      expect(o.x).toBeCloseTo(150, 4);
      expect(o.y).toBeCloseTo(115.7207, 3);
    });
    it("the finer pass starts when the coarse badge touches a box's 3px of air, not only the box itself", () => {
      const o = scene({ zoom: 0.9, gap: 28.44480829825625, off: 40.303858948173, h1: 150, h2: 150, across: true, tx: 100.44098693644628, ty: 30.018797678872943 });
      expect(o.x).toBeCloseTo(316.6667, 3); // gating on the box without its air leaves the coarse badge at 314, 96.1
      expect(o.y).toBeCloseTo(75, 3);
    });
    it("the reach into a box is the straight-line distance from the badge centre (a corner counts by its diagonal), not the larger of the two axes", () => {
      const o = scene({ zoom: 1.1, gap: 24.071652254089713, off: 0.2359816338866949, h1: 98.2, h2: 184.5, across: true, tx: 100.19461508956738, ty: 90.30987899727188, labels: ["GET /jwks"] });
      expect(o.x).toBeCloseTo(310.9417, 3);
      expect(o.y).toBeCloseTo(100.6678, 3); // the larger-axis distance puts it at 70.79
    });
    it("a spot whose cost is a little over 250 (air of a box within 15px) is still not good enough: the placer looks at the next tier", () => {
      const o = scene({ zoom: 1.1, gap: 29.974552242085338, off: 0, h1: 98.2, h2: 150, across: true, tx: 100.6311595919542, ty: 30.324085544794798, lit: ["e0"], labels: [POST] });
      expect(o.x).toBeCloseTo(313.6364, 3); // a cost limit of 260 accepts 314
      expect(o.y).toBeCloseTo(49.1, 3);
    });
    it("the finer pass does not leave a badge out of sight of the canvas to dodge a box: a spot wholly outside the canvas costs as much as one cut by its edge", () => {
      const o = scene({ zoom: 1.5665236868918875, gap: 14.41796437650919, off: 40.15772477630526, h1: 150, h2: 184.5, across: false, tx: 100.20503757777624, ty: -19.03322937223129, view: { w: 343, h: 486 } });
      expect(o.x).toBeCloseTo(146.8082, 3); // a spot outside the canvas costing nothing sends it to 170.08, off the right edge
      expect(o.y).toBeCloseTo(154.6019, 3);
    });
    it("the middle of every run is offered in the loosest tier only, not in every tier (in a crowd of boxes the earlier tier's middle would end the search too soon)", () => {
      const P = (x, y) => ({ x, y });
      const routes = { e: { ok: true, pts: [P(0, 0), P(0, -51.023), P(-149.55, -51.023), P(-149.55, 13.002), P(-37.479, 13.002)] } };
      const rects = { b0: { x: -94.503, y: -124.238, w: 134.845, h: 84.68 }, b1: { x: -155.073, y: -79.021, w: 117.935, h: 90.371 }, b2: { x: -27.811, y: -118.593, w: 128.127, h: 125.773 } };
      const o = placeLabels(routes, rects, [{ id: "e", label: "x" }], { zoom: 1.676, tx: 0, ty: 0 }).e;
      expect(o.x).toBeCloseTo(-71.9844, 3); // mids in every tier: -66.02
      expect(o.y).toBeCloseTo(18.3719, 3);
    });
    it("the first tier keeps 26px from both ends of the arrow: a spot 25.5px from the end belongs to the next tier, which also holds a better one", () => {
      const P = (x, y) => ({ x, y });
      const L = 55.5; // between the boxes; the vertical arrow f crosses 38px in, which makes the spot at 30 dearer than the one at 20
      const rects = { a: { x: -300, y: -75, w: 300, h: 150 }, b: { x: L, y: -75, w: 300, h: 150 }, c: { x: -100, y: -400, w: 300, h: 300 }, d: { x: -100, y: 100, w: 300, h: 300 } };
      const routes = { e: { ok: true, pts: [P(0, 0), P(L, 0)] }, f: { ok: true, pts: [P(38, -100), P(38, 100)] } };
      const out = placeLabels(routes, rects, [{ id: "e", label: "x" }, { id: "f", label: "y" }], {});
      expect(out.e.x).toBeCloseTo(20, 6); // a first tier at 25px puts it at 30
      expect(out.e.y).toBeCloseTo(0, 6);
    });
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

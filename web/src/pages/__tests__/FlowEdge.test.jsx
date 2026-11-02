import { createPortal } from "react-dom";
import { render } from "@testing-library/react";
import { Position, ReactFlowProvider, getSmoothStepPath } from "@xyflow/react";
import { FlowEdge, labelTransform } from "../IdJagPlaygroundDiagramPage";
import { pathFromPoints, labelPoint } from "../../utils/orthoRoute";
import { plainRoute } from "../../utils/idJagPlaygroundRouting";

// The edge-label layer of a real ReactFlow is a node React Flow creates itself; here the label goes to <body> so a test can read it. Everything else is real.
vi.mock("@xyflow/react", async (orig) => {
  const m = await orig();
  return { ...m, EdgeLabelRenderer: ({ children }) => createPortal(children, document.body) };
});

// An edge from (100,100), leaving to the right, to (400,300), arriving from below. The smooth-step line React Flow would draw by itself and the plain
// right-angled line the page draws for an arrow with no route are different shapes, and so are the middles of the two.
const SRC = { x: 100, y: 100 }, TGT = { x: 400, y: 300 };
const smooth = getSmoothStepPath({ sourceX: SRC.x, sourceY: SRC.y, targetX: TGT.x, targetY: TGT.y, sourcePosition: Position.Right, targetPosition: Position.Bottom });
const PLAIN = plainRoute(SRC, TGT, "r", "b"); // [(100,100), (400,100), (400,300)]

function draw(data, { label = "RFC 8693 token exchange" } = {}) {
  const base = { on: false, listHover: false, dragging: false, num: "3", dashed: false, pulse: 0, dur: 2 };
  const view = render(
    <ReactFlowProvider>
      <svg>
        <FlowEdge id="e1" sourceX={SRC.x} sourceY={SRC.y} targetX={TGT.x} targetY={TGT.y} sourcePosition={Position.Right} targetPosition={Position.Bottom} label={label} style={{}} data={{ ...base, ...data }} />
      </svg>
    </ReactFlowProvider>,
  );
  const d = view.container.querySelector("path.react-flow__edge-path").getAttribute("d");
  const badge = document.querySelector('[data-edge="e1"]');
  const [, tx, ty] = /^translate\(([-\d.]+)px,([-\d.]+)px\)/.exec(badge.style.transform);
  return { d, badge, at: { x: Number(tx), y: Number(ty) }, words: badge.querySelector(".ewords"), unmount: view.unmount };
}
// is the point on one of the straight runs?
const onLine = (p, pts) => pts.slice(1).some((q, i) => { const a = pts[i]; return p.x >= Math.min(a.x, q.x) && p.x <= Math.max(a.x, q.x) && p.y >= Math.min(a.y, q.y) && p.y <= Math.max(a.y, q.y) && (a.x === q.x ? p.x === a.x : p.y === a.y); });

describe("FlowEdge draws an arrow the router found no way round for as its plain right-angled line", () => {
  const noRoute = { ok: false, pts: PLAIN };
  // chosen on the last run, not at the middle of the longest run (250,100) and not at the smooth-step middle
  const place = { x: 400, y: 180, side: "r", valign: "c", w: 150, h: 22, ok: true };

  it("sanity: the plain line, the smooth-step line and their middles all differ", () => {
    expect(pathFromPoints(PLAIN)).not.toBe(smooth[0]);
    expect(PLAIN).toEqual([SRC, { x: 400, y: 100 }, TGT]);
    expect(labelPoint(PLAIN)).toEqual({ x: 250, y: 100 });
    expect(Math.hypot(smooth[1] - 250, smooth[2] - 100), "the two middles are far apart").toBeGreaterThan(30);
    expect(onLine(place, PLAIN)).toBe(true);
  });

  it("the drawn line is the plain route, not the smooth-step path", () => {
    const { d } = draw({ route: noRoute, place });
    expect(d).toBe(pathFromPoints(PLAIN));
    expect(d).not.toBe(smooth[0]);
  });

  it("the badge sits where placeLabels put it (place), which is on that line", () => {
    const { at } = draw({ route: noRoute, place });
    expect(at).toEqual({ x: place.x, y: place.y });
    expect(onLine(at, PLAIN)).toBe(true);
  });

  it("without a place the badge sits on the plain line's own middle, not the smooth-step middle", () => {
    const { at } = draw({ route: noRoute, place: undefined });
    expect(at).toEqual(labelPoint(PLAIN));
    expect(onLine(at, PLAIN)).toBe(true);
    expect(at).not.toEqual({ x: smooth[1], y: smooth[2] });
  });

  it("a lit arrow with no route shows its badge only, never its words (they could cover a box); a routed one with the same place shows them", () => {
    const alone = draw({ route: noRoute, place, on: true });
    expect(alone.words).toBeNull();
    alone.unmount();
    const routed = draw({ route: { ok: true, pts: PLAIN }, place, on: true });
    expect(routed.words?.textContent).toBe("RFC 8693 token exchange");
  });

  it("not even on hover: the badge stays alone", () => {
    expect(draw({ route: noRoute, place, listHover: true }).words).toBeNull();
  });

  it("the badge keeps its number", () => {
    expect(draw({ route: noRoute, place }).badge.textContent).toBe("3");
  });

  it("while a box is dragged (no route given) the smooth-step path and its middle are drawn", () => {
    const { d, at } = draw({ route: undefined, place: undefined, dragging: true });
    expect(d).toBe(smooth[0]);
    expect(at).toEqual({ x: smooth[1], y: smooth[2] });
  });

  it("a route with fewer than two points cannot be drawn, so the smooth-step path is", () => {
    const { d } = draw({ route: { ok: false, pts: [SRC] }, place: undefined });
    expect(d).toBe(smooth[0]);
  });

  it("a straight plain route of exactly two points is drawn and labelled like any other", () => {
    const pts = [SRC, { x: 400, y: 100 }];
    const { d, at } = draw({ route: { ok: false, pts }, place: undefined });
    expect(d).toBe(pathFromPoints(pts));
    expect(d).not.toBe(smooth[0]);
    expect(at).toEqual(labelPoint(pts));
    expect(at).toEqual({ x: 250, y: 100 });
  });

  it("a routed arrow draws its route", () => {
    const pts = [SRC, { x: 100, y: 200 }, { x: 400, y: 200 }, TGT];
    const { d, at } = draw({ route: { ok: true, pts }, place: undefined });
    expect(d).toBe(pathFromPoints(pts));
    expect(at).toEqual(labelPoint(pts));
  });

  it("the label is counter-scaled by the zoom (1 here) and anchored by labelTransform", () => {
    const { badge } = draw({ route: noRoute, place });
    expect(badge.style.transform).toBe(labelTransform(place, place.x, place.y, 1));
  });
});

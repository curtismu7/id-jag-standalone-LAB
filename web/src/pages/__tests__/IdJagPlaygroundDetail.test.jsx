import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { PLAYGROUND_DIAGRAMS, edgeBadges, edgeStepNumber, firstStepLighting, focusNode } from "../../utils/idJagPlaygroundDiagrams";

// jsdom cannot measure nodes, so ReactFlow would draw no edges: stand in a minimal one that renders the
// page's own node and edge components, so badges, labels, selection and click handling are real.
const rf = vi.hoisted(() => ({ props: null, fitView: vi.fn(), lookup: new Map() }));
vi.mock("@xyflow/react", () => ({
  ReactFlow: (p) => {
    rf.props = p;
    return (
      <div data-testid="rf">
        {p.nodes.map((n) => {
          const C = p.nodeTypes[n.type];
          return (
            <div key={n.id} data-testid={`node-${n.id}`} onClick={(e) => p.onNodeClick(e, n)}>
              <C data={n.data} selected={false} />
              <button data-testid={`drag-${n.id}`} onClick={() => p.onNodeDragStop({}, n)} />
            </div>
          );
        })}
        <svg>
          {p.edges.map((e) => {
            const C = p.edgeTypes[e.type];
            return <C key={e.id} id={e.id} label={e.label} markerEnd={e.markerEnd} style={e.style} data={e.data} />;
          })}
        </svg>
        {p.children}
      </div>
    );
  },
  ReactFlowProvider: ({ children }) => children,
  useReactFlow: () => ({ fitView: rf.fitView }),
  useNodesInitialized: () => true,
  useStore: (sel) => sel({ nodeLookup: rf.lookup, transform: [0, 0, 1] }), // empty in most tests: no measured boxes, so no routes
  useStoreApi: () => ({ getState: () => ({ transform: [0, 0, 1], width: 1000, height: 700 }), subscribe: () => () => {} }),
  EdgeLabelRenderer: ({ children }) => <div>{children}</div>,
  BaseEdge: ({ className }) => <path className={className} />,
  getSmoothStepPath: () => ["M0,0", 0, 0],
  NodeResizer: () => null, Handle: () => null, Background: () => null, Controls: () => null,
  Position: { Top: "top", Bottom: "bottom", Left: "left", Right: "right" },
  ConnectionMode: { Loose: "loose" }, MarkerType: { ArrowClosed: "arrowclosed" },
}));
vi.mock("../../utils/idJagDetail/mock.js", () => ({
  default: {
    2: {
      forms: [{ title: "Token exchange", code: "POST /token\ngrant_type=token-exchange" }],
      tokens: [{ note: "The ID-JAG (mock)", header: { typ: "oauth-id-jag+jwt" }, claims: { iss: "https://idp.example", aud: "https://as.example" } }],
      refs: [
        { id: "RFC 8693", title: "OAuth 2.0 Token Exchange", kind: "rfc" },
        { id: "MCP authorization", title: "Model Context Protocol: Authorization", kind: "spec" },
        { id: "draft-ietf-oauth-identity-assertion-authz-grant", title: "Identity Assertion JWT Authorization Grant", kind: "emerging" },
      ],
    },
  },
}));

import IdJagPlaygroundDiagramPage from "../IdJagPlaygroundDiagramPage";

const d = PLAYGROUND_DIAGRAMS["pf-as"];
const open = (url) => { window.history.pushState({}, "", url); return render(<IdJagPlaygroundDiagramPage />); };
const badge = (id) => screen.getByTestId(`pgd-badge-${id}`);
const label = (id) => document.querySelector(`[data-edge="${id}"]`);
const pressed = () => screen.getAllByRole("button", { pressed: true }).map((b) => b.textContent);
afterEach(() => { window.history.pushState({}, "", "/"); vi.useRealTimers(); });

// pf-as edges by file order: e0 sign-in, e1 code, e2 button presses (steps 2-5), e3 exchange (2, 5), e4 redeem, e5 registry read,
// e6 JWKS fetch, e7 tools/list, e8 verify, e9 protected page, e10 negative tests.
describe("numbered arrows", () => {
  it("every edge badge starts with the first step it belongs to, with a letter when several calls start there", () => {
    open("/diagram/pf-as");
    const want = edgeBadges(d);
    for (const e of d.edges) expect(badge(e.id)).toHaveTextContent(want[e.id]);
    expect(Object.values(want)).toEqual(["1a", "1b", "2a", "2b", "3a", "3b", "3c", "4a", "4b", "4c", "5"]);
    expect(new Set(Object.values(want)).size).toBe(d.edges.length); // no two badges on a diagram read the same
    expect(edgeStepNumber(d.edges[3])).toBe(2); // shared by steps 2 and 5: the first
    expect(edgeStepNumber(d.edges[4])).toBe(3);
  });

  it("a step with several edges numbers them 3a, 3b, 3c", () => {
    open("/diagram/pf-as?step=3");
    expect(["e4", "e5", "e6"].map((id) => badge(id).textContent)).toEqual(["3a", "3b", "3c"]);
  });

  it("words show only on edges the step lights; the other badges stay numbers only", () => {
    open("/diagram/pf-as?step=3");
    expect(label("e4")).toHaveTextContent(/RFC 7523 jwt-bearer/);
    expect(label("e4").textContent.startsWith("3a")).toBe(true);
    expect(label("e4")).not.toHaveTextContent("\u2462"); // the circled digit is the badge now
    expect(label("e7")).toHaveTextContent(/^4a$/);
    expect(label("e0")).toHaveTextContent(/^1a$/);
  });

  it("the overview shows numbers only", () => {
    open("/diagram/pf-as");
    expect(document.querySelectorAll(".elabel.words")).toHaveLength(0);
  });

  it("hovering an unlit edge's badge shows its words, leaving hides them", () => {
    open("/diagram/pf-as?step=3");
    fireEvent.mouseEnter(label("e7"));
    expect(label("e7")).toHaveTextContent(/tools\/list/);
    fireEvent.mouseLeave(label("e7"));
    expect(label("e7")).toHaveTextContent(/^4a$/);
  });

  it("dashed edges carry the dashed class and the legend explains the notation", () => {
    open("/diagram/pf-as");
    expect(rf.props.edges.find((e) => e.id === "e6").data.dashed).toBe(true);
    expect(document.querySelector('[data-edge-head="e6"]')).toHaveClass("ijx-head--dashed");
    expect(document.querySelector('[data-edge-head="e7"]')).toBeNull();
    expect(screen.getByTestId("pgd-legend")).toHaveTextContent(/red number = step.*solid line = request\/response.*blue dashed = trust source \(JWKS or registry read\) or alternate path/);
  });
});

describe("step detail panel", () => {
  it("renders the wire form, MOCK tokens and standards for a step with data", () => {
    open("/diagram/mock?step=2");
    const det = screen.getByTestId("pgd-detail");
    expect(within(det).getByText("Request on the wire")).toBeInTheDocument();
    expect(det).toHaveTextContent("grant_type=token-exchange");
    expect(within(det).getByText(/Mock token\(s\) in play/)).toBeInTheDocument();
    expect(within(det).getByText("MOCK")).toBeInTheDocument();
    expect(det).toHaveTextContent('"typ": "oauth-id-jag+jwt"');
    expect(det).toHaveTextContent('"aud": "https://as.example"');
    expect(within(det).getByText("Standards behind this step")).toBeInTheDocument();
    expect(screen.getByTestId("pgd-refs").querySelectorAll("li")).toHaveLength(3);
    expect(det).toHaveTextContent("Emerging items are drafts or in-progress work; their status can change.");
  });

  it("marks emerging refs and labels RFC and spec kinds", () => {
    open("/diagram/mock?step=2");
    const items = [...screen.getByTestId("pgd-refs").querySelectorAll("li")];
    expect(items.map((li) => li.dataset.kind)).toEqual(["rfc", "spec", "emerging"]);
    expect(items.map((li) => li.querySelector(".chip").textContent)).toEqual(["RFC", "Spec", "Emerging"]);
    expect(items.map((li) => li.classList.contains("emerging"))).toEqual([false, false, true]);
  });

  it("shows no detail on the overview or a step without data", () => {
    open("/diagram/mock");
    expect(screen.queryByTestId("pgd-detail")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next ▶" }));
    expect(screen.queryByTestId("pgd-detail")).toBeNull(); // step 1 has no data
    fireEvent.click(screen.getByRole("button", { name: "Next ▶" }));
    expect(screen.getByTestId("pgd-detail")).toBeInTheDocument();
  });
});

describe("select and sync", () => {
  const ringed = () => [...document.querySelectorAll(".card.sel .ct")].map((el) => el.textContent);

  it("clicking a node selects it (ring) and jumps to the first step that lights it", () => {
    open("/diagram/pf-as");
    fireEvent.click(screen.getByTestId("node-ras"));
    expect(pressed()).toEqual(["3 · Redeem at resource-as"]);
    expect(ringed()).toEqual(["resource-as · resource AS"]);
    expect(window.location.search).toBe("?step=3");
    expect(firstStepLighting(d, "ras")).toBe(3);
  });

  it("shows the step's why (the diagram data's step.why) in the panel, on the steps that have one", () => {
    open("/diagram/pf-as?step=3");
    expect(screen.getByTestId("pgd-why")).toHaveTextContent(/resource-as trusts PingFederate because the server's registry read/);
    fireEvent.click(screen.getByRole("button", { name: "Next ▶" }));
    expect(screen.getByTestId("pgd-why")).toHaveTextContent(/The ID-JAG stops at resource-as/);
    cleanup();
    open("/diagram/mock?step=2");
    expect(screen.queryByTestId("pgd-why")).toBeNull();
  });

  it("scrolls the panel to the step detail, and shows a hidden panel", () => {
    open("/diagram/mock");
    fireEvent.click(screen.getByRole("button", { name: "◀ Hide panel" }));
    const aside = document.querySelector("aside");
    aside.scrollTo = vi.fn();
    expect(aside.style.visibility).toBe("hidden");
    fireEvent.click(screen.getByTestId("node-pf")); // first lit at step 2, which has detail
    expect(aside.style.visibility).not.toBe("hidden");
    expect(screen.getByTestId("pgd-detail")).toBeInTheDocument();
    expect(aside.scrollTo).toHaveBeenCalledTimes(1);
  });

  it("moving the step selects that step's focus node, keeps the selection when the step lights it", () => {
    const next = () => fireEvent.click(screen.getByRole("button", { name: "Next ▶" }));
    open("/diagram/pf-as?step=1");
    expect(ringed()).toEqual(["Browser"]); // first actor of the step's zoom set
    expect(focusNode(d, 1)).toBe("browser");
    next(); // step 2
    expect(ringed()).toEqual(["Browser"]); // the browser's button press is lit in step 2: kept
    fireEvent.click(screen.getByTestId("node-pf")); // first lit at step 1
    expect(pressed()).toEqual(["1 · Sign in at PingFederate"]);
    expect(ringed()).toEqual(["PingFederate · issues the ID-JAG"]);
    next(); next(); // steps 2, 3 both light pf: selection kept
    expect(pressed()).toEqual(["3 · Redeem at resource-as"]);
    expect(ringed()).toEqual(["PingFederate · issues the ID-JAG"]);
    next(); // step 4 does not light pf: its focus actor
    expect(ringed()).toEqual(["Browser"]); // the first actor step 4 lights
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(ringed()).toEqual([]);
  });

  it("a drag is not a click: the threshold is 5px and a click right after a drag stop is ignored", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    open("/diagram/pf-as");
    expect(rf.props.nodeDragThreshold).toBe(5);
    fireEvent.click(screen.getByTestId("drag-ras"));
    vi.setSystemTime(1_000_100);
    fireEvent.click(screen.getByTestId("node-ras"));
    expect(pressed()).toEqual(["Overview"]);
    act(() => vi.setSystemTime(1_000_400));
    fireEvent.click(screen.getByTestId("node-ras"));
    expect(pressed()).toEqual(["3 · Redeem at resource-as"]);
  });
});

describe("Reset, speed and simulate", () => {
  const dropAt = (id, position) => act(() => rf.props.onNodesChange([{ type: "position", id, position }]));
  const posOf = (id) => rf.props.nodes.find((n) => n.id === id).position;

  it("Reset puts every moved box back where the diagram data places it, shows the overview and fits the view", () => {
    open("/diagram/pf-as?step=3");
    const home = { ...posOf("ras") };
    dropAt("ras", { x: 9, y: 9 });
    expect(posOf("ras")).toEqual({ x: 9, y: 9 });
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(posOf("ras")).toEqual(home);
    expect(pressed()).toEqual(["Overview"]);
    expect(window.location.search).toBe("");
  });

  it("Reset also stops a running simulation", () => {
    vi.useFakeTimers();
    open("/diagram/pf-as");
    fireEvent.click(screen.getByRole("button", { name: "▶ Simulate" }));
    expect(pressed()).toEqual(["1 · Sign in at PingFederate"]);
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    act(() => vi.advanceTimersByTime(20000));
    expect(pressed()).toEqual(["Overview"]);
  });

  it("the speed control sets the pause between simulated steps: Fast 1.5 s, Normal 3.5 s, Slow 6 s", () => {
    vi.useFakeTimers();
    open("/diagram/pf-as");
    const speed = screen.getByLabelText("Speed");
    expect([...speed.options].map((o) => o.textContent)).toEqual(["Slow", "Normal", "Fast"]);
    expect(speed.value).toBe("normal");
    fireEvent.change(speed, { target: { value: "fast" } });
    fireEvent.click(screen.getByRole("button", { name: "▶ Simulate" }));
    expect(pressed()).toEqual(["1 · Sign in at PingFederate"]);
    act(() => vi.advanceTimersByTime(1400));
    expect(pressed()).toEqual(["1 · Sign in at PingFederate"]);
    act(() => vi.advanceTimersByTime(200));
    expect(pressed()).toEqual(["2 · Get an ID-JAG from PingFederate"]);
    fireEvent.change(speed, { target: { value: "slow" } });
    act(() => vi.advanceTimersByTime(5900));
    expect(pressed()).toEqual(["2 · Get an ID-JAG from PingFederate"]);
    act(() => vi.advanceTimersByTime(200));
    expect(pressed()).toEqual(["3 · Redeem at resource-as"]);
  });
});

describe("routed arrows", () => {
  const withBoxes = () => {
    const d = PLAYGROUND_DIAGRAMS["pf-as"];
    rf.lookup = new Map(d.nodes.map((n) => [n.id, { id: n.id, internals: { positionAbsolute: { x: n.x, y: n.y } }, measured: { width: 300, height: 120 } }]));
    return d;
  };
  afterEach(() => { rf.lookup = new Map(); });

  it("hands every edge a route from its real box positions, with no fallback", () => {
    const d = withBoxes();
    const { container } = render(<IdJagPlaygroundDiagramPage />);
    for (const e of rf.props.edges) { expect(e.data.route?.ok, e.id).toBe(true); expect(e.data.place?.side, e.id).toMatch(/^[rl]$/); }
    expect(rf.props.edges).toHaveLength(d.edges.length);
    expect(container.querySelector("main").getAttribute("data-route-fallbacks")).toBe("0");
  });

  it("draws the plain path with no routes until the boxes are measured", () => {
    render(<IdJagPlaygroundDiagramPage />);
    expect(rf.props.edges.every((e) => e.data.route === undefined)).toBe(true);
  });

  it("drops the routes while a box is dragged and re-routes on drop", () => {
    withBoxes();
    const { container } = render(<IdJagPlaygroundDiagramPage />);
    act(() => rf.props.onNodeDragStart({}, {}));
    expect(rf.props.edges.every((e) => e.data.route === undefined && e.data.place === undefined)).toBe(true);
    expect(container.querySelector("main").hasAttribute("data-route-fallbacks")).toBe(false);
    act(() => rf.props.onNodeDragStop({}, {}));
    expect(rf.props.edges.every((e) => e.data.route?.ok)).toBe(true);
  });
});

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { PLAYGROUND_DIAGRAMS, edgeStepNumber, firstStepLighting, focusNode } from "../../utils/idJagPlaygroundDiagrams";

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
  useStore: (sel) => sel({ nodeLookup: rf.lookup }), // empty in most tests: no measured boxes, so no routes
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

describe("numbered arrows", () => {
  it("every edge badge shows the first step it belongs to, on the overview too", () => {
    open("/diagram/pf-as");
    for (const e of d.edges) expect(badge(e.id)).toHaveTextContent(String(Math.min(...e.steps)));
    expect(badge("a2")).toHaveTextContent("2"); // shared by steps 2 and 5: the first
    expect(badge("abtn")).toHaveTextContent("2"); // ambient button edge, steps 2-5
    expect(edgeStepNumber(d.edges.find((e) => e.id === "a3"))).toBe(3);
  });

  it("a step with several edges shows the same number on each", () => {
    open("/diagram/pf-as?step=3");
    for (const id of ["a3", "a3r", "a3k"]) expect(badge(id)).toHaveTextContent("3");
  });

  it("words show only on edges the step lights; the other badges stay numbers only", () => {
    open("/diagram/pf-as?step=3");
    expect(label("a3")).toHaveTextContent(/RFC 7523 jwt-bearer/);
    expect(label("a3").textContent.startsWith("3")).toBe(true);
    expect(label("a3")).not.toHaveTextContent("③"); // the circled digit is the badge now
    expect(label("a4")).toHaveTextContent(/^4$/);
    expect(label("a1a")).toHaveTextContent(/^1$/);
  });

  it("the overview shows numbers only", () => {
    open("/diagram/pf-as");
    expect(document.querySelectorAll(".elabel.words")).toHaveLength(0);
  });

  it("hovering an unlit edge's badge shows its words, leaving hides them", () => {
    open("/diagram/pf-as?step=3");
    fireEvent.mouseEnter(label("a4"));
    expect(label("a4")).toHaveTextContent(/tools\/list/);
    fireEvent.mouseLeave(label("a4"));
    expect(label("a4")).toHaveTextContent(/^4$/);
  });

  it("dashed edges carry the dashed class and the legend explains the notation", () => {
    open("/diagram/pf-as");
    expect(rf.props.edges.find((e) => e.id === "a3k").markerEnd.color).toBe("#1f5fbf");
    expect(screen.getByTestId("pgd-legend")).toHaveTextContent(/orange number = step.*solid line = request\/response.*blue dashed = trust source \(JWKS or registry read\) or alternate path/);
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

  it("clicking a callout jumps to the step it belongs to", () => {
    open("/diagram/pf-as");
    fireEvent.click(screen.getByTestId("node-n-jti"));
    expect(pressed()).toEqual(["5 · Negative tests"]);
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
    expect(ringed()).toEqual(["Playground server · the OAuth client"]);
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

describe("routed arrows", () => {
  const withBoxes = () => {
    const d = PLAYGROUND_DIAGRAMS["pf-as"];
    rf.lookup = new Map([...d.nodes, ...d.notes].map((n) => [n.id, { id: n.id, internals: { positionAbsolute: { x: n.x, y: n.y } }, measured: { width: 300, height: 120 } }]));
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

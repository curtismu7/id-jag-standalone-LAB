import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import IdJagPlaygroundDiagramPage, { labelTransform, useDraggableNodes, wordsShown } from "../IdJagPlaygroundDiagramPage";
import { PLAYGROUND_DIAGRAMS, PLAYGROUND_DIAGRAM_MODES, playgroundDiagramPath, stepParts } from "../../utils/idJagPlaygroundDiagrams";

const open = (url) => {
  window.history.pushState({}, "", url);
  return render(<IdJagPlaygroundDiagramPage />);
};
const pressed = () => screen.getAllByRole("button", { pressed: true }).map((b) => b.textContent);
afterEach(() => window.history.pushState({}, "", "/"));

describe("ID-JAG playground diagram data", () => {
  it("has one diagram per playground mode", () => {
    expect(PLAYGROUND_DIAGRAM_MODES).toEqual(["mock", "pf-as", "pf-pf", "byo"]);
  });

  it.each(PLAYGROUND_DIAGRAM_MODES)("%s: every edge joins two actors and every step 1-5 has a call", (mode) => {
    const d = PLAYGROUND_DIAGRAMS[mode];
    const ids = new Set(d.nodes.map((n) => n.id));
    for (const e of d.edges) {
      expect(ids.has(e.from) && ids.has(e.to), e.id).toBe(true);
      expect(e.fh).toMatch(/^[TBLR][123]$/);
      expect(e.th).toMatch(/^[TBLR][123]$/);
    }
    expect(d.steps.map((s) => s.n)).toEqual([1, 2, 3, 4, 5]);
    for (const n of [1, 2, 3, 4, 5]) expect(stepParts(d, n).edges.length, `step ${n}`).toBeGreaterThan(0);
  });

  it("uses this repo's actors: no MCP gateway, step 4 goes straight to mcp-sample", () => {
    for (const mode of PLAYGROUND_DIAGRAM_MODES) {
      const d = PLAYGROUND_DIAGRAMS[mode];
      expect(JSON.stringify(d)).not.toMatch(/[Gg]ateway|oauth-mcp|BFF/); // kind "bff" is only a colour
      expect(d.edges.filter((e) => e.steps.includes(4)).some((e) => e.to === "mcp")).toBe(true);
    }
    expect(PLAYGROUND_DIAGRAMS["pf-as"].nodes.map((n) => n.title)).toContain("resource-as · resource AS");
  });

  it("shows where trust comes from as dashed reads, and the mode gotchas", () => {
    const dashed = (mode) => PLAYGROUND_DIAGRAMS[mode].edges.filter((e) => e.dashed).map((e) => e.label).join(" | ");
    expect(dashed("pf-as")).toMatch(/trusted-idps\/registry.*PF_URL/);
    expect(dashed("pf-as")).toMatch(/resource-as \/jwks/);
    expect(dashed("pf-pf")).toMatch(/single key/);
    expect(dashed("byo")).toMatch(/trusted-idps\/registry/);
    const why = (mode) => PLAYGROUND_DIAGRAMS[mode].steps.map((s) => s.why).join(" ");
    expect(why("pf-pf")).toMatch(/single-key JWKS/);
    expect(why("pf-pf")).toMatch(/mcp-sample trusts resource-as only/);
    expect(why("byo")).toMatch(/Trusted IdPs registry/);
  });

  it("byo: step 1 shows the xaa.dev hop (IdenX sign-in, callback, exchange); step 3 names its JWKS", () => {
    const d = PLAYGROUND_DIAGRAMS.byo;
    expect(d.nodes.find((n) => n.id === "idenx").sub).toMatch(/idp\.xaa\.dev/);
    const lit = (n) => d.edges.filter((e) => e.steps.includes(n) && (e.from === "idenx" || e.to === "idenx")).map((e) => e.label).join(" | ");
    expect(lit(1)).toMatch(/\/xaa\/login.*\/xaa\/callback.*RFC 8693/);
    expect(d.steps[2].text).toMatch(/idp\.xaa\.dev\/jwks/);
  });

  it("lights the actors a step's calls touch, and zooms to them", () => {
    const parts = stepParts(PLAYGROUND_DIAGRAMS["pf-as"], 3);
    expect(parts.nodes).toEqual(["browser", "server", "ras", "registry", "pf"]);
    expect(parts.focus).toEqual(parts.nodes);
    expect(stepParts(PLAYGROUND_DIAGRAMS.mock, 1).focus).toEqual(["browser", "mockapi"]);
    expect(stepParts(PLAYGROUND_DIAGRAMS.mock, 0).nodes).toHaveLength(6);
  });

  it("builds /diagram/:mode paths with ?step=N", () => {
    expect(playgroundDiagramPath("pf-pf", 3)).toBe("/diagram/pf-pf?step=3");
    expect(playgroundDiagramPath("byo")).toBe("/diagram/byo");
  });
});

describe("ID-JAG playground diagram page", () => {
  it.each(PLAYGROUND_DIAGRAM_MODES)("%s renders its actors and every call on the overview", (mode) => {
    const d = PLAYGROUND_DIAGRAMS[mode];
    const { container } = open(playgroundDiagramPath(mode));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(d.label);
    const titles = [...container.querySelectorAll(".card .ct")].map((el) => el.textContent);
    expect(titles).toEqual(d.nodes.map((n) => n.title));
    expect(screen.getByTestId("pgd-calls").querySelectorAll("li")).toHaveLength(d.edges.length);
    expect(pressed()).toEqual(["Overview"]);
  });

  it("?step=N lights that step: its calls, its actors and nothing else", () => {
    const { container } = open(playgroundDiagramPath("pf-pf", 3));
    expect(pressed()).toEqual(["3 · Redeem at our PingFederate"]);
    const calls = screen.getByTestId("pgd-calls").textContent;
    expect(calls).toMatch(/RFC 7523 jwt-bearer · client_id PF_REDEEMER_CLIENT_ID/);
    expect(calls).not.toMatch(/tools\/list/);
    const lit = [...container.querySelectorAll(".card.on .ct")].map((el) => el.textContent).sort();
    expect(lit).toEqual(["Acme PingFederate · issuer", "Browser", "Our PingFederate · resource AS", "Playground server · the OAuth client"]);
  });

  it("Next and Back step through and keep the URL in step; the mode links keep the step", () => {
    open(playgroundDiagramPath("pf-as", 1));
    fireEvent.click(screen.getByRole("button", { name: "Next ▶" }));
    expect(pressed()).toEqual(["2 · Get an ID-JAG from PingFederate"]);
    expect(window.location.pathname + window.location.search).toBe("/diagram/pf-as?step=2");
    fireEvent.click(screen.getByRole("button", { name: "◀ Back" }));
    expect(pressed()).toEqual(["1 · Sign in at PingFederate"]);
    expect(screen.getByRole("link", { name: "Your IdP → our resource AS" })).toHaveAttribute("href", "/diagram/byo?step=1");
    expect(screen.getByRole("link", { name: "PingFederate → resource AS" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "▶ Simulate" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fullscreen" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fit" })).toBeInTheDocument();
  });

  it("falls back to the pf-as diagram for an unknown mode", () => {
    open("/diagram/nope");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("PingFederate → resource AS");
  });
});

describe("diagram labels and Reset", () => {
  it("Reset puts every box back where it started", () => {
    const computed = [{ id: "a", position: { x: 0, y: 0 } }, { id: "b", position: { x: 300, y: 40 } }];
    const { result } = renderHook(() => useDraggableNodes(computed));
    act(() => result.current.onNodesChange([{ type: "position", id: "a", position: { x: 55, y: 66 } }]));
    expect(result.current.nodes[0].position).toEqual({ x: 55, y: 66 });
    expect(result.current.nodes[1].position).toEqual({ x: 300, y: 40 });
    act(() => result.current.reset());
    expect(result.current.nodes.map((n) => n.position)).toEqual([{ x: 0, y: 0 }, { x: 300, y: 40 }]);
  });

  it("the Reset button clears the step and the moved boxes", () => {
    open(playgroundDiagramPath("pf-as", 3));
    expect(pressed()).toEqual(["3 · Redeem at resource-as"]);
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(pressed()).toEqual(["Overview"]);
  });

  it("the step list holds every call of the step, as focusable entries that mark the arrow", () => {
    open(playgroundDiagramPath("pf-as", 3));
    const items = [...screen.getByTestId("pgd-calls").querySelectorAll("li")];
    expect(items.map((li) => li.textContent)).toEqual(PLAYGROUND_DIAGRAMS["pf-as"].edges.filter((e) => e.steps.includes(3)).map((e) => e.label));
    for (const li of items) expect(li).toHaveAttribute("tabindex", "0");
  });
});

describe("label words and scale", () => {
  const place = { x: 10, y: 20, side: "r", valign: "c", w: 200, h: 30, ok: true };
  it("shows the words for a lit or hovered arrow that has a clear place, and never while a box is dragged", () => {
    expect(wordsShown({ place, on: true })).toBe(true);
    expect(wordsShown({ place, hover: true })).toBe(true);
    expect(wordsShown({ place })).toBe(false);
    expect(wordsShown({ place, on: true, dragging: true })).toBe(false);
    expect(wordsShown({ place: { ...place, ok: false }, on: true, hover: true })).toBe(false);
    expect(wordsShown({ on: true })).toBe(true); // no route, so no place to choose: the words sit on the plain path
    expect(wordsShown({ on: true, fallback: true })).toBe(false); // the router found no way round: drawn plain, not placed, so no words that could cover a box
  });
  it("counter-scales the label by 1 / zoom and anchors the badge centre on the arrow for every side and alignment", () => {
    expect(labelTransform(place, 100, 50, 0.5)).toBe("translate(100px,50px) scale(2) translate(-12px,-50%)");
    expect(labelTransform({ ...place, side: "l", valign: "u" }, 100, 50, 2)).toBe("translate(100px,50px) scale(0.5) translate(calc(-100% + 12px),calc(-100% + 12px))");
    expect(labelTransform({ ...place, valign: "d" }, 0, 0, 1)).toBe("translate(0px,0px) scale(1) translate(-12px,-12px)");
    expect(labelTransform(undefined, 7, 8, 1)).toBe("translate(7px,8px) scale(1) translate(-50%,-50%)");
  });
});

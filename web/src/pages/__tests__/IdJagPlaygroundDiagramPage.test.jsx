import { fireEvent, render, screen } from "@testing-library/react";
import IdJagPlaygroundDiagramPage from "../IdJagPlaygroundDiagramPage";
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
    const notes = (mode) => PLAYGROUND_DIAGRAMS[mode].notes.map((n) => n.text).join(" ");
    expect(notes("pf-pf")).toMatch(/single-key JWKS/);
    expect(notes("pf-pf")).toMatch(/mcp-sample trusts resource-as only/);
    expect(notes("byo")).toMatch(/Trusted IdPs registry/);
  });

  it("byo: step 1 shows the xaa.dev hop (IdenX sign-in, callback, exchange); step 3 names its JWKS", () => {
    const d = PLAYGROUND_DIAGRAMS.byo;
    expect(d.nodes.find((n) => n.id === "idenx").sub).toMatch(/idp\.xaa\.dev/);
    const lit = (n) => d.edges.filter((e) => e.steps.includes(n) && (e.from === "idenx" || e.to === "idenx")).map((e) => e.label).join(" | ");
    expect(lit(1)).toMatch(/\/xaa\/login.*\/xaa\/callback.*RFC 8693/);
    expect(d.steps[2].text).toMatch(/idp\.xaa\.dev\/jwks/);
  });

  it("lights the browser's button press but zooms to the real hop", () => {
    const parts = stepParts(PLAYGROUND_DIAGRAMS["pf-as"], 3);
    expect(parts.nodes).toContain("browser");
    expect(parts.focus).toEqual(["server", "ras", "registry", "pf", "n-trust"]);
    expect(stepParts(PLAYGROUND_DIAGRAMS.mock, 1).focus).toEqual(["browser", "mockapi", "n-mock"]);
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

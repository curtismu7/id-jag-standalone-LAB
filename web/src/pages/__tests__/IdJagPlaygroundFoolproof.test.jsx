// Phase 3A: preflight before every button, lifetime clocks, the step-3 scope list, the step-4 Results
// panel, diagram links, the protected resource and the run report.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("../../services/api", () => ({ default: { get, post, put: vi.fn(), delete: vi.fn() } }));

import IdJagPlaygroundPage from "../IdJagPlaygroundPage";
import { buildReport } from "../../utils/runReport";
import { pressWhenEnabled } from "./pressWhenEnabled";

const JWT_SHAPED = /eyJ[\w-]*\.[\w-]+\.[\w-]+/;
const now = () => Math.floor(Date.now() / 1000);
const CONFIG = {
  mode: "pf-as", signedIn: true, modes: [{ id: "pf-as", available: true }],
  idp: { name: "PingFederate (issuer)", issuer: "https://pf.test", tokenEndpoint: "https://pf.test/as/token.oauth2", jwksUrl: "https://pf.test/pf/JWKS", exchangeClientId: "pf-exchange" },
  resourceAs: { name: "Resource AS", issuer: "http://localhost:4721", tokenEndpoint: "http://resource-as:9080/token", clientId: "id-jag-playground" },
  request: { resource: "http://localhost:4722/mcp", scope: "" },
};
const issued = (scope) => ({ request: { endpoint: "POST https://pf.test/as/token.oauth2" }, response: { token_type: "N_A" },
  token: { header: { typ: "oauth-id-jag+jwt" }, claims: { iss: "https://pf.test", scope, iat: now(), exp: now() + 300 } } });
const redeemed = { request: { endpoint: "POST http://resource-as:9080/token" }, status: 200, response: { token_type: "Bearer", scope: "read" },
  token: { header: { typ: "at+jwt" }, claims: { scope: "read", exp: now() + 3600 } } };

let preflight;
function mount() {
  get.mockImplementation((url) => Promise.resolve({ data: url.endsWith("/config") ? CONFIG : url.includes("/preflight?") ? preflight : [] }));
  return render(<IdJagPlaygroundPage />);
}
const preflightCalls = () => get.mock.calls.map(([u]) => u).filter((u) => u.includes("/preflight?")).map((u) => new URLSearchParams(u.split("?")[1]));
const step = (n) => screen.getByRole("heading", { name: new RegExp(`^${n}$`) });

beforeEach(() => {
  get.mockReset(); post.mockReset(); localStorage.clear();
  localStorage.setItem("idjag.playground.mode", "pf-as");
  preflight = { ok: true, checks: [] };
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("no network in tests"))));
});
afterEach(() => vi.unstubAllGlobals());

describe("preflight before every button", () => {
  it("a failing check blocks the action, shows the fix, and Re-check asks again without the cache", async () => {
    preflight = { ok: false, checks: [
      { id: "origin", label: "This page is on APP_ORIGIN", status: "pass", detail: "ok" },
      { id: "signed-in", label: "Signed in at PingFederate (issuer)", status: "fail", detail: "No sign-in at this mode's issuer.", fix: "Click the sign-in button in step 1." },
    ] };
    mount();
    await pressWhenEnabled("Request ID-JAG");
    const panel = await screen.findByTestId("ijp-preflight");
    expect(panel).toHaveTextContent("Pre-flight: fix this first, nothing was sent");
    expect(panel).toHaveTextContent("Click the sign-in button in step 1.");
    expect(panel).not.toHaveTextContent("This page is on APP_ORIGIN"); // passes stay quiet
    expect(post).not.toHaveBeenCalledWith("/api/id-jag-playground/issue", expect.anything());
    const [q] = preflightCalls();
    expect(Object.fromEntries(q)).toEqual({ step: "issue", mode: "pf-as", origin: window.location.origin });

    preflight = { ok: true, checks: [] };
    await pressWhenEnabled("Re-check", within(panel));
    expect(await screen.findByText("Pre-flight: All checks pass. Run the step again.")).toBeInTheDocument();
    expect(preflightCalls().at(-1).get("fresh")).toBe("1");
  });

  it("a warning shows but lets the action through", async () => {
    preflight = { ok: true, checks: [{ id: "lifetime", label: "ID-JAG lifetime is 5 minutes or less", status: "warn", detail: "3600 s", fix: "Lower it." }] };
    post.mockImplementation((url) => Promise.resolve({ data: url.endsWith("/issue") ? issued("read") : { checks: [] } }));
    mount();
    await pressWhenEnabled("Request ID-JAG");
    expect(await screen.findByText("Pre-flight: warnings (sent anyway)")).toBeInTheDocument();
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/id-jag-playground/issue", {}));
  });
});

describe("step 3: scope list and lifetime clock", () => {
  it("lists the ID-JAG's MCP scopes, sends no scope by default, and resets a pick the next ID-JAG lacks", async () => {
    mount();
    post.mockImplementation((url) => Promise.resolve({ status: 200, data: url.endsWith("/issue") ? issued("openid read mcp:invoke")
      : url.endsWith("/inspect") ? { checks: [] } : redeemed }));
    await pressWhenEnabled("Request ID-JAG");
    const select = await screen.findByLabelText("Scope to request");
    await waitFor(() => expect(select).toBeEnabled());
    expect([...select.options].map((o) => o.textContent)).toEqual(["All scopes in this ID-JAG (recommended)", "read", "mcp:invoke"]);
    expect(screen.getByTestId("ijp-life-idjag")).toHaveTextContent(/ID-JAG: [45]:\d\d left/);

    await pressWhenEnabled("Redeem ID-JAG");
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/id-jag-playground/redeem", {}, expect.anything()));
    expect(preflightCalls().at(-1).has("scope")).toBe(false);
    const life = await screen.findByTestId("ijp-life-idjag");
    expect(life).toHaveTextContent("redeemed (single-use)");
    // Redeemed is the expected end of a single-use token: info (blue), not the red of an error.
    expect(life).toHaveClass("is-used");
    expect(life).not.toHaveClass("is-expired");

    fireEvent.change(select, { target: { value: "mcp:invoke" } });
    await pressWhenEnabled("Redeem ID-JAG");
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/id-jag-playground/redeem", { scope: "mcp:invoke" }, expect.anything()));
    expect(preflightCalls().at(-1).get("scope")).toBe("mcp:invoke");

    post.mockImplementation((url) => Promise.resolve({ data: url.endsWith("/issue") ? issued("read") : { checks: [] } }));
    await pressWhenEnabled("Request ID-JAG");
    await waitFor(() => expect([...screen.getByLabelText("Scope to request").options].map((o) => o.value)).toEqual(["", "read"]));
    expect(screen.getByLabelText("Scope to request")).toHaveValue("");
  });

  it("a refusal before the AS (scope guard) is an error with plain guidance, not an empty result", async () => {
    mount();
    post.mockImplementation((url) => Promise.resolve(url.endsWith("/redeem")
      ? { status: 400, data: { error: "scope_not_in_id_jag", message: "The ID-JAG does not grant admin." } }
      : { data: url.endsWith("/issue") ? issued("read") : { checks: [] } }));
    await pressWhenEnabled("Request ID-JAG");
    await waitFor(() => expect(screen.getByRole("button", { name: "Redeem ID-JAG" })).toBeEnabled());
    await pressWhenEnabled("Redeem ID-JAG");
    expect(await screen.findByText("scope_not_in_id_jag")).toBeInTheDocument();
    expect(screen.getByText(/Pick a scope the ID-JAG carries/)).toBeInTheDocument();
  });
});

describe("step 4: Results panel", () => {
  async function redeemFirst(callReply) {
    mount();
    post.mockImplementation((url, body) => {
      if (url.endsWith("/call")) return callReply(body);
      return Promise.resolve({ status: 200, data: url.endsWith("/issue") ? issued("read") : url.endsWith("/inspect") ? { checks: [] } : redeemed });
    });
    await pressWhenEnabled("Request ID-JAG");
    await waitFor(() => expect(screen.getByRole("button", { name: "Redeem ID-JAG" })).toBeEnabled());
    await pressWhenEnabled("Redeem ID-JAG");
    await screen.findByText("Response (HTTP 200)");
    await pressWhenEnabled("List tools this token can see");
    return screen.findByTestId("ijp-results");
  }

  it("says so explicitly when the token can see no tools, and names the hidden ones", async () => {
    const results = await redeemFirst(() => Promise.resolve({ data: { request: { endpoint: "POST http://mcp-sample:9090/mcp" }, tools: [], deniedTools: ["echo (needs mcp:invoke)"] } }));
    expect(results).toHaveTextContent("tools/list: 0 tools");
    expect(results).toHaveTextContent("0 tools: the token's scope allows none of this server's tools");
    expect(results).toHaveTextContent("Hidden from this token by scope: echo (needs mcp:invoke)");
    expect(screen.getByTestId("ijp-life-token")).toHaveTextContent(/Access token: \d+:\d\d left/);
  });

  it("shows the MCP server's refusal in the Results panel in plain words", async () => {
    const results = await redeemFirst(() => Promise.reject(Object.assign(new Error("HTTP 422"),
      { response: { status: 422, data: { error: "invalid_token", message: "iss is not trusted", mcpStatus: 401, wwwAuthenticate: 'Bearer error="invalid_token"' } } })));
    expect(results).toHaveTextContent("invalid_token");
    expect(results).toHaveTextContent("MCP server answered HTTP 401");
    expect(results).toHaveTextContent("The MCP server refused the token");
  });
});

describe("diagram links", () => {
  it("open the mode's diagram, and each step on it, in a new tab", async () => {
    localStorage.setItem("idjag.playground.mode", "mock");
    mount();
    const view = screen.getByRole("link", { name: "View Sample data (browser) diagram ↗" });
    expect(view).toHaveAttribute("href", "/diagram/mock");
    expect(view).toHaveAttribute("target", "_blank");
    expect(view.getAttribute("rel")).toContain("noopener");
    const s3 = within(step("Redeem it at the MCP authorization server").closest("section")).getByRole("link", { name: "see step 3 on the diagram ↗" });
    expect(s3).toHaveAttribute("href", "/diagram/mock?step=3");
    expect(s3).toHaveAttribute("target", "_blank");
  });
});

describe("run report", () => {
  const readBlob = (b) => new Promise((ok) => { const f = new FileReader(); f.onload = () => ok(f.result); f.readAsText(b); });

  it("mock: downloads Markdown and JSON built in the page, with decoded claims and no raw token, and sends nothing", async () => {
    localStorage.setItem("idjag.playground.mode", "mock");
    const blobs = [];
    const names = [];
    URL.createObjectURL = vi.fn((b) => { blobs.push(b); return "blob:report"; });
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function () { names.push(this.download); });
    try {
      mount();
      await pressWhenEnabled("Request ID-JAG");
      await screen.findByTestId("ijp-checks", {}, { timeout: 10000 });
      await pressWhenEnabled("Redeem ID-JAG");
      await screen.findByText("Response (HTTP 200)", {}, { timeout: 10000 });

      fireEvent.click(screen.getByRole("button", { name: "Download report" }));
      fireEvent.click(screen.getByRole("button", { name: "Download JSON" }));
      expect(names).toEqual([expect.stringMatching(/^id-jag-run-mock-.*\.md$/), expect.stringMatching(/^id-jag-run-mock-.*\.json$/)]);
      const [md, json] = await Promise.all(blobs.map(readBlob));
      expect(md).toContain("# ID-JAG playground run");
      expect(md).toContain("| sub | user.0042 |");
      expect(md).toMatch(/Step 3, redeem: HTTP 200/);
      expect(md).toContain("| Header typ | pass |");
      const data = JSON.parse(json);
      expect(data.idJag.claims.client_id).toBe("agent-mcp-client");
      expect(data.redeem.accessToken.claims.aud).toBe("https://mcp.example.com/mcp");
      for (const text of [md, json]) expect(text).not.toMatch(JWT_SHAPED);
      expect(get).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      click.mockRestore();
    }
  }, 30000);

  it("buildReport never lets a JWT-shaped string through, wherever it hides", () => {
    const raw = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl";
    const { json, markdown } = buildReport({ mode: "byo", config: CONFIG,
      inspection: { header: {}, claims: { sub: "x", note: `pasted ${raw}` }, checks: [{ label: "Sig", status: "fail", actual: raw }] },
      preflights: { redeem: { ok: false, checks: [{ label: "x", status: "fail", detail: raw }] } } });
    expect(JSON.stringify(json)).not.toMatch(JWT_SHAPED);
    expect(markdown).not.toMatch(JWT_SHAPED);
    expect(markdown).toContain("[redacted JWT]");
  });
});

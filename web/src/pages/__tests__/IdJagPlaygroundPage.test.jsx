import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const { get, post, put, del } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() }));
vi.mock("../../services/api", () => ({ default: { get, post, put, delete: del } }));

import IdJagPlaygroundPage, { STEP_TERMS } from "../IdJagPlaygroundPage";
import { pressWhenEnabled } from "./pressWhenEnabled";
import terms from "../../data/terms.json";

const config = (over = {}) => ({
  mode: "pf-as", signedIn: true,
  idp: { name: "PingFederate (issuer)", issuer: "https://pf.test", tokenEndpoint: "https://pf.test/as/token.oauth2", jwksUrl: "https://pf.test/pf/JWKS", exchangeClientId: "pf-exchange" },
  resourceAs: { name: "Resource AS", issuer: "https://as.test", tokenEndpoint: "https://as.test/token", clientId: "id-jag-playground" },
  request: { resource: "https://as.test/mcp", scope: "mcp:invoke" },
  ...over,
});

const PREFLIGHT_OK = { ok: true, checks: [] };
function mount(cfg) {
  get.mockImplementation((url) => Promise.resolve({ data: url.endsWith("/config") ? cfg : url.includes("/preflight?") ? PREFLIGHT_OK : [] }));
  return render(<IdJagPlaygroundPage />);
}

const slow = { timeout: 10000 }; // as testSetup.js asyncUtilTimeout; a wait only lasts this long when it is going to fail
let fetchSpy;

beforeEach(() => {
  get.mockReset(); post.mockReset(); put.mockReset(); del.mockReset(); localStorage.clear();
  localStorage.setItem("idjag.playground.mode", "pf-as"); // a real mode; mock tests pick "mock"
  fetchSpy = vi.fn(() => Promise.reject(new Error("no network in tests")));
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => vi.unstubAllGlobals());

describe("ID-JAG playground page", () => {
  it("step 1 says it is done when already signed in, names who, and offers only a quiet 'Sign in as someone else'", async () => {
    mount(config({ signedIn: true, signedInAs: "demo-user@example.invalid" }));
    const status = await screen.findByTestId("ijp-signin-status");
    expect(status).toHaveTextContent("Signed in at PingFederate (issuer) as demo-user@example.invalid. Nothing more to do in this step: continue to step 2.");
    expect(screen.queryByRole("button", { name: "Sign in again" })).toBeNull();
    const again = screen.getByRole("button", { name: "Sign in as someone else" });
    expect(again).not.toHaveClass("ijp-btn--primary");
    const step1 = screen.getByRole("heading", { name: "Sign in at the issuer PingFederate" }).closest("section");
    expect(step1.querySelector(".ijp-step__n")).toHaveClass("is-done");
    expect(within(step1).getByText("1 (done)")).toBeInTheDocument();
  });

  it("step 1 is the red sign-in call to action only while not signed in", async () => {
    mount(config({ signedIn: false }));
    const status = await screen.findByTestId("ijp-signin-status");
    expect(status).toHaveTextContent("Not signed in");
    expect(status).not.toHaveClass("ijp-status--ok");
    const btn = screen.getByRole("button", { name: "Sign in at the issuer PingFederate" });
    expect(btn).toHaveClass("ijp-btn--primary");
    const step1 = screen.getByRole("heading", { name: "Sign in at the issuer PingFederate" }).closest("section");
    expect(step1.querySelector(".ijp-step__n")).not.toHaveClass("is-done");
  });

  it("shows a backends strip and re-checks on demand", async () => {
    const backends = { backends: [
      { id: "idp", label: "PingFederate (issuer)", url: "https://pf.test/.well-known/openid-configuration", state: "up", ms: 40, detail: "40 ms" },
      { id: "resource-as", label: "Resource AS", url: "https://as.test/.well-known/oauth-authorization-server", state: "slow", ms: 1800, detail: "1800 ms" },
      { id: "mcp", label: "MCP server", url: "https://mcp.test/.well-known/oauth-protected-resource", state: "up", ms: 30, detail: "30 ms" },
    ] };
    get.mockImplementation((url) => Promise.resolve({ data: url.endsWith("/config") ? config() : url.endsWith("/backends") ? backends : url.includes("/preflight?") ? PREFLIGHT_OK : [] }));
    render(<IdJagPlaygroundPage />);
    const strip = await screen.findByTestId("ijp-backends");
    expect(await within(strip).findByText("Resource AS")).toBeInTheDocument();
    expect(within(strip).getByText("Resource AS").closest(".ijp-chip")).toHaveClass("is-slow");
    expect(within(strip).getByText("MCP server").closest(".ijp-chip")).toHaveClass("is-up");
    const calls = () => get.mock.calls.filter(([u]) => u.endsWith("/backends")).length;
    const before = calls();
    fireEvent.click(within(strip).getByRole("button", { name: "Re-check" }));
    await waitFor(() => expect(calls()).toBe(before + 1));
  });

  it("shows each step as Request, Response, Decoded and Code tabs", async () => {
    mount(config());
    post.mockImplementation((url) => Promise.resolve({ data: url.endsWith("/issue")
      ? { request: { endpoint: "POST https://pf.test/as/token.oauth2", body: { grant_type: "urn:ietf:params:oauth:grant-type:token-exchange", subject_token: "[your session token]", client_id: "id-jag-kit" } },
          response: { issued_token_type: "urn:ietf:params:oauth:token-type:id-jag" }, token: { header: { typ: "oauth-id-jag+jwt" }, claims: { client_id: "id-jag-kit" } } }
      : { checks: [] } }));
    await pressWhenEnabled("Request ID-JAG");
    const tabs = await screen.findByRole("tablist", { name: "Get an ID-JAG from PingFederate" });
    expect(within(tabs).getAllByRole("tab").map((t) => t.textContent)).toEqual(["Request", "Response", "Decoded", "Code"]);
    fireEvent.click(within(tabs).getByRole("tab", { name: "Code" }));
    expect(await screen.findByText(/fetch\("https:\/\/pf\.test\/as\/token\.oauth2"/)).toBeInTheDocument();
  });

  it("step 4 calls the REST page or the MCP server, and remembers the choice", async () => {
    const { unmount } = mount(config());
    expect(await screen.findByRole("button", { name: "List tools this token can see" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "REST API" }));
    expect(screen.getByRole("button", { name: "Open with the access token" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "List tools this token can see" })).not.toBeInTheDocument();
    unmount();
    mount(config());
    expect(await screen.findByRole("button", { name: "REST API" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Open with the access token" })).toBeInTheDocument();
  });

  it("revoke and prove shows both calls and the verdict", async () => {
    mount(config());
    post.mockImplementation((url) => Promise.resolve({ data: url.endsWith("/revoke") ? {
      revoke: { request: { endpoint: "POST https://pf.test/as/revoke_token.oauth2", body: { token: "[your session token]", token_type_hint: "refresh_token", client_id: "id-jag-kit" } }, status: 200 },
      retry: { request: { endpoint: "POST https://pf.test/as/token.oauth2", body: { grant_type: "urn:ietf:params:oauth:grant-type:token-exchange", client_id: "id-jag-kit" } }, status: 400, error: "invalid_grant" },
      proved: true,
    } : {} }));
    await pressWhenEnabled("Revoke and retry");
    expect(await screen.findByText("Proved: PingFederate refused a new ID-JAG (invalid_grant)")).toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "Revoke the refresh token" })).toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "Ask for a new ID-JAG with it" })).toBeInTheDocument();
  });

  it("revoke needs a sign-in and is absent in byo mode", async () => {
    const { unmount } = mount(config({ signedIn: false }));
    expect(await screen.findByRole("button", { name: "Revoke and retry" })).toBeDisabled();
    unmount();
    localStorage.setItem("idjag.playground.mode", "byo");
    mount(config({ mode: "byo" }));
    await screen.findByTestId("ijp-story");
    expect(screen.queryByRole("button", { name: "Revoke and retry" })).not.toBeInTheDocument();
  });

  it.each([
    ["pf-as", /Mark leaves the company in the middle of a task/],
    ["pf-pf", /Lena's company runs its own PingFederate/],
    ["mock", /Mary's agent calls the sample MCP server, rehearsed offline/],
    ["byo", /Lena reads shared data from Acme/],
  ])("shows the %s talk track, in the generic vertical by default", async (m, title) => {
    localStorage.setItem("idjag.playground.mode", m);
    mount(config({ mode: m }));
    const panel = await screen.findByTestId("story-panel");
    expect(within(panel).getByRole("heading", { name: title })).toBeInTheDocument();
  });

  it("offers the same flow from mcpc and VS Code", async () => {
    mount(config());
    const summary = await screen.findByText("Run this flow from a real client (mcpc, VS Code)");
    const panel = summary.closest("details");
    expect(panel.textContent).toContain("--idp https://pf.test");
    expect(panel.textContent).toContain("login https://as.test/mcp --grant id-jag");
    expect(panel.textContent).toContain('"url": "https://as.test/mcp"');
  });

  const samlConfig = (over = {}) => config({ saml: { available: true, reason: null, audience: "idJagKitSamlAud", issuer: "https://app.test/saml", supportedModes: ["pf-as"], appSignedIn: true, ...over } });
  const SAML_ISSUE = {
    assertion: { issuer: "https://app.test/saml", nameId: "jordan@example.com", nameIdFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress", audience: "idJagKitSamlAud",
      issueInstant: "2026-10-19T10:00:00Z", notBefore: "2026-10-19T09:59:00Z", notOnOrAfter: "2026-10-19T10:05:00Z",
      signature: { algorithm: "rsa-sha256", canonicalization: "exc-c14n", certSha1: "AB:CD" },
      xml: "<saml:Assertion>\n  <ds:SignatureValue>[…]</ds:SignatureValue>\n</saml:Assertion>" },
    request: { endpoint: "POST https://pf.test/as/token.oauth2", body: { grant_type: "urn:ietf:params:oauth:grant-type:token-exchange", subject_token: "[the signed SAML assertion, base64url, kept server-side]", subject_token_type: "urn:ietf:params:oauth:token-type:saml2", client_id: "id-jag-kit" } },
    response: { issued_token_type: "urn:ietf:params:oauth:token-type:id-jag" },
    token: { header: { typ: "oauth-id-jag+jwt" }, claims: { sub: "jordan@example.com", client_id: "id-jag-kit", scope: "mcp:invoke" } },
  };
  const mountSaml = (cfg = samlConfig()) => {
    localStorage.setItem("idjag.playground.protocol", "saml");
    mount(cfg);
    post.mockImplementation((url) => Promise.resolve({ data: url.endsWith("/issue") ? SAML_ISSUE : { checks: [] } }));
  };

  it("mock SAML is one exchange: the assertion, then the ID-JAG PingFederate returns for it", async () => {
    localStorage.setItem("idjag.playground.mode", "mock");
    mount(config());
    fireEvent.click(screen.getByRole("button", { name: "SAML" }));
    expect(screen.getByRole("heading", { name: "Sign in with SAML at PingFederate" })).toBeInTheDocument();
    expect(screen.getByText(/PingFederate takes the assertion directly/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Request ID-JAG" }));
    expect(await screen.findByRole("tablist", { name: "The SAML assertion" }, slow)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Trade the SAML assertion for an ID-JAG" })).toBeInTheDocument();
    expect(screen.queryByRole("tablist", { name: "Assertion → refresh token" })).not.toBeInTheDocument();
    const jag = screen.getByRole("tablist", { name: "SAML assertion → ID-JAG" });
    fireEvent.click(within(jag).getByRole("tab", { name: "Request" }));
    const body = screen.getByRole("tabpanel", { name: "SAML assertion → ID-JAG: Request" }).textContent;
    expect(body).toContain("urn:ietf:params:oauth:token-type:saml2");
    expect(body).toContain("urn:ietf:params:oauth:token-type:id-jag");
    expect(body).not.toContain("refresh_token");
  });

  it("SAML is disabled in real modes", async () => {
    mount(config());
    const saml = await screen.findByRole("button", { name: "SAML" });
    expect(saml).toBeDisabled();
    expect(saml).toHaveAttribute("title", "PingFederate SAML subject not verified yet (F2 spike)");
  });

  it("SAML is enabled in PingFederate → resource AS when the server can sign assertions", async () => {
    mount(samlConfig());
    await screen.findByRole("button", { name: "Request ID-JAG" });
    expect(screen.getByRole("button", { name: "SAML" })).toBeEnabled();
  });

  it("SAML is disabled with the server's reason when it cannot sign assertions", async () => {
    mount(samlConfig({ available: false, reason: "SAML_SIGNING_KEY_FILE is not set" }));
    const saml = await screen.findByRole("button", { name: "SAML" });
    expect(saml).toBeDisabled();
    expect(saml).toHaveAttribute("title", "SAML_SIGNING_KEY_FILE is not set");
  });

  it("SAML is disabled outside PingFederate → resource AS even when the server can sign", async () => {
    localStorage.setItem("idjag.playground.mode", "pf-pf");
    mount(samlConfig({ mode: "pf-pf" }));
    const saml = await screen.findByRole("button", { name: "SAML" });
    expect(saml).toBeDisabled();
    expect(saml).toHaveAttribute("title", expect.stringContaining("PingFederate → resource AS"));
  });

  it("a real SAML run explains the idea, asks for the pre-flight with protocol=saml and sends {protocol:saml}", async () => {
    mountSaml();
    expect(await screen.findByRole("heading", { name: "Sign in to this app (it signs the SAML assertion)" })).toBeInTheDocument();
    expect(screen.getByText(/this app plays a small SAML identity provider/)).toBeInTheDocument();
    expect(screen.getByText(/no second sign-in/i)).toBeInTheDocument();
    expect(screen.getByTestId("ijp-signin-status")).toHaveTextContent("Signed in");
    expect(screen.getByRole("button", { name: "Sign in as someone else" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Request ID-JAG" }));
    await screen.findByRole("tablist", { name: "The SAML assertion" });
    expect(post).toHaveBeenCalledWith("/api/id-jag-playground/issue", { protocol: "saml" });
    expect(get.mock.calls.some(([u]) => u.includes("/preflight?") && u.includes("step=issue") && u.includes("protocol=saml"))).toBe(true);
  });

  it("a real SAML run shows step 2 as the assertion (decoded and redacted XML) then the exchange", async () => {
    mountSaml();
    await pressWhenEnabled("Request ID-JAG");
    expect(await screen.findByRole("heading", { name: "Trade the SAML assertion for an ID-JAG" })).toBeInTheDocument();
    const assertion = await screen.findByRole("tablist", { name: "The SAML assertion" });
    expect(within(assertion).getAllByRole("tab").map((t) => t.textContent)).toEqual(["Decoded", "XML (redacted)"]);
    const decoded = screen.getByRole("tabpanel", { name: "The SAML assertion: Decoded" }).textContent;
    expect(decoded).toContain("jordan@example.com");
    expect(decoded).toContain("idJagKitSamlAud");
    expect(decoded).not.toContain("<saml:Assertion>");
    fireEvent.click(within(assertion).getByRole("tab", { name: "XML (redacted)" }));
    const xml = screen.getByRole("tabpanel", { name: "The SAML assertion: XML (redacted)" }).textContent;
    expect(xml).toContain("<ds:SignatureValue>[…]</ds:SignatureValue>");
    const jag = screen.getByRole("tablist", { name: "SAML assertion → ID-JAG" });
    fireEvent.click(within(jag).getByRole("tab", { name: "Decoded" }));
    expect(screen.getByRole("tabpanel", { name: "SAML assertion → ID-JAG: Decoded" }).textContent).toContain("jordan@example.com");
    expect(screen.queryByRole("tablist", { name: "Get an ID-JAG from PingFederate" })).not.toBeInTheDocument();
  });

  it("a real SAML run does not wait for an issuer sign-in: the app sign-in is what counts", async () => {
    mountSaml(samlConfig({ signedIn: false }));
    expect(await screen.findByRole("button", { name: "Request ID-JAG" })).toBeEnabled();
  });

  it("a real SAML run's step 1 follows the app sign-in, not the issuer's refresh-token session", async () => {
    mountSaml(samlConfig({ appSignedIn: true }));
    expect(await screen.findByTestId("ijp-signin-status")).toHaveTextContent("Signed in to this app.");
    expect(screen.getByRole("button", { name: "Sign in as someone else" })).toBeInTheDocument();
    cleanup();
    mountSaml({ ...samlConfig({ appSignedIn: false }), signedIn: true }); // a stale issuer session from an earlier OIDC run
    expect(await screen.findByTestId("ijp-signin-status")).toHaveTextContent("Not signed in to this app.");
    expect(screen.getByRole("button", { name: "Sign in to this app" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in again" })).not.toBeInTheDocument();
  });

  it.each([
    ["the server cannot sign", "pf-as", () => samlConfig({ available: false, reason: "no key" })],
    ["the mode is not pf-as", "pf-pf", () => samlConfig({ mode: "pf-pf" })],
    ["the server is older and has no saml config", "pf-as", () => config()],
  ])("a stored SAML choice falls back to OIDC when %s", async (_why, mode, cfg) => {
    localStorage.setItem("idjag.playground.mode", mode);
    mountSaml(cfg());
    expect(await screen.findByRole("heading", { name: "Get an ID-JAG from PingFederate" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "OIDC" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "SAML" })).toHaveAttribute("aria-pressed", "false");
    await pressWhenEnabled("Request ID-JAG");
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/id-jag-playground/issue", {}));
    expect(post).not.toHaveBeenCalledWith("/api/id-jag-playground/issue", { protocol: "saml" });
    expect(get.mock.calls.some(([u]) => u.includes("protocol=saml"))).toBe(false);
  });

  it("a SAML run refused with sign_in_required tells the user to sign in to the app, not the issuer", async () => {
    mountSaml();
    post.mockRejectedValue({ response: { data: { error: "sign_in_required" } } });
    await pressWhenEnabled("Request ID-JAG");
    expect(await screen.findByText(/Sign in to this app first/)).toBeInTheDocument();
    expect(screen.queryByText(/Sign in at the issuer first/)).not.toBeInTheDocument();
  });

  it("hides the revoke step for SAML, mock or real, and shows it for OIDC", async () => {
    mount(config());
    expect(await screen.findByRole("button", { name: "Revoke and retry" })).toBeInTheDocument();
    cleanup();
    mountSaml();
    await screen.findByRole("button", { name: "Request ID-JAG" });
    expect(screen.queryByRole("button", { name: "Revoke and retry" })).not.toBeInTheDocument();
    cleanup();
    localStorage.setItem("idjag.playground.mode", "mock");
    mount(config());
    fireEvent.click(screen.getByRole("button", { name: "SAML" }));
    expect(screen.queryByRole("button", { name: "Revoke and retry" })).not.toBeInTheDocument();
  });

  it("switching a real SAML run back to OIDC clears it", async () => {
    mountSaml();
    await pressWhenEnabled("Request ID-JAG");
    await screen.findByRole("tablist", { name: "The SAML assertion" });
    await screen.findByTestId("ijp-checks");
    fireEvent.click(screen.getByRole("button", { name: "OIDC" }));
    expect(screen.queryByRole("tablist", { name: "The SAML assertion" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Get an ID-JAG from PingFederate" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revoke and retry" })).toBeInTheDocument();
  });

  it("switching protocol clears the run", async () => {
    localStorage.setItem("idjag.playground.mode", "mock");
    mount(config());
    fireEvent.click(screen.getByRole("button", { name: "Request ID-JAG" }));
    expect(await screen.findByRole("tablist", { name: "Get an ID-JAG from PingFederate" }, slow)).toBeInTheDocument();
    await screen.findByTestId("ijp-checks", {}, slow); // the step has finished (toggles are locked while one runs)
    fireEvent.click(screen.getByRole("button", { name: "SAML" }));
    expect(screen.queryByRole("tablist", { name: "Get an ID-JAG from PingFederate" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tablist", { name: "SAML assertion → ID-JAG" })).not.toBeInTheDocument();
  });

  it("every step term exists in the glossary", () => {
    const ids = new Set(terms.map((t) => t.id));
    for (const [step, list] of Object.entries(STEP_TERMS)) for (const id of list) expect(ids.has(id), `step ${step}: ${id}`).toBe(true);
  });

  it("step 2 links its terms to the glossary", async () => {
    mount(config());
    expect(await screen.findByRole("link", { name: "ID-JAG" })).toHaveAttribute("href", "/learn#term-id-jag");
    expect(screen.getByRole("link", { name: "Token exchange (RFC 8693)" })).toHaveAttribute("href", "/learn#term-token-exchange");
  });

  it("probes the backends again once the server is on the picked mode", async () => {
    get.mockImplementation((url) => Promise.resolve({ data: url.endsWith("/config")
      ? config({ mode: "byo", modes: [{ id: "pf-as", available: true }, { id: "byo", available: true }] })
      : url.endsWith("/backends") ? { backends: [] } : url.includes("/preflight?") ? PREFLIGHT_OK : [] }));
    post.mockResolvedValue({ data: config({ mode: "pf-as" }) });
    render(<IdJagPlaygroundPage />);
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/id-jag-playground/mode", { mode: "pf-as" }));
    await waitFor(() => expect(get.mock.calls.filter(([u]) => u.endsWith("/backends")).length).toBe(2));
  });

  it("keeps the newest backends answer when an older one arrives late", async () => {
    let releaseOld;
    const old = new Promise((r) => { releaseOld = r; });
    let n = 0;
    get.mockImplementation((url) => {
      if (url.endsWith("/config")) return Promise.resolve({ data: config({ mode: "byo", modes: [{ id: "pf-as", available: true }, { id: "byo", available: true }] }) });
      if (url.includes("/preflight?")) return Promise.resolve({ data: PREFLIGHT_OK });
      if (url.endsWith("/backends")) {
        n += 1;
        return n === 1 ? old : Promise.resolve({ data: { backends: [{ id: "mcp", label: "Newest answer", url: "https://mcp.test", state: "up", ms: 1, detail: "1 ms" }] } });
      }
      return Promise.resolve({ data: [] });
    });
    post.mockResolvedValue({ data: config({ mode: "pf-as" }) });
    render(<IdJagPlaygroundPage />);
    const strip = await screen.findByTestId("ijp-backends");
    expect(await within(strip).findByText("Newest answer")).toBeInTheDocument();
    releaseOld({ data: { backends: [{ id: "idp", label: "Old mode answer", url: "https://old.test", state: "down", ms: null, detail: "no answer in 4 s" }] } });
    await new Promise((r) => setTimeout(r, 50));
    expect(within(strip).queryByText("Old mode answer")).not.toBeInTheDocument();
    expect(within(strip).getByText("Newest answer")).toBeInTheDocument();
  });

  it("says each backend's state in words, with the reason when it is not up", async () => {
    get.mockImplementation((url) => Promise.resolve({ data: url.endsWith("/config") ? config() : url.endsWith("/backends")
      ? { backends: [{ id: "idp", label: "PingFederate (issuer)", url: "https://pf.test/x", state: "down", ms: null, detail: "HTTP 503" }] }
      : url.includes("/preflight?") ? PREFLIGHT_OK : [] }));
    render(<IdJagPlaygroundPage />);
    const strip = await screen.findByRole("group", { name: "Backends" });
    const state = await within(strip).findByText("down: HTTP 503");
    expect(state).not.toHaveClass("ijp-sr");
  });

  it("pressing OIDC outside mock keeps the run", async () => {
    localStorage.setItem("idjag.playground.protocol", "saml");
    mount(config());
    post.mockImplementation((url) => Promise.resolve({ data: url.endsWith("/issue")
      ? { request: { endpoint: "POST https://pf.test/as/token.oauth2", body: { grant_type: "x" } }, response: {}, token: { header: {}, claims: { client_id: "c" } } }
      : { checks: [] } }));
    await pressWhenEnabled("Request ID-JAG");
    await screen.findByRole("tablist", { name: "Get an ID-JAG from PingFederate" });
    await screen.findByTestId("ijp-checks");
    fireEvent.click(screen.getByRole("button", { name: "OIDC" }));
    expect(screen.getByRole("tablist", { name: "Get an ID-JAG from PingFederate" })).toBeInTheDocument();
  });

  it("a failed control shows that nothing was revoked", async () => {
    mount(config());
    post.mockImplementation((url) => Promise.resolve({ data: url.endsWith("/revoke")
      ? { control: { request: { endpoint: "POST https://pf.test/as/token.oauth2", body: { grant_type: "x" } }, status: 400, error: "invalid_request" }, proved: false }
      : {} }));
    await pressWhenEnabled("Revoke and retry");
    expect(await screen.findByText("Not proved: the exchange already fails before revoking (invalid_request), so nothing was revoked.")).toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "Control: ask for an ID-JAG before revoking" })).toBeInTheDocument();
    expect(screen.queryByRole("tablist", { name: "Revoke the refresh token" })).not.toBeInTheDocument();
  });

  it.each(["mock", "pf-as", "pf-pf", "byo"])("tells the %s story", async (m) => {
    localStorage.setItem("idjag.playground.mode", m);
    mount(config({ mode: m }));
    expect((await screen.findByTestId("ijp-story")).textContent).toMatch(/^The story\. .{60,}/);
  });

  it("defaults to mock mode on a first visit", () => {
    localStorage.clear();
    mount(config());
    expect(screen.getByTestId("ijp-mock-badge")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sample data (browser)" })).toHaveAttribute("aria-pressed", "true");
  });

  it("explains what to set when the picked mode is not configured", async () => {
    mount(config({ signedIn: false, modes: [{ id: "pf-as", available: false, reason: "Not configured: set RESOURCE_AS_ISSUER" }, { id: "byo", available: true }] }));
    expect(await screen.findByText("Not configured: set RESOURCE_AS_ISSUER", { selector: ".ijp-banner" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Request ID-JAG" })).toBeDisabled();
  });

  it("shows a message instead of crashing when the server has no playground API", async () => {
    mount("<!doctype html><html></html>");
    expect(await screen.findByText(/does not have the ID-JAG playground API/)).toBeInTheDocument();
  });

  it("Start over clears every result and the server's copy, keeps the sign-in, and is offered after an ID-JAG exists", async () => {
    mount(config());
    post.mockImplementation((url) => Promise.resolve({
      data: url.endsWith("/issue")
        ? { request: { grant_type: "token-exchange" }, response: { issued_token_type: "id-jag" }, token: { header: { typ: "oauth-id-jag+jwt" }, claims: { client_id: "id-jag-playground" } } }
        : url.endsWith("/restart") ? { ok: true } : { checks: [{ id: "typ", label: "Header typ", status: "pass", expected: "x", actual: "x", rule: "4.1" }] },
    }));
    expect(await screen.findByTestId("ijp-start-over")).toBeDisabled(); // nothing to clear yet
    expect(screen.queryByTestId("ijp-start-over-step3")).toBeNull();
    await pressWhenEnabled("Request ID-JAG");
    await screen.findByTestId("ijp-checks");
    expect(screen.getByTestId("ijp-start-over-step3")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("ijp-start-over"));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/id-jag-playground/restart", {}));
    await waitFor(() => expect(screen.queryByTestId("ijp-checks")).toBeNull());
    expect(screen.getByTestId("ijp-start-over")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Request ID-JAG" })).toBeEnabled(); // still signed in: a new ID-JAG is one click away
  });

  it("issues an ID-JAG and shows the spec check table", async () => {
    mount(config());
    post.mockImplementation((url) => Promise.resolve({
      data: url.endsWith("/issue")
        ? { request: { grant_type: "token-exchange" }, response: { issued_token_type: "id-jag" }, token: { header: { typ: "oauth-id-jag+jwt" }, claims: { client_id: "id-jag-playground" } } }
        : { checks: [
            { id: "typ", label: "Header typ", status: "pass", expected: "oauth-id-jag+jwt", actual: "oauth-id-jag+jwt", rule: "4.1" },
            { id: "lifetime", label: "Lifetime", status: "warn", expected: "<= 300s", actual: "3600s", rule: "4.1" },
          ] },
    }));
    await pressWhenEnabled("Request ID-JAG");
    const table = await screen.findByTestId("ijp-checks");
    expect(table).toHaveTextContent("Spec check: 1 of 2 pass");
    expect(table).toHaveTextContent("Header typ");
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/id-jag-playground/inspect", {}));
  });

  it("mock mode runs steps 2-5 from fixtures with no network calls", async () => {
    localStorage.setItem("idjag.playground.mode", "mock");
    mount(config());
    expect(screen.getByTestId("ijp-mock-badge")).toHaveTextContent("Sample data: nothing is sent");
    expect(screen.getByTestId("ijp-signin-status")).toHaveTextContent("Sample data: no sign-in needed");

    fireEvent.click(screen.getByRole("button", { name: "Request ID-JAG" }));
    expect(await screen.findByTestId("ijp-checks", {}, slow)).toHaveTextContent("Spec check: 17 of 17 pass");

    fireEvent.change(screen.getByLabelText("Scope to request"), { target: { value: "mcp:read" } });
    fireEvent.click(screen.getByRole("button", { name: "Redeem ID-JAG" }));
    expect(await screen.findByText("Response (HTTP 200)", {}, slow)).toBeInTheDocument();
    expect(screen.getAllByText("mcp:read").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "List tools this token can see" }));
    expect(await screen.findByTestId("ijp-tool-count", {}, slow)).toHaveTextContent("3 tools");
    expect(screen.getByText(/Hidden from this token by scope: delete_record/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: /query/ }), { target: { value: "acme" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: /limit/ }), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Call tool" }));
    expect(await screen.findByText("Sample result from search_records", {}, slow)).toBeInTheDocument();
    expect(screen.getAllByText("acme").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Run all" }));
    await waitFor(() => expect(screen.getAllByText(/^✅ refused/)).toHaveLength(4), { timeout: 10000 });
    expect(screen.getByText(/invalid_client/, { selector: ".ijp-result" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "REST API" }));
    fireEvent.click(screen.getByRole("button", { name: "Try with the raw ID-JAG" }));
    expect(await screen.findByText(/token type check failed/, {}, slow)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open with the access token" }));
    expect(await screen.findByText("Who the resource server says you are", {}, slow)).toBeInTheDocument();
    expect(screen.getByTestId("ijp-resource-status")).toHaveTextContent("200 OK");
    expect(screen.getByText("Partner Okta (sample)")).toBeInTheDocument();

    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 30000);

  it("Form | JSON toggle switches how data renders", async () => {
    localStorage.setItem("idjag.playground.mode", "mock");
    const { container } = mount(config());
    fireEvent.click(screen.getByRole("button", { name: "Request ID-JAG" }));
    await screen.findByTestId("ijp-checks", {}, slow);
    expect(container.querySelector(".ijp-json")).toBeNull();
    expect(container.querySelector(".ijp-kv dt")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "JSON" }));
    expect(container.querySelector(".ijp-form")).toBeNull();
    expect(container.querySelector(".ijp-json").textContent).toContain('"grant_type"');
    expect(localStorage.getItem("idjag.playground.view")).toBe("json");
  });

  it("picking a real mode calls POST /mode and re-renders from the returned config", async () => {
    mount(config({ modes: [{ id: "pf-as", available: true }, { id: "pf-pf", available: true }] }));
    post.mockResolvedValue({ data: config({ mode: "pf-pf", idp: { ...config().idp, name: "Acme PingFederate (issuer)" }, resourceAs: { ...config().resourceAs, name: "PingFederate (redeemer)" } }) });
    fireEvent.click(await screen.findByRole("button", { name: "Acme PingFederate → PingFederate" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/id-jag-playground/mode", { mode: "pf-pf" }));
    expect(await screen.findByText("Resource AS: PingFederate (redeemer)")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Redeem it at our PingFederate" })).toBeInTheDocument();
    expect(localStorage.getItem("idjag.playground.mode")).toBe("pf-pf");
  });

  it("shows an unavailable mode disabled with its reason", async () => {
    mount(config({ modes: [{ id: "pf-as", available: true }, { id: "pf-pf", available: false, reason: "Local PingFederate not configured" }] }));
    const btn = await screen.findByRole("button", { name: "Acme PingFederate → PingFederate" });
    await waitFor(() => expect(btn).toBeDisabled());
    expect(btn).toHaveAttribute("title", "Local PingFederate not configured");
  });

  it("pf-pf sign-in opens the issuer sign-in event, not the app sign-in and not a redirect", async () => {
    localStorage.setItem("idjag.playground.mode", "pf-pf");
    const assign = vi.fn();
    const orig = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { ...orig, assign } });
    try {
      mount(config({ mode: "pf-pf", signedIn: false }));
      const step1 = (await screen.findByRole("heading", { name: "Sign in at the Acme PingFederate" })).closest("section");
      await waitFor(() => expect(within(step1).getByRole("button")).toBeEnabled());
      const seen = [];
      const claim = (e) => { e.detail.handled = true; seen.push({ kind: e.detail.kind, returnTo: e.detail.returnTo }); };
      window.addEventListener("idjag:signin", claim);
      try {
        fireEvent.click(within(step1).getByRole("button"));
        await waitFor(() => expect(seen).toEqual([{ kind: "issuer", returnTo: "/" }]));
      } finally {
        window.removeEventListener("idjag:signin", claim);
      }
      expect(assign).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: orig });
    }
  });

  const IDP = { id: "partner", name: "Partner IdP", issuer: "https://idp.partner.test", jwksUrl: "https://idp.partner.test/jwks", idJagClientId: "partner-agent", clientId: "id-jag-playground", pfClientId: "id-jag-redeemer", scopes: "", targets: ["resource-as"], enabled: true };
  const ENDPOINTS = { "resource-as": { issuer: "https://as.test", tokenEndpoint: "https://as.test/token" }, pingfederate: { issuer: "https://pf.local", tokenEndpoint: "https://pf.local/as/token.oauth2" } };
  const mountWith = (cfg, registry) => {
    get.mockImplementation((url) => {
      if (url.endsWith("/config")) return Promise.resolve({ data: cfg });
      if (url.endsWith("/trusted-idps")) return typeof registry === "function" ? registry() : Promise.resolve({ data: registry });
      if (url.includes("/preflight?")) return Promise.resolve({ data: PREFLIGHT_OK });
      return Promise.resolve({ data: [] });
    });
    return render(<IdJagPlaygroundPage />);
  };

  it("byo: paste an ID-JAG, inspect it against the trusted IdP, then redeem", async () => {
    localStorage.setItem("idjag.playground.mode", "byo");
    mountWith(config({ mode: "byo", signedIn: false, publicEndpoints: ENDPOINTS }), { idps: [IDP], canManage: false });
    post.mockImplementation((url) => Promise.resolve({ data: url.endsWith("/byo/inspect")
      ? { trusted: true, header: { typ: "oauth-id-jag+jwt" }, claims: { iss: IDP.issuer, client_id: "partner-agent" }, checks: [{ id: "iss", label: "Issuer is Partner IdP", status: "pass", expected: IDP.issuer, actual: IDP.issuer }] }
      : { request: { client_id: "id-jag-playground" }, status: 200, response: { token_type: "Bearer" }, token: { header: {}, claims: { scope: "mcp:read" } } } }));
    const step1 = (await screen.findByRole("heading", { name: "Paste an ID-JAG from your IdP" })).closest("section");
    expect(within(step1).getByText("https://as.test")).toBeInTheDocument();
    fireEvent.click(within(step1).getByRole("button", { name: "PingFederate" }));
    expect(within(step1).getByText("https://pf.local")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Request ID-JAG" })).toBeNull();
    expect(screen.getByRole("button", { name: "Redeem ID-JAG" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Your ID-JAG/), { target: { value: " a.b.c " } });
    fireEvent.click(screen.getByRole("button", { name: "Inspect ID-JAG" }));
    expect(await screen.findByTestId("ijp-checks")).toHaveTextContent("Spec check: 1 of 1 pass");
    expect(post).toHaveBeenCalledWith("/api/id-jag-playground/byo/inspect", { idJag: "a.b.c", target: "pingfederate" });

    const redeem = screen.getByRole("button", { name: "Redeem ID-JAG" });
    await waitFor(() => expect(redeem).toBeEnabled());
    fireEvent.click(redeem);
    expect(await screen.findByText("Response (HTTP 200)")).toBeInTheDocument();
    expect(post).toHaveBeenCalledWith("/api/id-jag-playground/redeem", {}, expect.anything());
  });

  it("byo: an untrusted issuer shows the hint and keeps redeem disabled", async () => {
    localStorage.setItem("idjag.playground.mode", "byo");
    mountWith(config({ mode: "byo", publicEndpoints: ENDPOINTS }), { idps: [], canManage: false });
    post.mockResolvedValue({ data: { trusted: false, hint: "Add this issuer on the Trusted IdPs panel (admin).", header: {}, claims: {}, checks: [{ id: "trusted-idp", label: "Issuer is a trusted IdP", status: "fail" }] } });
    fireEvent.change(await screen.findByLabelText(/Your ID-JAG/), { target: { value: "a.b.c" } });
    fireEvent.click(screen.getByRole("button", { name: "Inspect ID-JAG" }));
    expect(await screen.findByTestId("ijp-byo-hint")).toHaveTextContent("Trusted IdPs panel");
    expect(screen.getByRole("button", { name: "Redeem ID-JAG" })).toBeDisabled();
  });

  // ---- xaa.dev: IdenX (Okta's free XAA playground) as a real outside IdP ----

  const XAA_BUTTON = "Get an ID-JAG from xaa.dev (IdenX, a free third-party IdP)";
  const XAA_OK = { available: true, reason: null, signedIn: false, user: null };
  const now = () => Math.floor(Date.now() / 1000);
  const XAA_INSPECTION = {
    trusted: true, idp: { id: "xaa-dev", name: "xaa.dev IdenX" }, header: { typ: "oauth-id-jag+jwt" },
    claims: { iss: "https://idp.xaa.dev", client_id: "idp-xaa-dev", scope: "read", exp: now() + 300 },
    checks: [{ id: "iss", label: "Issuer is xaa.dev IdenX", status: "pass", expected: "https://idp.xaa.dev", actual: "https://idp.xaa.dev" }],
    request: { endpoint: "POST https://idp.xaa.dev/token", body: { audience: "https://as.test", subject_token: "[your IdenX refresh token, kept server-side]" } },
  };
  const withLocation = async (fn) => {
    const assign = vi.fn();
    const orig = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { ...orig, assign } });
    try { await fn(assign); } finally { Object.defineProperty(window, "location", { configurable: true, value: orig }); }
  };

  it("byo: the xaa.dev button signs in at IdenX first (after its pre-flight) and links xaa.dev in a new tab", async () => {
    localStorage.setItem("idjag.playground.mode", "byo");
    await withLocation(async (assign) => {
      mountWith(config({ mode: "byo", publicEndpoints: ENDPOINTS, xaa: XAA_OK }), { idps: [], canManage: false });
      const link = within(await screen.findByTestId("ijp-xaa")).getByRole("link", { name: "xaa.dev" });
      expect(link).toHaveAttribute("href", "https://xaa.dev");
      expect(link).toHaveAttribute("target", "_blank");
      const btn = screen.getByRole("button", { name: XAA_BUTTON });
      await waitFor(() => expect(btn).toBeEnabled());
      fireEvent.click(btn);
      await waitFor(() => expect(assign).toHaveBeenCalledWith("/api/id-jag-playground/xaa/login?return_to=/"));
      const q = new URLSearchParams(get.mock.calls.map(([u]) => u).find((u) => u.includes("/preflight?")).split("?")[1]);
      expect([q.get("step"), q.get("mode")]).toEqual(["xaa", "byo"]);
      expect(post).not.toHaveBeenCalled();
    });
  });

  it("byo: back from IdenX (?xaa=signed_in) it gets the ID-JAG and shows the inspection, ready to redeem", async () => {
    localStorage.setItem("idjag.playground.mode", "byo");
    window.history.pushState({}, "", "/?xaa=signed_in");
    try {
      post.mockResolvedValue({ data: XAA_INSPECTION });
      mountWith(config({ mode: "byo", publicEndpoints: ENDPOINTS, xaa: { ...XAA_OK, signedIn: true, user: "alice@example.com" } }), { idps: [], canManage: false });
      expect(await screen.findByTestId("ijp-checks")).toHaveTextContent("Spec check: 1 of 1 pass");
      expect(post).toHaveBeenCalledWith("/api/id-jag-playground/xaa/id-jag", {});
      expect(window.location.search).toBe(""); // a reload does not fetch another one
      expect(screen.getByText("Request to IdenX")).toBeInTheDocument();
      expect(screen.getByText(/Signed in at IdenX as alice@example.com/)).toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole("button", { name: "Redeem ID-JAG" })).toBeEnabled());
    } finally { window.history.pushState({}, "", "/"); }
  });

  it("byo: shows an IdenX sign-in error from the redirect, and a disabled button with the reason when unavailable", async () => {
    localStorage.setItem("idjag.playground.mode", "byo");
    window.history.pushState({}, "", "/?xaa_error=invalid_state");
    try {
      mountWith(config({ mode: "byo", publicEndpoints: ENDPOINTS, xaa: { available: false, reason: "xaa.dev addresses ID-JAGs to a public https issuer registered at xaa.dev" } }), { idps: [], canManage: false });
      expect(await screen.findByText(/IdenX sign-in did not complete \(invalid_state\)/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: XAA_BUTTON })).toBeDisabled();
      expect(screen.getByTestId("ijp-xaa-reason")).toHaveTextContent("public https issuer");
      expect(post).not.toHaveBeenCalled();
    } finally { window.history.pushState({}, "", "/"); }
  });

  it("mock: the xaa.dev button gives a sample IdenX ID-JAG that redeems, with no network calls", async () => {
    localStorage.setItem("idjag.playground.mode", "mock");
    mount(config());
    fireEvent.click(screen.getByRole("button", { name: XAA_BUTTON }));
    const table = await screen.findByTestId("ijp-checks", {}, slow);
    expect(table).toHaveTextContent("Spec check: 17 of 17 pass");
    expect(table).toHaveTextContent("https://idp.xaa.dev");
    const redeem = screen.getByRole("button", { name: "Redeem ID-JAG" });
    await waitFor(() => expect(redeem).toBeEnabled());
    fireEvent.click(redeem);
    expect(await screen.findByText("Response (HTTP 200)", {}, slow)).toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 30000);

  it("Trusted IdPs: admin adds, edits and deletes (with an in-page confirm)", async () => {
    mountWith(config({ publicEndpoints: ENDPOINTS }), { idps: [IDP], canManage: true });
    post.mockResolvedValue({ data: {} }); put.mockResolvedValue({ data: {} }); del.mockResolvedValue({ data: null });
    const panel = await screen.findByTestId("ijp-trusted-idps");
    expect(await within(panel).findByText("Partner IdP")).toBeInTheDocument();
    expect(within(panel).getByText("partner-agent")).toBeInTheDocument();
    expect(within(panel).getByText("https://as.test/token")).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole("button", { name: "Add trusted IdP" }));
    const add = within(panel).getByRole("form", { name: "Add trusted IdP" });
    fireEvent.change(within(add).getByLabelText("Id (slug)"), { target: { value: "acme" } });
    fireEvent.change(within(add).getByLabelText("Issuer (https)"), { target: { value: "https://acme.test" } });
    fireEvent.click(within(add).getByRole("checkbox", { name: "PingFederate" }));
    fireEvent.click(within(add).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/id-jag-playground/trusted-idps", expect.objectContaining({ id: "acme", issuer: "https://acme.test", targets: ["resource-as", "pingfederate"], enabled: true })));

    fireEvent.click(await within(panel).findByRole("button", { name: "Edit" }));
    const edit = within(panel).getByRole("form", { name: "Edit trusted IdP" });
    expect(within(edit).getByLabelText("Id (slug)")).toBeDisabled();
    fireEvent.click(within(edit).getByRole("checkbox", { name: "Enabled" }));
    fireEvent.click(within(edit).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(put).toHaveBeenCalledWith("/api/id-jag-playground/trusted-idps/partner", expect.objectContaining({ enabled: false, name: "Partner IdP" })));
    expect(put.mock.calls[0][1]).not.toHaveProperty("editing");

    const confirmSpy = vi.spyOn(window, "confirm");
    fireEvent.click(await within(panel).findByRole("button", { name: "Delete" }));
    expect(del).not.toHaveBeenCalled();
    fireEvent.click(within(panel).getByRole("button", { name: "Confirm delete" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("/api/id-jag-playground/trusted-idps/partner"));
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("Trusted IdPs: the real API gives a read-only list that links to the Trusted IdPs page", async () => {
    mountWith(config({ publicEndpoints: ENDPOINTS }), { idps: [IDP], canManage: false });
    const panel = await screen.findByTestId("ijp-trusted-idps");
    expect(await within(panel).findByText("Partner IdP")).toBeInTheDocument();
    expect(within(panel).getByTestId("ijp-trusted-readonly")).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: /Add trusted IdP|Edit|Delete/ })).toBeNull();
    expect(get).toHaveBeenCalledWith("/api/id-jag-playground/trusted-idps");
    expect(within(panel).getByRole("link", { name: "Trusted IdPs page" })).toHaveAttribute("href", "/trusted-idps");
  });
});

describe("gateway redeem mode", () => {
  const gwConfig = (over = {}) => config({ mode: "gateway-redeem", signedIn: false,
    modes: [{ id: "pf-as", label: "PingFederate", available: true }, { id: "gateway-redeem", label: "Gateway redeems the ID-JAG (mock only)", available: true, reason: null }], ...over });
  const mountGw = (cfg, available = true) => {
    localStorage.setItem("idjag.playground.mode", "gateway-redeem");
    get.mockImplementation((url) => {
      if (url.endsWith("/config")) return Promise.resolve({ data: cfg });
      if (url.endsWith("/gateway-redeem/state")) return Promise.resolve({ data: { available, reason: available ? null : "Live mode is not available for gateway redeem.", claim: "x", spec: { OBO: { TokenURL: "", ClientID: "", ClientSecret: { set: false }, AuthMethod: "client_secret_basic", Resource: "", Scope: "", PrivateKeyPEM: { set: false }, KeyID: "", SubjectTokenType: "t", RequestedTokenType: "r", Redeem: null } }, authMethods: ["client_secret_basic"], allowList: [], cast: {}, scenarios: [], claims: [] } });
      return Promise.resolve({ data: url.includes("/preflight?") ? PREFLIGHT_OK : [] });
    });
    return render(<IdJagPlaygroundPage />);
  };

  it("replaces the six sign-in steps with the gateway panel, keeps the talk track, and hides the sign-in controls", async () => {
    mountGw(gwConfig());
    expect(await screen.findByTestId("gateway-redeem")).toBeInTheDocument();
    expect(screen.getByTestId("ijp-story")).toHaveTextContent("Ping release claim (2026-11-02), unverified on our tenant");
    expect(screen.getByTestId("story-panel")).toHaveTextContent("Story S48");
    expect(screen.queryByRole("heading", { name: /Sign in at the issuer/ })).toBeNull();
    expect(screen.queryByRole("group", { name: "Sign-in protocol" })).toBeNull();
    expect(screen.queryByText("How other implementations do it")).toBeNull();
    expect(screen.getByRole("group", { name: "Playground mode" })).toHaveTextContent("Gateway redeems the ID-JAG (mock only)");
    expect(document.querySelectorAll("[id^='ijp-step-']").length).toBe(5);
  });

  it("links the mode to its own diagram", async () => {
    mountGw(gwConfig());
    await screen.findByTestId("gateway-redeem");
    expect(screen.getByRole("link", { name: /View Gateway redeems the ID-JAG at the target app diagram/ })).toHaveAttribute("href", "/diagram/gateway-redeem");
  });

  it("in Live mode the panel says it is unavailable and the mode is disabled in the picker with the reason", async () => {
    const reason = "Live mode is not available for gateway redeem: the 2026-11-02 release is not on our tenant.";
    mountGw(gwConfig({ modes: [{ id: "pf-as", label: "PingFederate", available: true }, { id: "gateway-redeem", label: "Gateway redeems the ID-JAG (mock only)", available: false, reason }] }), false);
    expect(await screen.findByTestId("gr-live-unavailable")).toHaveTextContent("Live is unavailable for this mode");
    await waitFor(() => expect(screen.getByRole("button", { name: "Gateway redeems the ID-JAG (mock only)" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Gateway redeems the ID-JAG (mock only)" })).toHaveAttribute("title", reason);
  });
});

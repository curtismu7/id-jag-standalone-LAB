import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("../../services/api", () => ({ default: { get, post, put: vi.fn(), delete: vi.fn() } }));

import IdJagPlaygroundPage from "../IdJagPlaygroundPage";

const config = (over = {}) => ({
  mode: "pf-as", signedIn: true,
  idp: { name: "PingFederate (issuer)", issuer: "https://pf.test", tokenEndpoint: "https://pf.test/as/token.oauth2", jwksUrl: "https://pf.test/pf/JWKS", exchangeClientId: "pf-exchange" },
  resourceAs: { name: "Resource AS", issuer: "https://as.test", tokenEndpoint: "https://as.test/token", clientId: "id-jag-playground" },
  request: { resource: "https://as.test/mcp", scope: "mcp:invoke" },
  ...over,
});
const ENTRY = { at: "2026-10-19T12:00:00.000Z", decision: "accepted", iss: "https://pf.test", client_id: "id-jag-playground", sub: "j***@pingone.com", aud: "https://as.test/mcp", scope: "mcp:invoke", jti: "b3f1c6e2…" };
const slow = { timeout: 10000 }; // as testSetup.js asyncUtilTimeout; a wait only lasts this long when it is going to fail

// Real-mode page with an ID-JAG issued and /redeem answering `redeemBody`; /as-events answers `events`.
async function redeemWith(events, { cfg = config(), redeemBody = { request: { endpoint: "POST https://as.test/token" }, status: 200, response: {}, token: { claims: { exp: 4102444800 } } } } = {}) {
  get.mockImplementation((url) => {
    if (url.endsWith("/config")) return Promise.resolve({ data: cfg });
    if (url.endsWith("/as-events")) return events instanceof Error ? Promise.reject(events) : Promise.resolve({ data: events });
    if (url.includes("/preflight?")) return Promise.resolve({ data: { ok: true, checks: [] } });
    return Promise.resolve({ data: [] });
  });
  post.mockImplementation((url) => Promise.resolve({ data: url.endsWith("/redeem") ? redeemBody
    : url.endsWith("/issue") ? { request: {}, response: {}, token: { header: {}, claims: { exp: 4102444800, scope: "mcp:invoke" } } } : { checks: [] } }));
  render(<IdJagPlaygroundPage />);
  fireEvent.click(await screen.findByRole("button", { name: "Request ID-JAG" }));
  const redeem = screen.getByRole("button", { name: "Redeem ID-JAG" });
  await waitFor(() => expect(redeem).toBeEnabled());
  fireEvent.click(redeem);
}

beforeEach(() => {
  get.mockReset(); post.mockReset(); localStorage.clear();
  localStorage.setItem("idjag.playground.mode", "pf-as");
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("no network in tests"))));
});
afterEach(() => vi.unstubAllGlobals());

describe("what the resource AS recorded", () => {
  it("shows the AS record with masked subject after a successful redeem", async () => {
    await redeemWith({ available: true, entry: ENTRY, recent: [ENTRY] });
    const panel = await screen.findByTestId("ijp-as-record", {}, slow);
    expect(panel).toHaveTextContent("What the resource AS recorded");
    expect(panel).toHaveTextContent("The resource AS received this ID-JAG and issued an access token");
    expect(panel).toHaveTextContent("id-jag-playground");
    expect(panel).toHaveTextContent("mcp:invoke");
    expect(panel).toHaveTextContent("https://as.test/mcp");
    expect(panel).toHaveTextContent("j***@pingone.com");
  });

  it("shows a refusal, not the success pill, when the matched entry was refused", async () => {
    const refused = { ...ENTRY, decision: "refused", reason: "jti already used" };
    await redeemWith({ available: true, entry: refused, recent: [refused] });
    const panel = await screen.findByTestId("ijp-as-record", {}, slow);
    expect(panel).not.toHaveTextContent("issued an access token");
    expect(panel).toHaveTextContent("refused");
    expect(panel).toHaveTextContent("jti already used");
  });

  it("says plainly when the AS has no record yet, with no error banner", async () => {
    await redeemWith({ available: true, entry: null, recent: [] });
    const panel = await screen.findByTestId("ijp-as-record", {}, slow);
    expect(panel).toHaveTextContent("The resource AS has no record of this one yet");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the server's reason when the AS could not be read", async () => {
    await redeemWith({ available: true, entry: null, recent: [], reason: "Could not read the resource AS's record." });
    expect(await screen.findByTestId("ijp-as-record", {}, slow)).toHaveTextContent("Could not read the resource AS's record.");
  });

  it("renders AS-supplied text as text, never as HTML", async () => {
    await redeemWith({ available: true, entry: { ...ENTRY, client_id: "<img src=x onerror=alert(1)>" }, recent: [] });
    const panel = await screen.findByTestId("ijp-as-record", {}, slow);
    expect(panel).toHaveTextContent("<img src=x onerror=alert(1)>");
    expect(panel.querySelector("img")).toBeNull();
  });

  it("is not shown when the mode redeems at PingFederate", async () => {
    await redeemWith({ available: false, reason: "This mode redeems at PingFederate, not at the kit's resource AS." });
    await screen.findByText("Response (HTTP 200)", {}, slow);
    await waitFor(() => expect(get.mock.calls.some(([u]) => u.endsWith("/as-events"))).toBe(true));
    expect(screen.queryByTestId("ijp-as-record")).not.toBeInTheDocument();
  });

  it("is not shown, and not asked for, when the redeem is refused", async () => {
    await redeemWith({ available: true, entry: ENTRY, recent: [] }, { redeemBody: { request: {}, status: 400, response: { error: "invalid_grant" }, token: null } });
    await screen.findByText("Response (HTTP 400)", {}, slow);
    expect(get.mock.calls.some(([u]) => u.endsWith("/as-events"))).toBe(false);
    expect(screen.queryByTestId("ijp-as-record")).not.toBeInTheDocument();
  });

  it("a failing as-events call never breaks the page", async () => {
    await redeemWith(new Error("boom"));
    await screen.findByText("Response (HTTP 200)", {}, slow);
    await waitFor(() => expect(get.mock.calls.some(([u]) => u.endsWith("/as-events"))).toBe(true));
    expect(screen.queryByTestId("ijp-as-record")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("is not shown by the negative tests alone: only after a successful redeem", async () => {
    get.mockImplementation((url) => Promise.resolve({ data: url.endsWith("/config") ? config() : url.endsWith("/as-events") ? { available: true, entry: null, recent: [] }
      : url.endsWith("/negative") ? [{ id: "replay", label: "Replay", expect: "invalid_grant", why: "w" }] : url.includes("/preflight?") ? { ok: true, checks: [] } : [] }));
    post.mockResolvedValue({ data: { id: "replay", pass: true, status: 400 } });
    render(<IdJagPlaygroundPage />);
    const runAll = await screen.findByRole("button", { name: "Run all" });
    await waitFor(() => expect(runAll).toBeEnabled());
    fireEvent.click(runAll);
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/id-jag-playground/negative/replay", {}, expect.anything()));
    await waitFor(() => expect(get.mock.calls.some(([u]) => String(u).endsWith("/as-events"))).toBe(true)); // it still looked
    expect(screen.queryByTestId("ijp-as-record")).toBeNull(); // but there is no redeem to report on
  });

  it("refreshes the record when the negative tests finish, after a successful redeem", async () => {
    await redeemWith({ available: true, entry: null, recent: [] });
    await screen.findByTestId("ijp-as-record", {}, slow);
    const calls = () => get.mock.calls.filter(([u]) => String(u).endsWith("/as-events")).length;
    const before = calls();
    fireEvent.click(await screen.findByRole("button", { name: "Run all" }));
    await waitFor(() => expect(calls()).toBeGreaterThan(before), slow);
  });
});

describe("Open the resource AS link", () => {
  it("links to the AS issuer in a new tab in pf-as mode, with the sentence", async () => {
    await redeemWith({ available: true, entry: null, recent: [] });
    const link = await screen.findByRole("link", { name: /Open the resource AS/ });
    expect(link).toHaveAttribute("href", "https://as.test/");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText(/lists every redemption it accepted or refused, live/)).toBeInTheDocument();
  });

  it("has no link when the mode redeems at PingFederate", async () => {
    localStorage.setItem("idjag.playground.mode", "pf-pf");
    get.mockImplementation((url) => Promise.resolve({ data: url.endsWith("/config") ? config({ mode: "pf-pf" }) : url.includes("/preflight?") ? { ok: true, checks: [] } : [] }));
    render(<IdJagPlaygroundPage />);
    await screen.findByRole("button", { name: "Request ID-JAG" });
    expect(screen.queryByRole("link", { name: /Open the resource AS/ })).not.toBeInTheDocument();
  });

  it("mock: a clearly marked sample record and the sentence without a working link", async () => {
    localStorage.setItem("idjag.playground.mode", "mock");
    render(<IdJagPlaygroundPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Request ID-JAG" }));
    const redeem = screen.getByRole("button", { name: "Redeem ID-JAG" });
    await waitFor(() => expect(redeem).toBeEnabled());
    fireEvent.click(redeem);
    const panel = await screen.findByTestId("ijp-as-record", {}, slow);
    expect(panel).toHaveTextContent(/sample/i);
    expect(panel).toHaveTextContent("The resource AS received this ID-JAG and issued an access token");
    expect(screen.getByText(/lists every redemption it accepted or refused, live/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Open the resource AS/ })).not.toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  }, 30000);

  it("step 5 says refusals appear in the AS record too", async () => {
    await redeemWith({ available: true, entry: null, recent: [] });
    expect(await screen.findByText(/Refusals appear in the resource AS.s own record too/)).toBeInTheDocument();
  });
});

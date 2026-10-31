import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const { get, post, put } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }));
vi.mock("../../services/api", () => ({ default: { get, post, put, delete: vi.fn() } }));

import GatewayRedeemPanel, { CLAIM, buildPatch } from "../GatewayRedeemPanel";

const SWAGGER = "console swagger name, 2026-10-31, schema only";
const masked = (set = true) => ({ set, writeOnly: true });
const spec = () => ({
  OBO: {
    TokenURL: "https://exchange-idp.mock.invalid/token", ClientID: "gateway-obo", ClientSecret: masked(), AuthMethod: "client_secret_basic",
    Resource: "https://target-idp.mock.invalid", Scope: "ledger:read", PrivateKeyPEM: masked(), KeyID: "obo-key-1",
    SubjectTokenType: "urn:ietf:params:oauth:token-type:access_token", RequestedTokenType: "urn:ietf:params:oauth:token-type:id-jag",
    Redeem: { TokenURL: "https://target-idp.mock.invalid/token", ClientID: "gateway-redeem", ClientSecret: masked(), AuthMethod: "private_key_jwt", Scope: "ledger:read", PrivateKeyPEM: masked(), KeyID: "gw-redeem-1" },
  },
});
const state = (over = {}) => ({
  claim: CLAIM, available: true, reason: null, spec: spec(), writeOnly: ["ClientSecret", "PrivateKeyPEM"],
  authMethods: ["client_secret_basic", "client_secret_post", "private_key_jwt"], allowList: ["https://exchange-idp.mock.invalid", "https://target-idp.mock.invalid"],
  cast: { user: "alice@mock.example", callerClient: "agent-app", gateway: "https://gateway.mock.invalid" },
  scenarios: [
    { id: "happy", label: "Both legs, as configured", why: "The happy path.", expect: { outcome: "ok" }, tag: "lab-invented" },
    { id: "no-redeem", label: "No Redeem.TokenURL", why: "No leg 2.", expect: { outcome: "refused" }, tag: "lab-invented" },
  ],
  claims: [{ id: "OBO.TokenURL", text: "modelMcpOBOSpec.TokenURL", tag: SWAGGER }],
  ...over,
});
const run = (over = {}) => ({
  scenario: "happy", label: "Both legs, as configured", why: "The happy path.", expect: { outcome: "ok" },
  verdict: { pass: true, checks: [{ what: "outcome", want: "ok", got: "ok" }] },
  refusal: null, redeemed: true, replay: null, traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
  callerToken: { token: "x.y.z", decoded: { header: { typ: "at+jwt" }, claims: { sub: "zed@mock.example" } } },
  leg1: { issuedTokenType: "urn:ietf:params:oauth:token-type:id-jag", token: "a.b.c", decoded: { header: { typ: "oauth-id-jag+jwt" }, claims: { sub: "zed@mock.example", aud: "https://target-idp.mock.invalid" } } },
  leg2: { token: "d.e.f", decoded: { header: { typ: "at+jwt" }, claims: { sub: "zed@mock.example", aud: "https://target-api.mock.invalid/ledger" } } },
  target: { status: 200, body: { principal: { sub: "zed@mock.example", act: { sub: "agent-app" } }, data: { entries: [] } } },
  controls: [{ label: "The caller's original token presented to the target API", status: 401, error: "invalid_token", failedCheck: "signature" }],
  hops: [
    { n: 1, label: "The agent calls the gateway with the caller token", from: "agent", to: "gateway", method: "POST", url: "https://gateway.mock.invalid/mcp", traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01", status: 200, request: {} },
    { n: 2, label: "Leg 1: exchange the caller token (RFC 8693)", from: "gateway", to: "exchange issuer", method: "POST", url: "https://exchange-idp.mock.invalid/token", traceparent: "00-0af7651916cd43dd8448eb211c80319c-aaaaaaaaaaaaaaaa-01", status: 200, request: { authentication: "Basic [client credentials, write-only]" }, response: { access_token: "a.b.c" } },
    { n: 3, label: "Leg 2: redeem at the target app's own issuer (RFC 7523)", from: "gateway", to: "target issuer", method: "POST", url: "https://target-idp.mock.invalid/token", traceparent: "00-0af7651916cd43dd8448eb211c80319c-bbbbbbbbbbbbbbbb-01", status: 200, request: { body: { client_assertion: "[signed with PrivateKeyPEM, write-only]" } }, response: { access_token: "d.e.f" } },
  ],
  targetIssuerEvents: [],
  ...over,
});

function mount({ st = state(), runs = {} } = {}) {
  get.mockImplementation((url) => Promise.resolve({ data: url.endsWith("/state") ? st : null }));
  post.mockImplementation((url, body) => {
    if (url.endsWith("/run")) return Promise.resolve({ data: runs[body.scenario] ?? run({ scenario: body.scenario }) });
    if (url.endsWith("/spec/reset")) return Promise.resolve({ data: { spec: spec() } });
    return Promise.resolve({ data: {} });
  });
  return render(<GatewayRedeemPanel />);
}
const ready = async () => { await screen.findByTestId("gateway-redeem"); await waitFor(() => expect(screen.getByTestId("gr-run-happy")).toBeEnabled()); };

beforeEach(() => { get.mockReset(); post.mockReset(); put.mockReset(); });
afterEach(cleanup);

describe("the claim and where each name comes from", () => {
  it("states the release claim and that nothing leaves this machine, and tags the swagger names", async () => {
    mount();
    await ready();
    expect(screen.getByTestId("gr-claim")).toHaveTextContent("Ping release claim (2026-11-02), UNVERIFIED on our tenant");
    expect(screen.getByTestId("gr-claim")).toHaveTextContent("Only PingFederate supports ID-JAG and DPoP in this lab family");
    const legend = screen.getByTestId("gr-legend");
    expect(legend).toHaveTextContent(SWAGGER);
    expect(legend).toHaveTextContent("lab reading");
    expect(legend).toHaveTextContent("lab-invented");
    // Every field label carries the swagger tag.
    for (const name of ["OBO.TokenURL", "OBO.ClientSecret", "OBO.PrivateKeyPEM", "OBO.RequestedTokenType", "OBO.Redeem.TokenURL", "OBO.Redeem.KeyID"]) {
      const label = screen.getByText(name).closest("label");
      expect(within(label).getByTitle(SWAGGER)).toBeInTheDocument();
    }
  });

  it("draws every field of both legs", async () => {
    mount();
    await ready();
    const names = ["TokenURL", "ClientID", "ClientSecret", "AuthMethod", "Resource", "Scope", "PrivateKeyPEM", "KeyID", "SubjectTokenType", "RequestedTokenType"];
    for (const n of names) expect(screen.getByText(`OBO.${n}`)).toBeInTheDocument();
    for (const n of ["TokenURL", "ClientID", "ClientSecret", "AuthMethod", "Scope", "PrivateKeyPEM", "KeyID"]) expect(screen.getByText(`OBO.Redeem.${n}`)).toBeInTheDocument();
  });

  it("has a section for each story and presenter step, ids ijp-step-1 to ijp-step-5", async () => {
    mount();
    await ready();
    for (const n of [1, 2, 3, 4, 5]) expect(document.getElementById(`ijp-step-${n}`)).not.toBeNull();
  });
});

describe("write-only fields", () => {
  it("never show a value: they are password-style inputs that say 'set' and start empty", async () => {
    mount();
    await ready();
    const secret = screen.getByLabelText(/OBO\.ClientSecret/);
    expect(secret).toHaveAttribute("type", "password");
    expect(secret).toHaveValue("");
    expect(secret).toHaveAttribute("placeholder", expect.stringContaining("set (write-only)"));
    const pem = screen.getByLabelText(/OBO\.PrivateKeyPEM/);
    expect(pem).toHaveValue("");
    expect(pem).toHaveClass("gateway-redeem__masked");
  });

  it("send a value only when one was typed, and null when Clear is ticked", () => {
    const s = spec();
    const draft = (over) => ({ OBO: { TokenURL: s.OBO.TokenURL, ClientID: "gateway-obo", AuthMethod: "client_secret_basic", Resource: s.OBO.Resource, Scope: "ledger:read", KeyID: "obo-key-1", SubjectTokenType: s.OBO.SubjectTokenType, RequestedTokenType: s.OBO.RequestedTokenType },
      Redeem: { TokenURL: s.OBO.Redeem.TokenURL, ClientID: "gateway-redeem", AuthMethod: "private_key_jwt", Scope: "ledger:read", KeyID: "gw-redeem-1" }, redeemOn: true, secrets: {}, clear: {}, ...over });
    expect(buildPatch(s, draft())).toBeNull(); // nothing changed, nothing sent
    expect(buildPatch(s, draft({ secrets: { "OBO.ClientSecret": "typed-value-1" } }))).toEqual({ OBO: { ClientSecret: "typed-value-1" } });
    expect(buildPatch(s, draft({ clear: { "OBO.Redeem.PrivateKeyPEM": true } }))).toEqual({ OBO: { Redeem: { PrivateKeyPEM: null } } });
    expect(buildPatch(s, draft({ redeemOn: false }))).toEqual({ OBO: { Redeem: null } });
    const changed = draft(); changed.OBO.Scope = "ledger:write";
    expect(buildPatch(s, changed)).toEqual({ OBO: { Scope: "ledger:write" } });
  });

  it("Save sends only the edit, shows the saved note, and clears what was typed", async () => {
    mount();
    await ready();
    put.mockResolvedValue({ data: { spec: spec() } });
    fireEvent.change(screen.getByLabelText(/OBO\.Scope/), { target: { value: "ledger:write" } });
    fireEvent.change(screen.getByLabelText(/OBO\.ClientSecret/), { target: { value: "typed-value-1" } });
    fireEvent.click(screen.getByTestId("gr-save"));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0][1]).toEqual({ OBO: { Scope: "ledger:write", ClientSecret: "typed-value-1" } });
    expect(await screen.findByText(/Write-only values were sent once/)).toBeInTheDocument();
    expect(screen.getByLabelText(/OBO\.ClientSecret/)).toHaveValue("");
    expect(document.body.textContent).not.toContain("typed-value-1");
  });

  it("with nothing changed, Save sends nothing", async () => {
    mount();
    await ready();
    fireEvent.click(screen.getByTestId("gr-save"));
    expect(await screen.findByText("No changes to save.")).toBeInTheDocument();
    expect(put).not.toHaveBeenCalled();
  });

  it("shows the field and the rule of a refused edit, and not the value", async () => {
    mount();
    await ready();
    put.mockRejectedValue(Object.assign(new Error("HTTP 422"), { response: { status: 422, data: { errors: [{ field: "OBO.AuthMethod", message: "must be one of client_secret_basic, client_secret_post, private_key_jwt" }] } } }));
    fireEvent.change(screen.getByLabelText(/OBO\.Scope/), { target: { value: "x" } });
    fireEvent.click(screen.getByTestId("gr-save"));
    const box = await screen.findByTestId("gr-save-errors");
    expect(box).toHaveTextContent("OBO.AuthMethod");
    expect(box).toHaveTextContent("The spec was not changed");
  });

  it("unticking the Redeem leg sends Redeem: null and greys the leg-2 fields", async () => {
    mount();
    await ready();
    put.mockResolvedValue({ data: { spec: { OBO: { ...spec().OBO, Redeem: null } } } });
    fireEvent.click(screen.getByLabelText(/send the second leg/));
    expect(screen.getByLabelText(/OBO\.Redeem\.TokenURL/)).toBeDisabled();
    fireEvent.click(screen.getByTestId("gr-save"));
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(put.mock.calls[0][1]).toEqual({ OBO: { Redeem: null } });
  });
});

describe("a run shows what the server returned, not a constant", () => {
  it("fills legs, the API answer and the controls from the response", async () => {
    mount();
    await ready();
    fireEvent.click(screen.getByTestId("gr-run-happy"));
    expect(await screen.findByTestId("gr-verdict")).toHaveTextContent("As expected");
    expect(screen.getByTestId("gr-leg1")).toHaveTextContent("zed@mock.example");
    expect(screen.getByTestId("gr-leg2")).toHaveTextContent("https://target-api.mock.invalid/ledger");
    expect(screen.getByTestId("gr-target")).toHaveTextContent("it sees zed@mock.example, acting for agent-app");
    expect(screen.getByTestId("gr-controls")).toHaveTextContent("signature");
    expect(post.mock.calls[0]).toEqual([expect.stringMatching(/\/run$/), { scenario: "happy" }]);
  });

  it("a different response gives a different page (nothing is fixed text)", async () => {
    const other = run({ target: { status: 200, body: { principal: { sub: "ivy@mock.example" } } } });
    mount({ runs: { happy: other } });
    await ready();
    fireEvent.click(screen.getByTestId("gr-run-happy"));
    expect(await screen.findByTestId("gr-target")).toHaveTextContent("it sees ivy@mock.example");
    expect(screen.getByTestId("gr-target")).not.toHaveTextContent("zed@mock.example");
  });

  it("shows a refusal with its stage, check and description, and 'not as expected' when the verdict fails", async () => {
    const refused = run({
      leg2: null, redeemed: false, target: null, controls: [], hops: run().hops.slice(0, 2),
      refusal: { stage: "leg2", kind: "oauth", status: 400, error: "invalid_grant", check: "audience", description: "the ID-JAG aud is not this authorization server" },
      verdict: { pass: false, checks: [{ what: "outcome", want: "ok", got: "refused" }] },
    });
    mount({ runs: { happy: refused } });
    await ready();
    fireEvent.click(screen.getByTestId("gr-run-happy"));
    expect(await screen.findByTestId("gr-refusal")).toHaveTextContent("Refused at leg2: invalid_grant · check: audience");
    expect(screen.getByTestId("gr-verdict")).toHaveTextContent("Not as expected");
    expect(screen.queryByTestId("gr-leg2")).toBeNull();
  });

  it("says plainly when there is no second leg", async () => {
    mount({ runs: { happy: run({ leg2: null, redeemed: false, hops: run().hops.slice(0, 2), target: { status: 401, body: { error: "invalid_token" } } }) } });
    await ready();
    fireEvent.click(screen.getByTestId("gr-run-happy"));
    expect(await screen.findByTestId("gr-no-leg2")).toHaveTextContent("Redeem.TokenURL is not set");
  });

  it("every scenario has a Run button, and Run all ten runs them in order and marks each pass or fail from its verdict", async () => {
    mount({ runs: { "no-redeem": run({ scenario: "no-redeem", verdict: { pass: false, checks: [{ what: "stage", want: "target", got: "leg1" }] } }) } });
    await ready();
    fireEvent.click(screen.getByTestId("gr-run-all"));
    await waitFor(() => expect(screen.getByTestId("gr-result-no-redeem")).toBeInTheDocument());
    expect(post.mock.calls.map(([, b]) => b.scenario)).toEqual(["happy", "no-redeem"]);
    expect(screen.getByTestId("gr-result-happy")).toHaveTextContent("Pass");
    expect(screen.getByTestId("gr-result-no-redeem")).toHaveTextContent("Fail: stage leg1");
  });

  it("shows the trace with one trace id and a traceparent on every hop", async () => {
    mount();
    await ready();
    fireEvent.click(screen.getByTestId("gr-run-happy"));
    const trace = await screen.findByTestId("gr-trace");
    expect(trace).toHaveTextContent("one trace id 0af7651916cd43dd8448eb211c80319c");
    expect(trace.querySelectorAll("details code").length).toBe(3);
    expect(trace.textContent).toContain("write-only");
  });
});

describe("Live mode", () => {
  it("says it is unavailable, why, and the buttons stay disabled", async () => {
    mount({ st: state({ available: false, reason: "Live mode is not available for gateway redeem: the 2026-11-02 release is not on our tenant." }) });
    const note = await screen.findByTestId("gr-live-unavailable");
    expect(note).toHaveTextContent("not on our tenant");
    expect(note).toHaveTextContent("Switch the header toggle to Mock");
    for (const id of ["gr-run-happy", "gr-save", "gr-reset-spec", "gr-run-all"]) expect(screen.getByTestId(id)).toBeDisabled();
  });
});

describe("a server without the API", () => {
  it("says so instead of drawing a broken form", async () => {
    get.mockResolvedValue({ data: "<html></html>" });
    render(<GatewayRedeemPanel />);
    expect(await screen.findByRole("alert")).toHaveTextContent("does not have the gateway redeem API");
  });
});

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const { get, post, put, del } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() }));
vi.mock("../../services/api", () => ({ default: { get, post, put, delete: del } }));

import TrustedIdpsPage from "../TrustedIdpsPage";

const API = "/api/id-jag-playground/trusted-idps";
const USER = { email: "olivia@pingidentity.com", name: "Olivia", isAdmin: false };
const ADMIN = { email: "ada@pingidentity.com", name: "Ada", isAdmin: true };
const ENTRY = {
  id: "acme", name: "Acme PingFederate", product: "pingfederate", issuer: "https://acme.example.com", jwksUrl: "https://acme.example.com/pf/JWKS",
  idJagClientId: "acme-agent", clientId: "idp-acme", pfClientId: "id-jag-redeemer", scopes: "read mcp:invoke", targets: ["resource-as"],
  status: "approved", owner: USER.email, reviewReason: null, secretIssuedAt: null,
};

function mount(me, routes = {}) {
  get.mockImplementation((url) => {
    if (url === "/api/me") return Promise.resolve(me ? { status: 200, data: me } : { status: 401, data: { error: "not_signed_in" } });
    const hit = Object.entries(routes).find(([k]) => url === k || url.startsWith(`${k}?`));
    return Promise.resolve({ status: 200, data: hit ? (typeof hit[1] === "function" ? hit[1](url) : hit[1]) : {} });
  });
  return render(<TrustedIdpsPage />);
}

beforeEach(() => { get.mockReset(); post.mockReset(); put.mockReset(); del.mockReset(); });

describe("Trusted IdPs page", () => {
  it("asks a signed-out visitor to sign in, and shows no tabs", async () => {
    const assign = vi.fn();
    const orig = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { ...orig, assign, pathname: "/trusted-idps" } });
    try {
      mount(null);
      const seen = [];
      const claim = (e) => { e.detail.handled = true; seen.push({ kind: e.detail.kind, returnTo: e.detail.returnTo }); };
      window.addEventListener("idjag:signin", claim);
      try {
        fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
      } finally {
        window.removeEventListener("idjag:signin", claim);
      }
      expect(seen).toEqual([{ kind: "app", returnTo: "/trusted-idps" }]);
      expect(assign).not.toHaveBeenCalled();
      expect(screen.queryByRole("tab")).toBeNull();
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: orig });
    }
  });

  it("shows only My IdPs to a non-admin, with status badges and the review note", async () => {
    mount(USER, { [`${API}/mine`]: { idps: [ENTRY, { ...ENTRY, id: "beta", name: "Beta", status: "rejected", reviewReason: "three RSA keys" }] } });
    expect(await screen.findByText("Acme PingFederate")).toBeInTheDocument();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["My IdPs"]);
    expect(screen.getByText("Approved")).toBeInTheDocument();
    expect(screen.getByText("Rejected")).toBeInTheDocument();
    expect(screen.getByText("three RSA keys")).toBeInTheDocument();
  });

  it("registers an IdP: product hints, discovery fills the JWKS URL, Test this IdP warns, submit posts pending", async () => {
    mount(USER, { [`${API}/mine`]: { idps: [] } });
    fireEvent.click(await screen.findByRole("button", { name: "Register an IdP" }));
    const form = screen.getByRole("form", { name: "Register an IdP" });
    fireEvent.click(within(form).getByRole("radio", { name: "Okta" }));
    expect(within(form).getByTestId("kc-product-hint")).toHaveTextContent(/org authorization server/i);
    fireEvent.change(within(form).getByLabelText("Id (slug)"), { target: { value: "acme" } });
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Acme Okta" } });
    fireEvent.change(within(form).getByLabelText("Issuer"), { target: { value: "https://acme.okta.com" } });

    post.mockImplementation((url) => Promise.resolve({ data: url.endsWith("/discover")
      ? { issuer: "https://acme.okta.com", jwksUrl: "https://acme.okta.com/oauth2/v1/keys", metadataUrl: "https://acme.okta.com/.well-known/openid-configuration" }
      : { keyCount: 2, distinctRsaKeys: 2, withKid: 2, withX5t: 0, keys: [{ kty: "RSA", alg: "RS256", kid: "a" }, { kty: "RSA", alg: "RS256", kid: "b" }],
        warnings: ["2 distinct RSA keys. PingFederate's JWT-bearer consumer cannot pick a key by x5t; publish a single-key JWKS."] } }));
    fireEvent.click(within(form).getByRole("button", { name: "Discover JWKS" }));
    await waitFor(() => expect(within(form).getByLabelText("JWKS URL")).toHaveValue("https://acme.okta.com/oauth2/v1/keys"));
    expect(post).toHaveBeenCalledWith(`${API}/discover`, { issuer: "https://acme.okta.com" });

    fireEvent.change(within(form).getByLabelText("client_id your IdP writes in the ID-JAG"), { target: { value: "0oa-agent" } });
    fireEvent.click(within(form).getByRole("checkbox", { name: "Our PingFederate" }));
    fireEvent.click(within(form).getByRole("button", { name: "Test this IdP" }));
    expect(await within(form).findByText(/cannot pick a key by x5t/)).toBeInTheDocument();
    expect(post).toHaveBeenCalledWith(`${API}/test`, { jwksUrl: "https://acme.okta.com/oauth2/v1/keys", targets: ["resource-as", "pingfederate"] });

    post.mockResolvedValue({ data: { ...ENTRY, status: "pending" } });
    fireEvent.click(within(form).getByRole("button", { name: "Submit for review" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(API, expect.objectContaining({
      id: "acme", name: "Acme Okta", product: "okta", issuer: "https://acme.okta.com", jwksUrl: "https://acme.okta.com/oauth2/v1/keys",
      idJagClientId: "0oa-agent", targets: ["resource-as", "pingfederate"],
    })));
  });

  it("editing an approved entry warns that trust changes go back to review, and PUTs", async () => {
    mount(USER, { [`${API}/mine`]: { idps: [ENTRY] } });
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const form = screen.getByRole("form", { name: "Edit acme" });
    expect(within(form).getByLabelText("Id (slug)")).toBeDisabled();
    expect(within(form).getByText(/back to review/)).toBeInTheDocument();
    put.mockResolvedValue({ data: ENTRY });
    fireEvent.click(within(form).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(put).toHaveBeenCalledWith(`${API}/acme`, expect.objectContaining({ name: "Acme PingFederate", product: "pingfederate" })));
  });

  it("shows the client secret once after the owner asks for it", async () => {
    mount(USER, { [`${API}/mine`]: { idps: [ENTRY] } });
    post.mockResolvedValue({ data: { clientId: "idp-acme", clientSecret: "s3cr3t-value-shown-once" } });
    fireEvent.click(await screen.findByRole("button", { name: "Get client secret" }));
    expect(await screen.findByLabelText("Client secret")).toHaveValue("s3cr3t-value-shown-once");
    expect(post).toHaveBeenCalledWith(`${API}/acme/secret`, {});
    fireEvent.click(screen.getByRole("button", { name: "I stored it" }));
    expect(screen.queryByLabelText("Client secret")).toBeNull();
    expect(screen.queryByDisplayValue("s3cr3t-value-shown-once")).toBeNull();
  });

  it("withdraw needs an in-page confirm", async () => {
    mount(USER, { [`${API}/mine`]: { idps: [ENTRY] } });
    del.mockResolvedValue({ data: null });
    fireEvent.click(await screen.findByRole("button", { name: "Withdraw" }));
    expect(del).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm withdraw" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith(`${API}/acme`));
  });

  it("admin review queue: approve, and reject only with a reason", async () => {
    const pending = { ...ENTRY, status: "pending", owner: "oscar@pingone.com", updatedAt: "2026-10-18T09:00:00.000Z" };
    mount(ADMIN, { [`${API}/mine`]: { idps: [] }, [`${API}/all`]: { idps: [{ ...ENTRY, id: "old", name: "Old" }, pending, { ...pending, id: "zeta", name: "Zeta" }] } });
    fireEvent.click(await screen.findByRole("tab", { name: "Review queue" }));
    const panel = await screen.findByRole("tabpanel");
    expect(await within(panel).findByText("2 waiting for review")).toBeInTheDocument();
    const card = within(panel).getAllByRole("listitem")[0]; // pending first
    expect(within(card).getByText("oscar@pingone.com")).toBeInTheDocument();
    post.mockResolvedValue({ data: {} });
    fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
    // the approval names the version the admin reviewed
    await waitFor(() => expect(post).toHaveBeenCalledWith(`${API}/acme/approve`, { updatedAt: "2026-10-18T09:00:00.000Z" }));

    const reject = within(card).getByRole("button", { name: "Reject" });
    expect(reject).toBeDisabled();
    fireEvent.change(within(card).getByLabelText("Reason (the owner sees it)"), { target: { value: "use a single-key JWKS" } });
    fireEvent.click(reject);
    await waitFor(() => expect(post).toHaveBeenCalledWith(`${API}/acme/reject`, { reason: "use a single-key JWKS" }));
    // the queue reloads after each review (initial + approve + reject)
    await waitFor(() => expect(get.mock.calls.filter(([u]) => u === `${API}/all`)).toHaveLength(3));
  });

  it("admin audit log lists changes newest first and pages back", async () => {
    const event = (action, extra = {}) => ({ at: "2026-10-18T10:00:00.000Z", actor: ADMIN.email, action, id: "acme", ...extra });
    mount(ADMIN, {
      [`${API}/mine`]: { idps: [] },
      [`${API}/audit`]: (url) => (url.includes("before=")
        ? { entries: [event("create", { actor: USER.email })], next: null }
        : { entries: [event("update", { before: { jwksUrl: "https://a/1", status: "approved" }, after: { jwksUrl: "https://a/2", status: "pending" } })], next: 1 }),
    });
    fireEvent.click(await screen.findByRole("tab", { name: "Audit log" }));
    expect(await screen.findByText("jwksUrl: https://a/1 → https://a/2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load older" }));
    expect(await screen.findByText(USER.email)).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith(`${API}/audit?before=1`);
    expect(screen.queryByRole("button", { name: "Load older" })).toBeNull();
  });

  it("tabs follow the arrow keys", async () => {
    mount(ADMIN, { [`${API}/mine`]: { idps: [] }, [`${API}/all`]: { idps: [] } });
    const mine = await screen.findByRole("tab", { name: "My IdPs" });
    fireEvent.keyDown(mine, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Review queue" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Review queue" })).toHaveFocus();
    expect(await screen.findByText("0 waiting for review")).toBeInTheDocument();
  });
});

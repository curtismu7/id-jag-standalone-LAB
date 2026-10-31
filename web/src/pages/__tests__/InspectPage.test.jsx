import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import terms from "../../data/terms.json";

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("../../services/api", () => ({ default: { get, post } }));

import InspectPage, { CHECK_TERMS } from "../InspectPage";

const DECODED = {
  type: "id-jag", header: { typ: "oauth-id-jag+jwt" }, claims: { iss: "https://pf.test", jti: "j1" }, idp: { id: "pf", name: "SE PingFederate" },
  checks: [
    { id: "typ", label: "Header typ", status: "pass", expected: "oauth-id-jag+jwt", actual: "oauth-id-jag+jwt", cite: "draft §3.1" },
    { id: "lifetime", label: "Short-lived", status: "warn", expected: "<= 300 s", actual: "600 s", cite: "vendors" },
    { id: "replay", label: "jti not redeemed before", status: "fail", expected: "not seen", actual: "already accepted", cite: "RFC 7523" },
  ],
};
const DISCOVERY = { backends: [
  { id: "resource-as", label: "Resource AS", url: "https://as.test/.well-known/oauth-authorization-server", data: { issuer: "https://as.test" },
    profileFields: { authorization_grant_profiles_supported: true, scopes_supported: false } },
  { id: "mcp", label: "MCP server", url: "https://mcp.test/.well-known/oauth-protected-resource", error: "no answer within 4 s" },
] };
const EVENTS = { available: true, events: [
  { at: "2026-10-20T10:41:08.000Z", decision: "accepted", client_id: "agent", scope: "read", jti: "abcd1234…" },
  { at: "2026-10-20T10:41:31.000Z", decision: "refused", error: "invalid_grant", reason: "already redeemed", client_id: "agent", jti: "abcd1234…" },
] };

beforeEach(() => {
  get.mockReset(); post.mockReset();
  get.mockImplementation(async (url) => ({ status: 200, data: url.endsWith("/discovery") ? DISCOVERY : EVENTS }));
  post.mockResolvedValue({ status: 200, data: DECODED });
});

describe("Inspector page", () => {
  it("links every check to a glossary term that exists", () => {
    for (const t of Object.values(CHECK_TERMS)) expect(terms.map((x) => x.id)).toContain(t);
  });

  it("decodes a pasted token and shows each check with its status and glossary link", async () => {
    render(<InspectPage />);
    fireEvent.change(screen.getByLabelText("Token"), { target: { value: " a.b.c " } });
    fireEvent.click(screen.getByRole("button", { name: "Decode and check" }));
    await waitFor(() => expect(screen.getByText(/Detected: ID-JAG/)).toBeInTheDocument());
    expect(post).toHaveBeenCalledWith("/api/inspect/decode", { token: "a.b.c" });
    expect(screen.getByText("Header typ")).toBeInTheDocument();
    expect(screen.getByText(/Warning/)).toBeInTheDocument();
    expect(screen.getByText(/Fail/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ID-JAG" })).toHaveAttribute("href", "/learn#term-id-jag");
    expect(screen.getByRole("link", { name: "jti replay protection" })).toHaveAttribute("href", "/learn#term-jti-replay");
  });

  it("says plainly when the token is not recognised or the server refuses it", async () => {
    post.mockRejectedValue({ response: { data: { message: "Paste a token" } }, message: "HTTP 400" });
    render(<InspectPage />);
    fireEvent.change(screen.getByLabelText("Token"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Decode and check" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Paste a token");
  });

  it("shows discovery JSON per backend, the profile-fields note and a down backend", async () => {
    render(<InspectPage />);
    fireEvent.click(screen.getByText("Backends (discovery metadata)"));
    expect(await screen.findByText(/"issuer": "https:\/\/as.test"/)).toBeInTheDocument();
    expect(screen.getByText(/no answer within 4 s/)).toBeInTheDocument();
    expect(screen.getByText((_, el) => el.tagName === "LI" && /scopes_supported.*not published/.test(el.textContent))).toBeInTheDocument();
  });

  it("keeps discovery out of the tab row and collapsed by default", () => {
    render(<InspectPage />);
    expect(screen.queryByRole("tab", { name: "Discovery" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Live log" })).toBeInTheDocument();
    expect(screen.getByText("Backends (discovery metadata)").closest("details")).not.toHaveAttribute("open");
  });

  it("gets an ID-JAG through the playground issue route, then checks the session's token", async () => {
    post.mockImplementation(async (url) => ({ status: 200, data: url.endsWith("/issue") ? { response: { access_token: "[the ID-JAG, kept server-side]" }, token: {} } : DECODED }));
    render(<InspectPage />);
    fireEvent.click(screen.getByRole("button", { name: "Get an ID-JAG" }));
    await waitFor(() => expect(screen.getByText(/Detected: ID-JAG/)).toBeInTheDocument());
    expect(post).toHaveBeenNthCalledWith(1, "/api/id-jag-playground/issue", {});
    expect(post).toHaveBeenNthCalledWith(2, "/api/inspect/decode", { fromSession: true });
    expect(screen.getByLabelText("Token")).toHaveValue("");
    expect(screen.getByLabelText("Token")).toHaveAttribute("placeholder", expect.stringContaining("held on the server"));
    expect(screen.getByRole("button", { name: "Decode and check" })).toBeEnabled();
    expect(screen.getByText("or paste a token from another tool")).toBeInTheDocument();
  });

  it("reveals the raw ID-JAG only on Show token, with Copy, and hides it again on a new mint", async () => {
    const writeText = vi.fn().mockResolvedValue();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    post.mockImplementation(async (url, body) => ({ status: 200, data: url.endsWith("/issue") ? {} : body.reveal ? { token: "raw.jwt.value" } : DECODED }));
    render(<InspectPage />);
    expect(screen.queryByRole("button", { name: "Show token" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Get an ID-JAG" }));
    await screen.findByText(/Detected: ID-JAG/);
    expect(screen.queryByDisplayValue("raw.jwt.value")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show token" }));
    const box = await screen.findByDisplayValue("raw.jwt.value");
    expect(box).toHaveAttribute("readonly");
    expect(post).toHaveBeenLastCalledWith("/api/inspect/decode", { fromSession: true, reveal: true });
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith("raw.jwt.value");
    fireEvent.click(screen.getByRole("button", { name: "Get an ID-JAG" }));
    await waitFor(() => expect(screen.queryByDisplayValue("raw.jwt.value")).not.toBeInTheDocument());
  });

  it("says plainly when there is nothing to reveal", async () => {
    post.mockImplementation(async (url, body) => {
      if (body.reveal) throw { response: { data: { message: "No ID-JAG has been issued in this session yet." } }, message: "HTTP 409" };
      return { status: 200, data: url.endsWith("/issue") ? {} : DECODED };
    });
    render(<InspectPage />);
    fireEvent.click(screen.getByRole("button", { name: "Get an ID-JAG" }));
    await screen.findByText(/Detected: ID-JAG/);
    fireEvent.click(screen.getByRole("button", { name: "Show token" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No ID-JAG has been issued");
  });

  it("says Sign in first, with a link, when there is no issuer sign-in", async () => {
    post.mockRejectedValue({ response: { status: 409, data: { error: "sign_in_required", message: "Sign in at PingFederate (issuer) first (step 1)" } }, message: "HTTP 409" });
    render(<InspectPage />);
    fireEvent.click(screen.getByRole("button", { name: "Get an ID-JAG" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Sign in first");
    expect(alert).not.toHaveTextContent("sign_in_required");
    expect(screen.getByRole("link", { name: /playground sign-in/i })).toHaveAttribute("href", "/");
  });

  it("lists the resource AS decisions and filters them", async () => {
    render(<InspectPage />);
    fireEvent.click(screen.getByRole("tab", { name: "Live log" }));
    expect(await screen.findByText(/already redeemed/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Redeem" }));
    expect(screen.queryByText(/already redeemed/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Denied" }));
    expect(screen.getByText(/already redeemed/)).toBeInTheDocument();
  });
});

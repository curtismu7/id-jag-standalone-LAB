import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import SignInModal from "../SignInModal";
import { signIn, signInIssuer } from "../../utils/signIn";

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
let assign;
let origLocation;

beforeEach(() => {
  assign = vi.fn();
  origLocation = window.location;
  Object.defineProperty(window, "location", { configurable: true, value: { ...origLocation, pathname: "/here", assign } });
});
afterEach(() => {
  Object.defineProperty(window, "location", { configurable: true, value: origLocation });
  vi.unstubAllGlobals();
});

const stubFetch = (...replies) => {
  const f = vi.fn();
  replies.forEach((r) => (r instanceof Error ? f.mockRejectedValueOnce(r) : f.mockResolvedValueOnce(r)));
  vi.stubGlobal("fetch", f);
  return f;
};
const START = reply(200, { flowId: "flow-123", status: "USERNAME_PASSWORD_REQUIRED" });

async function open(kind = "app", ...replies) {
  const f = stubFetch(START, ...replies);
  render(<SignInModal />);
  act(() => { (kind === "app" ? signIn : signInIssuer)("/back"); });
  await screen.findByRole("dialog");
  return f;
}
const fill = (user, pw) => {
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: user } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: pw } });
};
async function submit(user = "ada", pw = "pw") {
  fill(user, pw);
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

describe("signIn events", () => {
  it("only logs, and never navigates, when no modal handles the event", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    signIn("/a b");
    signInIssuer("/x");
    expect(assign).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledTimes(2);
    err.mockRestore();
  });

  it("defaults the app sign-in return_to to the current path", async () => {
    const f = stubFetch(START);
    render(<SignInModal />);
    act(() => { signIn(); });
    await screen.findByRole("dialog");
    expect(f.mock.calls[0][0]).toBe("/auth/pi-flow/start?return_to=%2Fhere");
  });
});

describe("SignInModal", () => {
  it("opens on the event and starts the app endpoint", async () => {
    const f = await open("app");
    expect(f).toHaveBeenCalledWith("/auth/pi-flow/start?return_to=%2Fback", { credentials: "include" });
    expect(assign).not.toHaveBeenCalled();
  });

  it("starts the issuer endpoint for the issuer kind", async () => {
    const f = await open("issuer");
    expect(f.mock.calls[0][0]).toBe("/api/id-jag-playground/issuer/pi-flow/start?return_to=%2Fback");
  });

  it("pre-fills the login_hint username and puts focus in Password", async () => {
    stubFetch(reply(200, { flowId: "flow-123", status: "USERNAME_PASSWORD_REQUIRED", loginHint: "demouser" }));
    render(<SignInModal />);
    act(() => { signInIssuer("/back"); });
    await screen.findByRole("dialog");
    expect(screen.getByLabelText("Username")).toHaveValue("demouser");
    expect(screen.getByLabelText("Password")).toHaveFocus();
  });

  it("is an accessible modal dialog with focus in Username", async () => {
    await open();
    const d = screen.getByRole("dialog");
    expect(d).toHaveAttribute("aria-modal", "true");
    expect(d).toHaveAccessibleName("Sign in");
    expect(screen.getByLabelText("Username")).toHaveFocus();
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("Password")).toHaveAttribute("autocomplete", "current-password");
  });

  it("posts the credentials and navigates to redirectTo", async () => {
    const f = await open("app", reply(200, { redirectTo: "http://app/auth/callback?code=c&state=s" }));
    await submit("ada", "pw");
    await waitFor(() => expect(assign).toHaveBeenCalledWith("http://app/auth/callback?code=c&state=s"));
    expect(f.mock.calls[1][0]).toBe("/auth/pi-flow/credentials");
    expect(f.mock.calls[1][1]).toMatchObject({ method: "POST", credentials: "include", body: '{"username":"ada","password":"pw"}' });
  });

  it("posts the issuer credentials to the issuer endpoint", async () => {
    const f = await open("issuer", reply(200, { redirectTo: "http://app/cb?code=c&state=s" }));
    await submit();
    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(f.mock.calls[1][0]).toBe("/api/id-jag-playground/issuer/pi-flow/credentials");
  });

  it("shows the 401 message, clears the password and stays open", async () => {
    await open("app", reply(401, { error: "invalid_credentials", message: "Username or password is incorrect." }));
    await submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("Username or password is incorrect.");
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(screen.getByLabelText("Password")).toHaveFocus();
    expect(screen.getByLabelText("Username")).toHaveValue("ada");
    expect(assign).not.toHaveBeenCalled();
  });

  it.each([
    ["fallback", reply(200, { fallback: true, status: "MFA_REQUIRED" }), /needs a step the kit's sign-in cannot show/],
    ["unsupported_state", reply(409, { error: "unsupported_state" }), /needs a step the kit's sign-in cannot show/],
    ["409", reply(409, { error: "pi_flow_not_started" }), /did not complete/],
    ["502", reply(502, { error: "pi_flow_failed" }), /did not complete/],
    ["network error", new Error("down"), /Could not reach the server/],
  ])("shows a message and a Close button on %s, and never navigates", async (_n, r, msg) => {
    await open("app", r);
    await submit();
    expect(await screen.findByRole("alert")).toHaveTextContent(msg);
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(assign).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says too many attempts on 429 and does not redirect", async () => {
    await open("app", reply(429, { error: "too_many_attempts" }));
    await submit();
    expect(await screen.findByRole("alert")).toHaveTextContent(/too many attempts/i);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it.each([
    ["409 pi_flow_unavailable", reply(409, { error: "pi_flow_unavailable" }), /PingFederate did not open a sign-in flow.*Sign-in limits/],
    ["502 pi_flow_unavailable", reply(502, { error: "pi_flow_unavailable" }), /PingFederate did not open a sign-in flow/],
    ["503 not_configured", reply(503, { error: "not_configured" }), /not configured/],
    ["409 not_configured naming keys", reply(409, { error: "not_configured", missing: ["PF_URL", "ACME_PF_URL"] }), /set PF_URL, ACME_PF_URL/],
    ["409 byo_mode", reply(409, { error: "byo_mode", message: "Your IdP issues the ID-JAG: no sign-in here." }), /Your IdP issues the ID-JAG/],
    ["a plain 409 with a body message", reply(409, { message: "Something the server said." }), /Something the server said\./],
    ["a 200 with no flowId", reply(200, {}), /did not complete/],
    ["network error", new Error("down"), /Could not reach the server/],
  ])("shows the message in the dialog and never navigates when start answers %s", async (_n, r, msg) => {
    stubFetch(r);
    render(<SignInModal />);
    act(() => signIn("/back"));
    expect(await screen.findByRole("alert")).toHaveTextContent(msg);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    expect(assign).not.toHaveBeenCalled();
  });

  it("shows the 409 body message from the issuer start, not a navigation", async () => {
    const f = stubFetch(reply(409, { error: "byo_mode", message: "Your IdP issues the ID-JAG: no sign-in here." }));
    render(<SignInModal />);
    act(() => signInIssuer("/back"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your IdP issues the ID-JAG: no sign-in here.");
    expect(f.mock.calls[0][0]).toBe("/api/id-jag-playground/issuer/pi-flow/start?return_to=%2Fback");
    expect(assign).not.toHaveBeenCalled();
  });

  it("Escape cancels without navigating and restores focus", async () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    await open();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
    expect(assign).not.toHaveBeenCalled();
    trigger.remove();
  });

  it("never renders the password as text", async () => {
    await open("app", reply(401, { message: "no" }));
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "s3cretpw" } });
    expect(screen.getByRole("dialog")).not.toHaveTextContent("s3cretpw");
    expect(document.body.textContent).not.toContain("s3cretpw"); // only the masked input holds it
  });

  it("ignores a second submit while one is in flight", async () => {
    let finish;
    const f = await open("app");
    f.mockImplementationOnce(() => new Promise((r) => { finish = r; }));
    fill("ada", "pw");
    const form = screen.getByLabelText("Username").closest("form");
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(f).toHaveBeenCalledTimes(2); // start + one credentials post
    await act(async () => finish(reply(200, { redirectTo: "/done" })));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/done"));
  });

  it("handles a second sign-in event while the first start is in flight without navigating", async () => {
    let finish;
    const f = stubFetch();
    f.mockImplementationOnce(() => new Promise((r) => { finish = r; }));
    render(<SignInModal />);
    act(() => { signIn("/back"); signIn("/back"); });
    expect(assign).not.toHaveBeenCalled();
    await act(async () => finish(START));
    await screen.findByRole("dialog");
    expect(f).toHaveBeenCalledTimes(1);
    expect(assign).not.toHaveBeenCalled();
  });

  it("ignores a sign-in event while a credentials post is in flight without navigating", async () => {
    const f = await open("app");
    f.mockImplementationOnce(() => new Promise(() => {}));
    fill("ada", "pw");
    fireEvent.submit(screen.getByLabelText("Username").closest("form"));
    act(() => { signIn("/back"); });
    expect(assign).not.toHaveBeenCalled();
  });

  it("is framed by the shared FloatingDialog (movable title bar, no pop-out) and Escape still closes it", async () => {
    await open();
    const d = screen.getByRole("dialog");
    expect(within(d).getByTestId("fd-titlebar")).toHaveTextContent("Sign in");
    expect(within(d).queryByRole("button", { name: "Pop out to a new window" })).toBeNull();
    fireEvent.keyDown(screen.getByLabelText("Username"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(assign).not.toHaveBeenCalled();
  });

  it("Escape cancels even when focus is outside the dialog", async () => {
    await open();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps Tab inside the dialog", async () => {
    await open();
    screen.getByRole("button", { name: "Sign in" }).focus();
    fireEvent.keyDown(document.body, { key: "Tab" });
    expect(screen.getByLabelText("Username")).toHaveFocus();
    fireEvent.keyDown(document.body, { key: "Tab", shiftKey: true });
    expect(screen.getByRole("button", { name: "Sign in" })).toHaveFocus();
  });

  it.each([
    ["redirectTo", () => reply(200, { redirectTo: "/done" })],
    ["a 502", () => reply(502, { error: "pi_flow_failed" })],
  ])("a cancelled sign-in ignores the late %s", async (_n, late) => {
    let finish;
    const f = await open("app");
    f.mockImplementationOnce(() => new Promise((r) => { finish = r; }));
    fill("ada", "pw");
    fireEvent.submit(screen.getByLabelText("Username").closest("form"));
    fireEvent.keyDown(document.body, { key: "Escape" });
    await act(async () => finish(late()));
    expect(assign).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

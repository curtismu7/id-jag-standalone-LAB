import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import AppShell from "../../AppShell";
import SignInModal from "../../components/SignInModal";
import { signIn } from "../../utils/signIn";
import { ModeProvider } from "../ModeContext";
import { ModeBanner, ModeToggle } from "../ModeToggle";

const MOCK = {
  mode: "mock", live: { ready: false, missing: ["PF_URL", "PF_EXCHANGE_CLIENT_ID", "PF_EXCHANGE_CLIENT_SECRET"] },
  mockUser: { username: "alice@mock.example", password: "mock-password" }, signin: { allowed: true },
};
const MOCK_READY = { ...MOCK, live: { ready: true, missing: [] } };
const LIVE = { mode: "live", live: { ready: true, missing: [] } };
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(JSON.stringify(body)), json: () => Promise.resolve(body) });

/** fetch by URL: /api/mode answers `mode` (and POSTs go to `post`), everything else is a 401/404 like a server with nobody signed in. */
function stub({ mode = MOCK, post } = {}) {
  const f = vi.fn((url, init = {}) => {
    if (url === "/api/mode") {
      if (init.method === "POST") return Promise.resolve(post ? post(JSON.parse(init.body)) : reply(200, mode));
      return mode instanceof Error ? Promise.reject(mode) : Promise.resolve(reply(200, mode));
    }
    return Promise.resolve(reply(url === "/api/me" ? 401 : 404, {}));
  });
  vi.stubGlobal("fetch", f);
  return f;
}
const posts = (f) => f.mock.calls.filter(([u, i]) => u === "/api/mode" && i?.method === "POST");
const wrap = (reload = vi.fn()) => render(<ModeProvider reload={reload}><ModeToggle /><ModeBanner /></ModeProvider>);
const button = (name) => screen.getByRole("button", { name });

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("mock mode", () => {
  it("marks Mock as on (aria-pressed) and the banner as mock (data-state)", async () => {
    stub();
    wrap();
    await waitFor(() => expect(button("Mock")).toHaveAttribute("aria-pressed", "true"));
    expect(button("Live")).toHaveAttribute("aria-pressed", "false");
    const banner = screen.getByTestId("mode-banner");
    expect(banner).toHaveAttribute("data-state", "mock");
    expect(banner).toHaveTextContent("MOCK");
    expect(banner).toHaveTextContent("Nothing leaves this machine");
    expect(screen.getByRole("group", { name: "Mock or live" })).toBeInTheDocument();
  });

  it("explains what Live needs instead of failing silently, and does not call the server", async () => {
    const f = stub();
    wrap();
    await waitFor(() => expect(button("Mock")).toHaveAttribute("aria-pressed", "true"));
    const live = button("Live");
    expect(live).toHaveAttribute("aria-disabled", "true");
    expect(live).not.toBeDisabled(); // still focusable, so a keyboard user hears why
    expect(live).toHaveAccessibleDescription(/Live is not available yet: set PF_URL, PF_EXCHANGE_CLIENT_ID, PF_EXCHANGE_CLIENT_SECRET in \.env/);
    fireEvent.click(live);
    expect(posts(f)).toHaveLength(0);
  });

  it("says why mock sign-in is off", async () => {
    stub({ mode: { ...MOCK, signin: { allowed: false, message: "Mock sign-in is off. Start the server with ALLOW_MOCK_SIGNIN=1 to use the built-in demo account." } } });
    wrap();
    expect(await screen.findByText(/ALLOW_MOCK_SIGNIN=1/)).toBeInTheDocument();
  });
});

describe("switching", () => {
  it("posts the mode, then reloads (the server ended the sessions)", async () => {
    const f = stub({ mode: MOCK_READY, post: () => reply(200, LIVE) });
    const reload = vi.fn();
    wrap(reload);
    await waitFor(() => expect(button("Live")).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(button("Live"));
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(posts(f)).toHaveLength(1);
    expect(JSON.parse(posts(f)[0][1].body)).toEqual({ mode: "live" });
    expect(posts(f)[0][1]).toMatchObject({ credentials: "same-origin" });
    expect(button("Live")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("mode-banner")).toHaveAttribute("data-state", "live");
    expect(screen.getByTestId("mode-banner")).toHaveTextContent("Tokens are real");
  });

  it("clicking the mode that is already on does nothing", async () => {
    const f = stub();
    wrap();
    await waitFor(() => expect(button("Mock")).toHaveAttribute("aria-pressed", "true"));
    fireEvent.click(button("Mock"));
    expect(posts(f)).toHaveLength(0);
  });

  it("shows the server's reason when it refuses, and does not reload", async () => {
    stub({ mode: MOCK_READY, post: () => reply(409, { error: "live_not_configured", message: "Live needs PingFederate settings first: set PF_URL" }) });
    const reload = vi.fn();
    wrap(reload);
    await waitFor(() => expect(button("Live")).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(button("Live"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Live needs PingFederate settings first: set PF_URL");
    expect(reload).not.toHaveBeenCalled();
    expect(button("Mock")).toHaveAttribute("aria-pressed", "true");
  });

  it("is a live page that never looks simulated: the banner says LIVE and Mock can be chosen again", async () => {
    stub({ mode: LIVE });
    wrap();
    await waitFor(() => expect(button("Live")).toHaveAttribute("aria-pressed", "true"));
    const banner = screen.getByTestId("mode-banner");
    expect(banner).toHaveAttribute("data-state", "live");
    expect(banner).toHaveTextContent("LIVE");
    expect(banner).not.toHaveTextContent("Nothing leaves this machine");
    expect(button("Mock")).not.toHaveAttribute("aria-disabled");
  });
});

describe("when the server cannot be read", () => {
  it("shows an unknown state and disables the switch, rather than guessing", async () => {
    stub({ mode: new Error("down") });
    wrap();
    await waitFor(() => expect(screen.getByTestId("mode-banner")).toHaveTextContent("Could not read the mode"));
    expect(screen.getByTestId("mode-banner")).toHaveAttribute("data-state", "unknown");
    expect(button("Mock")).toBeDisabled();
    expect(button("Live")).toBeDisabled();
  });

  it("treats an answer that is not a mode as unreadable", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(reply(200, { email: "ada@example.com" }))));
    wrap();
    await waitFor(() => expect(screen.getByTestId("mode-banner")).toHaveAttribute("data-state", "unknown"));
  });
});

describe("on every page", () => {
  it("the app shell carries the toggle and the banner, in presenter mode too", async () => {
    localStorage.setItem("idjag.present", "1");
    stub();
    render(<AppShell><p>any page</p></AppShell>);
    await waitFor(() => expect(button("Mock")).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByTestId("mode-banner")).toHaveAttribute("data-state", "mock");
    expect(document.documentElement.dataset.present).toBe("1");
    expect(screen.getByRole("toolbar", { name: "Presenter controls" })).toBeInTheDocument();
    expect(screen.getByTestId("mode-banner").closest("[data-admin-only]")).toBeNull(); // presenter mode hides admin things, never this
    expect(within(screen.getByRole("banner")).getByRole("group", { name: "Mock or live" })).toBeInTheDocument();
  });
});

describe("sign-in dialog", () => {
  async function openDialog(mode) {
    const f = vi.fn((url, init = {}) => {
      if (url === "/api/mode") return Promise.resolve(reply(200, mode));
      if (String(url).startsWith("/auth/pi-flow/start")) return Promise.resolve(reply(200, { flowId: "flow-123", status: "USERNAME_PASSWORD_REQUIRED" }));
      return Promise.resolve(reply(404, {}));
    });
    vi.stubGlobal("fetch", f);
    render(<ModeProvider><SignInModal /></ModeProvider>);
    await waitFor(() => expect(f).toHaveBeenCalledWith("/api/mode", expect.anything()));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    act(() => { signIn("/back"); });
    return screen.findByRole("dialog");
  }

  it("shows the demo account in mock mode, so nobody has to look it up", async () => {
    const dialog = await openDialog(MOCK);
    expect(within(dialog).getByTestId("signin-mock-hint")).toHaveTextContent("alice@mock.example / mock-password");
  });

  it("shows nothing of the kind in live mode", async () => {
    const dialog = await openDialog(LIVE);
    expect(within(dialog).queryByTestId("signin-mock-hint")).toBeNull();
  });
});

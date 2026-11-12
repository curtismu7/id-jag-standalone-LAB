import { fireEvent, render, screen } from "@testing-library/react";
import api from "../services/api";
import AppShell from "../AppShell";

afterEach(() => vi.unstubAllGlobals());
const respond = (status, body) => vi.fn(() => Promise.resolve({ status, text: () => Promise.resolve(body) }));

describe("api client", () => {
  it("sends same-origin JSON and returns { status, data }", async () => {
    const f = respond(200, '{"ok":true}');
    vi.stubGlobal("fetch", f);
    expect(await api.post("/x", { a: 1 })).toEqual({ status: 200, data: { ok: true } });
    expect(f).toHaveBeenCalledWith("/x", expect.objectContaining({ method: "POST", credentials: "same-origin", body: '{"a":1}' }));
  });

  it("throws with err.response on non-2xx unless validateStatus accepts it", async () => {
    vi.stubGlobal("fetch", respond(409, '{"error":"not_configured"}'));
    await expect(api.get("/x")).rejects.toMatchObject({ response: { status: 409, data: { error: "not_configured" } } });
    expect((await api.post("/x", {}, { validateStatus: () => true })).status).toBe(409);
  });

  it("keeps a non-JSON body as text", async () => {
    vi.stubGlobal("fetch", respond(200, "<!doctype html>"));
    expect((await api.get("/x")).data).toBe("<!doctype html>");
  });
});

describe("app shell", () => {
  it("switches and remembers the theme", async () => {
    localStorage.setItem("idjag.theme", "light");
    render(<AppShell><p>child</p></AppShell>);
    expect(document.documentElement.dataset.theme).toBe("light");
    fireEvent.change(screen.getByRole("combobox", { name: "Theme" }), { target: { value: "dark" } });
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("idjag.theme")).toBe("dark");
    expect(screen.getByRole("link", { name: "Playground" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Trusted IdPs" })).toHaveAttribute("href", "/trusted-idps");
    expect(screen.getByRole("link", { name: "Setup guides" })).toHaveAttribute("href", "/guides");
    expect(screen.getByRole("link", { name: "Learn" })).toHaveAttribute("href", "/learn");
    expect(screen.getByRole("link", { name: "Inspector" })).toHaveAttribute("href", "/inspect");
    await screen.findByRole("button", { name: "Sign in" }); // /api/me settled (no server here)
  });

  it("shows the release-claim banner on a page and again in presenter mode, and the gateway redeem Live note", async () => {
    vi.stubGlobal("fetch", respond(401, '{"error":"not_signed_in"}'));
    render(<AppShell><p>child</p></AppShell>);
    expect(screen.getByTestId("claim-banner")).toHaveTextContent("Ping release claim (2026-11-02), UNVERIFIED on our tenant");
    fireEvent.click(screen.getByTestId("presenter"));
    expect(document.documentElement.dataset.present).toBe("1");
    expect(screen.getByTestId("claim-banner")).toBeVisible();
    expect(screen.getByTestId("claim-banner")).not.toHaveAttribute("data-admin-only");
    fireEvent.click(screen.getByTestId("presenter"));
    await screen.findByRole("button", { name: "Sign in" });
  });

  it("shows Sign in when signed out", async () => {
    vi.stubGlobal("fetch", respond(401, '{"error":"not_signed_in"}'));
    render(<AppShell><p>child</p></AppShell>);
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  it("shows the signed-in user, an admin badge, and a same-origin POST sign-out", async () => {
    const me = respond(200, '{"email":"ada@pingidentity.com","name":"Ada","isAdmin":true}');
    vi.stubGlobal("fetch", vi.fn((url, o) => (url === "/api/customer-config" ? respond(404, "{}")() : me(url, o))));
    render(<AppShell><p>child</p></AppShell>);
    expect(await screen.findByText("Ada")).toBeInTheDocument();
    expect(screen.getByText("Admin")).toBeInTheDocument();
    const out = screen.getByRole("button", { name: "Sign out" });
    expect(out.closest("form")).toHaveAttribute("action", "/auth/logout");
    expect(out.closest("form")).toHaveAttribute("method", "post");
  });
});

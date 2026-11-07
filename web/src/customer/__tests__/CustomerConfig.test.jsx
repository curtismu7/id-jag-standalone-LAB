import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import AppShell from "../../AppShell";
import StoryPanel from "../../story/StoryPanel";
import { fill } from "../../story/fill";

const serve = (body, status = 200) => vi.stubGlobal("fetch", vi.fn((url) => (
  url === "/api/customer-config"
    ? Promise.resolve({ status, text: () => Promise.resolve(JSON.stringify(body)) })
    : Promise.resolve({ status: 401, text: () => Promise.resolve("{}") }))));
const root = () => document.documentElement.style;

beforeEach(() => { try { localStorage.clear(); } catch { /* none */ } });
afterEach(() => { vi.unstubAllGlobals(); root().cssText = ""; });

describe("fill() persona", () => {
  const vertical = { cast: { lena: { name: "Lena" } }, vocab: {} };
  it("overrides a cast name and leaves the rest alone", () => {
    expect(fill("{{lena}} and {{mark}}", vertical, { lena: "Priya" })).toBe("Priya and ⟨missing: mark⟩");
    expect(fill("{{lena}}", vertical)).toBe("Lena");
  });
});

describe("customer config in the shell", () => {
  it("shows the customer name and applies brand variables", async () => {
    serve({ name: "Northwind Bank", brand: { primary: "#0b6bcb", headerStart: "#0a2540", headerEnd: "#12395f" } });
    render(<AppShell><p>child</p></AppShell>);
    expect(await screen.findByText("Northwind Bank")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Ping Identity" })).toBeInTheDocument();
    // The name is painted by the render; the brand variables are set by a passive effect that React flushes afterwards.
    // Wait for the effect's own result: asserting right after the text appears raced it, and lost when the machine was busy.
    await waitFor(() => expect(root().getPropertyValue("--ping-red")).toBe("#0b6bcb"));
    expect(root().getPropertyValue("--brand-header")).toContain("#0a2540");
  });

  it("shows a same-origin logo beside the Ping logo", async () => {
    serve({ name: "Northwind", brand: { logoUrl: "/branding/northwind.png" } });
    const { container } = render(<AppShell><p>child</p></AppShell>);
    await screen.findByText("Northwind");
    expect(container.querySelector('.shell-brand img[src="/branding/northwind.png"]')).not.toBeNull();
  });

  it("keeps the Ping defaults when the brand colour is unreadable on both themes", async () => {
    serve({ name: "Grey Co", brand: { primary: "#808080" } });
    render(<AppShell><p>child</p></AppShell>);
    await screen.findByText("Grey Co");
    expect(root().getPropertyValue("--ping-red")).toBe("");
  });

  it.each([["an error", () => vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("down"))))],
    ["an empty config", () => serve({})],
    ["a non-JSON answer (the SPA fallback page)", () => vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ status: 200, text: () => Promise.resolve("<!doctype html>") })))],
  ])("renders the defaults on %s", async (_n, setup) => {
    setup();
    render(<AppShell><p>child</p></AppShell>);
    expect(screen.getByText("ID-JAG Kit")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("child")).toBeInTheDocument());
    expect(root().getPropertyValue("--ping-red")).toBe("");
  });
});

describe("customer config in the story panel", () => {
  it("uses the customer's persona names", async () => {
    serve({ persona: { lena: "Priya" } });
    render(<AppShell><StoryPanel mode="byo" /></AppShell>);
    expect(await screen.findByRole("heading", { name: /Priya reads shared data from Acme/ })).toBeInTheDocument();
    expect(screen.queryByText(/Lena/)).toBeNull();
  });

  it("opens on the customer's vertical", async () => {
    serve({ vertical: "healthcare" });
    render(<AppShell><StoryPanel mode="byo" /></AppShell>);
    await waitFor(() => expect(screen.getByLabelText("Vertical")).toHaveValue("healthcare"));
  });

  it("lets the viewer's own pick win over the customer's vertical, and survive a reload", async () => {
    localStorage.setItem("idjag.story.vertical", "retail");
    serve({ vertical: "healthcare" });
    const { unmount } = render(<AppShell><StoryPanel mode="byo" /></AppShell>);
    await screen.findByLabelText("Vertical");
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByLabelText("Vertical")).toHaveValue("retail");
    fireEvent.change(screen.getByLabelText("Vertical"), { target: { value: "banking" } });
    unmount();
    serve({ vertical: "healthcare" });
    render(<AppShell><StoryPanel mode="byo" /></AppShell>);
    expect(screen.getByLabelText("Vertical")).toHaveValue("banking");
  });

  it("falls back to generic for a vertical id this build does not have", async () => {
    serve({ vertical: "mining" });
    render(<AppShell><StoryPanel mode="byo" /></AppShell>);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByLabelText("Vertical")).toHaveValue("generic");
  });
});

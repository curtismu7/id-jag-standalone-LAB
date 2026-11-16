import { render, screen, within } from "@testing-library/react";
import AppShell from "../AppShell";

// The header shows this lab's own Verified / In progress mark, read from the same /api/shelf call the Shelf link makes (through the lab-proxy that
// call reaches the shelf, whose payload lists every demo with its mark). The lab's own /api/shelf has no demos, so there is no mark then.
afterEach(() => vi.unstubAllGlobals());

const mark = (status, label, extra = {}) => ({ status, label, note: "", updatedAt: "2026-11-15", source: "shipped", ...extra });
const json = (status, body) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) });
function withShelf(payload) {
  vi.stubGlobal("fetch", vi.fn((url) => (url === "/api/shelf" ? json(200, payload) : json(401, { error: "not_signed_in" }))));
}
const header = async () => within(await screen.findByTestId("top-menu"));

describe("verification mark in the header", () => {
  it("shows this lab's own mark beside the Shelf link, and no other lab's", async () => {
    withShelf({ shelfUrl: "http://shelf.example", demos: [
      { id: "other-lab", verification: mark("in-progress", "In progress") },
      { id: "id-jag-standalone", verification: mark("verified", "Verified", { note: "Every playground mode run on the mock" }) },
    ] });
    render(<AppShell><p>child</p></AppShell>);
    const bar = await header();
    expect(await bar.findByText("Verified")).toBeInTheDocument();
    expect(await bar.findByRole("link", { name: "Shelf" })).toBeInTheDocument();
    expect(bar.queryByText("In progress")).toBeNull();
    expect(document.querySelectorAll(".verify")).toHaveLength(1);
    expect(bar.getByText("Verified").closest(".verify")).toHaveAttribute("title", expect.stringContaining("Every playground mode run on the mock"));
  });

  it("shows nothing when the lab is opened on its own port (its /api/shelf has no demos) or the shelf has no mark for it", async () => {
    for (const payload of [{ shelfUrl: "http://shelf.example" }, { shelfUrl: "http://shelf.example", demos: [{ id: "id-jag-standalone", verification: null }] }]) {
      withShelf(payload);
      const { unmount } = render(<AppShell><p>child</p></AppShell>);
      const bar = await header();
      expect(await bar.findByRole("link", { name: "Shelf" })).toBeInTheDocument(); // the shelf answered, and still no badge
      expect(document.querySelector(".verify")).toBeNull();
      unmount();
    }
  });
});

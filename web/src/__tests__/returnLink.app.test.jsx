// Opened from Customer Agent LAB: the strip sits right below the simulation banner and a compact Back button sits in the shell bar.
// Strip only: UC-LEARN8, UC-LEARN9, UC25 and UC40 are the whole playground, so nothing is preselected.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import AppShell from "../AppShell";

const respond = (status, body) => vi.fn(() => Promise.resolve({ status, text: () => Promise.resolve(body) }));
const mode = '{"mode":"mock","live":{"ready":false,"missing":[]}}';
beforeEach(() => vi.stubGlobal("fetch", vi.fn((url) => (url === "/api/mode" ? respond(200, mode)() : respond(401, '{"error":"not_signed_in"}')()))));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });

describe("return link", () => {
  it("?from=customer-agent: strip right below the simulation banner, Back in the shell bar, direct URL at the root", async () => {
    window.history.replaceState(null, "", "/?from=customer-agent&uc=UC40&vertical=banking");
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, pathname: "/", search: "?from=customer-agent&uc=UC40&vertical=banking", assign });
    render(<AppShell><p>child</p></AppShell>);
    const strip = screen.getByRole("note", { name: "Opened from Customer Agent LAB" });
    expect(strip).toHaveTextContent("UC40");
    expect((await screen.findByTestId("mode-banner")).nextElementSibling).toBe(strip);
    expect(document.querySelector("header.shell-bar button.return-link--header")).not.toBeNull();
    const backs = screen.getAllByRole("button", { name: /Back to Customer Agent LAB/ });
    expect(backs).toHaveLength(2);
    fireEvent.click(backs[0]);
    expect(assign).toHaveBeenCalledWith("http://127.0.0.1:5603/?returned=id-jag-standalone&uc=UC40");
    await screen.findByRole("button", { name: "Sign in" });
  });

  it("behind the lab proxy (/id-jag-kit/): Back is the fixed proxy path on this origin", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, pathname: "/id-jag-kit/", search: "?from=customer-agent&uc=UC-LEARN9", assign });
    render(<AppShell><p>child</p></AppShell>);
    fireEvent.click(screen.getAllByRole("button", { name: /Back to Customer Agent LAB/ })[0]);
    expect(assign).toHaveBeenCalledWith("/customer-agent/?returned=id-jag-standalone&uc=UC-LEARN9");
    await screen.findByRole("button", { name: "Sign in" });
  });

  it("?from=ai-demo-standalone: the strip names AI Demo Standalone; behind the proxy Back goes to /ai-demo-standalone/", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, pathname: "/id-jag-kit/", search: "?from=ai-demo-standalone&uc=UC-LEARN9", assign });
    window.history.replaceState(null, "", "/?from=ai-demo-standalone&uc=UC-LEARN9");
    render(<AppShell><p>child</p></AppShell>);
    expect(screen.getByRole("note", { name: "Opened from AI Demo Standalone" }).textContent).toContain("UC-LEARN9");
    fireEvent.click(screen.getAllByRole("button", { name: /Back to AI Demo Standalone/ })[0]);
    expect(assign).toHaveBeenCalledWith("/ai-demo-standalone/?returned=id-jag-standalone&uc=UC-LEARN9");
  });

  it("no from, an unknown from or a bad id: no strip, no button", async () => {
    for (const q of ["/", "/?from=elsewhere&uc=UC40", "/?from=customer-agent&uc=a%20b", "/?from=customer-agent&uc=UC40&vertical=%3Cb%3E"]) {
      window.history.replaceState(null, "", q);
      render(<AppShell><p>child</p></AppShell>);
      expect(screen.queryByRole("note", { name: /Opened from/ })).toBeNull();
      expect(screen.queryByRole("button", { name: /Back to/ })).toBeNull();
      await screen.findByRole("button", { name: "Sign in" });
      cleanup();
    }
  });

  it("the vendored files match return-link.sha256, which names the parent commit", () => {
    const dir = path.join(process.cwd(), "src", "return-link");
    const text = fs.readFileSync(path.join(dir, "return-link.sha256"), "utf8");
    expect(text.split("\n")[0]).toMatch(/^# vendored byte for byte from curtismu7\/AI-DEMO-Standalone shared\/return-link at [0-9a-f]{7,40}/);
    const pins = text.split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(/\s+/));
    expect(pins.map(([, f]) => f).sort()).toEqual(["ReturnLink.jsx", "ReturnLink.test.jsx", "returnTargets.js"]);
    for (const [h, f] of pins) expect(createHash("sha256").update(fs.readFileSync(path.join(dir, f))).digest("hex"), f).toBe(h);
  });
});

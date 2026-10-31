import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import AppShell from "../../AppShell";
import StoryPanel from "../../story/StoryPanel";

const KEY = "idjag.present";
const respond = (status, body) => vi.fn(() => Promise.resolve({ status, text: () => Promise.resolve(body) }));
const Steps = ({ n = 3 }) => (
  <main>
    <input aria-label="field" />
    {Array.from({ length: n }, (_, i) => <section key={i} className="ijp-step"><h2 id={`ijp-step-${i + 1}`}>Step title {i + 1}</h2></section>)}
  </main>
);
const mount = (ui = <Steps />) => render(<AppShell>{ui}</AppShell>);
const dataset = () => document.documentElement.dataset.present;
const press = (key, target = document.body, init = {}) => fireEvent.keyDown(target, { key, ...init });
let scroll;

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, "", "/");
  vi.stubGlobal("fetch", respond(401, "{}"));
  scroll = vi.fn();
  Element.prototype.scrollIntoView = scroll;
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete document.documentElement.dataset.present; });

describe("present toggle", () => {
  it("turns on and off, sets data-present, and persists", () => {
    mount();
    expect(dataset()).toBeUndefined();
    const btn = screen.getByRole("button", { name: "Present" });
    fireEvent.click(btn);
    expect(dataset()).toBe("1");
    expect(btn).toHaveAttribute("aria-pressed", "true");
    expect(localStorage.getItem(KEY)).toBe("1");
    fireEvent.click(btn);
    expect(dataset()).toBeUndefined();
    expect(localStorage.getItem(KEY)).toBe("0");
  });

  it("starts on when it was left on", () => {
    localStorage.setItem(KEY, "1");
    mount();
    expect(dataset()).toBe("1");
  });

  it("starts on with ?present=1", () => {
    window.history.replaceState({}, "", "/?present=1");
    mount();
    expect(dataset()).toBe("1");
    expect(localStorage.getItem(KEY)).toBeNull(); // not written until toggled
  });

  it("still works when storage throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Present" }));
    expect(dataset()).toBe("1");
    vi.restoreAllMocks();
  });
});

describe("keys", () => {
  it("p toggles, but not while typing in a field", () => {
    mount();
    press("p");
    expect(dataset()).toBe("1");
    press("p");
    expect(dataset()).toBeUndefined();
    press("p", screen.getByLabelText("field"));
    expect(dataset()).toBeUndefined();
  });

  it("Escape leaves present mode and fullscreen, even from a field", () => {
    const exit = vi.fn(() => Promise.resolve());
    Object.defineProperty(document, "fullscreenElement", { value: {}, configurable: true });
    document.exitFullscreen = exit;
    mount();
    press("p");
    press("Escape", screen.getByLabelText("field"));
    expect(dataset()).toBeUndefined();
    expect(exit).toHaveBeenCalled();
    expect(screen.queryByTestId("present-count")).toBeNull();
    delete document.fullscreenElement; delete document.exitFullscreen;
  });

  it("the Fullscreen button requests fullscreen, and is disabled where unsupported", () => {
    mount();
    press("p");
    expect(screen.getByRole("button", { name: "Fullscreen" })).toBeDisabled();
    cleanup(); localStorage.clear(); delete document.documentElement.dataset.present;
    const req = vi.fn(() => Promise.resolve());
    document.documentElement.requestFullscreen = req;
    mount();
    press("p");
    fireEvent.click(screen.getByRole("button", { name: "Fullscreen" }));
    expect(req).toHaveBeenCalled();
    delete document.documentElement.requestFullscreen;
  });
});

describe("step counter", () => {
  const count = () => screen.getByTestId("present-count").textContent;

  it("counts the steps on the page and stops at both ends", async () => {
    mount();
    press("p");
    await waitFor(() => expect(count()).toBe("Step 1 of 3"));
    const prev = screen.getByRole("button", { name: "Previous" });
    const next = screen.getByRole("button", { name: "Next" });
    expect(prev).toBeDisabled();
    fireEvent.click(next); fireEvent.click(next);
    expect(count()).toBe("Step 3 of 3");
    expect(next).toBeDisabled();
    fireEvent.click(next);
    expect(count()).toBe("Step 3 of 3");
    fireEvent.click(prev);
    expect(count()).toBe("Step 2 of 3");
  });

  it("scrolls to and highlights the matching step, and announces it", async () => {
    mount();
    press("p");
    await waitFor(() => expect(count()).toBe("Step 1 of 3"));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(scroll).toHaveBeenLastCalledWith({ behavior: "smooth", block: "start" });
    expect(document.getElementById("ijp-step-2").closest("section")).toHaveAttribute("data-step-active");
    expect(document.getElementById("ijp-step-1").closest("section")).not.toHaveAttribute("data-step-active");
    expect(screen.getByRole("status")).toHaveTextContent("Step 2 of 3: Step title 2");
  });

  it("arrow keys move, but not inside a field and not when presenting is off", async () => {
    mount();
    press("ArrowRight");
    press("p");
    await waitFor(() => expect(count()).toBe("Step 1 of 3"));
    press("ArrowRight", screen.getByLabelText("field"));
    expect(count()).toBe("Step 1 of 3");
    press("ArrowRight");
    expect(count()).toBe("Step 2 of 3");
    press("ArrowLeft");
    expect(count()).toBe("Step 1 of 3");
    press("ArrowLeft");
    expect(count()).toBe("Step 1 of 3");
  });

  it("follows steps that appear or disappear", async () => {
    const { rerender } = mount(<Steps n={3} />);
    press("p");
    await waitFor(() => expect(count()).toBe("Step 1 of 3"));
    rerender(<AppShell><Steps n={2} /></AppShell>);
    await waitFor(() => expect(count()).toBe("Step 1 of 2"));
  });

  it("does not smooth-scroll under prefers-reduced-motion", async () => {
    vi.stubGlobal("matchMedia", (q) => ({ matches: q.includes("reduce"), addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
    mount();
    press("p");
    await waitFor(() => expect(count()).toBe("Step 1 of 3"));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(scroll).toHaveBeenLastCalledWith({ behavior: "auto", block: "start" });
  });
});

describe("story panel sync", () => {
  const withStory = <><StoryPanel mode="byo" /><Steps n={5} /></>;
  const current = () => document.querySelector(".story__steps .is-current .story__step");

  it("keeps the panel open and the counter and panel agree both ways", async () => {
    localStorage.setItem("idjag.story.open", "closed");
    mount(withStory);
    expect(screen.queryByText("Goal")).toBeNull();
    press("p");
    expect(screen.getByText("Goal")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide talk track" })).toBeDisabled();
    await waitFor(() => expect(screen.getByTestId("present-count")).toHaveTextContent("Step 1 of 5"));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(current()).toHaveTextContent(/^2/);
    fireEvent.click(screen.getAllByRole("button").find((b) => b.classList.contains("story__step") && b.textContent.startsWith("4")));
    expect(screen.getByTestId("present-count")).toHaveTextContent("Step 4 of 5");
    expect(current()).toHaveTextContent(/^4/);
    press("Escape");
    expect(screen.queryByText("Goal")).toBeNull(); // the closed choice comes back
  });
});

describe("admin-only contract", () => {
  it("the shell tags the Admin badge and the Trusted IdPs and Setup guides links, not Sign out", async () => {
    vi.stubGlobal("fetch", respond(200, '{"email":"ada@x.com","name":"Ada","isAdmin":true}'));
    mount();
    expect(await screen.findByText("Admin")).toHaveAttribute("data-admin-only");
    expect(screen.getByRole("link", { name: "Trusted IdPs" })).toHaveAttribute("data-admin-only");
    expect(screen.getByRole("link", { name: "Setup guides" })).toHaveAttribute("data-admin-only");
    for (const name of ["Playground", "Inspector", "Learn"]) expect(screen.getByRole("link", { name })).not.toHaveAttribute("data-admin-only");
    expect(screen.getByRole("button", { name: "Sign out" }).closest("[data-admin-only]")).toBeNull();
  });

  it("the stylesheet hides data-admin-only only under data-present", async () => {
    const css = (await import("node:fs")).readFileSync(`${process.cwd()}/src/present/present.css`, "utf8");
    expect(css).toMatch(/:root\[data-present="1"\] \[data-admin-only\] \{ display: none; \}/);
    expect(css).not.toMatch(/^\[data-admin-only\]/m);
  });
  // jsdom has no layout, so assert the stylesheet keeps scrolled-to step headings clear of the sticky bar.
  it("offsets step headings below the sticky present bar", async () => {
    const css = (await import("node:fs")).readFileSync(`${process.cwd()}/src/present/present.css`, "utf8");
    expect(css).toMatch(/\.present-bar \{[^}]*position: sticky; top: 0/);
    expect(css).toMatch(/:root\[data-present="1"\] \[id\^="ijp-step-"\] \{ scroll-margin-top: var\(--present-bar-h\); \}/);
    const rem = parseFloat(css.match(/--present-bar-h:\s*([\d.]+)rem/)[1]);
    expect(rem * 16).toBeGreaterThanOrEqual(54);
  });
});

import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { act, render } from "@testing-library/react";
import IdJagPlaygroundDiagramPage, { READABLE_MIN_ZOOM } from "../IdJagPlaygroundDiagramPage";
import { PLAYGROUND_DIAGRAM_MODES, playgroundDiagramPath } from "../../utils/idJagPlaygroundDiagrams";

// ReactFlow itself is real; the wrapper records the zoom limits the page asks it for, counts its fit-view calls, and lets a test
// say whether React Flow reports the boxes as measured.
const asked = [];
const fits = [];
let initialized = true;
vi.mock("@xyflow/react", async (orig) => {
  const m = await orig();
  return {
    ...m,
    ReactFlow: (props) => { asked.push({ minZoom: props.minZoom, maxZoom: props.maxZoom }); return createElement(m.ReactFlow, props); },
    useNodesInitialized: () => initialized,
    useReactFlow: () => { const rf = m.useReactFlow(); return { ...rf, fitView: (...a) => { fits.push(a); return rf.fitView(...a); } }; },
  };
});

const css = fs.readFileSync(path.resolve(process.cwd(), "src/pages/IdJagPlaygroundDiagramPage.css"), "utf8");
// font-size (rem) of every rule that styles text inside a diagram card (the title, the subtitle, the lines)
const cardFontRem = () => {
  const rules = [...css.matchAll(/(\.ijx \.(?:ct|cs|card ul))\s*\{[^}]*?font-size:\s*([\d.]+)rem/g)];
  return Object.fromEntries(rules.map((r) => [r[1], Number(r[2])]));
};

describe("diagram text stays readable at every zoom the page allows", () => {
  it("reads the real card font sizes from the CSS (title, subtitle, lines), none missing", () => {
    expect(Object.keys(cardFontRem()).sort()).toEqual([".ijx .card ul", ".ijx .cs", ".ijx .ct"]);
  });

  it("the smallest card text is at least 10px on screen at the lowest zoom", () => {
    const smallestPx = Math.min(...Object.values(cardFontRem())) * 16;
    expect(smallestPx * READABLE_MIN_ZOOM).toBeGreaterThanOrEqual(10);
  });

  it.each(PLAYGROUND_DIAGRAM_MODES)("%s: ReactFlow is given that floor as its minimum zoom", (mode) => {
    asked.length = 0;
    window.history.pushState({}, "", playgroundDiagramPath(mode));
    const { unmount } = render(<IdJagPlaygroundDiagramPage />);
    expect(asked.length).toBeGreaterThan(0);
    for (const a of asked) expect(a.minZoom).toBe(READABLE_MIN_ZOOM);
    unmount();
    window.history.pushState({}, "", "/");
  });
});

describe("dragging a box does not refit the view", () => {
  afterEach(() => { vi.useRealTimers(); initialized = true; window.history.pushState({}, "", "/"); });
  const settle = () => act(() => { vi.advanceTimersByTime(700); });

  it("the step's fit runs when the boxes first count as measured, not again when React Flow re-reports them after a drop", () => {
    vi.useFakeTimers();
    window.history.pushState({}, "", playgroundDiagramPath("mock"));
    initialized = false;
    fits.length = 0;
    const { rerender } = render(<IdJagPlaygroundDiagramPage />);
    settle();
    const onMount = fits.length;
    initialized = true; rerender(<IdJagPlaygroundDiagramPage />); settle();
    expect(fits.length, "first measured: the deep-link fit").toBe(onMount + 1);
    // a drop hands React Flow new node objects: measured reads false, then true again
    initialized = false; rerender(<IdJagPlaygroundDiagramPage />); settle();
    initialized = true; rerender(<IdJagPlaygroundDiagramPage />); settle();
    expect(fits.length, "no refit after the blip").toBe(onMount + 1);
  });
});

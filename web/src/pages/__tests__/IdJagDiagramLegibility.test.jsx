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
// Every rule in the stylesheet that sets a font size on text inside a diagram card: the card itself, its title (.ct), subtitle (.cs), and any
// descendant (`.card ul`, `.card li`, `.card b`, `.k-red .cs`, a rule inside @media ...). Returns [{ selector, px }]; px is null when the size is
// in a unit this check cannot turn into pixels (em, %, a keyword), so such a rule fails the test instead of slipping through.
const CARD_PART = /(^|[\s>+~])(\.card|\.ct|\.cs)(?![\w-])|\.react-flow__node/;
export function cardFontSizes(cssText) {
  const out = [];
  for (const [, sel, body] of cssText.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const parts = sel.split(",").map((x) => x.trim()).filter((x) => CARD_PART.test(x));
    if (!parts.length) continue;
    for (const [, v] of body.matchAll(/(?:^|;)\s*font-size\s*:\s*([^;]+)/g)) {
      const m = /^([\d.]+)(rem|px)\b/.exec(v.trim());
      out.push({ selector: parts.join(", "), px: m ? Number(m[1]) * (m[2] === "rem" ? 16 : 1) : null, value: v.trim() });
    }
    // the `font` shorthand sets a size too: `font: inherit` sets none, anything with a size in it is read like font-size
    for (const [, v] of body.matchAll(/(?:^|;)\s*font\s*:\s*([^;]+)/g)) {
      if (/^(inherit|initial|unset|revert)$/i.test(v.trim())) continue;
      const m = /(?:^|\s)([\d.]+)(rem|px)\b/.exec(v);
      out.push({ selector: parts.join(", "), px: m ? Number(m[1]) * (m[2] === "rem" ? 16 : 1) : null, value: v.trim() });
    }
  }
  return out;
}
const tooSmall = (rules) => rules.filter((r) => r.px === null || r.px * READABLE_MIN_ZOOM < 10);

describe("diagram text stays readable at every zoom the page allows", () => {
  it("reads the real card font sizes from the CSS (title, subtitle, lines), none missing", () => {
    expect(cardFontSizes(css).map((r) => r.selector).sort()).toEqual([".ijx .card ul", ".ijx .cs", ".ijx .ct"]);
  });

  it("every font size set on text inside a card is at least 10px on screen at the lowest zoom", () => {
    expect(tooSmall(cardFontSizes(css))).toEqual([]);
  });

  it("the check catches a smaller rule added anywhere inside a card (a descendant, a shorthand, a media query, a minified rule, an unreadable unit)", () => {
    expect(tooSmall(cardFontSizes(css))).toHaveLength(0);
    for (const extra of [
      ".card li{font-size:.4rem}",
      ".ijx .card ul li { font-size: 6px; }",
      ".ijx .card b{font:700 .5rem/1.2 Montserrat}",
      "@media (max-width:600px){.ijx .cs{font-size:.5rem}}",
      ".ijx .k-red .ct,.ijx .k-red .cs{font-size:.3rem}",
      ".ijx .card ul{font-size:.8em}",
      ".ijx .react-flow__node *{font-size:.2rem}",
    ]) {
      expect(tooSmall(cardFontSizes(`${css}\n${extra}`)).length, extra).toBeGreaterThan(0);
    }
    // text outside a card is not this test's business
    expect(tooSmall(cardFontSizes(`${css}\n.ijx .detail pre{font-size:.4rem}`))).toHaveLength(0);
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

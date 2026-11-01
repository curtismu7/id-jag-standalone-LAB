import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { act, render } from "@testing-library/react";
import IdJagPlaygroundDiagramPage, { READABLE_MIN_ZOOM } from "../IdJagPlaygroundDiagramPage";
import { PLAYGROUND_DIAGRAMS, PLAYGROUND_DIAGRAM_MODES, playgroundDiagramPath } from "../../utils/idJagPlaygroundDiagrams";
import { parseRules, scanCardCss, tooSmall } from "./cardCssScan";

// ReactFlow itself is real; the wrapper records the zoom limits the page asks it for, counts its fit-view calls, and lets a test
// say whether React Flow reports the boxes as measured.
const asked = [];
const fits = [];
let initialized = true;
vi.mock("@xyflow/react", async (orig) => {
  const m = await orig();
  return {
    ...m,
    ReactFlow: (props) => { asked.push({ minZoom: props.minZoom, maxZoom: props.maxZoom, autoPanOnNodeDrag: props.autoPanOnNodeDrag, nodesDraggable: props.nodesDraggable, panOnDrag: props.panOnDrag }); return createElement(m.ReactFlow, props); },
    useNodesInitialized: () => initialized,
    useReactFlow: () => { const rf = m.useReactFlow(); return { ...rf, fitView: (...a) => { fits.push(a); return rf.fitView(...a); } }; },
  };
});

// Every stylesheet the web app ships, not only this page's: Vite bundles them all into one, so a rule in any of them can reach a card.
const srcDir = path.resolve(process.cwd(), "src");
const cssFiles = fs.readdirSync(srcDir, { recursive: true }).filter((f) => f.endsWith(".css")).sort();
const css = cssFiles.map((f) => fs.readFileSync(path.join(srcDir, f), "utf8")).join("\n");
const KINDS = [...new Set(PLAYGROUND_DIAGRAM_MODES.flatMap((m) => PLAYGROUND_DIAGRAMS[m].nodes.map((n) => n.kind)))];

describe("diagram text stays readable at every zoom the page allows", () => {
  // The scan asks the DOM about a real rendered card with its real ancestors. The page's markup is copied under <body> once, so it stays
  // attached when Testing Library cleans up after each test.
  let card, fixture;
  beforeAll(() => {
    window.history.pushState({}, "", playgroundDiagramPath("mock"));
    const { container, unmount } = render(<IdJagPlaygroundDiagramPage />);
    fixture = container.querySelector(".ijx").cloneNode(true);
    unmount();
    document.body.appendChild(fixture);
    card = fixture.querySelector(".card");
    window.history.pushState({}, "", "/");
  });
  afterAll(() => { fixture.remove(); });
  const scan = (extra = "") => scanCardCss(`${css}\n${extra}`, card, KINDS);
  const bad = (extra) => tooSmall(scan(extra), READABLE_MIN_ZOOM);

  it("scans the real stylesheets and finds the card's own font sizes (title, subtitle, items), none missing", () => {
    expect(KINDS.length).toBeGreaterThan(1);
    expect(cssFiles).toContain(path.join("pages", "IdJagPlaygroundDiagramPage.css"));
    const { findings, rootPx } = scan();
    expect(rootPx).toBe(16);
    const px = (sel) => findings.filter((f) => f.type === "font-size" && f.selector === sel).map((f) => f.px);
    expect(px(".ijx .ct")).toEqual([0.85 * 16]);
    expect(px(".ijx .cs")).toEqual([0.72 * 16]);
    expect(px(".ijx .card ul")).toEqual([0.72 * 16]);
  });

  it("reads every stylesheet the app ships, not only the diagram page's (the body size comes from standalone-ui.css)", () => {
    expect(cssFiles.length).toBeGreaterThan(3);
    expect(scan().findings.filter((f) => f.selector === "body").map((f) => f.px)).toContain(14);
  });

  it("the line is 10px on screen at the floor: 11.12px and up passes, 11.1px does not (rem follows the root size)", () => {
    expect(bad(".ijx .cs{font-size:11.12px}")).toEqual([]);
    expect(bad(".ijx .cs{font-size:11.1px}")).toHaveLength(1);
    expect(bad(".ijx .cs{font-size:.7rem}"), ".7rem is 11.2px at 16px per rem").toEqual([]);
    expect(bad(".ijx .cs{font-size:.69rem}"), ".69rem is 11.04px").toHaveLength(1);
    expect(bad("html{font-size:125%}\n.ijx .cs{font-size:.56rem}"), "a root of 125% is 20px, so .56rem is 11.2px").toEqual([]);
    expect(bad(".ijx .cs{font-size:.56rem}"), ".56rem is 8.96px at 16px per rem").toHaveLength(1);
  });

  it("every rule that can change card text is at least 10px on screen at the lowest zoom, and none zooms or scales it", () => {
    expect(bad()).toEqual([]);
  });

  // Each of these makes card text smaller on screen, in a way the first version of this check did not look at. All must fail it.
  it.each([
    [".card li", ".card li{font-size:.4rem}"],
    ["a descendant of the list", ".ijx .card ul li { font-size: 6px; }"],
    ["a shorthand", ".ijx .card li{font:700 .5rem/1.2 Montserrat}"],
    ["a shorthand with a size that cannot be read", ".ijx .card li{font:700 smaller/1.2 Montserrat}"],
    ["inside @media", "@media (max-width:600px){.ijx .cs{font-size:.5rem}}"],
    ["inside @supports inside @media", "@media print{@supports (display:grid){.ijx .ct{font-size:.5rem}}}"],
    ["a kind's own subtitle and title", ".ijx .k-red .ct,.ijx .k-red .cs{font-size:.3rem}"],
    ["a unit that cannot be read", ".ijx .card ul{font-size:.8em}"],
    ["a percentage", ".ijx .cs{font-size:70%}"],
    ["a keyword", ".ijx .cs{font-size:x-small}"],
    ["every node", ".ijx .react-flow__node *{font-size:.2rem}"],
    ["a kind's items", ".ijx .k-red li{font-size:.4rem}"],
    ["every item on the page", ".ijx li{font-size:.4rem}"],
    ["every list", ".ijx ul{font-size:.4rem}"],
    ["everything under the page", ".ijx *{font-size:.4rem}"],
    ["items of a lit card", ".ijx .on li{font-size:.4rem}"],
    ["items of a dimmed card", ".ijx .dim li{font-size:.4rem}"],
    ["items of a selected card", ".ijx .sel li{font-size:.4rem}"],
    ["an attribute selector", "[class~=card] li{font-size:.4rem}"],
    ["the root: every rem shrinks", ":root{font-size:8px}"],
    ["html: every rem shrinks", "html{font-size:50%}"],
    ["body, which the card inherits from", "body{font-size:6px}"],
    ["the page wrapper, which the card inherits from", ".ijx{font-size:6px}"],
    ["the pointer over a card", ".ijx .card:hover li{font-size:.4rem}"],
    ["a pseudo-element", ".ijx .card li::before{font-size:.4rem}"],
    ["zoom on the card", ".ijx .card{zoom:.5}"],
    ["zoom on a box's parent", ".ijx .react-flow__nodes{zoom:50%}"],
    ["zoom on the page", ".ijx{zoom:.8}"],
    ["a scale transform on the card", ".ijx .card{transform:scale(.5)}"],
    ["a scale among other transforms on a box", ".ijx .react-flow__node{transform:translate(2px,3px) scale(.7)}"],
    ["a matrix on the viewport", ".ijx .react-flow__viewport{transform:matrix(.5,0,0,.5,0,0)}"],
    ["the scale property on the page", ".ijx{scale:.6}"],
  ])("fails when a rule shrinks card text: %s", (_, extra) => {
    expect(bad(extra).length, extra).toBeGreaterThan(0);
  });

  // The helper itself: the ways a rule could hide from a scan that is only almost right.
  it.each([
    ["a selector the DOM cannot parse (read as matching)", ".ijx li:totally-made-up{font-size:.4rem}"],
    ["a comment before the declaration", ".cs{/* c */font-size:.4rem}"],
    ["a comment inside the selector list", ".x,/* c */.cs{font-size:.4rem}"],
    ["the card's selector second in a comma list", ".ijx .nothing,.ijx .cs{font-size:.4rem}"],
    ["the card's selector third in a comma list", ".ijx .a,.ijx .b,.ijx .ct{font-size:.4rem}"],
    ["the card's selector first in a comma list", ".ijx .cs,.ijx .nothing{font-size:.4rem}"],
    ["a comma inside :is()", ".ijx :is(.nothing,.cs){font-size:.4rem}"],
    ["an !important", ".ijx .cs{font-size:.4rem!important}"],
    ["no space or semicolon", ".ijx .cs{color:red;font-size:.4rem}"],
    ["a minified rule after another", ".ijx .a{color:red}.ijx .cs{font-size:.4rem}"],
  ])("the scan sees %s", (_, extra) => {
    expect(bad(extra).length, extra).toBeGreaterThan(0);
  });

  it("does not fail rules that cannot reach card text, or that are fine", () => {
    for (const extra of [
      ".ijx .detail pre{font-size:.4rem}",           // text outside a card
      ".ijx aside li{font-size:.4rem}",
      ".ijx .elabel{transform:scale(.5)}",           // a label, not a card or something above one
      ".ijx .nothing,.ijx .alsonothing{font-size:.4rem}",
      ".ijx .card{zoom:1}", ".ijx .card{transform:scale(1)}", ".ijx .card{transform:translate(2px,2px)}",
      ".ijx .cs{font-size:1rem}", ".ijx li{font-size:20px}",
      "/* .ijx .cs{font-size:.4rem} */",
    ]) expect(bad(extra), extra).toEqual([]);
    expect(parseRules("@keyframes k{from{font-size:1px}to{font-size:2px}}.a{color:red}")).toEqual([{ selector: ".a", body: "color:red" }]);
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

describe("holding a box near the canvas edge does not pan the view", () => {
  // React Flow pans the view by itself while a box is held near the edge of the canvas (autoPanOnNodeDrag, on by default). On a 343px phone canvas
  // almost every point is near an edge, so a 100px drag moved the view too and the box landed far from the pointer, often on another box.
  it.each(PLAYGROUND_DIAGRAM_MODES)("%s: boxes are draggable, the canvas does not pan while one is held, and dragging the background still pans", (mode) => {
    asked.length = 0;
    window.history.pushState({}, "", playgroundDiagramPath(mode));
    const { unmount } = render(<IdJagPlaygroundDiagramPage />);
    expect(asked.length).toBeGreaterThan(0);
    for (const a of asked) {
      expect(a.nodesDraggable).toBe(true);
      expect(a.autoPanOnNodeDrag).toBe(false);
      expect(a.panOnDrag, "panning by dragging the background is React Flow's default and stays on").not.toBe(false);
    }
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

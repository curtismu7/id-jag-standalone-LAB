import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import IdJagPlaygroundDiagramPage, { READABLE_MIN_ZOOM } from "../IdJagPlaygroundDiagramPage";
import { PLAYGROUND_DIAGRAMS, PLAYGROUND_DIAGRAM_MODES, playgroundDiagramPath } from "../../utils/idJagPlaygroundDiagrams";
import { appStylesheets, lengthPx, normalizeSelector, parseRules, scanCardCss, tooSmall } from "./cardCssScan";
import { ATTACKS, HARMLESS } from "./cardCssVariants";

// ReactFlow itself is real; the wrapper records the zoom limits the page asks it for, counts its fit-view calls, and lets a test
// say whether React Flow reports the boxes as measured.
const asked = [];
const fits = [];
let initialized = true;
vi.mock("@xyflow/react", async (orig) => {
  const m = await orig();
  return {
    ...m,
    ReactFlow: (props) => { asked.push({ fitViewOptions: props.fitViewOptions, minZoom: props.minZoom, maxZoom: props.maxZoom, autoPanOnNodeDrag: props.autoPanOnNodeDrag, nodesDraggable: props.nodesDraggable, panOnDrag: props.panOnDrag }); return createElement(m.ReactFlow, props); },
    useNodesInitialized: () => initialized,
    useReactFlow: () => { const rf = m.useReactFlow(); return { ...rf, fitView: (...a) => { fits.push(a); return rf.fitView(...a); } }; },
  };
});

// Every stylesheet the web app ships, not only this page's: Vite bundles them all into one, so a rule in any of them can reach a card. That is every .css
// under src, every .css a script imports or another .css @imports (inside web/, not node_modules), and what index.html links or writes in <style>.
const { files: cssFiles, css } = appStylesheets(process.cwd());
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
    expect(cssFiles).toContain(path.join("src", "pages", "IdJagPlaygroundDiagramPage.css"));
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

  // The ways to hide a small size or a shrink from a scan that only looks at the page as it is rendered right now (table in cardCssVariants.js).
  it.each(ATTACKS)("fails when card text is made small by: %s", (_, extra) => {
    expect(bad(extra).length, extra).toBeGreaterThan(0);
  });
  it.each(HARMLESS)("does not fail: %s", (_, extra) => {
    expect(bad(extra), extra).toEqual([]);
  });

  it("every card state is tried: a rule for a selected or dragged node, or a lit, dimmed or selected card, is read (the page's own markup carries none of those)", () => {
    for (const extra of [".ijx .react-flow__node.selected .cs{font-size:.4rem}", ".ijx .react-flow__node.dragging li{font-size:.4rem}", ".ijx .card.on.sel li{font-size:.4rem}", ".ijx .card.dim .ct{font-size:.4rem}", ".ijx .card.k-red .cs{font-size:.4rem}"]) expect(bad(extra).length, extra).toBeGreaterThan(0);
  });

  it("every declaration of a rule is read, not only the first of each property", () => {
    expect(bad(".ijx .cs{font-size:12px;font-size:.4rem}")).toHaveLength(1);
    expect(bad(".ijx .cs{font-size:.4rem;font-size:12px}")).toHaveLength(1);
    expect(bad(".ijx .cs{zoom:1;zoom:.5}")).toHaveLength(1);
    expect(bad(".ijx .cs{transform:none;transform:scale(.5)}")).toHaveLength(1);
  });

  it("the root's size follows the state it is set in: the presenter scale in the stylesheets is read, and a smaller one fails", () => {
    expect(scan().rootPx).toBe(16);
    expect(scan(":root{--present-scale:.4}").rootPx).toBeCloseTo(6.4, 6);
    expect(scan(':root[data-present="1"]{font-size:50%}').rootPx).toBe(8);
    expect(scan(':root[data-present="1"]{font-size:150%}').rootPx).toBe(16);
  });

  it("a scan puts the page back as it found it: no attribute, class or id it set on an ancestor is left behind", () => {
    const before = () => { const out = []; for (let e = card; e; e = e.parentElement) out.push(`${e.tagName}|${e.id}|${e.className}|${e.getAttributeNames().sort().map((n) => `${n}=${e.getAttribute(n)}`).join(";")}`); return out.join("\n"); };
    const snapshot = before();
    expect(bad('.zzroot[data-zz-attr="1"] .zzmid#zzid .ijx .cs{font-size:.4rem}\nhtml.zz-dark{font-size:1rem}\n:root[data-zz-theme="x"]{font-size:16px}')).toHaveLength(1);
    expect(before()).toBe(snapshot);
  });

  it("a class the page carries somewhere is not assumed on an ancestor, one it never carries is (so `.legend li` is left alone, `.dark li` is not)", () => {
    expect(bad(".ijx .legend li{font-size:.4rem}")).toEqual([]);
    expect(bad(".zz-dark .ijx li{font-size:.4rem}").length).toBeGreaterThan(0);
  });

  describe("appStylesheets: which stylesheets are scanned", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "idjag-css-"));
    const put = (rel, text) => { const f = path.join(tmp, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
    afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const web = path.join(tmp, "web");
    it("reads every .css under src, what a script imports, what a .css @imports (inside web/ only, not node_modules), and index.html's links and <style>", () => {
      put("web/src/a.css", '@import "./b.css";\n@import url("../up.css");\n@import "https://example.invalid/remote.css";\n@import "../../../outside.css";\n.a{color:red}');
      put("web/src/b.css", ".b{color:red}");
      put("web/up.css", ".up{color:red}");
      put("web/src/deep/x.jsx", 'import "../../extra.css";\nimport s from "../viaDefault.css?inline";\nconst l = () => import("../lazy.css");\nimport { a,\n b } from "../named.css";\nimport "pkg/shrink.css";\nimport "/rooted.css";');
      put("web/src/deep/__tests__/t.test.js", 'import "../../../testonly.css";');
      for (const f of ["extra", "rooted", "testonly"]) put(`web/${f}.css`, `.${f}{color:red}`);
      put("web/src/viaDefault.css", ".v{color:red}"); put("web/src/lazy.css", ".l{color:red}"); put("web/src/named.css", ".n{color:red}");
      put("web/node_modules/pkg/shrink.css", ".pkg{color:red}"); put("web/node_modules/pkg/src/y.css", ".pkgy{color:red}");
      put("outside.css", ".outside{color:red}");
      put("web/public/linked.css", ".linked{color:red}"); put("web/index.html", '<link rel="stylesheet" href="/linked.css"><link rel="icon" href="/nope.css"><style>.inline{color:red}</style>');
      const { files, css: text } = appStylesheets(web);
      expect(files).toEqual(["extra.css", "public/linked.css", "rooted.css", "src/a.css", "src/b.css", "src/lazy.css", "src/named.css", "src/viaDefault.css", "testonly.css", "up.css", "<style> in index.html"]);
      for (const c of ["a", "b", "up", "extra", "v", "l", "n", "rooted", "linked", "inline"]) expect(text, c).toContain(`.${c}{`);
      for (const c of ["pkg", "pkgy", "outside"]) expect(text, c).not.toContain(`.${c}{`);
    });
    it("a stylesheet outside web/src that a script imports or another stylesheet @imports is scanned: a rule in it that shrinks card text fails", () => {
      put("web/src/p.jsx", 'import "../extra-shrink.css";'); put("web/extra-shrink.css", ".ijx .cs{font-size:6px}");
      put("web/src/q.css", '@import "../imported-shrink.css";'); put("web/imported-shrink.css", ".ijx .ct{font-size:6px}");
      const text = appStylesheets(web).css;
      expect(tooSmall(scanCardCss(text, card, KINDS), READABLE_MIN_ZOOM).map((f) => f.selector).sort()).toEqual([".ijx .cs", ".ijx .ct"]);
    });
    it("the app's own stylesheets: all eleven under src, none from node_modules", () => {
      expect(cssFiles.filter((f) => f.endsWith(".css")).length).toBe(11);
      expect(cssFiles.every((f) => !f.includes("node_modules"))).toBe(true);
    });
  });

  describe("scanCardCss: what each helper does on its own", () => {
    const flagged = (extra) => bad(extra).map((f) => `${f.type}:${f.value}`);
    it("lengthPx: clamp(min, value, max) is the value held between the two", () => {
      expect(lengthPx("clamp(5px,20px,10px)")).toBe(10);
      expect(lengthPx("clamp(10px,5px,20px)")).toBe(10);
      expect(lengthPx("clamp(5px,7px,10px)")).toBe(7);
      expect(lengthPx("clamp(5px,7px)")).toBeNull();
    });
    it("a var() chain several levels deep is followed to the end, with fallbacks", () => {
      expect(flagged(":root{--a:var(--b);--b:var(--c);--c:var(--d);--d:5px}\n.ijx .cs{font-size:var(--a)}")).toEqual(["font-size:var(--a)"]);
      expect(flagged(":root{--a:var(--b);--b:var(--c);--c:var(--d);--d:20px}\n.ijx .cs{font-size:var(--a)}")).toEqual([]);
      expect(flagged(".ijx .cs{font-size:var(--nothing-declared,5px)}")).toEqual(["font-size:var(--nothing-declared,5px)"]);
    });
    it("every value a custom property is declared with counts (the smallest decides)", () => {
      expect(flagged(":root{--s:20px}\n.x{--s:5px}\n.ijx .cs{font-size:var(--s)}")).toEqual(["font-size:var(--s)"]);
    });
    it("a size with !important is read the same as without it", () => {
      expect(flagged(".ijx .cs{font-size:12px !important}")).toEqual([]);
      expect(flagged(".ijx .cs{font-size:5px ! important}")).toEqual(["font-size:5px"]);
    });
    it("font-size-adjust other than none / auto / 100% fails; those three do not", () => {
      expect(flagged(".ijx .cs{font-size-adjust:.3}")).toEqual(["text-size-adjust:.3"]);
      for (const v of ["none", "auto", "100%"]) expect(flagged(`.ijx .cs{font-size-adjust:${v}}`), v).toEqual([]);
    });
    it("a selector the DOM engine throws on is read as matching (fails closed), not skipped", () => {
      expect(() => document.body.matches(".ijx >> .cs")).toThrow();
      expect(bad(".ijx >> .cs{font-size:.4rem}").length).toBeGreaterThan(0);
    });
    it("a property name is decoded and lower-cased; an animation name is unquoted and decoded; every name in the list is followed", () => {
      expect(flagged(".ijx .cs{font\\2d size:6px}")).toEqual(["font-size:6px"]);
      expect(flagged(".ijx .cs{FONT-SIZE:6px}")).toEqual(["font-size:6px"]);
      expect(flagged('@keyframes "sh"{to{font-size:6px}}\n.ijx .cs{animation-name:"sh"}')).toEqual(["font-size:6px"]);
      expect(flagged("@keyframes s\\68{to{font-size:6px}}\n.ijx .cs{animation:other 1s, sh 2s}")).toEqual(["font-size:6px"]);
      expect(flagged("@keyframes sh{to{font-size:6px}}\n.ijx .cs{animation:sh 1s, other 2s}")).toEqual(["font-size:6px"]);
    });
  });

  describe("parseRules", () => {
    it("flattens native nesting: & , a bare selector, > and @media inside a rule", () => {
      const rules = parseRules(".a{color:red; & b{font-size:1px} c{x:y} > d{z:w} @media (x){ e{p:q} font-size:2px } }");
      expect(rules).toEqual([
        { selector: ".a", body: "color:red;font-size:2px" },
        { selector: ".a b", body: "font-size:1px" },
        { selector: ".a c", body: "x:y" },
        { selector: ".a > d", body: "z:w" },
        { selector: ".a e", body: "p:q" },
      ]);
    });
    it("every & in a nested selector stands for the parent", () => {
      expect(parseRules(".a{ & + & {k:v} .x & &.y{k:w} }").map((r) => r.selector)).toEqual([".a", ".a + .a", ".x .a .a.y"]);
    });
    it("a & in the middle and a list of parents", () => {
      expect(parseRules(".a,.b{ .x &{k:v} &.on{k:v2} }").map((r) => r.selector)).toEqual([".a,.b", ".x .a,.x .b", ".a.on,.b.on"]);
    });
    it("skips at-rule statements and does not let them swallow the next rule", () => {
      expect(parseRules("@layer base, components;@custom-media --n (max-width:30em);@tailwind base;@import url(a.css) layer(x);@charset \"utf-8\";.a{k:v}")).toEqual([{ selector: ".a", body: "k:v" }]);
    });
    it("a brace or a semicolon inside a string or parentheses does not end a rule", () => {
      expect(parseRules('.a::after{content:"};{"}.b{background:url(data:image/png;base64,AAA)}').map((r) => r.selector)).toEqual([".a::after", ".b"]);
    });
    it("rules inside @layer, @container and @scope are read; @keyframes and @font-face are not", () => {
      expect(parseRules("@layer x{.a{k:v}}@container (min-width:1px){.b{k:v}}@scope (.s){.c{k:v}}@keyframes k{to{k:v}}@font-face{src:url(x)}").map((r) => r.selector)).toEqual([".a", ".b", ".c"]);
    });
  });

  describe("normalizeSelector", () => {
    it("decodes escapes, lower-cases type selectors only, drops hover / pseudo-elements / structural and unknown pseudo-classes", () => {
      expect(normalizeSelector(".ijx .\\63 s").query).toBe(".ijx .cs");
      expect(normalizeSelector(".ijx .card LI").query).toBe(".ijx .card li");
      expect(normalizeSelector('[data-id="PF Two"] .Card').query).toBe('[data-id="PF Two"] .Card');
      expect(normalizeSelector("li:nth-child(2n+1):hover::before").query).toBe("li");
      expect(normalizeSelector(".a:not(:first-child) .b").query).toBe(".a .b");
      expect(normalizeSelector(".a:lang(en) .b").query).toBe(".a .b");
      expect(normalizeSelector(".a:before").query).toBe(".a");
      expect(normalizeSelector(".a >").query).toBe(".a >*");
      expect(normalizeSelector(":root[data-present=\"1\"] body").query).toBe(':root[data-present="1"] body');
      expect(normalizeSelector(":is(.a,.b):not(.c)").query).toBe(":is(.a,.b):not(.c)");
    });
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

describe("the fit of the view", () => {
  // padding is the room left round what is fitted: 5% round the whole map (overview, Fit, Reset), 40% round the lit boxes of a step; never zoomed in past 1
  afterEach(() => { vi.useRealTimers(); window.history.pushState({}, "", "/"); });
  const open = (mode, step) => {
    vi.useFakeTimers();
    window.history.pushState({}, "", playgroundDiagramPath(mode, step));
    asked.length = 0; fits.length = 0;
    const view = render(<IdJagPlaygroundDiagramPage />);
    act(() => { vi.advanceTimersByTime(700); });
    return view;
  };
  const last = () => fits.at(-1)[0];
  it("the overview fits the whole map with 5% padding, and ReactFlow's own first fit asks for the same", () => {
    const { unmount } = open("mock", 0);
    expect(asked[0].fitViewOptions).toEqual({ padding: 0.05 });
    expect(last()).toEqual({ nodes: undefined, padding: 0.05, duration: 500, maxZoom: 1 });
    unmount();
  });
  it("a step fits its lit boxes with 40% padding", () => {
    const { unmount } = open("mock", 2);
    expect(last().padding).toBe(0.4);
    expect(last().maxZoom).toBe(1);
    expect(last().nodes.length).toBeGreaterThan(0);
    unmount();
  });
  it("Fit, Reset and Fullscreen fit the whole map with 5% padding", () => {
    const { unmount } = open("mock", 2);
    fits.length = 0;
    fireEvent.click(screen.getByRole("button", { name: "Fit" }));
    expect(last()).toMatchObject({ padding: 0.05 });
    expect(last().nodes).toBeUndefined();
    fits.length = 0;
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    act(() => { vi.advanceTimersByTime(700); });
    expect(fits.map((f) => f[0].padding), "the overview's own fit, then Reset's").toEqual([0.05, 0.05]);
    fits.length = 0;
    fireEvent.click(screen.getByRole("button", { name: "Fullscreen" }));
    act(() => { vi.advanceTimersByTime(400); });
    expect(last()).toMatchObject({ padding: 0.05 });
    expect(last().nodes).toBeUndefined();
    unmount();
  });
  it("a resized window fits again the same way: 5% on the overview, 40% on a step", () => {
    for (const [step, padding] of [[0, 0.05], [3, 0.4]]) {
      const { unmount } = open("mock", step);
      fits.length = 0;
      act(() => { window.dispatchEvent(new Event("resize")); vi.advanceTimersByTime(400); });
      expect(fits.length).toBe(1);
      expect(last().padding, `step ${step}`).toBe(padding);
      unmount();
    }
  });
});

describe("a box released over a disabled button is not left stuck to the pointer", () => {
  // Chrome sends no mouseup to a disabled form control. React Flow ends a drag on the window's mouseup, so a box released over Next on the last step
  // (or Back on the overview), which sit under the canvas on a phone and beside it on a desktop, never got it and kept following the pointer. A disabled
  // control that ignores the pointer lets the event reach what is under it. (scripts/check-diagram-drag-release.py drives the real thing in Chrome.)
  const style = fs.readFileSync(path.join(process.cwd(), "src", "pages", "IdJagPlaygroundDiagramPage.css"), "utf8");
  let sheet;
  beforeAll(() => { sheet = document.createElement("style"); sheet.textContent = style; document.head.appendChild(sheet); });
  afterAll(() => { sheet.remove(); window.history.pushState({}, "", "/"); });
  it.each(PLAYGROUND_DIAGRAM_MODES.flatMap((m) => [[m, 0], [m, PLAYGROUND_DIAGRAMS[m].steps.length]]))("%s step %i: every disabled control has pointer-events none", (mode, step) => {
    window.history.pushState({}, "", playgroundDiagramPath(mode, step));
    const { container, unmount } = render(<IdJagPlaygroundDiagramPage />);
    const disabled = [...container.querySelectorAll(":disabled")];
    expect(disabled.length, "Back is disabled on the overview, Next on the last step").toBeGreaterThan(0);
    for (const el of disabled) expect(window.getComputedStyle(el).pointerEvents, el.textContent).toBe("none");
    expect(window.getComputedStyle(container.querySelector("button:not(:disabled)")).pointerEvents, "enabled buttons are unchanged").not.toBe("none");
    unmount();
  });
});

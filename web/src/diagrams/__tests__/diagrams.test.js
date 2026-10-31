import fs from "node:fs";
import path from "node:path";
import { validateDiagram } from "../diagramSchema";
import { diagramNames, loadDiagram } from "../loadDiagram";
import { assignHandles, toPlaygroundModel } from "../playgroundModel";
import { PLAYGROUND_DIAGRAMS } from "../../utils/idJagPlaygroundDiagrams";
import { routeEdges } from "../../utils/idJagPlaygroundRouting";

// vitest runs with the web package as its working directory (npm test -w web, or from web/)
const dir = `${path.resolve(process.cwd(), "..", "diagrams")}/`;
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();

describe("diagram-studio/1 data in diagrams/", () => {
  it("has one file per playground mode, and the loader finds them all by name", () => {
    expect(files).toEqual(["byo", "gateway-redeem", "mock", "pf-as", "pf-pf"]);
    expect(diagramNames().sort()).toEqual(files);
  });

  it.each(files)("%s: is a valid diagram-studio/1 document whose id is its file name", (name) => {
    const data = JSON.parse(fs.readFileSync(`${dir}${name}.json`, "utf8"));
    expect(validateDiagram(data)).toEqual([]);
    expect(data.id).toBe(name);
    expect(loadDiagram(name)).toEqual(data);
  });

  it.each(files)("%s: every step lights at least one arrow, and steps 1-5 are the playground's five steps", (name) => {
    const d = loadDiagram(name);
    expect(d.steps).toHaveLength(5);
    for (const s of d.steps) expect(s.edges.length).toBeGreaterThan(0);
  });

  it.each(files)("%s: no real host, tenant or person: only .invalid, .example and sample names", (name) => {
    const text = fs.readFileSync(`${dir}${name}.json`, "utf8");
    const hosts = text.match(/[a-z0-9-]+(\.[a-z0-9-]+)+(?=[/\s"':]|$)/gi) ?? [];
    for (const h of hosts.filter((x) => /\.(com|net|org|io|dev|local|internal)$/i.test(x))) {
      expect(["xaa.dev", "idp.xaa.dev", "pingfederate.example.com", "mcp-as.example.com", "mcp.example.com"].some((ok) => h === ok || h.endsWith(`.${ok}`)), h).toBe(true);
    }
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i); // no email address
  });

  it("refuses a name that is not a plain diagram id, and a file that is not valid", () => {
    for (const bad of ["../package", "nope", "", undefined, null, 5, "__proto__", "PF-AS"]) expect(loadDiagram(bad)).toBeNull();
    const base = loadDiagram("mock");
    expect(validateDiagram({ ...base, schema: "x" })).not.toEqual([]);
    expect(validateDiagram({ ...base, edges: [{ source: "nope", target: base.nodes[0].id }] })).not.toEqual([]);
    expect(validateDiagram({ ...base, steps: [{ title: "t", what: "w", edges: [99] }] })).not.toEqual([]);
    expect(validateDiagram({ ...base, nodes: [...base.nodes, base.nodes[0]] })).not.toEqual([]);
    expect(validateDiagram({ ...base, groups: { x: { label: "x", color: "purple" } } })).not.toEqual([]);
    expect(validateDiagram(null)).not.toEqual([]);
  });
});

describe("the playground model built from the data", () => {
  it("is what the page uses: PLAYGROUND_DIAGRAMS is toPlaygroundModel of the loaded file, nothing hand-built", () => {
    for (const name of files) expect(PLAYGROUND_DIAGRAMS[name]).toEqual(toPlaygroundModel(loadDiagram(name)));
  });

  it("turns file order into edge ids and step lists, and group colour into the card kind", () => {
    const d = toPlaygroundModel(loadDiagram("pf-as"));
    expect(d.edges.map((e) => e.id)).toEqual(d.edges.map((_, i) => `e${i}`));
    expect(d.edges[3].steps).toEqual([2, 5]);
    expect(d.nodes.find((n) => n.id === "pf").kind).toBe("red");
    expect(d.nodes.find((n) => n.id === "browser").kind).toBe("dark");
    expect(d.nodes[0].lines).toEqual(loadDiagram("pf-as").nodes[0].sub.slice(1));
    expect(d.steps[2]).toMatchObject({ n: 3, t: "Redeem at resource-as" });
  });

  it.each(files)("%s: every arrow end has its own slot on its box (no two arrows leave or enter on one point)", (name) => {
    const d = PLAYGROUND_DIAGRAMS[name];
    const used = d.edges.flatMap((e) => [`${e.from}:${e.fh}`, `${e.to}:${e.th}`]);
    expect(new Set(used).size).toBe(used.length);
    for (const e of d.edges) { expect(e.fh).toMatch(/^[TBLR][123]$/); expect(e.th).toMatch(/^[TBLR][123]$/); }
  });

  it("assignHandles faces the other box, spreads arrows over a side's slots, and spills a full side to the next side", () => {
    const nodes = [{ id: "a", x: 0, y: 0 }, { id: "b", x: 1000, y: 0 }, { id: "c", x: 1000, y: 600 }];
    expect(assignHandles(nodes, [{ from: "a", to: "b" }])).toEqual([{ fh: "R2", th: "L2" }]);
    const two = assignHandles(nodes, [{ from: "a", to: "b" }, { from: "a", to: "c" }]);
    expect(two[0].fh[0]).toBe("R");
    const five = assignHandles(nodes, Array.from({ length: 5 }, () => ({ from: "a", to: "b" })));
    expect(new Set(five.map((h) => h.fh)).size).toBe(5);
  });

  // A box dragged a little must not leave an arrow without a route (an unrouted arrow is drawn straight and its badge lands on a box).
  it("gateway-redeem: every arrow still routes after any one box is dragged 70 right/left and 50 down/up", () => {
    const d = PLAYGROUND_DIAGRAMS["gateway-redeem"];
    const height = { agent: 98, gateway: 185, exchange: 115, targetidp: 132, api: 115 }; // as drawn at the page's width of 300
    const at = (moved, dx, dy) => Object.fromEntries(d.nodes.map((n) => [n.id, { x: n.x + (n.id === moved ? dx : 0), y: n.y + (n.id === moved ? dy : 0), w: 300, h: height[n.id] }]));
    expect(routeEdges(at(null, 0, 0), d.edges).fallbacks).toBe(0);
    for (const n of d.nodes) for (const dx of [-70, 70]) for (const dy of [-50, 50]) {
      const { fallbacks } = routeEdges(at(n.id, dx, dy), d.edges);
      expect({ moved: n.id, dx, dy, fallbacks }).toEqual({ moved: n.id, dx, dy, fallbacks: 0 });
    }
  });
});

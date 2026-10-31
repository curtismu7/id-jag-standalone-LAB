// One ReactFlow diagram per ID-JAG playground mode. The diagrams are diagram-studio/1 data in <repo>/diagrams/, loaded by
// name (diagrams/loadDiagram.js) and turned into the page's model by diagrams/playgroundModel.js. The page
// (pages/IdJagPlaygroundDiagramPage.jsx) only draws what is here; no box or arrow is built by hand.
//
// Step 0 is the overview: everything lit. An actor is lit when a call of the step touches it.
import { loadDiagram } from "../diagrams/loadDiagram";
import { toPlaygroundModel } from "../diagrams/playgroundModel";

export const playgroundDiagramPath = (mode, step) => `/diagram/${mode}${step ? `?step=${step}` : ""}`;

// Order of the mode picker; the names are the diagram files.
const MODES = ["mock", "pf-as", "pf-pf", "byo"];
export const PLAYGROUND_DIAGRAMS = Object.fromEntries(MODES.map((m) => [m, toPlaygroundModel(loadDiagram(m))]));

export const PLAYGROUND_DIAGRAM_MODES = Object.keys(PLAYGROUND_DIAGRAMS);

const ends = (edges) => [...new Set(edges.flatMap((e) => [e.from, e.to]))];

/** What step `step` lights up: its calls and the actors they touch. Step 0 lights everything. */
export function stepParts(d, step) {
  const edges = step ? d.edges.filter((e) => e.steps.includes(step)) : d.edges;
  const nodes = step ? ends(edges) : d.nodes.map((n) => n.id);
  return { edges: edges.map((e) => e.id), nodes, focus: nodes };
}

/** The step number an edge's badge starts with: the first step it belongs to. */
export const edgeStepNumber = (e) => Math.min(...e.steps);

/**
 * The text of every edge's badge: its first step number, plus a letter when several calls start in that step
 * (3a, 3b, 3c), so no two badges on a diagram read the same. Returns { [edgeId]: text }.
 */
export function edgeBadges(d) {
  const seen = {};
  const total = {};
  for (const e of d.edges) total[edgeStepNumber(e)] = (total[edgeStepNumber(e)] ?? 0) + 1;
  return Object.fromEntries(d.edges.map((e) => {
    const n = edgeStepNumber(e);
    const k = seen[n] ?? 0;
    seen[n] = k + 1;
    return [e.id, total[n] > 1 ? `${n}${String.fromCharCode(97 + k)}` : String(n)];
  }));
}

/** Does `step` light this actor? */
export const stepLights = (d, step, id) => stepParts(d, step).nodes.includes(id);

/** First step (1..n) that lights the actor, or 0 when none does. */
export const firstStepLighting = (d, id) => d.steps.find((s) => stepLights(d, s.n, id))?.n ?? 0;

/** The actor a step centres on: the first actor it lights. */
export const focusNode = (d, step) => stepParts(d, step).focus[0] ?? null;

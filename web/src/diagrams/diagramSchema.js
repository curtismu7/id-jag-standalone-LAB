// A check for diagram-studio/1 documents (the format of the diagram-studio data). Same limits as the studio's own
// validator, written here so this app has no import from another repo. It returns a list of problems; empty means valid.
export const SCHEMA = "diagram-studio/1";
export const COLORS = ["red", "dark", "grey", "blue", "green", "amber"];
const ID = /^[a-z0-9][a-z0-9_-]*$/;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max;
const num = (v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 20000;

export function validateDiagram(d) {
  const p = [];
  if (!isObj(d)) return ["diagram must be an object"];
  if (d.schema !== SCHEMA) p.push(`schema must be "${SCHEMA}"`);
  if (typeof d.id !== "string" || !ID.test(d.id) || d.id.length > 48) p.push("bad id");
  if (!text(d.title, 120)) p.push("title is required (max 120)");
  if (d.lede !== undefined && (typeof d.lede !== "string" || d.lede.length > 600)) p.push("lede must be text (max 600)");
  const groups = isObj(d.groups) ? d.groups : {};
  if (!Object.keys(groups).length) p.push("at least one group");
  for (const [k, g] of Object.entries(groups)) {
    if (!ID.test(k)) p.push(`group key "${k}" is not an id`);
    if (!isObj(g) || !text(g.label, 80) || !COLORS.includes(g.color)) p.push(`group "${k}" needs a label and a known colour`);
  }
  const ids = new Set();
  if (!Array.isArray(d.nodes) || !d.nodes.length || d.nodes.length > 60) p.push("nodes: 1 to 60");
  else for (const [i, n] of d.nodes.entries()) {
    const at = `node ${i + 1}`;
    if (!isObj(n)) { p.push(`${at} must be an object`); continue; }
    if (typeof n.id !== "string" || !ID.test(n.id) || ids.has(n.id)) p.push(`${at}: bad or duplicate id`);
    else ids.add(n.id);
    if (!text(n.label, 80)) p.push(`${at}: label is required (max 80)`);
    if (!Object.hasOwn(groups, n.group)) p.push(`${at}: unknown group`);
    if (n.sub !== undefined && (!Array.isArray(n.sub) || n.sub.length > 6 || !n.sub.every((s) => typeof s === "string" && s.length <= 120))) p.push(`${at}: sub is up to 6 short lines`);
    if (!num(n.x) || !num(n.y)) p.push(`${at}: x and y must be numbers`);
  }
  if (!Array.isArray(d.edges) || d.edges.length > 120) p.push("edges: an array of at most 120");
  else for (const [i, e] of d.edges.entries()) {
    const at = `edge ${i + 1}`;
    if (!isObj(e) || !ids.has(e.source) || !ids.has(e.target)) p.push(`${at}: unknown source or target`);
    else {
      if (e.label !== undefined && (typeof e.label !== "string" || e.label.length > 160)) p.push(`${at}: label max 160`);
      if (e.dashed !== undefined && typeof e.dashed !== "boolean") p.push(`${at}: dashed must be true or false`);
    }
  }
  if (!Array.isArray(d.steps) || d.steps.length > 60) p.push("steps: an array of at most 60");
  else for (const [i, s] of d.steps.entries()) {
    const at = `step ${i + 1}`;
    if (!isObj(s) || !text(s.title, 120)) { p.push(`${at}: title is required`); continue; }
    if (typeof s.what !== "string" || s.what.length > 600) p.push(`${at}: what must be text (max 600)`);
    if (s.why !== undefined && (typeof s.why !== "string" || s.why.length > 600)) p.push(`${at}: why must be text (max 600)`);
    const n = Array.isArray(d.edges) ? d.edges.length : 0;
    if (!Array.isArray(s.edges) || !s.edges.every((x) => Number.isInteger(x) && x >= 0 && x < n)) p.push(`${at}: edges must be valid arrow numbers`);
  }
  return p;
}

// Turns a diagram-studio/1 document into the model the playground diagram page draws.
//   nodes: actors. kind is the group's colour (red, dark, grey ...), which picks the card look.
//   edges: one call each, in file order (lane assignment follows it). steps = the step numbers (1-n) that light it.
//          fh/th = card handles (T|B|L|R + slot 1..3), chosen here from where the two boxes sit.
//   steps: { n, t, text, why }. Step 0 is the overview: everything lit. The overview text is the diagram's lede.
const CARD = { w: 300, h: 150 }; // a card's usual size; only used to pick which side an arrow leaves from

const OPPOSITE = { T: "B", B: "T", L: "R", R: "L" };
const NEXT = { T: ["L", "R", "B"], B: ["L", "R", "T"], L: ["T", "B", "R"], R: ["T", "B", "L"] };
const SLOTS = { 1: [2], 2: [1, 3], 3: [1, 2, 3] };

/**
 * Which side of its box each arrow end uses, and which of the 3 slots on that side. The side faces the box at the
 * other end; a full side (3 arrows) hands the end to the next side, so no two arrow ends share a slot. Arrows on
 * one side are ordered by where their other end is, so they do not cross at the box. Returns [{ fh, th }] by edge.
 */
export function assignHandles(nodes, edges) {
  const at = new Map(nodes.map((n) => [n.id, { cx: n.x + CARD.w / 2, cy: n.y + CARD.h / 2 }]));
  const used = new Map(); // "node:side" -> ends placed there
  const ends = [];        // [{ i, end, node, side, other }]
  edges.forEach((e, i) => {
    const a = at.get(e.from), b = at.get(e.to);
    const dx = b.cx - a.cx, dy = b.cy - a.cy;
    const horizontal = Math.abs(dx) * 0.6 >= Math.abs(dy);
    const fromSide = horizontal ? (dx >= 0 ? "R" : "L") : (dy >= 0 ? "B" : "T");
    for (const [end, node, other, want] of [["fh", e.from, e.to, fromSide], ["th", e.to, e.from, OPPOSITE[fromSide]]]) {
      const side = [want, ...NEXT[want]].find((s) => (used.get(`${node}:${s}`) ?? []).length < 3) ?? want;
      const key = `${node}:${side}`;
      const item = { i, end, side, pos: side === "T" || side === "B" ? at.get(other).cx : at.get(other).cy };
      used.set(key, [...(used.get(key) ?? []), item]);
      ends.push(item);
    }
  });
  const out = edges.map(() => ({}));
  for (const list of used.values()) {
    const sorted = [...list].sort((p, q) => p.pos - q.pos || p.i - q.i);
    sorted.forEach((it, k) => { out[it.i][it.end] = it.side + (SLOTS[Math.min(sorted.length, 3)][k] ?? 2); });
  }
  return out;
}

export function toPlaygroundModel(data) {
  const nodes = data.nodes.map((n) => ({
    id: n.id, kind: data.groups[n.group].color, group: n.group, title: n.label, sub: n.sub?.[0] ?? "", lines: (n.sub ?? []).slice(1), x: n.x, y: n.y,
  }));
  const raw = data.edges.map((e, i) => ({
    id: `e${i}`, from: e.source, to: e.target, label: e.label ?? "", dashed: !!e.dashed,
    steps: data.steps.flatMap((s, k) => (s.edges.includes(i) ? [k + 1] : [])),
  }));
  const handles = assignHandles(nodes, raw);
  return {
    id: data.id,
    label: data.title,
    overview: data.lede ?? "",
    groups: data.groups,
    nodes,
    edges: raw.map((e, i) => ({ ...e, ...handles[i] })),
    steps: data.steps.map((s, k) => ({ n: k + 1, t: s.title, text: s.what, why: s.why ?? "" })),
  };
}

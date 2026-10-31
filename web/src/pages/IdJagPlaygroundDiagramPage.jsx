import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReactFlow, ReactFlowProvider, useReactFlow, useNodesInitialized, useStore, NodeResizer, BaseEdge, EdgeLabelRenderer, getSmoothStepPath,
  Background, Controls, Handle, Position, ConnectionMode, MarkerType } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./IdJagPlaygroundDiagramPage.css";
import { PLAYGROUND_DIAGRAMS, PLAYGROUND_DIAGRAM_MODES, playgroundDiagramPath, stepParts, edgeBadges, stepLights, firstStepLighting, focusNode } from "../utils/idJagPlaygroundDiagrams";
import { stepDetail } from "../utils/idJagStepDetail";
import { pathFromPoints, labelPoint } from "../utils/orthoRoute";
import { routeEdges } from "../utils/idJagPlaygroundRouting";

// One diagram per ID-JAG playground mode (/diagram/:mode). ?step=N lights playground step N; the URL
// is the step state, so every view is a deep link. Ported from AI-DEMO2 (no router here: the path is read directly).

// Handles: every side has 3 slots (1,2,3) so edges can leave/enter without overlapping.
const SIDES = [["T", Position.Top], ["B", Position.Bottom], ["L", Position.Left], ["R", Position.Right]];
function Card({ data, selected }) {
  return (
    <div className={`card k-${data.kind} ${data.dim ? "dim" : ""} ${data.on ? "on" : ""} ${data.sel ? "sel" : ""}`}>
      <NodeResizer isVisible={selected} minWidth={220} minHeight={90} />
      {SIDES.flatMap(([s, pos]) => [1, 2, 3].map((i) => (
        <Handle key={s + i} id={s + i} type="source" position={pos}
          style={{ [pos === Position.Top || pos === Position.Bottom ? "left" : "top"]: `${i * 25}%`, opacity: 0 }} />
      )))}
      <div className="ct">{data.title}</div>
      <div className="cs">{data.sub}</div>
      <ul>{data.lines.map((l) => <li key={l}>{l}</li>)}</ul>
    </div>
  );
}
// Edge with a token dot travelling along the path while the simulation runs it. The numbered badge always
// shows the step number; the words show only while the step lights the edge, or on hover.
// data.route is the routed path around the boxes; without it (while a box is dragged, or when no route was found) the plain smooth-step path is drawn.
function FlowEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, label, markerEnd, style, data }) {
  const [smooth, sx, sy] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const routed = data.route && data.route.ok;
  const path = routed ? pathFromPoints(data.route.pts) : smooth;
  // place = where the routed badge sits on the line and which way its words grow (see placeLabels); without it the label is centred on the path
  const place = routed ? data.place : undefined;
  const { x: lx, y: ly } = place || (routed ? labelPoint(data.route.pts) : { x: sx, y: sy });
  const [hover, setHover] = useState(false);
  const words = data.on || hover;
  return (
    <>
      <g onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
        {data.dashed ? (
          <defs>
            <marker id={`ijx-head-${id}`} className="ijx-head ijx-head--dashed" data-edge-head={id} markerWidth="12.5" markerHeight="12.5" viewBox="-10 -10 20 20" markerUnits="strokeWidth" orient="auto-start-reverse" refX="0" refY="0">
              <polyline className="arrowclosed" strokeLinecap="round" strokeLinejoin="round" points="-5,-4 0,0 -5,4 -5,-4" />
            </marker>
          </defs>
        ) : null}
        <BaseEdge id={id} path={path} markerEnd={data.dashed ? `url(#ijx-head-${id})` : markerEnd} style={style} className={data.dashed ? "dashed" : undefined} interactionWidth={24} />
      </g>
      {data.pulse ? (
        <circle r="7" className="pkt" key={data.pulse}>
          <animateMotion dur={`${data.dur}s`} repeatCount="1" fill="freeze" path={path} />
        </circle>
      ) : null}
      <EdgeLabelRenderer>
        <div className={`elabel nodrag nopan ${data.on ? "on" : ""} ${words ? "words" : ""} ${place ? `side-${place.side}` : ""}`} data-edge={id}
          style={{ transform: place ? `translate(${lx}px,${ly}px) translate(var(--bx-x),-50%)` : `translate(-50%,-50%) translate(${lx}px,${ly}px)`, maxWidth: place && words ? place.w : undefined }}
          onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
          <span className="enum" data-testid={`pgd-badge-${id}`}>{data.num}</span>
          {words ? <span className="ewords">{label}</span> : null}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
const nodeTypes = { card: Card };
const edgeTypes = { flow: FlowEdge };

/** Computed nodes made draggable: remembers where each node was dropped (view-only, resets on reload). */
function useDraggableNodes(computed) {
  const [moved, setMoved] = useState({});
  const nodes = useMemo(() => computed.map((n) => (moved[n.id] ? { ...n, position: moved[n.id] } : n)), [computed, moved]);
  const onNodesChange = useCallback((changes) => {
    const drags = changes.filter((c) => c.type === "position" && c.position);
    if (drags.length) setMoved((m) => ({ ...m, ...Object.fromEntries(drags.map((c) => [c.id, c.position])) }));
  }, []);
  const resetPositions = useCallback(() => setMoved({}), []);
  return { nodes, onNodesChange, resetPositions };
}

// Pause between simulated steps, by the speed control.
const SPEEDS = [{ id: "slow", label: "Slow", ms: 6000 }, { id: "normal", label: "Normal", ms: 3500 }, { id: "fast", label: "Fast", ms: 1500 }];

const DETAIL_KIND = { rfc: "RFC", spec: "Spec", emerging: "Emerging" };
const json = (o) => JSON.stringify(o, null, 2);
/** Request on the wire, MOCK tokens and standards for one step. */
function StepDetail({ detail }) {
  const { forms, tokens, refs } = detail;
  return (
    <div className="detail" data-testid="pgd-detail">
      {forms.length ? (
        <>
          <h3>Request on the wire</h3>
          {forms.map((f) => (
            <figure key={f.title} className="code"><figcaption>{f.title}</figcaption><pre><code>{f.code}</code></pre></figure>
          ))}
        </>
      ) : null}
      {tokens.length ? (
        <>
          <h3>Mock token(s) in play <span className="chip mock">MOCK</span></h3>
          <p className="muted">Teaching values only: not real tokens, not signed by anything.</p>
          {tokens.map((t) => (
            <figure key={t.note} className="code token"><figcaption>{t.note}</figcaption>
              <pre><code>{t.header ? `// header\n${json(t.header)}\n// claims\n${json(t.claims)}` : json(t.claims)}</code></pre>
            </figure>
          ))}
        </>
      ) : null}
      {refs.length ? (
        <>
          <h3>Standards behind this step</h3>
          <ul className="refs" data-testid="pgd-refs">
            {refs.map((r) => (
              <li key={r.id} className={r.kind === "emerging" ? "emerging" : undefined} data-kind={r.kind}>
                <span className={`chip ${r.kind}`}>{DETAIL_KIND[r.kind] || r.kind}</span> <b>{r.id}</b> {r.title}
              </li>
            ))}
          </ul>
          <p className="muted">Emerging items are drafts or in-progress work; their status can change.</p>
        </>
      ) : null}
    </div>
  );
}

const readStep = (last) => Math.min(last, Math.max(0, parseInt(new URLSearchParams(window.location.search).get("step"), 10) || 0));

function PlaygroundFlow({ mode, d }) {
  const rf = useReactFlow();
  const measured = useNodesInitialized(); // a ?step deep link can only zoom once nodes have sizes
  const last = d.steps.length;
  const [step, setStepState] = useState(() => readStep(last));
  // The selected actor follows the step: kept when the step lights it, else the step's focus actor (none on the overview).
  const [sel, setSel] = useState(() => (readStep(last) ? focusNode(d, readStep(last)) : null));
  const setStep = (n) => {
    setStepState(n);
    setSel((prev) => (!n ? null : prev && stepLights(d, n, prev) ? prev : focusNode(d, n)));
    window.history.replaceState(null, "", playgroundDiagramPath(mode, n));
  };
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState("normal");
  const [panel, setPanel] = useState(true);
  const [side, setSide] = useState(380);
  const lit = stepParts(d, step);
  const detail = step ? stepDetail(mode, step) : null;
  const asideRef = useRef(null);
  const sectionRef = useRef(null);
  const detailRef = useRef(null);
  const lastDrag = useRef(0);
  const [scrollTick, setScrollTick] = useState(0);
  const current = step ? d.steps[step - 1] : { t: "Overview", text: d.overview };

  const computed = useMemo(() => [
    ...d.nodes.map((n) => ({ id: n.id, type: "card", position: { x: n.x, y: n.y }, style: { width: 300 },
      data: { ...n, dim: !!step && !lit.nodes.includes(n.id), on: !!step && lit.nodes.includes(n.id), sel: sel === n.id } })),
  // lit is derived from (d, step)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [d, step, sel]);
  const { nodes, onNodesChange, resetPositions } = useDraggableNodes(computed);
  const badges = useMemo(() => edgeBadges(d), [d]);

  // Arrows are routed around every box from React Flow's real box positions and sizes. The string key changes
  // only when a box lands or is resized, which re-routes; while a box is dragged the plain path is drawn.
  const [dragging, setDragging] = useState(false);
  const nodeLookup = useStore((st) => st.nodeLookup);
  const boxKey = useStore((st) => {
    let k = "";
    for (const n of st.nodeLookup.values()) {
      const p = n.internals.positionAbsolute;
      k += `${n.id}:${Math.round(p.x)},${Math.round(p.y)},${Math.round(n.measured?.width ?? 0)},${Math.round(n.measured?.height ?? 0)}|`;
    }
    return k;
  });
  const routing = useMemo(() => {
    if (dragging) return { routes: {}, fallbacks: null, places: {} };
    const rects = {};
    for (const n of nodeLookup.values()) {
      const p = n.internals.positionAbsolute;
      rects[n.id] = { x: p.x, y: p.y, w: n.measured?.width ?? 300, h: n.measured?.height ?? 150 };
    }
    return routeEdges(rects, d.edges);
    // nodeLookup is mutated in place; boxKey carries its changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxKey, dragging, d]);

  const edges = d.edges.map((e) => {
    const on = lit.edges.includes(e.id);
    return {
      id: e.id, source: e.from, target: e.to, sourceHandle: e.fh, targetHandle: e.th, label: e.label, type: "flow",
      data: { on: !!step && on, num: badges[e.id], dashed: !!e.dashed, route: routing.routes[e.id], place: routing.places?.[e.id], pulse: step && on ? step : 0, dur: 2 },
      markerEnd: { type: MarkerType.ArrowClosed },
      style: { strokeWidth: on ? 2.4 : 1.2, opacity: on ? 1 : 0.15, strokeDasharray: e.dashed ? "6 4" : undefined },
    };
  });

  // Zoom to the lit actors and callouts (or the whole map on the overview).
  useEffect(() => {
    const ids = step ? lit.focus.map((id) => ({ id })) : undefined;
    const t = setTimeout(() => rf.fitView({ nodes: ids, padding: step ? 0.4 : 0.05, duration: 500, maxZoom: 1 }), 60);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, panel, measured]);

  useEffect(() => {
    if (!playing) return undefined;
    const t = setTimeout(() => (step >= last ? setPlaying(false) : setStep(step + 1)), SPEEDS.find((s) => s.id === speed).ms);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, step, speed]);

  // A node click selects it, jumps to the first step that lights it and brings that step's detail into view.
  // A drag that just ended is not a click.
  const onNodeClick = (_, node) => {
    if (Date.now() - lastDrag.current < 300) return;
    const n = firstStepLighting(d, node.id);
    setPlaying(false);
    if (n) setStep(n);
    setSel(node.id);
    setPanel(true);
    setScrollTick((t) => t + 1);
  };
  useEffect(() => {
    const aside = asideRef.current;
    const el = detailRef.current || sectionRef.current;
    if (!scrollTick || !aside || !el) return;
    aside.scrollTo?.({ top: el.getBoundingClientRect().top - aside.getBoundingClientRect().top + aside.scrollTop - 8, behavior: "smooth" });
  }, [scrollTick]);

  const play = () => { if (!step || step >= last) setStep(1); setPlaying(true); };
  const go = (n) => { setPlaying(false); setStep(n); };
  // Reset: stop the simulation, show the overview, put every box back where the data places it, and fit the view.
  const reset = () => { setPlaying(false); setStep(0); resetPositions(); setTimeout(() => rf.fitView({ padding: 0.05, duration: 300 }), 60); };
  const fullscreen = () => {
    const el = document.querySelector(".ijx");
    if (document.fullscreenElement) document.exitFullscreen();
    else if (el?.requestFullscreen) el.requestFullscreen();
    setTimeout(() => rf.fitView({ padding: 0.05, duration: 300 }), 250);
  };

  const startSplit = (e) => {
    e.preventDefault();
    const mv = (ev) => setSide(Math.min(720, Math.max(260, ev.clientX)));
    const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
  };

  return (
    <div className="ijx-app" style={{ "--ijx-cols": panel ? `${side}px 6px 1fr` : "0 0 1fr" }}>
      <aside ref={asideRef} style={panel ? undefined : { padding: 0, border: 0, overflow: "hidden", visibility: "hidden" }}>
        <h1>ID-JAG Playground: {d.label}</h1>
                <nav className="modes" aria-label="Playground mode">
          {PLAYGROUND_DIAGRAM_MODES.map((m) => (
            <a key={m} href={playgroundDiagramPath(m, step)} aria-current={m === mode ? "page" : undefined}>{PLAYGROUND_DIAGRAMS[m].label}</a>
          ))}
        </nav>
        <div className="sim">
          <button className="pri" onClick={playing ? () => setPlaying(false) : play}>{playing ? "Pause" : "▶ Simulate"}</button>
          <button onClick={() => go(Math.max(0, step - 1))} disabled={step === 0}>◀ Back</button>
          <button onClick={() => go(Math.min(last, step + 1))} disabled={step === last}>Next ▶</button>
          <button onClick={reset}>Reset</button>
          <label className="speed">Speed
            <select value={speed} onChange={(e) => setSpeed(e.target.value)}>
              {SPEEDS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </label>
          <span className="hint">Drag nodes to rearrange</span>
        </div>
        <nav aria-label="Steps">
          {[{ n: 0, t: "Overview" }, ...d.steps].map((s) => (
            <button key={s.n} className={s.n === step ? "sel" : ""} aria-pressed={s.n === step} onClick={() => go(s.n)}>
              {s.n ? `${s.n} · ${s.t}` : s.t}
            </button>
          ))}
        </nav>
        <section ref={sectionRef}>
          <h2>{step ? `Step ${step} · ${current.t}` : current.t}</h2>
          <p>{current.text}</p>
          <h3>{step ? "Calls in this step" : "Every call"}</h3>
          <ul data-testid="pgd-calls">{d.edges.filter((e) => lit.edges.includes(e.id)).map((e) => <li key={e.id}>{e.label}</li>)}</ul>
          {step && current.why ? <p className="why" data-testid="pgd-why">{current.why}</p> : null}
          {detail ? <div ref={detailRef}><StepDetail detail={detail} /></div> : null}
        </section>
        <p className="legend" data-testid="pgd-legend"><span className="enum">1</span> red number = step (3a, 3b when a step starts several calls) · solid line = request/response · <span className="blue">blue dashed</span> = trust source (JWKS or registry read) or alternate path</p>
        <p className="legend" data-testid="pgd-simulated">{mode === "mock" ? "Sample data: every box here is stood in for by fixtures in the page; nothing is sent." : "In Mock mode (the switch in the header) the PingFederate, resource-as and mcp-sample boxes are simulated inside this app and no call leaves this machine. In Live mode they are the real servers named in your settings."}</p>
        <p className="legend"><a href="/">Open the playground</a> to run this mode.</p>
      </aside>
      <div className="split" style={panel ? undefined : { visibility: "hidden" }} onPointerDown={startSplit} title="Drag to resize panel" />
      <main data-route-fallbacks={routing.fallbacks ?? undefined}>
        <div className="tools">
          <button onClick={() => setPanel(!panel)}>{panel ? "◀ Hide panel" : "▶ Show panel"}</button>
          <button onClick={() => rf.fitView({ padding: 0.05, duration: 300 })}>Fit</button>
          <button onClick={fullscreen}>Fullscreen</button>
        </div>
        <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
          onNodesChange={onNodesChange} nodesDraggable nodeDragThreshold={5} onNodeClick={onNodeClick} onNodeDragStart={() => setDragging(true)} onNodeDragStop={() => { lastDrag.current = Date.now(); setDragging(false); }} connectionMode={ConnectionMode.Loose}
          fitView fitViewOptions={{ padding: 0.05 }} minZoom={0.1} nodesConnectable={false} proOptions={{ hideAttribution: true }}>
          <Background gap={24} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </main>
    </div>
  );
}

/** /diagram/:mode; an unknown mode falls back to pf-as. */
export default function IdJagPlaygroundDiagramPage() {
  const asked = window.location.pathname.split("/")[2];
  const mode = PLAYGROUND_DIAGRAMS[asked] ? asked : "pf-as";
  return (
    <div className="ijx" data-testid="idjag-playground-diagram">
      <ReactFlowProvider>
        <PlaygroundFlow mode={mode} d={PLAYGROUND_DIAGRAMS[mode]} />
      </ReactFlowProvider>
    </div>
  );
}

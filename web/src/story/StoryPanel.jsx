import { useMemo, useState } from "react";
import { usePresent } from "../present/PresentMode";
import { VERTICALS, storyForMode, verticalById } from "./stories";
import { fillAll } from "./fill";
import { useCustomer } from "../customer/CustomerConfig";
import "./StoryPanel.css";

// The talk track: who the story is about, what to say at each step, and what proves it. Reads one story file
// and re-skins it with the chosen vertical. The Allowed/Blocked switch shows each step's blocked wording where it has any.

const KEYS = { vertical: "idjag.story.vertical", path: "idjag.story.path", open: "idjag.story.open" };
const read = (k, fallback) => { try { return localStorage.getItem(k) ?? fallback; } catch { return fallback; } };
const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage blocked: not remembered */ } };
const jump = (n) => document.getElementById(`ijp-step-${n}`)?.scrollIntoView?.({ behavior: "smooth", block: "start" });

export default function StoryPanel({ mode }) {
  const raw = storyForMode(mode);
  const customer = useCustomer();
  const [picked, setPicked] = useState(() => read(KEYS.vertical, null)); // the viewer's own choice; it beats the customer default
  const verticalId = picked ?? customer.vertical ?? "generic";
  const [path, setPath] = useState(() => (read(KEYS.path, "happy") === "blocked" ? "blocked" : "happy"));
  const [open, setOpen] = useState(() => read(KEYS.open, "open") !== "closed");
  const [localActive, setLocalActive] = useState(null);
  const presenter = usePresent(); // the shell holds the active step so the Step N of M bar and this list stay in sync
  const active = presenter ? presenter.active : localActive;
  const isOpen = open || !!presenter?.present; // presenter mode keeps the talk track open

  const vertical = verticalById(verticalId);
  const story = useMemo(() => (raw ? fillAll(raw, vertical, customer.persona) : null), [raw, vertical, customer.persona]);
  if (!story) return null;

  const blocked = path === "blocked";
  const current = story.steps.find((s) => s.n === active) || story.steps[0];
  const pickVertical = (id) => { setPicked(id); write(KEYS.vertical, id); };
  const pickPath = (p) => { setPath(p); write(KEYS.path, p); };
  const toggle = () => { setOpen(!open); write(KEYS.open, open ? "closed" : "open"); };
  const pickStep = (n) => { if (presenter) presenter.goTo(n); else { setLocalActive(n); jump(n); } };
  const text = (step) => (blocked && step.blocked ? step.blocked : step);

  return (
    <section className="story" aria-label="Talk track" data-testid="story-panel">
      <header className="story__head">
        <div>
          <p className="story__eyebrow">Story {story.id} · {vertical.displayName}</p>
          <h2 className="story__title">{story.title}</h2>
        </div>
        <button type="button" className="ijp-btn" aria-expanded={isOpen} onClick={toggle} disabled={!!presenter?.present}>{isOpen ? "Hide talk track" : "Show talk track"}</button>
      </header>
      {isOpen && (
        <>
          <div className="story__controls">
            <label className="story__field">Vertical
              <select value={vertical.id} onChange={(e) => pickVertical(e.target.value)}>
                {VERTICALS.map((v) => <option key={v.id} value={v.id}>{v.id === "generic" ? "Generic" : v.displayName}</option>)}
              </select>
            </label>
            <div className="ijp-seg" role="group" aria-label="Story path">
              <button type="button" aria-pressed={!blocked} onClick={() => pickPath("happy")}>Allowed</button>
              <button type="button" aria-pressed={blocked} onClick={() => pickPath("blocked")}>Blocked</button>
            </div>
          </div>
          <dl className="story__summary">
            <dt>Goal</dt><dd>{story.goal}</dd>
            <dt>Obstacle</dt><dd>{story.obstacle}</dd>
            <dt>Control</dt><dd>{story.control}</dd>
          </dl>
          <ol className="story__steps">
            {story.steps.map((s) => (
              <li key={s.n} className={s.n === current.n ? "is-current" : undefined}>
                <button type="button" className="story__step" aria-current={s.n === current.n ? "step" : undefined} onClick={() => pickStep(s.n)}>
                  <span className="story__n">{s.n}</span>{s.title}
                  {blocked && s.blocked && <span className="story__tag">blocked</span>}
                </button>
                {s.n === current.n && (
                  <div className="story__body">
                    <p>{text(s).tell}</p>
                    <p className="story__say"><strong>Say:</strong> “{text(s).say}”</p>
                    <p className="story__why"><strong>Why it matters:</strong> {s.why}</p>
                  </div>
                )}
              </li>
            ))}
          </ol>
          <p className="story__proof"><strong>Proof:</strong> {blocked ? story.proof.blocked : story.proof.happy}</p>
          <p className="story__takeaway">“{story.say}”</p>
        </>
      )}
    </section>
  );
}

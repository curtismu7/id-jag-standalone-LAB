import { useAppMode } from "./ModeContext";
import "./mode.css";

const MODES = [["mock", "Mock"], ["live", "Live"]];

/**
 * The Mock/Live switch, in the header of every page. aria-pressed marks the mode that is on. Live stays unavailable
 * (aria-disabled, still focusable) until the live settings exist; the banner under the header says what is missing.
 */
export function ModeToggle() {
  const m = useAppMode();
  if (!m) return null;
  const ready = m.status === "ready";
  return (
    <div className="mode-toggle" role="group" aria-label="Mock or live">
      <span className="mode-toggle__label" aria-hidden="true">Mode</span>
      {MODES.map(([id, label]) => {
        const blocked = id === "live" && ready && !m.live?.ready;
        return (
          <button key={id} type="button" className="mode-toggle__button" aria-pressed={ready && m.mode === id}
            aria-disabled={blocked || undefined} aria-describedby={blocked ? "mode-banner-hint" : undefined}
            disabled={!ready || m.switching} onClick={() => !blocked && m.choose(id)}>
            {label}
          </button>
        );
      })}
    </div>
  );
}

const NOTE = {
  mock: "Mock: a simulated PingFederate, resource authorization server and MCP server run inside this app. Every token is marked mock. Nothing leaves this machine.",
  live: "Live: requests go to the PingFederate, resource authorization server and MCP server named in this app's settings. Tokens are real.",
};

/** The simulation banner, on every page and in presenter mode. data-state is the mode that is on. */
export function ModeBanner() {
  const m = useAppMode();
  if (!m) return null;
  const state = m.status === "ready" ? m.mode : "unknown";
  const hints = [];
  if (m.status === "ready" && m.mode === "mock" && m.live && !m.live.ready) {
    hints.push(`Live is not available yet: set ${m.live.missing.join(", ")} in .env, then restart the server.`);
  }
  if (m.status === "ready" && m.mode === "mock" && m.signin && !m.signin.allowed) hints.push(m.signin.message);
  return (
    <div className="banner mode-banner" data-state={state} role="status" data-testid="mode-banner">
      <strong className="mode-banner__badge">{state === "mock" ? "MOCK" : state === "live" ? "LIVE" : "MODE"}</strong>
      <span className="mode-banner__text">
        {state === "unknown" ? (m.status === "loading" ? "Checking the mode…" : "Could not read the mode from the server.") : NOTE[state]}
      </span>
      {(hints.length > 0 || m.error) && (
        <span className="mode-banner__hint" id="mode-banner-hint" role={m.error ? "alert" : undefined}>{[...hints, m.error].filter(Boolean).join(" ")}</span>
      )}
    </div>
  );
}

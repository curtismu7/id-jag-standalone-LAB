import { useCallback, useEffect, useMemo, useState } from "react";
import api from "../services/api";
import "./AgentCorePanel.css";

// The "aws-agentcore" playground mode: the exchange issuer turns the caller token into an ID-JAG (leg 1, RFC 8693), the
// AgentCore leg's target issuer redeems it (leg 2, RFC 7523) and mints the runtime's access token, and the (mock) Bedrock
// AgentCore runtime runs one tool under the workload identity that token resolves to. The AWS side is a lab simulation:
// no AWS service is called. Every request here goes to in-process mocks (the server's /aws-agentcore routes). Every result
// on this page is what the last run returned; nothing shown as a result is a constant. ClientSecret is write-only: the
// server never sends it back, and the form only ever sends a value you typed.

const BASE = "/api/id-jag-playground/aws-agentcore";
const READING = "the lab's reading of a standard";

// The fields of each leg, in the order the engine lists them. secret: write-only. kind: how the form draws it.
const LEG1 = [
  { key: "TokenURL", hint: "where leg 1 is sent (the exchange issuer)" },
  { key: "ClientID", hint: "the runner's client at the exchange issuer" },
  { key: "ClientSecret", secret: true, hint: "write-only; used by client_secret_basic and client_secret_post" },
  { key: "AuthMethod", kind: "method", hint: "how the runner authenticates (values are the lab's reading)" },
  { key: "Resource", hint: "RFC 8707: becomes the aud of the ID-JAG. The lab sets it to the AgentCore target issuer" },
  { key: "Scope", hint: "scope asked for; empty asks for all the client may have" },
  { key: "SubjectTokenType", hint: "token type of the caller token" },
  { key: "RequestedTokenType", hint: "id-jag asks for an ID-JAG; access_token gets a plain token that cannot be redeemed" },
];
const LEG2 = [
  { key: "TokenURL", hint: "the AgentCore leg's own issuer" },
  { key: "ClientID", hint: "the client the ID-JAG names; the issuer refuses any other" },
  { key: "ClientSecret", secret: true, hint: "write-only; used by client_secret_post and client_secret_basic" },
  { key: "AuthMethod", kind: "method", hint: "the target issuer takes client_secret_post or client_secret_basic" },
  { key: "Scope", hint: "narrows the access token; empty keeps all the ID-JAG grants" },
];

const pretty = (v) => JSON.stringify(v, null, 2);
const errText = (e) => e.response?.data?.message || e.response?.data?.error || e.message;

function Json({ value }) {
  if (value === undefined || value === null) return null;
  return <pre className="ijp-json">{pretty(value)}</pre>;
}

/** A step section the story and presenter mode can jump to (id ijp-step-N), drawn like the playground's steps. */
function Section({ n, title, note, children }) {
  return (
    <section className="ijp-step" aria-labelledby={`ijp-step-${n}`}>
      <header className="ijp-step__head">
        <span className="ijp-step__n">{n}</span>
        <h2 id={`ijp-step-${n}`}>{title}</h2>
        <a className="ijp-diagram-link" href={`/diagram/aws-agentcore?step=${n}`} target="_blank" rel="noopener noreferrer">see step {n} on the diagram ↗</a>
      </header>
      {note && <p className="ijp-note">{note}</p>}
      {children}
    </section>
  );
}

function Tag({ children, title }) {
  return <span className="agentcore__tag" title={title}>{children}</span>;
}

function Verdict({ run }) {
  const v = run.verdict;
  return (
    <div className="agentcore__verdict" data-state={v.pass ? "ok" : "bad"} data-testid="ac-verdict" role="status">
      <strong>{v.pass ? "As expected" : "Not as expected"}: {run.label}.</strong> {run.why}
      <table className="agentcore__table">
        <thead><tr><th>Check</th><th>Expected</th><th>Observed</th></tr></thead>
        <tbody>
          {v.checks.map((c) => <tr key={c.what} data-state={c.want === c.got ? "ok" : "bad"}><td>{c.what}</td><td>{String(c.want)}</td><td>{String(c.got)}</td></tr>)}
        </tbody>
      </table>
    </div>
  );
}

/** One field of a leg: a label with its source tag, the input (never a value for a write-only field), and the hint. */
function Field({ leg, f, draft, set, spec, authMethods, disabled }) {
  const id = `ac-${leg}-${f.key}`;
  const server = spec?.[f.key];
  const typed = draft.secrets[`${leg}.${f.key}`] ?? "";
  const cleared = !!draft.clear[`${leg}.${f.key}`];
  const label = (
    <label htmlFor={id}>
      <span className="agentcore__name">{leg}.{f.key}</span>
      <Tag title={READING}>lab reading</Tag>
      {f.secret && <Tag title="write-only: the server never returns this value">write-only</Tag>}
    </label>
  );
  let input;
  if (f.secret) {
    input = (
      <>
        <input id={id} type="password" disabled={disabled || cleared} autoComplete="new-password" spellCheck={false} value={typed}
          placeholder={server?.set ? "set (write-only). Leave empty to keep it" : "not set"}
          onChange={(e) => set((d) => ({ ...d, secrets: { ...d.secrets, [`${leg}.${f.key}`]: e.target.value } }))} />
        <label className="ijp-check"><input type="checkbox" checked={cleared} disabled={disabled}
          onChange={(e) => set((d) => ({ ...d, clear: { ...d.clear, [`${leg}.${f.key}`]: e.target.checked } }))} />Clear it on save</label>
      </>
    );
  } else if (f.kind === "method") {
    input = (
      <select id={id} value={draft[leg][f.key]} disabled={disabled} onChange={(e) => set((d) => ({ ...d, [leg]: { ...d[leg], [f.key]: e.target.value } }))}>
        {authMethods.map((m) => <option key={m} value={m}>{m}</option>)}
      </select>
    );
  } else {
    input = <input id={id} value={draft[leg][f.key]} disabled={disabled} spellCheck={false} onChange={(e) => set((d) => ({ ...d, [leg]: { ...d[leg], [f.key]: e.target.value } }))} />;
  }
  return <div className="agentcore__field">{label}{input}<span className="ijp-cite">{f.hint}</span></div>;
}

/** The draft the form edits, from the masked spec the server sent. */
const draftFrom = (spec) => ({
  Exchange: Object.fromEntries(LEG1.filter((f) => !f.secret).map((f) => [f.key, spec.Exchange[f.key] ?? ""])),
  Redeem: Object.fromEntries(LEG2.filter((f) => !f.secret).map((f) => [f.key, spec.Redeem[f.key] ?? ""])),
  secrets: {},
  clear: {},
});

/** Only what changed: a typed secret replaces, a ticked Clear sends null, an untouched secret is left out. */
export function buildPatch(spec, draft) {
  const legPatch = (name, fields, current) => {
    const out = {};
    for (const f of fields) {
      const path = `${name}.${f.key}`;
      if (f.secret) {
        if (draft.clear[path]) out[f.key] = null;
        else if (draft.secrets[path]) out[f.key] = draft.secrets[path];
      } else if (draft[name][f.key] !== (current?.[f.key] ?? "")) out[f.key] = draft[name][f.key];
    }
    return out;
  };
  const exchange = legPatch("Exchange", LEG1, spec.Exchange);
  const redeem = legPatch("Redeem", LEG2, spec.Redeem);
  const patch = {};
  if (Object.keys(exchange).length) patch.Exchange = exchange;
  if (Object.keys(redeem).length) patch.Redeem = redeem;
  return Object.keys(patch).length ? patch : null;
}

function Hop({ h }) {
  return (
    <details className="agentcore__hop" data-state={h.blocked ? "bad" : h.status && h.status >= 400 ? "bad" : "ok"}>
      <summary>
        <span className="agentcore__n">{h.n}</span> {h.label}
        <span className="ijp-cite"> {h.method} {h.url} {h.blocked ? `refused before sending: ${h.blocked.kind}` : h.status ? `-> ${h.status}` : ""}</span>
      </summary>
      <p className="ijp-cite">{h.from} to {h.to} · traceparent <code>{h.traceparent}</code>{h.note ? ` · ${h.note}` : ""}</p>
      {h.blocked && <p className="ijp-banner ijp-banner--error" role="note">The runner did not send this: {h.blocked.reason}</p>}
      <div className="ijp-io">
        <div><h4>Request</h4><Json value={h.request} /></div>
        <div><h4>Response</h4><Json value={h.response ?? (h.blocked ? { blocked: h.blocked } : null)} /></div>
      </div>
    </details>
  );
}

const hopByLabel = (run, prefix) => run?.hops?.find((h) => h.label.startsWith(prefix));

export default function AgentCorePanel() {
  const [state, setState] = useState(null);
  const [draft, setDraft] = useState(null);
  const [run, setRun] = useState(null);
  const [results, setResults] = useState({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState(null);
  const [saveErrors, setSaveErrors] = useState([]);
  const [saved, setSaved] = useState("");

  const load = useCallback(async () => {
    try {
      const { data } = await api.get(`${BASE}/state`);
      if (!data?.spec) throw new Error("This server does not have the AWS AgentCore API. Start the API server that matches this page.");
      setState(data);
      setDraft(draftFrom(data.spec));
    } catch (e) { setError(errText(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const available = !!state?.available;
  const off = !available || !!busy || !draft;

  const save = async () => {
    const patch = buildPatch(state.spec, draft);
    if (!patch) { setSaved("No changes to save."); return; }
    setBusy("save"); setSaveErrors([]); setSaved(""); setError(null);
    try {
      const { data } = await api.put(`${BASE}/spec`, patch);
      setState((s) => ({ ...s, spec: data.spec }));
      setDraft(draftFrom(data.spec));
      setSaved("Saved. Write-only values were sent once and are not shown again.");
    } catch (e) {
      if (e.response?.status === 422) setSaveErrors(e.response.data.errors || []); else setError(errText(e));
    } finally { setBusy(""); }
  };
  const resetSpec = async () => {
    setBusy("reset"); setError(null); setSaveErrors([]); setSaved("");
    try {
      const { data } = await api.post(`${BASE}/spec/reset`);
      setState((s) => ({ ...s, spec: data.spec })); setDraft(draftFrom(data.spec)); setRun(null); setResults({});
      setSaved("The spec is back to the defaults.");
    } catch (e) { setError(errText(e)); } finally { setBusy(""); }
  };
  const runScenario = async (id) => {
    setBusy(`run-${id}`); setError(null);
    try {
      const { data } = await api.post(`${BASE}/run`, { scenario: id });
      setRun(data); setResults((r) => ({ ...r, [id]: data.verdict }));
      return data;
    } catch (e) { setError(errText(e)); return null; } finally { setBusy(""); }
  };
  const runLive = async () => {
    setBusy("run-live"); setError(null);
    try {
      const { data } = await api.post(`${BASE}/run-live`, {});
      setRun(data);
      return data;
    } catch (e) { setError(errText(e)); return null; } finally { setBusy(""); }
  };
  const runAll = async () => {
    for (const s of state.scenarios) { if (!(await runScenario(s.id))) break; }
  };

  const hops = useMemo(() => ({
    one: hopByLabel(run, "Leg 1"),
    two: hopByLabel(run, "Leg 2"),
    runtime: run?.hops?.find((h) => h.label.startsWith("Invoke")),
  }), [run]);

  if (error && !state) return <div className="ijp-banner ijp-banner--error" role="alert">{error}</div>;
  if (!state || !draft) return <p className="ijp-note">Loading…</p>;

  const refusalAt = (stage) => (run?.refusal?.stage === stage ? run.refusal : null);
  const refusal = (r) => r && (
    <div className="ijp-banner ijp-banner--error" role="alert" data-testid="ac-refusal">
      <strong>Refused at {r.stage}{r.kind && r.kind !== "oauth" ? ` (${r.kind})` : ""}:</strong> {r.error}{r.check ? ` · check: ${r.check}` : ""}. {r.description}
    </div>
  );

  return (
    <div className="agentcore" data-testid="agentcore">
      <div className="ijp-banner" role="note" data-testid="ac-simulated">
        <strong>A lab simulation of the AWS side.</strong> No AWS service is called and nothing here is a product test of AgentCore: the runtime, its workload identity and the tool are mocks inside this app. The ID-JAG hops are the same RFC 8693 and RFC 7523 shapes the live modes use.
      </div>
      {!available && (
        <div className="ijp-banner" role="note" data-testid="ac-live-note">
          <strong>Live: the ID-JAG hops run for real.</strong>{" "}
          {state.live && (
            <>
              Leg 1 exchanges your pf-as issuer session's refresh token at <code>{state.live.exchange.TokenURL || "(PF_URL unset)"}</code> (client <code>{state.live.exchange.ClientID || "(unset)"}</code>, ID-JAG aud <code>{state.live.exchange.Audience || "(RESOURCE_AS_ISSUER unset)"}</code>);
              leg 2 redeems the ID-JAG at the kit's resource-as <code>{state.live.redeem.TokenURL || "(unset)"}</code> (client <code>{state.live.redeem.ClientID || "(unset)"}</code>).
              {state.live.missing.length > 0 && <> Still missing: <strong>{state.live.missing.join(", ")}</strong>.</>}
              {state.live.runtime && <> Runtime: {state.live.runtime.reason}</>}
              {!state.live.signedIn && state.live.missing.length === 0 && <> Sign in at PingFederate first (step 1 of this page uses the pf-as sign-in).</>}
            </>
          )}
        </div>
      )}
      <p className="ijp-note" data-testid="ac-legend">
        Where each name comes from: <Tag title={READING}>lab reading</Tag> = our reading of RFC 8693 and RFC 7523.
        {" "}<Tag title="made up for this lab">lab-invented</Tag> = made up for the lab (the cast, the scenarios, the allow-list, the workload identity, the mock hosts).
      </p>

      <Section n={1} title="The agent hands its caller token to the runner" note={available ? "The mock exchange issuer signs the agent in as the user and issued the caller token. The runner starts from it and never sees the user's session." : "Live: the runner starts from your pf-as issuer session's refresh token — the same sign-in the PingFederate → resource AS mode uses. Sign in there (or in this mode's step 1), then run live."}>
        <div className="agentcore__bar">
          {available && <button type="button" className="ijp-btn ijp-btn--primary" disabled={off} onClick={() => runScenario("happy")} data-testid="ac-run-happy">{busy === "run-happy" ? "Running…" : "Run all three hops"}</button>}
          {!available && <button type="button" className="ijp-btn ijp-btn--primary" disabled={!!busy || !state?.live || state.live.missing.length > 0} onClick={runLive} data-testid="ac-run-live">{busy === "run-live" ? "Running…" : "Run live legs 1-2"}</button>}
          <span className="ijp-cite">User {state.cast.user} · agent client {state.cast.callerClient} · runtime {available ? state.cast.runtime : "the live runtime (not deployed yet)"}</span>
        </div>
        {error && <div className="ijp-banner ijp-banner--error" role="alert">{error}</div>}
        {run && run.verdict && <Verdict run={run} />}
        {run?.live && (
          <p className="ijp-status" data-state={run.redeemed ? "ok" : "bad"} data-testid="ac-live-result">
            Live run: {run.redeemed
              ? "leg 1 issued a real ID-JAG and leg 2 redeemed it for real (both decoded below); the runtime hop refused, so the redeemed access token was discarded."
              : `refused at ${run.refusal?.stage ?? "?"} (${run.refusal?.error ?? "unknown"}).`}
          </p>
        )}
        {run?.callerToken && <details className="agentcore__hop"><summary>The caller token (mock-issued, shown raw)</summary><Json value={run.callerToken.decoded} /></details>}
      </Section>

      <Section n={2} title="Leg 1: the runner exchanges the caller token for an ID-JAG" note="Exchange spec. RFC 8693 token exchange at Exchange.TokenURL; the result is an ID-JAG addressed to Exchange.Resource.">
        <fieldset className="agentcore__fieldset" disabled={off}>
          <legend>Exchange: the leg 1 spec</legend>
          <div className="agentcore__grid">
            {LEG1.map((f) => <Field key={f.key} leg="Exchange" f={f} draft={draft} set={setDraft} spec={state.spec.Exchange} authMethods={state.authMethods} disabled={off} />)}
          </div>
        </fieldset>
        {run && hops.one && (
          <div className="agentcore__result" data-testid="ac-leg1">
            <h3>Leg 1 as sent, and what came back</h3>
            <div className="ijp-io">
              <div><h4>Request</h4><Json value={hops.one.request} /></div>
              <div><h4>Response</h4><Json value={hops.one.response ?? (hops.one.blocked ? { blocked: hops.one.blocked } : null)} /></div>
            </div>
            {run.leg1 && <><h4>The ID-JAG, decoded <span className="ijp-cite">({run.live ? "real PingFederate, " : "mock-issued, "}issued_token_type {run.leg1.issuedTokenType}{run.leg1.isIdJag ? ", typ oauth-id-jag+jwt" : ", NOT an ID-JAG"})</span></h4><Json value={run.leg1.decoded} /></>}
          </div>
        )}
        {refusal(refusalAt("leg1"))}
      </Section>

      <Section n={3} title="Leg 2: the runner redeems it at the AgentCore target issuer" note="Redeem spec. RFC 7523 jwt-bearer at the target issuer. It mints the runtime's access token with act (who acts for the user) and the workload identity (wid, lab-invented).">
        <fieldset className="agentcore__fieldset" disabled={off}>
          <legend>Redeem: the leg 2 spec</legend>
          <div className="agentcore__grid">
            {LEG2.map((f) => <Field key={f.key} leg="Redeem" f={f} draft={draft} set={setDraft} spec={state.spec.Redeem} authMethods={state.authMethods} disabled={off} />)}
          </div>
        </fieldset>
        <div className="agentcore__bar">
          <button type="button" className="ijp-btn ijp-btn--primary" disabled={off} onClick={save} data-testid="ac-save">{busy === "save" ? "Saving…" : "Save the spec"}</button>
          <button type="button" className="ijp-btn" disabled={off} onClick={resetSpec} data-testid="ac-reset-spec">Reset the spec</button>
          <span className="ijp-cite" role="status" data-testid="ac-saved">{saved}</span>
        </div>
        {saveErrors.length > 0 && (
          <div className="ijp-banner ijp-banner--error" role="alert" data-testid="ac-save-errors">
            The spec was not changed:
            <ul>{saveErrors.map((e) => <li key={`${e.field}-${e.message}`}><code>{e.field}</code> {e.message}</li>)}</ul>
          </div>
        )}
        {run && hops.two && (
          <div className="agentcore__result" data-testid="ac-leg2">
            <h3>Leg 2 as sent, and what came back</h3>
            <div className="ijp-io">
              <div><h4>Request</h4><Json value={hops.two.request} /></div>
              <div><h4>Response</h4><Json value={hops.two.response ?? (hops.two.blocked ? { blocked: hops.two.blocked } : null)} /></div>
            </div>
            {run.leg2 && <><h4>The runtime's access token, decoded <span className="ijp-cite">({run.live ? "minted by the kit's resource-as (real)" : "minted by the AgentCore target issuer"})</span></h4><Json value={run.leg2.decoded} /></>}
          </div>
        )}
        {refusal(refusalAt("leg2"))}
        {run?.replay && (
          <div className="agentcore__result" data-testid="ac-replay">
            <h4>Replay of the same ID-JAG</h4>
            <p>{run.replay.accepted ? "The target issuer accepted it a second time." : `Refused: ${run.replay.refusal?.error} · check: ${run.replay.refusal?.check}. ${run.replay.refusal?.description}`}</p>
          </div>
        )}
        {run?.targetIssuerEvents?.length > 0 && (
          <details className="agentcore__hop"><summary>What the target issuer recorded</summary><Json value={run.targetIssuerEvents} /></details>
        )}
      </Section>

      <Section n={4} title="The runtime runs the tool under the workload identity" note={available ? "The runner invokes the mock runtime with the access token the target issuer minted. The runtime verifies it against its own issuer's keys and resolves the workload identity (wid)." : "Live: the runner calls the MCP resource server the redeemed token names (MCP_URL - the dev-live mcp-sample, or the owner-run AgentCore runtime's MCP endpoint). With no MCP_URL the run stops after leg 2."}>
        {run?.runtime ? (
          <div className="agentcore__result" data-testid="ac-runtime">
            {run.runtime.tools ? (
              <>
                <p className="ijp-status" data-state="ok">The MCP tool server answered: the redeemed token authorized the call. {run.runtime.tools.length} tool{run.runtime.tools.length === 1 ? "" : "s"} visible at <code>{run.runtime.tool}</code>.</p>
                <Json value={run.runtime.tools} />
              </>
            ) : (
              <div className="agentcore__result" data-testid="ac-runtime">
                <p className="ijp-status" data-state={run.runtime.status === 200 ? "ok" : "bad"}>The runtime answered {run.runtime.status}{run.runtime.body?.principal ? `: it sees ${run.runtime.body.principal.sub}${run.runtime.body.principal.act ? `, acting for ${run.runtime.body.principal.act.sub}` : ""}` : ""}{run.runtime.body?.workloadIdentity ? ` · workload identity ${run.runtime.body.workloadIdentity}` : ""}.</p>
                <Json value={run.runtime.body} />
              </div>
            )}
          </div>
        ) : run?.live ? <p className="ijp-note" data-testid="ac-live-runtime-note">The live run stops here: {run.refusal?.description || "no MCP resource server is named"}.</p> : <p className="ijp-note">Run all three hops to see the runtime's answer.</p>}
        {refusal(refusalAt("runtime"))}
      </Section>

      {!available && (
        <Section n={5} title="Live: what a run proves, and what it cannot yet" note="Live mode has no mock scenarios: the mock-only scenarios below are hidden.">
          <p className="ijp-note">A live run proves: PingFederate issued an ID-JAG from your pf-as session (leg 1), the kit's resource-as redeemed it and minted an access token (leg 2), and the redeemed token authorized a real MCP tool call (leg 3) — real tokens shown decoded, never leaving the server. Without MCP_URL the run stops after leg 2 at stage <code>runtime</code>.</p>
        </Section>
      )}

      {available && (
      <Section n={5} title="What the runtime refuses, and the scenarios" note="Each scenario breaks one thing and shows the stage and the check that refused it. The verdict compares what was expected with what the run did.">
        {run?.controls?.length > 0 && (
          <div className="agentcore__result" data-testid="ac-controls">
            <h4>Controls in the last run</h4>
            <table className="agentcore__table">
              <thead><tr><th>Presented to the runtime</th><th>Answer</th><th>Check that failed</th></tr></thead>
              <tbody>{run.controls.map((c) => <tr key={c.label} data-state={c.status === 401 ? "ok" : "bad"}><td>{c.label}</td><td>{c.status} {c.error}</td><td>{c.failedCheck || "none"}</td></tr>)}</tbody>
            </table>
          </div>
        )}
        <div className="agentcore__bar">
          <button type="button" className="ijp-btn" disabled={off} onClick={runAll} data-testid="ac-run-all">{busy.startsWith("run-") ? "Running…" : "Run all scenarios"}</button>
          <Tag title="made up for this lab">lab-invented</Tag>
        </div>
        <ul className="ijp-negatives" data-testid="ac-scenarios">
          {state.scenarios.map((s) => (
            <li key={s.id} data-state={results[s.id] ? (results[s.id].pass ? "ok" : "bad") : "idle"}>
              <div>
                <strong>{s.label}</strong>
                <p>{s.why}</p>
                {results[s.id] && <p className="ijp-result" data-testid={`ac-result-${s.id}`}>{results[s.id].pass ? "Pass" : "Fail"}: {results[s.id].checks.map((c) => `${c.what} ${c.got}`).join(", ")}</p>}
              </div>
              <button type="button" className="ijp-btn" disabled={off} onClick={() => runScenario(s.id)} data-testid={`ac-scenario-run-${s.id}`}>Run</button>
            </li>
          ))}
        </ul>
        {run?.hops && (
          <details className="agentcore__trace" data-testid="ac-trace">
            <summary>Trace: every hop of the last run, one trace id {run.traceparent.split("-")[1]}</summary>
            {run.hops.map((h) => <Hop key={h.n} h={h} />)}
          </details>
        )}
        <details className="agentcore__trace" data-testid="ac-claims">
          <summary>Where every claim on this page comes from</summary>
          <div className="ijp-checks">
            <table>
              <thead><tr><th>Claim</th><th>Source</th></tr></thead>
              <tbody>{state.claims.map((c) => <tr key={c.id}><td>{c.text}</td><td>{c.tag}</td></tr>)}</tbody>
            </table>
          </div>
        </details>
        <p className="ijp-cite">Allow-list (lab-invented): {state.allowList.map((o) => new URL(o).host).join(", ")}. Anything else is refused before a request is made.</p>
      </Section>
      )}
    </div>
  );
}

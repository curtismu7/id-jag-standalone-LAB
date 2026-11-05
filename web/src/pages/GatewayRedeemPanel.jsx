import { useCallback, useEffect, useMemo, useState } from "react";
import api from "../services/api";
import "./GatewayRedeemPanel.css";

// The "gateway-redeem" playground mode: the Privilege MCP gateway exchanges the caller's token (leg 1) and, when a Redeem spec with a
// TokenURL is set, redeems the result at the target app's own issuer (leg 2). Leg 1 measured on our tenant 2026-11-05 (gateway
// v1.261102: "[mcpgw] obo exchange ok …" on a test app with AuthMode obo — see AI-DEMO2-internal/privilege/OBO-REDEEM-VERIFICATION-
// 2026-11-05.md); leg 2 (Redeem) and every request on THIS page remain UNVERIFIED: everything here goes to in-process mocks (the
// server's /gateway-redeem routes). Every result on this page is what the last run returned; nothing shown as a result is a constant.
// ClientSecret and PrivateKeyPEM are write-only: the server never sends them back, and the form only ever sends a value you typed.

const BASE = "/api/id-jag-playground/gateway-redeem";
export const CLAIM = "Ping release claim (2026-11-02); leg 1 (OBO exchange) measured on our tenant 2026-11-05, leg 2 (Redeem) and this page's mocks UNVERIFIED";
const SWAGGER = "console swagger name, 2026-10-31, schema only";

// The fields of each leg, in the order the swagger lists them. secret: write-only. kind: how the form draws it.
const LEG1 = [
  { key: "TokenURL", hint: "where leg 1 is sent (the exchange issuer)" },
  { key: "ClientID", hint: "the gateway's client at the exchange issuer" },
  { key: "ClientSecret", secret: true, hint: "write-only; used by client_secret_basic and client_secret_post" },
  { key: "AuthMethod", kind: "method", hint: "how the gateway authenticates (values are the lab's reading)" },
  { key: "Resource", hint: "RFC 8707: becomes the aud of the ID-JAG. The lab sets it to the target app's issuer" },
  { key: "Scope", hint: "scope asked for; empty asks for all the client may have" },
  { key: "PrivateKeyPEM", secret: true, kind: "pem", hint: "write-only; signs the client assertion for private_key_jwt" },
  { key: "KeyID", hint: "kid of the client assertion for private_key_jwt" },
  { key: "SubjectTokenType", hint: "token type of the caller token" },
  { key: "RequestedTokenType", hint: "id-jag asks for an ID-JAG; access_token gets a plain token that cannot be redeemed" },
];
const LEG2 = [
  { key: "TokenURL", hint: "the TARGET APP'S OWN issuer. Empty means no leg 2" },
  { key: "ClientID", hint: "the gateway's client at the target issuer" },
  { key: "ClientSecret", secret: true, hint: "write-only; used by client_secret_post" },
  { key: "AuthMethod", kind: "method", hint: "the target issuer takes client_secret_post or private_key_jwt" },
  { key: "Scope", hint: "narrows the access token; empty keeps all the ID-JAG grants" },
  { key: "PrivateKeyPEM", secret: true, kind: "pem", hint: "write-only; signs the client assertion for private_key_jwt" },
  { key: "KeyID", hint: "kid of the client assertion for private_key_jwt" },
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
        <a className="ijp-diagram-link" href={`/diagram/gateway-redeem?step=${n}`} target="_blank" rel="noopener noreferrer">see step {n} on the diagram ↗</a>
      </header>
      {note && <p className="ijp-note">{note}</p>}
      {children}
    </section>
  );
}

function Tag({ children, title }) {
  return <span className="gateway-redeem__tag" title={title}>{children}</span>;
}

function Verdict({ run }) {
  const v = run.verdict;
  return (
    <div className="gateway-redeem__verdict" data-state={v.pass ? "ok" : "bad"} data-testid="gr-verdict" role="status">
      <strong>{v.pass ? "As expected" : "Not as expected"}: {run.label}.</strong> {run.why}
      <table className="gateway-redeem__table">
        <thead><tr><th>Check</th><th>Expected</th><th>Observed</th></tr></thead>
        <tbody>
          {v.checks.map((c) => <tr key={c.what} data-state={c.want === c.got ? "ok" : "bad"}><td>{c.what}</td><td>{String(c.want)}</td><td>{String(c.got)}</td></tr>)}
        </tbody>
      </table>
    </div>
  );
}

/** One field of a leg: a label with its swagger tag, the input (never a value for a write-only field), and the hint. */
function Field({ leg, f, draft, set, spec, authMethods, disabled }) {
  const id = `gr-${leg}-${f.key}`;
  const server = spec?.[f.key];
  const typed = draft.secrets[`${leg}.${f.key}`] ?? "";
  const cleared = !!draft.clear[`${leg}.${f.key}`];
  const label = (
    <label htmlFor={id}>
      <span className="gateway-redeem__name">{leg === "OBO" ? "OBO" : "OBO.Redeem"}.{f.key}</span>
      <Tag title={SWAGGER}>swagger name</Tag>
      {f.secret && <Tag title="write-only: the server never returns this value">write-only</Tag>}
    </label>
  );
  let input;
  if (f.secret) {
    const props = { id, disabled: disabled || cleared, autoComplete: "new-password", spellCheck: false, value: typed,
      placeholder: server?.set ? "set (write-only). Leave empty to keep it" : "not set",
      onChange: (e) => set((d) => ({ ...d, secrets: { ...d.secrets, [`${leg}.${f.key}`]: e.target.value } })) };
    input = (
      <>
        {f.kind === "pem" ? <textarea {...props} rows={3} className="gateway-redeem__masked" /> : <input {...props} type="password" />}
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
  return <div className="gateway-redeem__field">{label}{input}<span className="ijp-cite">{f.hint}</span></div>;
}

/** The draft the form edits, from the masked spec the server sent. */
const draftFrom = (spec) => ({
  OBO: Object.fromEntries(LEG1.filter((f) => !f.secret).map((f) => [f.key, spec.OBO[f.key] ?? ""])),
  Redeem: Object.fromEntries(LEG2.filter((f) => !f.secret).map((f) => [f.key, spec.OBO.Redeem?.[f.key] ?? ""])),
  redeemOn: !!spec.OBO.Redeem,
  secrets: {},
  clear: {},
});

/** Only what changed: a typed secret replaces, a ticked Clear sends null, an untouched secret is left out. */
export function buildPatch(spec, draft) {
  const leg = (name, fields, current) => {
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
  const obo = leg("OBO", LEG1, spec.OBO);
  if (!draft.redeemOn) { if (spec.OBO.Redeem) obo.Redeem = null; }
  else {
    const r = leg("Redeem", LEG2, spec.OBO.Redeem);
    if (!spec.OBO.Redeem || Object.keys(r).length) obo.Redeem = r;
  }
  return Object.keys(obo).length ? { OBO: obo } : null;
}

function Hop({ h }) {
  return (
    <details className="gateway-redeem__hop" data-state={h.blocked ? "bad" : h.status && h.status >= 400 ? "bad" : "ok"}>
      <summary>
        <span className="gateway-redeem__n">{h.n}</span> {h.label}
        <span className="ijp-cite"> {h.method} {h.url} {h.blocked ? `refused before sending: ${h.blocked.kind}` : h.status ? `-> ${h.status}` : ""}</span>
      </summary>
      <p className="ijp-cite">{h.from} to {h.to} · traceparent <code>{h.traceparent}</code>{h.note ? ` · ${h.note}` : ""}</p>
      {h.blocked && <p className="ijp-banner ijp-banner--error" role="note">The gateway did not send this: {h.blocked.reason}</p>}
      <div className="ijp-io">
        <div><h4>Request</h4><Json value={h.request} /></div>
        <div><h4>Response</h4><Json value={h.response ?? (h.blocked ? { blocked: h.blocked } : null)} /></div>
      </div>
    </details>
  );
}

const leg = (run, prefix) => run?.hops?.find((h) => h.label.startsWith(prefix));

export default function GatewayRedeemPanel() {
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
      if (!data?.spec) throw new Error("This server does not have the gateway redeem API. Start the API server that matches this page.");
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
  const runAll = async () => {
    for (const s of state.scenarios) { if (!(await runScenario(s.id))) break; }
  };

  const legs = useMemo(() => ({ one: leg(run, "Leg 1"), two: leg(run, "Leg 2"), api: run?.hops?.find((h) => h.label.startsWith("Call the target")) }), [run]);

  if (error && !state) return <div className="ijp-banner ijp-banner--error" role="alert">{error}</div>;
  if (!state || !draft) return <p className="ijp-note">Loading…</p>;

  const refusalAt = (stage) => (run?.refusal?.stage === stage ? run.refusal : null);
  const refusal = (r) => r && (
    <div className="ijp-banner ijp-banner--error" role="alert" data-testid="gr-refusal">
      <strong>Refused at {r.stage}{r.kind && r.kind !== "oauth" ? ` (${r.kind})` : ""}:</strong> {r.error}{r.check ? ` · check: ${r.check}` : ""}. {r.description}
    </div>
  );

  return (
    <div className="gateway-redeem" data-testid="gateway-redeem">
      <div className="ijp-banner" role="note" data-testid="gr-claim">
        <strong>{CLAIM}.</strong> The Privilege release of 2026-11-02 is not on our tenant. Everything on this page runs against mocks inside this app and nothing leaves this machine.
        Only PingFederate supports ID-JAG and DPoP in this lab family; this mode shows the gateway side of the claim, it does not test a product.
      </div>
      {!available && (
        <div className="ijp-banner ijp-banner--error" role="alert" data-testid="gr-live-unavailable">
          <strong>Live is unavailable for this mode.</strong> {state.reason} Switch the header toggle to Mock to run it.
        </div>
      )}
      <p className="ijp-note" data-testid="gr-legend">
        Where each name comes from: <Tag title={SWAGGER}>swagger name</Tag> = {SWAGGER}. <Tag title="the lab's reading of a standard or the release">lab reading</Tag> = our reading of RFC 8693, RFC 7523 and the release.
        {" "}<Tag title="made up for this lab">lab-invented</Tag> = made up for the lab (the cast, the ten scenarios, the allow-list, the mock hosts).
      </p>

      <Section n={1} title="The agent calls the gateway with the caller token" note="The mock company IdP signs the agent in as the user and issues the caller token. The gateway checks it before it does anything else.">
        <div className="gateway-redeem__bar">
          <button type="button" className="ijp-btn ijp-btn--primary" disabled={off} onClick={() => runScenario("happy")} data-testid="gr-run-happy">{busy === "run-happy" ? "Running…" : "Run both legs"}</button>
          <span className="ijp-cite">User {state.cast.user} · agent client {state.cast.callerClient} · gateway {state.cast.gateway}</span>
        </div>
        {error && <div className="ijp-banner ijp-banner--error" role="alert">{error}</div>}
        {run && <Verdict run={run} />}
        {run?.callerToken && <details className="gateway-redeem__hop"><summary>The caller token (mock-issued, shown raw)</summary><Json value={run.callerToken.decoded} /></details>}
        {refusal(refusalAt("caller"))}
      </Section>

      <Section n={2} title="Leg 1: the gateway exchanges the caller token for an ID-JAG" note="OBO spec (modelMcpOBOSpec). RFC 8693 token exchange at OBO.TokenURL; the result is an ID-JAG addressed to OBO.Resource.">
        <fieldset className="gateway-redeem__fieldset" disabled={off}>
          <legend>OBO: the On-Behalf-Of spec</legend>
          <div className="gateway-redeem__grid">
            {LEG1.map((f) => <Field key={f.key} leg="OBO" f={f} draft={draft} set={setDraft} spec={state.spec.OBO} authMethods={state.authMethods} disabled={off} />)}
          </div>
        </fieldset>
        {run && legs.one && (
          <div className="gateway-redeem__result" data-testid="gr-leg1">
            <h3>Leg 1 as sent, and what came back</h3>
            <div className="ijp-io">
              <div><h4>Request</h4><Json value={legs.one.request} /></div>
              <div><h4>Response</h4><Json value={legs.one.response ?? (legs.one.blocked ? { blocked: legs.one.blocked } : null)} /></div>
            </div>
            {run.leg1 && <><h4>The ID-JAG, decoded <span className="ijp-cite">(mock-issued, issued_token_type {run.leg1.issuedTokenType})</span></h4><Json value={run.leg1.decoded} /></>}
          </div>
        )}
        {refusal(refusalAt("leg1"))}
      </Section>

      <Section n={3} title="Leg 2: the gateway redeems it at the target app's own issuer" note="Redeem spec (modelMcpOBORedeemSpec). Only when Redeem.TokenURL is set: RFC 7523 jwt-bearer at the target app's issuer. Without it the exchange result is not redeemed.">
        <label className="ijp-check" htmlFor="gr-redeem-on">
          <input id="gr-redeem-on" type="checkbox" checked={draft.redeemOn} disabled={off} onChange={(e) => setDraft((d) => ({ ...d, redeemOn: e.target.checked }))} />
          <span className="gateway-redeem__name">OBO.Redeem</span> <Tag title={SWAGGER}>swagger name</Tag> send the second leg
        </label>
        <fieldset className="gateway-redeem__fieldset" disabled={off || !draft.redeemOn}>
          <legend>Redeem: the second leg</legend>
          <div className="gateway-redeem__grid">
            {LEG2.map((f) => <Field key={f.key} leg="Redeem" f={f} draft={draft} set={setDraft} spec={state.spec.OBO.Redeem} authMethods={state.authMethods} disabled={off || !draft.redeemOn} />)}
          </div>
        </fieldset>
        <div className="gateway-redeem__bar">
          <button type="button" className="ijp-btn ijp-btn--primary" disabled={off} onClick={save} data-testid="gr-save">{busy === "save" ? "Saving…" : "Save the spec"}</button>
          <button type="button" className="ijp-btn" disabled={off} onClick={resetSpec} data-testid="gr-reset-spec">Reset the spec</button>
          <span className="ijp-cite" role="status" data-testid="gr-saved">{saved}</span>
        </div>
        {saveErrors.length > 0 && (
          <div className="ijp-banner ijp-banner--error" role="alert" data-testid="gr-save-errors">
            The spec was not changed:
            <ul>{saveErrors.map((e) => <li key={`${e.field}-${e.message}`}><code>{e.field}</code> {e.message}</li>)}</ul>
          </div>
        )}
        {run && run.leg1 && !legs.two && (
          <p className="ijp-status" data-testid="gr-no-leg2">No second leg: Redeem.TokenURL is not set, so the exchange result was not redeemed.</p>
        )}
        {run && legs.two && (
          <div className="gateway-redeem__result" data-testid="gr-leg2">
            <h3>Leg 2 as sent, and what came back</h3>
            <div className="ijp-io">
              <div><h4>Request</h4><Json value={legs.two.request} /></div>
              <div><h4>Response</h4><Json value={legs.two.response ?? (legs.two.blocked ? { blocked: legs.two.blocked } : null)} /></div>
            </div>
            {run.leg2 && <><h4>The access token, decoded <span className="ijp-cite">(minted by the target app's issuer)</span></h4><Json value={run.leg2.decoded} /></>}
          </div>
        )}
        {refusal(refusalAt("leg2"))}
        {run?.replay && (
          <div className="gateway-redeem__result" data-testid="gr-replay">
            <h4>Replay of the same assertion</h4>
            <p>{run.replay.accepted ? "The target issuer accepted it a second time." : `Refused: ${run.replay.refusal?.error} · check: ${run.replay.refusal?.check}. ${run.replay.refusal?.description}`}</p>
          </div>
        )}
        {run?.targetIssuerEvents?.length > 0 && (
          <details className="gateway-redeem__hop"><summary>What the target app's issuer recorded</summary><Json value={run.targetIssuerEvents} /></details>
        )}
      </Section>

      <Section n={4} title="The target app's API sees the user" note="The gateway calls the API with the access token the target issuer minted. The API verifies it against its own issuer's keys.">
        {run?.target ? (
          <div className="gateway-redeem__result" data-testid="gr-target">
            <p className="ijp-status" data-state={run.target.status === 200 ? "ok" : "bad"}>The API answered {run.target.status}{run.target.body?.principal ? `: it sees ${run.target.body.principal.sub}${run.target.body.principal.act ? `, acting for ${run.target.body.principal.act.sub}` : ""}` : ""}.</p>
            <Json value={run.target.body} />
          </div>
        ) : <p className="ijp-note">Run both legs to see the API's answer.</p>}
        {refusal(refusalAt("target"))}
      </Section>

      <Section n={5} title="What the target API refuses, and the ten scenarios" note="Each scenario breaks one thing and shows the stage and the check that refused it. The verdict compares what was expected with what the run did.">
        {run?.controls?.length > 0 && (
          <div className="gateway-redeem__result" data-testid="gr-controls">
            <h4>Controls in the last run</h4>
            <table className="gateway-redeem__table">
              <thead><tr><th>Presented to the API</th><th>Answer</th><th>Check that failed</th></tr></thead>
              <tbody>{run.controls.map((c) => <tr key={c.label} data-state={c.status === 401 ? "ok" : "bad"}><td>{c.label}</td><td>{c.status} {c.error}</td><td>{c.failedCheck || "none"}</td></tr>)}</tbody>
            </table>
          </div>
        )}
        <div className="gateway-redeem__bar">
          <button type="button" className="ijp-btn" disabled={off} onClick={runAll} data-testid="gr-run-all">{busy.startsWith("run-") ? "Running…" : "Run all ten"}</button>
          <Tag title="made up for this lab">lab-invented</Tag>
        </div>
        <ul className="ijp-negatives" data-testid="gr-scenarios">
          {state.scenarios.map((s) => (
            <li key={s.id} data-state={results[s.id] ? (results[s.id].pass ? "ok" : "bad") : "idle"}>
              <div>
                <strong>{s.label}</strong>
                <p>{s.why}</p>
                {results[s.id] && <p className="ijp-result" data-testid={`gr-result-${s.id}`}>{results[s.id].pass ? "Pass" : "Fail"}: {results[s.id].checks.map((c) => `${c.what} ${c.got}`).join(", ")}</p>}
              </div>
              <button type="button" className="ijp-btn" disabled={off} onClick={() => runScenario(s.id)} data-testid={`gr-scenario-run-${s.id}`}>Run</button>
            </li>
          ))}
        </ul>
        {run?.hops && (
          <details className="gateway-redeem__trace" data-testid="gr-trace">
            <summary>Trace: every hop of the last run, one trace id {run.traceparent.split("-")[1]}</summary>
            {run.hops.map((h) => <Hop key={h.n} h={h} />)}
          </details>
        )}
        <details className="gateway-redeem__trace" data-testid="gr-claims">
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
    </div>
  );
}

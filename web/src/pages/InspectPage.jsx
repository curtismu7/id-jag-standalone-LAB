import { useCallback, useEffect, useState } from "react";
import "./console.css";
import terms from "../data/terms.json";
import api from "../services/api";

// Inspector: paste any token and see the spec checks, each backend's discovery metadata, and the resource AS's own
// decision record. All of it comes from /api/inspect (server/src/inspectApi.js); nothing is stored.

const TABS = [["decode", "Decode & check"], ["log", "Live log"]];
const ISSUE_URL = "/api/id-jag-playground/issue"; // the playground's own issue route: the only place an ID-JAG is minted
const HELD_HINT = "ID-JAG issued and held on the server. Use Decode and check, or Show token to see it.";
const TYPE_LABEL = { "id-jag": "ID-JAG", "id-token": "ID token", "access-token": "Access token", saml: "SAML assertion", unknown: "not recognised" };
const STATUS = { pass: ["approved", "✓ Pass"], warn: ["pending", "! Warning"], fail: ["rejected", "✕ Fail"] };
// Check id -> glossary term id (checks without a glossary term have no link).
export const CHECK_TERMS = {
  typ: "id-jag", "trusted-idp": "idp-authorization-server", "idp-target": "idp-authorization-server", iss: "idp-authorization-server",
  aud: "resource-authorization-server", client_id: "strict-client-binding", replay: "jti-replay",
};
const termName = (id) => terms.find((t) => t.id === id)?.term;
const errText = (e) => e.response?.data?.message || e.response?.data?.error || e.message;
const json = (v) => JSON.stringify(v, null, 2);
const FILTERS = [["All", null], ["Redeem", "accepted"], ["Denied", "refused"]];

function Decode() {
  const [token, setToken] = useState("");
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [signIn, setSignIn] = useState(false);
  const [held, setHeld] = useState(false); // a minted ID-JAG stays on the server unless the user asks to see it
  const [revealed, setRevealed] = useState("");
  const decode = async (body) => {
    setError(""); setSignIn(false); setResult(null);
    try { setResult((await api.post("/api/inspect/decode", body)).data); } catch (e) { setError(errText(e)); }
  };
  const run = () => decode(held ? { fromSession: true } : { token: token.trim() });
  const getJag = async () => {
    setError(""); setSignIn(false); setResult(null);
    try { await api.post(ISSUE_URL, {}); } catch (e) {
      if (e.response?.data?.error === "sign_in_required") setSignIn(true); else setError(errText(e));
      return;
    }
    setToken(""); setHeld(true); setRevealed("");
    await decode({ fromSession: true });
  };
  const reveal = async () => {
    setError("");
    try { setRevealed((await api.post("/api/inspect/decode", { fromSession: true, reveal: true })).data.token); } catch (e) { setError(errText(e)); }
  };
  return (
    <section className="kc-guide" aria-label="Decode and check">
      <div className="kc-actions"><button type="button" className="kc-btn kc-btn--primary" onClick={getJag}>Get an ID-JAG</button></div>
      {signIn && <div className="kc-banner kc-banner--error" role="alert">Sign in first: <a href="/">go to the playground sign-in step</a>.</div>}
      {held && !revealed && <div className="kc-actions"><button type="button" className="kc-btn" onClick={reveal}>Show token</button></div>}
      {revealed && (
        <>
          <label className="kc-field">ID-JAG (raw)
            <textarea readOnly value={revealed} rows={5} spellCheck={false} />
          </label>
          <div className="kc-actions"><button type="button" className="kc-btn" onClick={() => navigator.clipboard?.writeText(revealed)}>Copy</button></div>
        </>
      )}
      <p className="kc-note">or paste a token from another tool</p>
      <label className="kc-field">Token
        <textarea value={token} rows={5} spellCheck={false} onChange={(e) => { setToken(e.target.value); setHeld(false); setRevealed(""); }}
          placeholder={held ? HELD_HINT : "An ID token, ID-JAG, access token (JWT) or a SAML assertion"} />
      </label>
      <div className="kc-actions"><button type="button" className="kc-btn" disabled={!held && !token.trim()} onClick={run}>Decode and check</button></div>
      {error && <div className="kc-banner kc-banner--error" role="alert">{error}</div>}
      {result && (
        <>
          <p><strong>Detected: {TYPE_LABEL[result.type]}</strong>{result.idp && ` · issuer: trusted IdP "${result.idp.name}"`}</p>
          {result.type === "unknown" && <p>This is neither a compact JWT nor a SAML assertion.</p>}
          {result.checks.length > 0 && (
            <div className="kc-table-wrap">
              <table className="kc-table">
                <thead><tr><th>Result</th><th>Check</th><th>Expected</th><th>Actual</th><th>Reference</th><th>Glossary</th></tr></thead>
                <tbody>
                  {result.checks.map((c) => {
                    const [cls, text] = STATUS[c.status];
                    const term = CHECK_TERMS[c.id];
                    return (
                      <tr key={c.id}>
                        <td><span className={`kc-badge kc-badge--${cls}`}>{text}</span></td>
                        <td>{c.label}</td><td>{String(c.expected ?? "")}</td><td>{String(c.actual ?? "")}</td><td>{c.cite}</td>
                        <td>{term && <a href={`/learn#term-${term}`}>{termName(term)}</a>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {result.header && <><h2>Header</h2><pre className="kc-code">{json(result.header)}</pre></>}
          {result.claims && <><h2>Claims</h2><pre className="kc-code">{json(result.claims)}</pre></>}
          {result.assertion && <><h2>Assertion</h2><pre className="kc-code">{result.assertion.xml}</pre></>}
        </>
      )}
    </section>
  );
}

function Backends() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setError("");
    try { setData((await api.get("/api/inspect/discovery")).data.backends); } catch (e) { setError(errText(e)); }
  }, []);
  return (
    <details className="kc-guide" aria-label="Backends" onToggle={(e) => { if (e.currentTarget.open && !data) load(); }}>
      <summary>Backends (discovery metadata)</summary>
      <p className="kc-note">
        MCP clients look for <code>authorization_grant_profiles_supported</code> and <code>scopes_supported</code> in this metadata
        (MCP enterprise-managed authorization). The marks below show whether each backend publishes them.
      </p>
      <div className="kc-actions"><button type="button" className="kc-btn" onClick={load}>Refresh</button></div>
      {error && <div className="kc-banner kc-banner--error" role="alert">{error}</div>}
      {data?.map((b) => (
        <div key={b.id} className="kc-card">
          <h2>{b.label}</h2>
          <p><code>{b.url}</code></p>
          {b.error ? <div className="kc-banner kc-banner--error" role="alert">Could not fetch: {b.error}</div> : (
            <>
              <ul>{Object.entries(b.profileFields).map(([f, ok]) => <li key={f}><code>{f}</code>: {ok ? "✓ published" : "✕ not published"}</li>)}</ul>
              <pre className="kc-code">{json(b.data)}</pre>
            </>
          )}
        </div>
      ))}
    </details>
  );
}

function Log() {
  const [res, setRes] = useState(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("All");
  const load = useCallback(async () => {
    setError("");
    try { setRes((await api.get("/api/inspect/events")).data); } catch (e) { setError(errText(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const want = FILTERS.find(([l]) => l === filter)[1];
  const rows = (res?.events || []).filter((e) => !want || e.decision === want);
  return (
    <section className="kc-guide" aria-label="Live log">
      <p className="kc-note">The resource AS's own record of its /token decisions (newest first, last 50, in memory). Token exchanges at the IdP and calls to the MCP server are not recorded there.</p>
      <div className="kc-chips" role="group" aria-label="Filter">
        {FILTERS.map(([l]) => <button key={l} type="button" aria-pressed={filter === l} onClick={() => setFilter(l)}>{l}</button>)}
        <button type="button" onClick={load}>Refresh</button>
      </div>
      {error && <div className="kc-banner kc-banner--error" role="alert">{error}</div>}
      {res && !res.available && <div className="kc-banner" role="alert">{res.reason}</div>}
      {res?.available && rows.length === 0 && <p>No decisions yet.</p>}
      {rows.length > 0 && (
        <div className="kc-table-wrap">
          <table className="kc-table">
            <thead><tr><th>Time (UTC)</th><th>Decision</th><th>Client</th><th>Scope</th><th>Detail</th><th>jti</th></tr></thead>
            <tbody>
              {rows.map((e, i) => (
                <tr key={`${e.at}-${i}`}>
                  <td>{String(e.at).replace("T", " ").slice(0, 19)}</td>
                  <td><span className={`kc-badge kc-badge--${e.decision === "accepted" ? "approved" : "rejected"}`}>{e.decision === "accepted" ? "✓ Redeem" : "✕ Denied"}</span></td>
                  <td>{e.client_id}</td><td>{e.scope}</td><td>{[e.error, e.reason].filter(Boolean).join(": ")}</td><td>{e.jti}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default function InspectPage() {
  const [tab, setTab] = useState("decode");
  return (
    <main className="kc">
      <header className="kc-hero">
        <p className="kc-eyebrow">Inspector</p>
        <h1>Inspect a token</h1>
        <p className="kc-lede">
          Get an ID-JAG, or paste any token, and check it against the IETF draft and this kit's trust registry. The Live log tab shows what the
          resource authorization server decided, and each backend's discovery metadata is in the section below.
        </p>
      </header>
      <div className="kc-tabs" role="tablist" aria-label="Inspector sections">
        {TABS.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>)}
      </div>
      {tab === "decode" && <Decode />}
      {tab === "log" && <Log />}
      <Backends />
    </main>
  );
}

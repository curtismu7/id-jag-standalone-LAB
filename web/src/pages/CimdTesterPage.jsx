import { useState } from "react";
import api from "../services/api";
import "./CimdTesterPage.css";

// CIMD tester, after client.dev (stytchauth/client.dev, MIT): the same two sides, run against this kit's
// PingFederate. Server: does PingFederate say it takes CIMD clients? Client: is a metadata document right
// by the draft's rules, and what does the (mock) PingFederate itself say about good and bad documents?

function Findings({ result }) {
  if (!result) return null;
  return (
    <div className="cimd__result" role="status" data-testid="cimd-tester-findings">
      <h3>{result.valid ? "Valid client ID metadata document" : "Not a valid client ID metadata document"}</h3>
      <p className="cimd__hint">Checked: {result.source === "pasted" ? "the pasted document" : result.source}</p>
      {[...result.errors, ...result.warnings].length > 0 && (
        <ul className="cimd__findings">
          {result.errors.map((e) => <li key={`e-${e.path}-${e.message}`}><strong>Error</strong> <code>{e.path}</code> {e.message}</li>)}
          {result.warnings.map((w) => <li key={`w-${w.path}-${w.message}`}><strong>Warning</strong> <code>{w.path}</code> {w.message}</li>)}
        </ul>
      )}
    </div>
  );
}

export default function CimdTesterPage() {
  const [tab, setTab] = useState("server");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState(null);
  const [server, setServer] = useState(null);
  const [client, setClient] = useState(null);
  const [probe, setProbe] = useState(null);
  const [pasted, setPasted] = useState("");

  async function call(label, path, set) {
    setBusy(label);
    setError(null);
    try {
      set((await api.post(`/api/cimd/tester/${path}`)).data);
    } catch (failure) {
      setError({ code: failure?.response?.data?.error || "cimd_tester_failed", detail: failure?.response?.data?.message || "" });
    } finally {
      setBusy("");
    }
  }

  return (
    <main className="cimd page">
      <header className="cimd__head">
        <p className="cimd__eyebrow">Client identity &middot; tester</p>
        <h1>CIMD tester</h1>
        <p>
          Both sides of client ID metadata documents, against PingFederate. After{" "}
          <a href="https://client.dev" target="_blank" rel="noopener noreferrer">client.dev</a> (MIT).
        </p>
      </header>

      <div className="cimd__tabs" role="tablist" aria-label="CIMD tester side">
        {[["server", "Test PingFederate (server)"], ["client", "Test a document (client)"]].map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "is-active" : ""} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {tab === "server" && (
        <section role="tabpanel" aria-label="Test PingFederate" className="card">
          <p className="cimd__hint">
            Reads PingFederate&apos;s discovery document: does it accept CIMD clients (documents as client_id),
            PKCE (S256) and public clients?
          </p>
          <button type="button" disabled={Boolean(busy)} onClick={() => call("Reading discovery", "server", setServer)}>
            {busy === "Reading discovery" ? busy : "Check PingFederate discovery"}
          </button>
          {server && (
            <div className="cimd__result" role="status" data-testid="cimd-tester-server">
              <h3>PingFederate at {server.issuer}</h3>
              <ul className="cimd__findings">
                {server.checks.map((c) => (
                  <li key={c.name} data-state={c.ok ? "ok" : "bad"}><strong>{c.ok ? "Pass" : "Fail"}</strong> {c.name} <code>{JSON.stringify(c.value)}</code></li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {tab === "client" && (
        <section role="tabpanel" aria-label="Test a document" className="card">
          <button type="button" disabled={Boolean(busy)} onClick={() => call("Checking", "client", setClient)}>
            Check this app&apos;s document
          </button>
          <label className="cimd__field">
            <span>Or paste a document (JSON, nothing is fetched)</span>
            <textarea rows={6} value={pasted} onChange={(event) => setPasted(event.target.value)} spellCheck={false} />
          </label>
          <button type="button" disabled={Boolean(busy) || !pasted.trim()} onClick={() => call("Checking pasted", "client", setClient)} data-pasted="true">
            Check the pasted document
          </button>
          <Findings result={client} />
          <h3>What does PingFederate say?</h3>
          <p className="cimd__hint">
            The server sends the mock PingFederate one authorization request per case and reads back its answer:
            a sign-in flow, or an error. The bad documents are served by this app at URLs the mock&apos;s CIMD
            policy allows. Mock mode only.
          </p>
          <button type="button" disabled={Boolean(busy)} onClick={() => call("Asking PingFederate", "probe", setProbe)}>
            {busy === "Asking PingFederate" ? busy : "Ask PingFederate about good and bad documents"}
          </button>
          {probe && (
            <div className="cimd__probe" data-testid="cimd-tester-probe">
              <table className="cimd__table">
                <thead><tr><th>Case</th><th>Expected</th><th>PingFederate said</th><th>As expected</th></tr></thead>
                <tbody>
                  {probe.results.map((r) => (
                    <tr key={r.id} data-state={r.asExpected ? "ok" : "bad"}>
                      <td>{r.title}</td>
                      <td>{r.expect === "accept" ? "Accept" : "Refuse"}</td>
                      <td>{r.pfSays}</td>
                      <td>{r.asExpected ? "Yes" : "No"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {error && (
        <p className="cimd__error" role="alert">
          The tester stopped. Reason: <code>{error.code}</code>{error.detail && <> {error.detail}</>}
        </p>
      )}
    </main>
  );
}

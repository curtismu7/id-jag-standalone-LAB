import { useEffect, useState } from "react";
import "./console.css";
import terms from "../data/terms.json";
import sources from "../data/sources.json";
import { GUIDES } from "./GuidesPage";
import { PLAYGROUND_DIAGRAMS, PLAYGROUND_DIAGRAM_MODES, playgroundDiagramPath } from "../utils/idJagPlaygroundDiagrams";

// Learn: an index of the in-app docs, the glossary the playground steps link to (#term-<id>), and the source
// library. The hash picks the tab (#glossary, #library, #term-<id>), so any of them can be linked to.

const TABS = [["docs", "Docs"], ["glossary", "Glossary"], ["library", "Library"]];
const STATUS_TEXT = { verified: "Verified by us", read: "Read", "search-only": "Search only", "not-read": "Not read" };
const KINDS = ["All", ...new Set(sources.map((s) => s.kind))];
const tabFromHash = (hash) => (hash.startsWith("#term-") || hash === "#glossary" ? "glossary" : hash === "#library" ? "library" : "docs");

export default function LearnPage() {
  const [tab, setTab] = useState(() => tabFromHash(window.location.hash));
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("All");

  // A #term-<id> link lands on that term (an unknown id just shows the glossary).
  useEffect(() => {
    const el = window.location.hash.startsWith("#term-") && document.getElementById(window.location.hash.slice(1));
    el?.scrollIntoView?.({ block: "center" });
  }, []);

  const pick = (id) => { setTab(id); window.history.replaceState(null, "", `#${id}`); };
  const q = query.trim().toLowerCase();
  const shownTerms = terms.filter((t) => !q || `${t.term} ${t.definition}`.toLowerCase().includes(q));
  const shownSources = sources.filter((s) => kind === "All" || s.kind === kind);

  return (
    <main className="kc">
      <header className="kc-hero">
        <p className="kc-eyebrow">Learn</p>
        <h1>Learn ID-JAG</h1>
        <p className="kc-lede">
          The docs in this app, the terms the playground uses, and the sources behind them. Every source says how far we
          checked it and when, so nobody repeats a guess as fact.
        </p>
      </header>
      <div className="kc-tabs" role="tablist" aria-label="Learn sections">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => pick(id)}>{label}</button>
        ))}
      </div>

      {tab === "docs" && (
        <section className="kc-guide" aria-label="Docs">
          <h2>Setup guides</h2>
          <ul>{GUIDES.map(([id, title]) => <li key={id}><a href={`/guides#${id}`}>{title}</a></li>)}</ul>
          <h2>Try it</h2>
          <ul>
            <li><a href="/">ID-JAG Playground</a>: the flow one step at a time, with every request, response and the code behind it.</li>
            <li><a href="/trusted-idps">Trusted IdPs</a>: register your IdP so our resource authorization server accepts its ID-JAGs.</li>
            <li><a href="/inspect">Inspector</a>: get an ID-JAG (or paste a token) to check it against the draft and the trust registry, read each backend's discovery metadata, and watch the resource AS's decisions.</li>
          </ul>
          <h2>Diagrams</h2>
          <ul>{PLAYGROUND_DIAGRAM_MODES.map((m) => <li key={m}><a href={playgroundDiagramPath(m)}>{`${PLAYGROUND_DIAGRAMS[m].label} diagram`}</a></li>)}</ul>
        </section>
      )}

      {tab === "glossary" && (
        <section className="kc-guide" aria-label="Glossary">
          <label className="kc-search">Search terms
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="jti, CIMD, resource AS…" />
          </label>
          {shownTerms.length === 0 && <p>No term matches. Try "token", "PingFederate" or "MCP".</p>}
          <dl className="kc-glossary">
            {shownTerms.map((t) => (
              <div key={t.id}>
                <dt id={`term-${t.id}`}>{t.term}</dt>
                <dd>{t.definition}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {tab === "library" && (
        <section className="kc-guide" aria-label="Library">
          <div className="kc-chips" role="group" aria-label="Filter by kind">
            {KINDS.map((k) => <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>{k}</button>)}
          </div>
          <div className="kc-table-wrap">
            <table className="kc-table">
              <thead><tr><th>Source</th><th>Kind</th><th>Use it for</th><th>Status</th><th>Checked</th></tr></thead>
              <tbody>
                {shownSources.map((s) => (
                  <tr key={s.id}>
                    <td><a href={s.url} target="_blank" rel="noopener noreferrer">{s.title}</a></td>
                    <td>{s.kind}</td>
                    <td>{s.use}</td>
                    <td><span className={`kc-status kc-status--${s.status}`}>{STATUS_TEXT[s.status]}</span></td>
                    <td>{s.checked}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}

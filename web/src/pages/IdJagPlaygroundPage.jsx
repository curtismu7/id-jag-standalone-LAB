import { createContext, Fragment, useContext, useEffect, useRef, useState } from "react";
import api from "../services/api";
import { MOCK_AS_RECORD, MOCK_CONFIG, mockApi } from "../utils/idJagPlaygroundMock";
import { PLAYGROUND_DIAGRAMS, playgroundDiagramPath } from "../utils/idJagPlaygroundDiagrams";
import { MODE_STEPS } from "../utils/idJagPlaygroundSteps";
import { buildReport, downloadFile } from "../utils/runReport";
import { signIn as signInApp, signInIssuer } from "../utils/signIn";
import { codeSnippet } from "../utils/codeSnippet";
import InteropPanel from "./InteropPanel";
import { mcpcCommand, vscodeMcpJson, vscodeSettings } from "../utils/realClients";
import terms from "../data/terms.json";
import StoryPanel from "../story/StoryPanel";
import "./IdJagPlaygroundPage.css";

// The real PingFederate ID-JAG flow, one step at a time (after Okta's xaa.dev), with a
// spec inspector and live negative tests (after MCPJam's XAA debugger). Raw tokens never
// reach the browser: the server returns decoded claims and redacted requests only.
// Mock mode runs the same steps from client-side fixtures and sends nothing.

const API = "/api/id-jag-playground";
const RETURN_TO = "/";
const MODE_KEY = "idjag.playground.mode";
const VIEW_KEY = "idjag.playground.view";

const MODES = [
  { id: "mock", label: "Sample data (browser)" },
  { id: "pf-as", label: "PingFederate → resource AS" },
  { id: "pf-pf", label: "Acme PingFederate → PingFederate" },
  { id: "byo", label: "Your IdP → our resource AS" },
];
const BYO_TARGETS = [{ id: "resource-as", label: "Resource AS" }, { id: "pingfederate", label: "PingFederate" }];
const VIEWS = [{ id: "form", label: "Form" }, { id: "json", label: "JSON" }];
const PROTOCOL_KEY = "idjag.playground.protocol";
const PROTOCOLS = [{ id: "oidc", label: "OIDC" }, { id: "saml", label: "SAML" }];
const SAML_UNVERIFIED = "PingFederate SAML subject not verified yet (F2 spike)";
const SAML_NOTE = "With SAML, the subject is a signed SAML assertion instead of a refresh token. PingFederate takes the assertion directly as the subject_token of one token exchange and answers with the ID-JAG: no refresh token first. Mock: sample data.";
const SAML_REAL_NOTE = "With SAML, this app plays a small SAML identity provider: it signs an assertion naming you (your email as the NameID) and PingFederate, which trusts the signing certificate, trades it for the ID-JAG in one exchange. There is no second sign-in: the subject is always the user signed in to this app.";
const SAML_ONLY_PF_AS = "SAML runs in the PingFederate → resource AS mode only";
const RESOURCE_KEY = "idjag.playground.resource";
const RESOURCES = [{ id: "mcp", label: "MCP server" }, { id: "rest", label: "REST API" }];
const REST_NOTE = "The MCP server also serves a plain page, /protected/profile, behind the same bearer validation as its tools. Open it with the access token from step 3, then try it without a token and with the raw ID-JAG: it must refuse both and say which check failed.";
const XAA_BUTTON = "Get an ID-JAG from xaa.dev (IdenX, a free third-party IdP)";

const stored = (key, allowed, fallback) => {
  try { const v = localStorage.getItem(key); return allowed.some((a) => a.id === v) ? v : fallback; } catch { return fallback; }
};
const store = (key, v) => { try { localStorage.setItem(key, v); } catch { /* storage blocked: not remembered */ } };

const SPEC_NOTES = {
  issue: "RFC 8693 token exchange at the IdP with requested_token_type=…:id-jag. audience names the resource authorization server; resource names the MCP server. The IdP decides the scope and returns a short-lived JWT typed oauth-id-jag+jwt in access_token, with token_type N_A.",
  redeem: "RFC 7523 JWT bearer grant at the resource authorization server. It verifies typ, the IdP signature, iss, a single aud equal to its own issuer, exp/iat, and that client_id is the client authenticating now. It grants at most the ID-JAG's scope and mints its own access token. It should not return a refresh token.",
  negative: "A resource authorization server must refuse a broken assertion with an OAuth error and no token. Each test mints a fresh ID-JAG, breaks one thing, and checks the refusal.",
  revoke: "Revoking the refresh token at PingFederate stops new ID-JAGs from this session. Access tokens already minted stay valid until they expire; the resource AS is not told.",
  negativeByo: "A resource authorization server must refuse a broken assertion with an OAuth error and no token. We cannot mint at your IdP, so each test reuses your pasted ID-JAG and breaks one thing. Replay is skipped: it would use up your token.",
};

// Per-mode wording: who redeems, who validates the MCP call.
const MODE_TEXT = {
  "pf-as": {
    story: "You sign in once at PingFederate. This app, acting as your agent, asks PingFederate for an ID-JAG addressed to our resource authorization server, trades it for an access token and calls the sample MCP server for you. PingFederate decides whether the agent may act; the resource AS decides what it may read.",
    signInTitle: "Sign in at the issuer PingFederate",
    signInNote: "The ID-JAG is minted from your session at the issuer PingFederate (the refresh token this app's server holds). If you already signed in to this app, this step is done: it uses that same session.",
    redeemTitle: "Redeem it at the resource authorization server",
    asRole: "Redeems the ID-JAG, mints its own token",
    mcpRole: "mcp-sample: trusts the resource AS's tokens",
    call: "The ID-JAG stops at the authorization server. The MCP call carries the new access token; mcp-sample verifies it against the resource AS's keys. Tools listed here are whatever this token's scope allows.",
  },
  "pf-pf": {
    story: "An outside company, Acme, runs its own PingFederate. You sign in there, and Acme's PingFederate issues an ID-JAG addressed to our PingFederate, which redeems it through a trusted IdP connection.",
    signInTitle: "Sign in at the Acme PingFederate",
    signInNote: "The ID-JAG is minted from your session at the Acme PingFederate, an outside company's IdP. This sign-in is separate from the app's own sign-in.",
    redeemTitle: "Redeem it at our PingFederate",
    asRole: "Redeems the ID-JAG through an IdP connection, mints the access token",
    mcpRole: "mcp-sample: trusts the resource AS only",
    call: "The ID-JAG stops at our PingFederate. The MCP call carries the access token our PingFederate minted, and mcp-sample trusts the resource AS's tokens only, so expect a refusal that names the failed check.",
  },
  byo: {
    story: "Your company's IdP issued an ID-JAG for our resource authorization server. Paste it: we check it against the draft and your Trusted IdP entry, redeem it and call the sample MCP server.",
    signInTitle: "Paste an ID-JAG from your IdP",
    signInNote: "No sign-in here: your own IdP issued this ID-JAG. Its issuer must be on the Trusted IdPs list below, aud must be the issuer of the authorization server you pick, and client_id the value registered for your IdP. The server keeps the token and shows only its decoded claims.",
    redeemTitle: "Redeem it at our resource authorization server",
    asRole: "Trusts your IdP's keys, redeems the ID-JAG, mints its own token",
    mcpRole: "mcp-sample: trusts the token our resource AS mints",
    call: "The ID-JAG stops at our authorization server. The MCP call carries the access token it minted; mcp-sample verifies it against the resource AS's keys.",
  },
  mock: {
    story: "Mary signs in once at the company's PingFederate, and the agent then reads Mary's data from the sample MCP server without a second sign-in. In this mode every step uses sample data and nothing is sent.",
    signInTitle: "Sign in with PingFederate",
    signInNote: "Sample data needs no sign-in: every step below uses sample data in your browser and sends nothing. (The Mock/Live switch in the header is separate: it chooses what the other modes talk to.)",
    redeemTitle: "Redeem it at the MCP authorization server",
    asRole: "Redeems the ID-JAG, mints its own token",
    mcpRole: "The sample MCP server",
    call: "The ID-JAG stops at the authorization server. The MCP call carries the new access token. In mock mode the tool list and results are sample data.",
  },
};

const VENDORS = [
  { name: "PingFederate 13.1", issue: "Token exchange; subject = refresh token or ID token; SP connection of type OAuth Token Exchange with ID-JAG enabled", redeem: "Can be the redeeming side too: a JWT bearer grant through an IdP connection. Pick Acme PingFederate → PingFederate above to have one PingFederate redeem what another issued", notes: "client_id and scope come from the SP connection's attribute mapping: map them to the client at the resource AS and the IT-granted MCP scopes" },
  { name: "Okta (Cross App Access)", issue: "Org authorization server /oauth2/v1/token; subject = ID token or refresh token; client auth private_key_jwt", redeem: "Resource app's own authorization server, JWT bearer, client credentials of the resource app", notes: "Needs a trusted resource connection; resource must match the configured issuer exactly or invalid_target; ID-JAG lives 300 s" },
  { name: "Auth0", issue: "Can act as the requesting side and as the resource authorization server", redeem: "Issues an access token for the Auth0 API", notes: "No refresh token for ID-JAG exchanges" },
  { name: "Keycloak (nightly, experimental)", issue: "Not implemented (receiver only)", redeem: "JWT bearer with an identity-provider alias trusted for the grant; confidential client", notes: "Tracks draft -01; options for assertion reuse and max lifetime" },
  { name: "MCP Enterprise-Managed Authorization", issue: "IdP (Okta first) issues the ID-JAG to the MCP client", redeem: "MCP server's authorization server; confidential clients", notes: "Access token must be audience-restricted to the MCP server named in resource; ID-JAG reusable until it expires" },
];

/** The glossary terms each step uses, linked to /learn#term-<id>. */
export const STEP_TERMS = {
  1: ["identity-assertion", "requesting-app"],
  2: ["id-jag", "token-exchange", "resource-authorization-server"],
  3: ["jwt-bearer-grant", "jti-replay", "strict-client-binding"],
  4: ["resource-server"],
  5: ["jti-replay"],
  6: ["refresh-token-revocation"],
};
const TERM = Object.fromEntries(terms.map((t) => [t.id, t]));

const ViewContext = createContext("form");
const TIME_CLAIMS = new Set(["exp", "iat", "nbf", "auth_time"]);

function Fields({ value, name }) {
  if (Array.isArray(value)) {
    if (value.every((v) => v === null || typeof v !== "object")) return <span>{value.map(String).join(", ") || "(empty)"}</span>;
    return <ol className="ijp-kv-list">{value.map((v, i) => <li key={i}><Fields value={v} /></li>)}</ol>;
  }
  if (value && typeof value === "object") {
    return (
      <dl className="ijp-kv">
        {Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => (
          <Fragment key={k}><dt>{k}</dt><dd><Fields value={v} name={k} /></dd></Fragment>
        ))}
      </dl>
    );
  }
  if (TIME_CLAIMS.has(name) && typeof value === "number") return <span>{value} <span className="ijp-cite">({new Date(value * 1000).toLocaleString()})</span></span>;
  return <span>{String(value)}</span>;
}

function Data({ value }) {
  const view = useContext(ViewContext);
  if (value === undefined || value === null) return null;
  if (view === "json") return <pre className="ijp-json">{JSON.stringify(value, null, 2)}</pre>;
  return <div className="ijp-form"><Fields value={value} /></div>;
}

function Segmented({ label, options, value, onPick, disabled }) {
  return (
    <div className="ijp-seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" aria-pressed={value === o.id} title={o.title}
          disabled={disabled || o.disabled} onClick={() => onPick(o.id)}>{o.label}</button>
      ))}
    </div>
  );
}

/** A link to this mode's diagram (step `step` lit). Diagrams always open in a new tab. */
function DiagramLink({ mode, step, children }) {
  return <a className="ijp-diagram-link" href={playgroundDiagramPath(mode, step)} target="_blank" rel="noopener noreferrer">{children}</a>;
}

function Step({ n, title, note, mode, done, children }) {
  return (
    <section className="ijp-step" aria-labelledby={`ijp-step-${n}`}>
      <header className="ijp-step__head">
        <span className={`ijp-step__n${done ? " is-done" : ""}`}>{done ? <><span aria-hidden="true">✓</span><span className="ijp-sr">{n} (done)</span></> : n}</span>
        <h2 id={`ijp-step-${n}`}>{title}</h2>
        {PLAYGROUND_DIAGRAMS[mode].steps.some((x) => x.n === n) && <DiagramLink mode={mode} step={n}>see step {n} on the diagram ↗</DiagramLink>}
      </header>
      {note && <p className="ijp-note">{note}</p>}
      {(STEP_TERMS[n] || []).some((id) => TERM[id]) && (
        <p className="ijp-terms">Terms:{" "}
          {STEP_TERMS[n].filter((id) => TERM[id]).map((id, i) => (
            <Fragment key={id}>{i > 0 && " · "}<a href={`/learn#term-${id}`}>{TERM[id].term}</a></Fragment>
          ))}
        </p>
      )}
      {children}
    </section>
  );
}

const OIDC_ONLY = new Set(["openid", "profile", "email", "offline_access", "phone", "address"]);
/** The scopes an ID-JAG grants at the MCP server (login-only scopes grant nothing there). */
const scopesOf = (claims) => (Array.isArray(claims?.scope) ? claims.scope : String(claims?.scope || "").split(/\s+/))
  .filter((s) => s && !OIDC_ONLY.has(s));

/** Plain guidance for the OAuth and MCP errors people actually hit here. */
function explain(e, resource, saml) {
  if (!e) return null;
  const text = [e.error, e.error_description, e.pfError, e.pfErrorDescription, e.message].filter(Boolean).join(" ");
  if (/invalid_origin/i.test(text)) return "The server only accepts actions from APP_ORIGIN. Open the playground at that address, or set APP_ORIGIN to this page's origin and restart the server.";
  if (/sign_in_required/i.test(text)) return saml ? "Sign in to this app first (step 1): the assertion names the signed-in user." : "Sign in at the issuer first (step 1): the ID-JAG is minted from that session.";
  if (/scope_not_in_id_jag/i.test(text)) return "Pick a scope the ID-JAG carries from the list in step 3, or All scopes.";
  if (/invalid jwt token/i.test(text)) {
    return "PingFederate could not verify the ID-JAG's signature. Its consumer cannot pick a key by x5t, so the issuer's JWKS must hold a single RSA key, or the redeeming PingFederate still has an older copy of that JWKS cached. Publish a single-key JWKS at the issuer, then re-save the IdP connection (or restart the redeeming PingFederate).";
  }
  if (/issuer is not trusted/i.test(text)) {
    return "resource-as does not trust this ID-JAG's issuer. It learns its trust list from this server's registry: set ID_JAG_REGISTRY_TOKEN for both, and for an outside IdP add it on the Trusted IdPs panel. Its cache lasts 30 s.";
  }
  if (/invalid_client/i.test(text)) return "The authorization server did not accept our client: RESOURCE_AS_CLIENT_ID and RESOURCE_AS_CLIENT_SECRET (or the PingFederate redeemer's) must match what it has registered.";
  if (/invalid_target/i.test(text)) {
    return `The authorization server serves no resource ${resource || "matching the request"}. On resource-as, list it in ACCEPTED_RESOURCES; on PingFederate, add it to the access token manager's Resource URIs. Then request a new ID-JAG.`;
  }
  if (/insufficient_scope/i.test(text)) return "The access token's scope does not cover this. Redeem with All scopes in step 3, or call a tool the token can see.";
  if (/already (been )?(used|redeemed)|replay|jti.*(used|seen)/i.test(text)) {
    return "This ID-JAG was already redeemed, and each one is single-use. Request a new ID-JAG (step 2), then redeem that one.";
  }
  if (/expired/i.test(text)) return "It expired: ID-JAGs live about 5 minutes. Request a new ID-JAG (step 2) and redeem it (step 3).";
  if (/invalid_token/i.test(text)) return "The MCP server refused the token: it accepts only access tokens from the resource AS it trusts, for its own resource, and unexpired.";
  return null;
}

function ErrorNote({ e, resource, saml }) {
  const hint = explain(e, resource, saml);
  return (
    <div className="ijp-banner ijp-banner--error" role="alert">
      <strong>{e.error || "Error"}</strong> {e.message || e.error_description || ""}{e.pfErrorDescription ? ` (${e.pfErrorDescription})` : ""}
      {e.mcpStatus && <div className="ijp-cite">MCP server answered HTTP {e.mcpStatus}{e.wwwAuthenticate ? `: ${e.wwwAuthenticate}` : ""}</div>}
      {hint && <p className="ijp-fix">{hint}</p>}
    </div>
  );
}

/** What the pre-flight found before a button was allowed to send anything. */
function PreflightPanel({ gate, onRecheck, busy }) {
  const title = !gate.ok ? "Pre-flight: fix this first, nothing was sent"
    : gate.checks.length ? "Pre-flight: warnings (sent anyway)" : "Pre-flight: All checks pass. Run the step again.";
  return (
    <div className={`ijp-preflight${gate.ok ? "" : " is-fail"}`} role={gate.ok ? "status" : "alert"} data-testid="ijp-preflight">
      <h4>{title}</h4>
      {gate.checks.length > 0 && (
        <ul>
          {gate.checks.map((c) => (
            <li key={c.id} className={`is-${c.status}`}>
              <span className="ijp-preflight__tag">{c.status === "fail" ? "Fail" : "Warn"}</span>
              <div><strong>{c.label}</strong> {c.detail}{c.fix && <p className="ijp-fix">{c.fix}</p>}</div>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="ijp-btn" onClick={onRecheck} disabled={busy}>{busy ? "Checking…" : "Re-check"}</button>
    </div>
  );
}

/**
 * One step's exchange as tabs: Request, Response, Decoded (when there is a token) and Code (the fetch call
 * behind it, placeholders only). `labels` renames a tab; `initial` picks the tab shown first.
 */
function StepTabs({ title, request, response, decoded, xml, labels = {}, initial = "request" }) {
  const tabs = [
    ["request", labels.request || "Request", request],
    ["response", labels.response || "Response", response],
    ["decoded", labels.decoded || "Decoded", decoded],
    ["xml", labels.xml || "XML", xml],
    ["code", "Code", request && (request.endpoint || request.url) ? request : undefined],
  ].filter(([, , v]) => v !== undefined && v !== null);
  const [picked, setPicked] = useState(initial);
  const tab = tabs.some(([k]) => k === picked) ? picked : tabs[0]?.[0];
  if (!tabs.length) return null;
  const value = tabs.find(([k]) => k === tab)[2];
  return (
    <div className="ijp-tabs">
      <div className="ijp-tabs__list" role="tablist" aria-label={title}>
        {tabs.map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setPicked(k)}>{label}</button>
        ))}
      </div>
      <div className="ijp-tabs__panel" role="tabpanel" aria-label={`${title}: ${tabs.find(([k]) => k === tab)[1]}`}>
        {tab === "code" ? <pre className="ijp-code">{codeSnippet(value)}</pre> : tab === "xml" ? <pre className="ijp-code">{value}</pre> : <Data value={value} />}
      </div>
    </div>
  );
}

/**
 * One chip per backend this mode talks to, probed by the server (mock: sample). Re-check probes again. `mode` is
 * the server session's mode, so the strip probes again once a page load has moved the session to the picked mode.
 */
function BackendsStrip({ client, mode }) {
  const [list, setList] = useState(null);
  const [checking, setChecking] = useState(false);
  const seq = useRef(0); // only the newest probe's answer counts: an older one (another mode) can land later
  const probe = () => {
    const n = ++seq.current;
    setChecking(true);
    client.get(`${API}/backends`)
      .then((r) => n === seq.current && setList(Array.isArray(r.data?.backends) ? r.data.backends : []))
      .catch(() => n === seq.current && setList([]))
      .finally(() => n === seq.current && setChecking(false));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(probe, [client, mode]);
  return (
    <div className="ijp-backends" data-testid="ijp-backends" role="group" aria-label="Backends">
      <span className="ijp-backends__label" aria-hidden="true">Backends</span>
      <span className="ijp-backends__list" aria-live="polite">
        {(list || []).map((b) => (
          <span key={b.id} className={`ijp-chip is-${b.state}`} title={b.url}>
            <span className="ijp-chip__led" aria-hidden="true" /><span>{b.label}</span>
            <span className="ijp-chip__state">{b.state === "up" ? "up" : `${b.state}: ${b.detail}`}</span>
          </span>
        ))}
      </span>
      {list && list.length === 0 && <span className="ijp-note">Could not check the backends.</span>}
      <button type="button" className="ijp-btn" data-admin-only="" onClick={probe} disabled={checking}>{checking ? "Checking…" : "Re-check"}</button>
    </div>
  );
}

/** Time left on an ID-JAG or access token; stale once expired or used. */
function Lifetime({ id, label, exp, used, now, again }) {
  if (typeof exp !== "number") return null;
  const left = exp - Math.floor(now / 1000);
  const stale = used || left <= 0;
  const text = used ? `redeemed (single-use). ${again}` : left <= 0 ? `expired. ${again}` : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} left`;
  // Not an error: a used or expired token is the expected end of its life. Redeemed uses the info status colour and expired the warn status colour (--status-info, --status-warn); the words say which, so colour is not the only cue.
  return <p className={`ijp-life${used ? " is-stale is-used" : stale ? " is-stale is-expired" : ""}`} data-testid={`ijp-life-${id}`}><strong>{label}:</strong> {text}</p>;
}

/** The resource server's answer, drawn as the small app page it protects. */
function ResourcePage({ r }) {
  const b = r.body && typeof r.body === "object" ? r.body : {};
  const ok = r.status === 200;
  const verified = Array.isArray(b.verified) ? b.verified : [];
  const failed = verified.find((v) => !v.ok);
  const subject = String(b.data?.subject || b.principal?.sub || "");
  return (
    <div className="ijp-page" data-testid="ijp-resource-page">
      <div className="ijp-page__bar">
        <span className="ijp-page__method">{r.request?.method || "GET"}</span>
        <span className="ijp-page__url">{r.request?.url}</span>
        <span className={`ijp-pill ${ok ? "is-ok" : "is-bad"}`} data-testid="ijp-resource-status">{r.status} {ok ? "OK" : b.error || "refused"}</span>
      </div>
      <p className="ijp-cite">Authorization: {r.request?.authorization}</p>
      {!ok && (
        <div className="ijp-banner ijp-banner--error" role="alert">
          The resource server refused: {failed ? `${failed.check} check failed. ${failed.detail}` : b.error_description || b.error || `HTTP ${r.status}`}
        </div>
      )}
      <div className="ijp-page__grid">
        {b.principal && (
          <div className="ijp-page__card">
            <h4>Who the resource server says you are</h4>
            <dl className="ijp-kv">
              <dt>sub</dt><dd>{b.principal.sub}</dd>
              <dt>client_id</dt><dd>{b.principal.client_id ?? "(none)"}</dd>
              <dt>scope</dt><dd>{b.principal.scope || "(none)"}</dd>
            </dl>
          </div>
        )}
        {verified.length > 0 && (
          <div className="ijp-page__card">
            <h4>How it verified the token</h4>
            <ul className="ijp-verify">
              {verified.map((v) => (
                <li key={v.check} className={v.ok ? "is-pass" : "is-fail"}>
                  <span className="ijp-verify__mark" aria-hidden="true">{v.ok ? "✔" : "✗"}</span>
                  <div><span className="ijp-sr">{v.ok ? "pass" : "fail"}</span><strong>{v.check}</strong> <span className="ijp-cite">{v.detail}</span></div>
                </li>
              ))}
            </ul>
          </div>
        )}
        {b.data && (
          <div className="ijp-page__card ijp-page__profile">
            <h4>Protected data</h4>
            <div className="ijp-profile">
              <span className="ijp-profile__avatar" aria-hidden="true">{subject.slice(0, 2).toUpperCase() || "?"}</span>
              <div><strong>{subject}</strong><div className="ijp-cite">{b.data.profileId}</div></div>
            </div>
            <dl className="ijp-kv">
              {Object.entries(b.data).filter(([k]) => !["subject", "profileId"].includes(k)).map(([k, v]) => (
                <Fragment key={k}><dt>{k}</dt><dd>{String(v)}</dd></Fragment>
              ))}
            </dl>
          </div>
        )}
      </div>
    </div>
  );
}

/** What the resource AS itself logged for this ID-JAG (read from its /events by our server). Plain text only. */
function AsRecord({ rec, sample }) {
  const e = rec.entry;
  return (
    <div className="ijp-as-record" data-testid="ijp-as-record" aria-live="polite">
      <h4>What the resource AS recorded{sample && " (sample record)"}</h4>
      {e ? (
        <>
          {e.decision === "accepted"
            ? <p className="ijp-pill is-ok">✓ The resource AS received this ID-JAG and issued an access token</p>
            : <p className="ijp-note">The resource AS refused this ID-JAG{e.reason ? `: ${e.reason}` : "."}</p>}
          <dl className="ijp-kv">
            <dt>time</dt><dd>{e.at}</dd>
            <dt>client</dt><dd>{e.client_id}</dd>
            <dt>scope</dt><dd>{e.scope}</dd>
            <dt>resource</dt><dd>{e.aud}</dd>
            <dt>subject</dt><dd>{e.sub}</dd>
          </dl>
        </>
      ) : <p className="ijp-note">{rec.reason || "The resource AS has no record of this one yet."}</p>}
    </div>
  );
}

/** Tool arguments from the form inputs, typed by the tool's inputSchema. */
function buildArgs(props, form) {
  const out = {};
  for (const [k, p] of Object.entries(props)) {
    const v = form[k];
    if (v === undefined || v === "") continue;
    if (p.type === "number" || p.type === "integer") out[k] = Number(v);
    else if (p.type === "object" || p.type === "array") {
      try { out[k] = JSON.parse(v); } catch { throw new Error(`${k} must be JSON`); }
    } else out[k] = v;
  }
  return out;
}

// Blank client ids fall back to the server's RESOURCE_AS_CLIENT_ID / PF_REDEEMER_CLIENT_ID.
const EMPTY_IDP = { id: "", name: "", issuer: "", jwksUrl: "", idJagClientId: "", clientId: "", pfClientId: "", scopes: "", targets: ["resource-as"], enabled: true };
const IDP_FIELDS = [
  ["id", "Id (slug)"], ["name", "Name"], ["issuer", "Issuer (https)"], ["jwksUrl", "JWKS URL (https)"],
  ["idJagClientId", "client_id your IdP writes in the ID-JAG"], ["clientId", "Our client at the resource AS"],
  ["pfClientId", "Our client at PingFederate"], ["scopes", "Scope cap (space-separated, optional)"],
];
const errText = (e) => e.response?.data?.message || e.response?.data?.error || e.message;

/** Registry of outside IdPs whose ID-JAGs our resource authorization servers accept. Admins edit; others read. */
function TrustedIdpsPanel({ api, endpoints }) {
  const [state, setState] = useState(null);
  const [form, setForm] = useState(null);
  const [confirmId, setConfirmId] = useState("");
  const [err, setErr] = useState("");

  const load = () => api.get(`${API}/trusted-idps`)
    .then((r) => setState(r.data))
    .catch((e) => setState({ error: errText(e) }));
  // Reload when the mode swaps the mock and real API.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setForm(null); setConfirmId(""); setErr(""); load(); }, [api]);

  const write = async (fn) => {
    setErr("");
    try { await fn(); setForm(null); setConfirmId(""); await load(); } catch (e) { setErr(errText(e)); }
  };
  const save = (e) => {
    e.preventDefault();
    const { editing, ...body } = form;
    write(() => (editing ? api.put(`${API}/trusted-idps/${editing}`, body) : api.post(`${API}/trusted-idps`, body)));
  };
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const toggleTarget = (t) => setForm((f) => ({ ...f, targets: f.targets.includes(t) ? f.targets.filter((x) => x !== t) : [...f.targets, t] }));
  const canManage = !!state?.canManage;

  return (
    <section className="ijp-step" aria-labelledby="ijp-trusted" data-testid="ijp-trusted-idps">
      <header className="ijp-step__head"><h2 id="ijp-trusted">Trusted IdPs</h2></header>
      <p className="ijp-note">
        Outside IdPs whose ID-JAGs our resource authorization servers accept in the "Your IdP" mode. The resource AS reads the enabled entries from
        {" "}<strong>{API}/trusted-idps/registry</strong>; the PingFederate sync reads <strong>{API}/trusted-idps/pingfederate</strong>. Neither holds a secret.
      </p>
      {!state && <p className="ijp-note">Loading…</p>}
      {state?.error && <div className="ijp-banner ijp-banner--error" role="alert">{state.error}</div>}
      {state?.idps && !canManage && (
        <p className="ijp-note" data-testid="ijp-trusted-readonly">
          Read only here. Register your IdP, or review requests as an admin, on the <a href="/trusted-idps">Trusted IdPs page</a>.
        </p>
      )}
      {err && <div className="ijp-banner ijp-banner--error" role="alert">{err}</div>}
      {state?.idps && (
        state.idps.length === 0 ? <p className="ijp-note">No trusted IdPs yet.</p> : (
          <div className="ijp-checks">
            <table>
              <thead><tr><th>IdP</th><th>Issuer</th><th>Targets</th><th>What the IdP puts in the ID-JAG, and where it is redeemed</th>{canManage && <th>Actions</th>}</tr></thead>
              <tbody>
                {state.idps.map((e) => (
                  <tr key={e.id} className={e.enabled ? "" : "is-warn"}>
                    <td><strong>{e.name}</strong><div className="ijp-cite">{e.id}{e.enabled ? "" : " (disabled)"}</div></td>
                    <td>{e.issuer}<div className="ijp-cite">JWKS {e.jwksUrl}</div></td>
                    <td>{e.targets.join(", ")}{e.scopes && <div className="ijp-cite">scope cap: {e.scopes}</div>}</td>
                    <td>
                      {e.targets.map((t) => (
                        <dl key={t} className="ijp-kv">
                          <dt>{t === "pingfederate" ? "PingFederate" : "Resource AS"} aud</dt><dd>{endpoints?.[t]?.issuer || "(not configured)"}</dd>
                          <dt>client_id</dt><dd>{e.idJagClientId}</dd>
                          <dt>token endpoint</dt><dd>{endpoints?.[t]?.tokenEndpoint || "(not configured)"}</dd>
                        </dl>
                      ))}
                    </td>
                    {canManage && (
                      <td>
                        {confirmId === e.id ? (
                          <span role="group" aria-label={`Confirm delete ${e.name}`}>
                            Delete {e.name}?{" "}
                            <button type="button" className="ijp-btn ijp-btn--primary" onClick={() => write(() => api.delete(`${API}/trusted-idps/${e.id}`))}>Confirm delete</button>
                            <button type="button" className="ijp-btn" onClick={() => setConfirmId("")}>Cancel</button>
                          </span>
                        ) : (
                          <>
                            <button type="button" className="ijp-btn" onClick={() => setForm({ ...EMPTY_IDP, ...e, editing: e.id })}>Edit</button>
                            <button type="button" className="ijp-btn" onClick={() => setConfirmId(e.id)}>Delete</button>
                          </>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
      {canManage && !form && <button type="button" className="ijp-btn ijp-btn--primary" onClick={() => setForm({ ...EMPTY_IDP, editing: null })}>Add trusted IdP</button>}
      {form && (
        <form onSubmit={save} aria-label={form.editing ? "Edit trusted IdP" : "Add trusted IdP"}><fieldset className="ijp-args">
          <legend>{form.editing ? `Edit ${form.editing}` : "Add trusted IdP"}</legend>
          {IDP_FIELDS.map(([k, label]) => (
            <label key={k} className="ijp-field">{label}
              <input value={form[k]} disabled={k === "id" && !!form.editing} onChange={(e) => set(k, e.target.value)} />
            </label>
          ))}
          <fieldset className="ijp-targets"><legend>Targets</legend>
            {BYO_TARGETS.map((t) => (
              <label key={t.id} className="ijp-check"><input type="checkbox" checked={form.targets.includes(t.id)} onChange={() => toggleTarget(t.id)} />{t.label}</label>
            ))}
          </fieldset>
          <label className="ijp-check"><input type="checkbox" checked={form.enabled} onChange={(e) => set("enabled", e.target.checked)} />Enabled</label>
          <button type="submit" className="ijp-btn ijp-btn--primary">Save</button>
          <button type="button" className="ijp-btn" onClick={() => setForm(null)}>Cancel</button>
        </fieldset></form>
      )}
    </section>
  );
}

export default function IdJagPlaygroundPage() {
  const [mode, setMode] = useState(() => stored(MODE_KEY, MODES, "mock"));
  const [view, setView] = useState(() => stored(VIEW_KEY, VIEWS, "form"));
  const [resourceKind, setResourceKind] = useState(() => stored(RESOURCE_KEY, RESOURCES, "mcp"));
  const [protocol, setProtocol] = useState(() => stored(PROTOCOL_KEY, PROTOCOLS, "oidc"));
  const [realModes, setRealModes] = useState(null);
  const [config, setConfig] = useState(null);
  const [busy, setBusy] = useState("");
  const [issued, setIssued] = useState(null);
  const [inspection, setInspection] = useState(null);
  const [redeemScope, setRedeemScope] = useState("");
  const [redeemed, setRedeemed] = useState(null);
  const [tools, setTools] = useState(null);
  const [tool, setTool] = useState("");
  const [args, setArgs] = useState("{}");
  const [argForm, setArgForm] = useState({});
  const [callResult, setCallResult] = useState(null);
  const [negatives, setNegatives] = useState([]);
  const [negResults, setNegResults] = useState({});
  const [byoTarget, setByoTarget] = useState("resource-as");
  const [byoToken, setByoToken] = useState("");
  const [error, setError] = useState(null);
  const [gate, setGate] = useState(null);
  const [preflights, setPreflights] = useState({});
  const [resource, setResource] = useState(null);
  const [revoked, setRevoked] = useState(null);
  const [asRecord, setAsRecord] = useState(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const isMock = mode === "mock";
  const isByo = mode === "byo";
  // SAML is real only in pf-as when the server can sign assertions; mock always has it. Anywhere else the run is OIDC.
  const samlReady = mode === "pf-as" && !!config?.saml?.available;
  const saml = protocol === "saml" && (isMock || samlReady);
  const realSaml = saml && !isMock;
  const client = isMock ? mockApi : api;

  // The current ID-JAG's claims drive the scope list and the lifetime clocks.
  const idJagClaims = isByo ? (inspection?.trusted ? inspection.claims : null) : issued?.token?.claims;
  const scopeOptions = scopesOf(idJagClaims);
  const scopePick = scopeOptions.includes(redeemScope) ? redeemScope : ""; // a pick the new ID-JAG lacks falls back to all
  const tokenExp = redeemed?.token?.claims?.exp;
  useEffect(() => {
    if (typeof idJagClaims?.exp !== "number" && typeof tokenExp !== "number") return undefined;
    setNowMs(Date.now());
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [idJagClaims?.exp, tokenExp]);

  const applyConfig = (data) => {
    // A server without this route (e.g. the Vite dev server alone) answers with HTML, not JSON.
    if (!data?.idp) throw new Error("This server does not have the ID-JAG playground API. Start the API server (npm run dev -w server).");
    setConfig(data);
    if (data.modes) setRealModes(data.modes);
  };
  const loadNegatives = (a) => a.get(`${API}/negative`).then((r) => setNegatives(Array.isArray(r.data) ? r.data : [])).catch(() => {});

  useEffect(() => {
    if (mode === "mock") { setConfig(MOCK_CONFIG); loadNegatives(mockApi); return; }
    (async () => {
      try {
        const { data } = await api.get(`${API}/config`);
        applyConfig(data);
        // The server session remembers its own mode; bring it in line with the one this browser picked.
        if (data.mode && data.mode !== mode) {
          if (data.modes?.find((m) => m.id === mode)?.available === false) setMode(data.mode);
          else applyConfig((await api.post(`${API}/mode`, { mode })).data);
        }
        // Back from the IdenX sign-in (/xaa/callback): get the ID-JAG at once, or say why sign-in failed.
        const back = new URLSearchParams(window.location.search);
        if (back.has("xaa") || back.has("xaa_error")) window.history.replaceState(null, "", window.location.pathname);
        if (back.get("xaa_error")) setError({ step: "xaa", error: "xaa_sign_in_failed", message: `IdenX sign-in did not complete (${back.get("xaa_error")}).` });
        else if (back.get("xaa") === "signed_in" && mode === "byo") run("xaa", loadXaaIdJag, checkFor("xaa"));
      } catch (e) { setError(e.response?.data || { message: e.message }); }
    })();
    loadNegatives(api);
    // Initial load only: later mode changes go through pickMode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clearResults = () => {
    setIssued(null); setInspection(null); setRedeemed(null); setTools(null); setCallResult(null); setNegResults({}); setResource(null); setRevoked(null); setAsRecord(null); setGate(null); setPreflights({});
  };

  /**
   * Ask the server whether this step can work right now. Failing checks block the action and stay on
   * screen with their fix; warnings show and let it through. recheck bypasses the server's 30 s cache.
   */
  const passes = async (step, params = {}, recheck = false) => {
    let r;
    try {
      const q = new URLSearchParams({ step, mode, origin: window.location.origin, ...params, ...(recheck ? { fresh: "1" } : {}) });
      ({ data: r } = await api.get(`${API}/preflight?${q}`));
      if (!Array.isArray(r?.checks)) throw new Error("This server has no pre-flight checks. Start the API server that matches this page.");
    } catch (e) {
      r = { checks: [{ id: "preflight", label: "Pre-flight checks ran", status: "fail", detail: errText(e), fix: "Reload the page. If this persists, the API server is down or older than this page." }] };
    }
    const ok = !r.checks.some((c) => c.status === "fail");
    const shown = r.checks.filter((c) => c.status !== "pass");
    setPreflights((p) => ({ ...p, [step]: { ok, checks: r.checks } }));
    setGate(shown.length || recheck ? { step, params, ok, checks: shown } : null);
    return ok;
  };

  // Every action button goes through here: pre-flight first (real modes), then the action.
  const run = async (label, fn, check) => {
    setBusy(label);
    setError(null);
    try {
      if (check && !(await passes(check.step, check.params))) return;
      await fn();
    } catch (e) { setError({ step: label, ...(e.response?.data || { message: e.message }) }); } finally { setBusy(""); }
  };
  // Mock mode sends nothing, so it has nothing to pre-flight.
  const checkFor = (step, params) => (isMock ? null : { step, params });

  const recheck = () => {
    setBusy("recheck");
    passes(gate.step, gate.params, true).finally(() => setBusy(""));
  };

  const pickMode = (m) => {
    if (m === mode) return;
    if (m === "mock") {
      store(MODE_KEY, m); clearResults(); setMode(m); setError(null); setConfig(MOCK_CONFIG); loadNegatives(mockApi);
      return;
    }
    run("mode", async () => {
      store(MODE_KEY, m);
      clearResults();
      setMode(m);
      applyConfig((await api.post(`${API}/mode`, { mode: m })).data);
      if (isMock) loadNegatives(api);
    }, { step: "mode", params: { mode: m } });
  };

  const pickView = (v) => { store(VIEW_KEY, v); setView(v); };
  const pickResource = (r) => { store(RESOURCE_KEY, r); setResourceKind(r); };
  const pickProtocol = (p) => { if (p === (saml ? "saml" : "oidc")) return; store(PROTOCOL_KEY, p); clearResults(); setError(null); setProtocol(p); };

  // Sign in at the mode's issuer PingFederate (not the app sign-in): it holds the refresh token the ID-JAG is minted from.
  const signIn = () => run("signin", async () => {
    signInIssuer(RETURN_TO);
  }, checkFor("signin"));

  // byo: the browser sends the user's own ID-JAG once; the server keeps it and returns decoded claims.
  const byoInspect = () => run("byo", async () => {
    clearResults();
    const { data } = await api.post(`${API}/byo/inspect`, { idJag: byoToken.trim(), target: byoTarget });
    if (data.config) applyConfig(data.config);
    setInspection(data);
  }, checkFor("issue", { target: byoTarget }));

  // xaa.dev: IdenX (Okta's free XAA playground IdP) issues the ID-JAG. The server signs in there, exchanges, and
  // loads the ID-JAG like a pasted one. Mock mode answers with a sample IdenX ID-JAG.
  const loadXaaIdJag = async () => {
    clearResults(); setByoTarget("resource-as");
    let data;
    try {
      ({ data } = await client.post(`${API}/xaa/id-jag`, {}));
    } catch (e) {
      // The server may have dropped the IdenX session (refused refresh token): refresh so the button signs in again.
      if (!isMock) api.get(`${API}/config`).then((r) => applyConfig(r.data)).catch(() => {});
      throw e;
    }
    if (data.config) applyConfig(data.config);
    if (isMock) setIssued(data);
    setInspection(data);
  };
  const xaaIdJag = () => run("xaa", async () => {
    if (!isMock && !config?.xaa?.signedIn) {
      window.location.assign(`${API}/xaa/login?return_to=${RETURN_TO}`);
      return;
    }
    await loadXaaIdJag();
  }, checkFor("xaa"));

  const issue = () => run("issue", async () => {
    setRedeemed(null); setTools(null); setCallResult(null); setInspection(null); setResource(null);
    const r = await client.post(`${API}/issue`, saml ? { protocol: "saml" } : {});
    setIssued(r.data);
    setInspection((await client.post(`${API}/inspect`, {})).data);
  }, checkFor("issue", realSaml ? { protocol: "saml" } : undefined));

  // No scope = everything the ID-JAG grants (the AS gives ID-JAG ∩ client): the working default.
  const scopeBody = scopePick ? { scope: scopePick } : {};
  // What the kit's own resource AS recorded. A convenience: any failure just hides the panel.
  const loadAsRecord = () => !isMock && client.get(`${API}/as-events`).then((r) => setAsRecord(r.data)).catch(() => setAsRecord(null));

  const redeem = () => run("redeem", async () => {
    setTools(null); setCallResult(null); setAsRecord(null);
    const r = await client.post(`${API}/redeem`, scopeBody, { validateStatus: () => true });
    // A refusal before the AS (sign-in, scope guard) has no request to show: report it as an error.
    if (!r.data?.request) throw Object.assign(new Error(r.data?.message || `Redeem failed (HTTP ${r.status})`), { response: r });
    setRedeemed(r.data);
    if (r.data.status === 200) loadAsRecord(); // not awaited: it must not keep the buttons busy
  }, checkFor("redeem", scopeBody));

  const pickTool = (name) => { setTool(name); setArgForm({}); };

  const listTools = () => run("list", async () => {
    setTools(null); setCallResult(null);
    const r = await client.post(`${API}/call`, {});
    setTools(r.data);
    pickTool(r.data.tools?.[0]?.name || "");
  }, checkFor("call"));

  const openResource = (variant) => run("resource", async () => {
    const r = await client.post(`${API}/resource`, { variant }, { validateStatus: () => true });
    if (!r.data?.request) throw Object.assign(new Error(r.data?.message || `HTTP ${r.status}`), { response: r });
    setResource(r.data);
  }, checkFor("resource", { variant }));

  const selected = (tools?.tools || []).find((t) => t.name === tool);
  const schemaProps = selected?.inputSchema?.properties;
  const required = selected?.inputSchema?.required || [];
  const useArgForm = view === "form" && schemaProps && Object.keys(schemaProps).length > 0;

  const callTool = () => run("call", async () => {
    let parsed = {};
    if (useArgForm) parsed = buildArgs(schemaProps, argForm);
    else { try { parsed = JSON.parse(args || "{}"); } catch { throw new Error("Arguments must be JSON"); } }
    setCallResult(null);
    setCallResult((await client.post(`${API}/call`, { tool, arguments: parsed })).data);
  }, checkFor("call"));

  const runNegative = (id) => run(`neg-${id}`, async () => {
    const r = await client.post(`${API}/negative/${id}`, {}, { validateStatus: () => true });
    setNegResults((m) => ({ ...m, [id]: r.data }));
    loadAsRecord(); // not awaited: it must not keep the buttons busy
  }, checkFor("negative"));

  const runAllNegatives = () => run("neg-all", async () => {
    for (const t of negatives) {
      const r = await client.post(`${API}/negative/${t.id}`, {}, { validateStatus: () => true });
      setNegResults((m) => ({ ...m, [t.id]: r.data }));
    }
    loadAsRecord(); // not awaited: it must not keep the buttons busy
  }, checkFor("negative"));

  // Revoke this session's refresh token at PingFederate, then show that a new ID-JAG is refused. The server drops
  // the issuer sign-in, so the page re-reads /config and step 1 shows signed out.
  // Each ID-JAG works once, so after a redeem (or any dead end) the way forward is a new one from step 2. This clears
  // every result and the server's copy of the ID-JAG and access token; the sign-in stays.
  const startOver = () => run("restart", async () => {
    await client.post(`${API}/restart`, {});
    clearResults();
    setRedeemScope("");
    setError(null);
    document.getElementById("ijp-step-2")?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  });
  const hasResults = !!(issued || inspection || redeemed || tools || callResult || resource || revoked || Object.keys(negResults).length);

  const revokeAndProve = () => run("revoke", async () => {
    const { data } = await client.post(`${API}/revoke`, {});
    setIssued(null); setInspection(null); setRedeemed(null); setTools(null); setCallResult(null); setResource(null);
    setRevoked(data);
    if (!isMock) applyConfig((await api.get(`${API}/config`)).data);
  }, checkFor("revoke"));
  const revokeVerdict = (r) => (r.proved ? `Proved: PingFederate refused a new ID-JAG (${r.retry.error})`
    : r.control && r.control.status !== 200 ? `Not proved: the exchange already fails before revoking (${r.control.error}), so nothing was revoked.`
    : r.revoke.status !== 200 ? `Not proved: PingFederate did not accept the revocation (HTTP ${r.revoke.status}${r.revoke.error ? `, ${r.revoke.error}` : ""}).`
      : r.retry.status === 200 ? "Not proved: PingFederate still issued an ID-JAG."
        : `Not proved: the retry failed without an OAuth refusal (HTTP ${r.retry.status}).`);

  // Built in the browser from what the page shows (decoded claims, redacted requests): nothing is fetched.
  const downloadReport = (format) => {
    const report = buildReport({ mode, modeLabel: MODES.find((m) => m.id === mode)?.label, config, issued, inspection, redeemed,
      tools, callResult, resource, negatives: negatives.map((t) => ({ ...t, result: negResults[t.id] || null })), preflights });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    if (format === "json") downloadFile(`id-jag-run-${mode}-${stamp}.json`, JSON.stringify(report.json, null, 2), "application/json");
    else downloadFile(`id-jag-run-${mode}-${stamp}.md`, report.markdown, "text/markdown");
  };

  const text = MODE_TEXT[mode];
  // Each step shows the pre-flight result for its own button (byo's Inspect and the xaa.dev button are step 1's).
  const gateAt = (panel) => gate && ((gate.step === "issue" && isByo) || gate.step === "xaa" ? "signin" : gate.step) === panel
    && <PreflightPanel gate={gate} onRecheck={recheck} busy={!!busy} />;
  const errorAt = (...steps) => (error && steps.includes(error.step) ? <ErrorNote e={error} resource={config?.request?.resource} saml={saml} /> : null);
  const toolList = tools?.tools || [];
  const pfRedeems = mode === "pf-pf" || config?.target === "pingfederate";
  const ownAs = !isMock && !pfRedeems && (mode === "pf-as" || isByo); // the AS that redeems is the kit's own resource AS
  const modeInfo = realModes?.find((r) => r.id === mode);
  const pfReady = !!config && (isMock || isByo || modeInfo?.available !== false);
  const canRun = pfReady && (isMock || isByo || realSaml || config.signedIn); // SAML needs the app sign-in, which the server checks
  const hasIdJag = isByo ? !!inspection?.trusted : !!issued;
  const passed = inspection ? inspection.checks.filter((c) => c.status === "pass").length : 0;
  const modeOptions = MODES.map((m) => {
    const real = realModes?.find((r) => r.id === m.id);
    return real?.available === false ? { ...m, disabled: true, title: real.reason || "Not available on this server" } : m;
  });
  // Why SAML is off here: the server's reason, or that it needs pf-as, or (an older server) the old text.
  const samlTitle = !config?.saml ? SAML_UNVERIFIED : config.saml.available ? SAML_ONLY_PF_AS : config.saml.reason || SAML_ONLY_PF_AS;
  const signedInHere = realSaml ? !!config?.saml?.appSignedIn : !!config?.signedIn; // SAML needs the app sign-in; OIDC the issuer's
  const signInStatus = isMock ? "Sample data: no sign-in needed."
    : realSaml ? `${signedInHere ? "Signed in" : "Not signed in"} to this app.`
    : `${config?.signedIn ? "Signed in" : "Not signed in"} at ${config?.idp?.name || "the issuer PingFederate"}.`;

  return (
    <ViewContext.Provider value={view}>
      <main className={`ijp${isMock ? " ijp--mock" : ""}`} data-testid="id-jag-playground">
        <header className="ijp-hero">
          <div>
            <p className="ijp-eyebrow">PingFederate · ID-JAG · try it and validate it</p>
            <h1>ID-JAG Playground</h1>
            <p className="ijp-lede">
              Run the real flow one step at a time against your PingFederate, our resource authorization server and
              the sample MCP server. Every request and response is shown (tokens decoded, never raw), each button runs a
              pre-flight check first, the ID-JAG is checked against the IETF draft, and live negative tests confirm the
              authorization server refuses what it should.
            </p>
            <p className="ijp-lede">
              Prefer a real client? <a href="/guides#desktop">Run the same flow from mcpc or VS Code</a>: they sign in at
              PingFederate and call the sample MCP server themselves.
            </p>
          </div>
        </header>

        <div className="ijp-toolbar">
          <div className="ijp-toolbar__group"><span>Mode</span><Segmented label="Playground mode" options={modeOptions} value={mode} onPick={pickMode} disabled={!!busy} />
            <DiagramLink mode={mode}>View {PLAYGROUND_DIAGRAMS[mode].label} diagram ↗</DiagramLink></div>
          <div className="ijp-toolbar__group"><span>Sign-in</span><Segmented label="Sign-in protocol" value={saml ? "saml" : "oidc"} onPick={pickProtocol} disabled={!!busy}
            options={PROTOCOLS.map((p) => (p.id === "saml" && !isMock && !samlReady ? { ...p, disabled: true, title: samlTitle } : p))} /></div>
          <div className="ijp-toolbar__group"><span>View</span><Segmented label="Data view" options={VIEWS} value={view} onPick={pickView} /></div>
          <div className="ijp-toolbar__group">
            <button type="button" className="ijp-btn" onClick={startOver} disabled={!!busy || !hasResults} data-testid="ijp-start-over"
              title="Clear every result below and start again from step 2. Your sign-in stays.">Start over</button>
          </div>
          <div className="ijp-toolbar__group" data-admin-only=""><span>Report</span>
            <button type="button" className="ijp-btn" onClick={() => downloadReport("md")}>Download report</button>
            <button type="button" className="ijp-btn" onClick={() => downloadReport("json")}>Download JSON</button>
          </div>
        </div>
        {gateAt("mode")}
        {isMock && <p className="ijp-mock-badge" role="status" data-testid="ijp-mock-badge">Sample data: nothing is sent</p>}
        {config && <BackendsStrip client={client} mode={isMock ? "mock" : config.mode || mode} />}
        {config && !isMock && (config.mode || mode) === "pf-as" && <InteropPanel client={client} base={API} />}
        <p className="ijp-story" data-testid="ijp-story"><strong>The story.</strong> {text.story}</p>
        <StoryPanel mode={mode} />

        {config && (
          <section className="ijp-actors" aria-label="Who plays which role">
            <div className="ijp-actor"><h3>Client</h3><p>This app's server, acting for the agent</p><dl><dt>IdP client</dt><dd>{config.idp.exchangeClientId || "—"}</dd><dt>Client at the AS</dt><dd>{config.resourceAs.clientId || "—"}</dd></dl></div>
            <div className="ijp-actor ijp-actor--idp"><h3>IdP: {config.idp.name}</h3><p>Issues the ID-JAG</p><dl><dt>Issuer</dt><dd>{config.idp.issuer || "—"}</dd><dt>Token endpoint</dt><dd>{config.idp.tokenEndpoint || "—"}</dd><dt>JWKS</dt><dd>{config.idp.jwksUrl || "—"}</dd></dl></div>
            <div className="ijp-actor ijp-actor--as"><h3>Resource AS: {config.resourceAs.name}</h3><p>{text.asRole}</p><dl><dt>Issuer (aud)</dt><dd>{config.resourceAs.issuer || "—"}</dd><dt>Token endpoint</dt><dd>{config.resourceAs.tokenEndpoint || "—"}</dd></dl></div>
            <div className="ijp-actor"><h3>MCP server</h3><p>{text.mcpRole}</p><dl><dt>Resource</dt><dd>{config.request.resource || "—"}</dd><dt>Requested scope</dt><dd>{config.request.scope || "(none)"}</dd></dl></div>
          </section>
        )}

        {config && !pfReady && (
          <div className="ijp-banner" role="alert">
            {modeInfo?.reason || "This mode is not configured on this server."}
          </div>
        )}
        {error && !["list", "call", "resource"].includes(error.step) && <ErrorNote e={error} resource={config?.request?.resource} saml={saml} />}

        <Step n={1} mode={mode} done={!isMock && !isByo && signedInHere} title={realSaml ? "Sign in to this app (it signs the SAML assertion)" : saml ? "Sign in with SAML at PingFederate" : text.signInTitle} note={realSaml ? SAML_REAL_NOTE : saml ? SAML_NOTE : text.signInNote}>
          {(isByo || isMock) && (
            <div className="ijp-xaa" data-testid="ijp-xaa">
              <button type="button" className="ijp-btn ijp-btn--primary" onClick={xaaIdJag} disabled={!config?.xaa?.available || !!busy}>
                {busy === "xaa" ? "Getting an ID-JAG…" : XAA_BUTTON}
              </button>
              <p className="ijp-note">
                <a href="https://xaa.dev" target="_blank" rel="noopener noreferrer">xaa.dev</a> is Okta's free Cross App Access playground:
                its IdP, IdenX, signs you in with any email and issues an ID-JAG addressed to our resource AS.
                {config?.xaa?.signedIn && config.xaa.user ? ` Signed in at IdenX as ${config.xaa.user}.` : ""}
              </p>
              {config?.xaa && !config.xaa.available && <p className="ijp-note" role="note" data-testid="ijp-xaa-reason">{config.xaa.reason}</p>}
            </div>
          )}
          {isByo ? (
            <>
              <div className="ijp-toolbar__group"><span>Redeem at</span><Segmented label="Target authorization server" options={BYO_TARGETS} value={byoTarget} onPick={setByoTarget} disabled={!!busy} /></div>
              <p className="ijp-note">Your ID-JAG's aud must be <strong>{config?.publicEndpoints?.[byoTarget]?.issuer || "(not configured)"}</strong>.</p>
              <label className="ijp-field ijp-field--wide">Your ID-JAG (compact JWT)
                <textarea rows={4} value={byoToken} spellCheck={false} autoComplete="off" placeholder="eyJ…" onChange={(e) => setByoToken(e.target.value)} />
              </label>
              <button type="button" className="ijp-btn ijp-btn--primary" onClick={byoInspect} disabled={!byoToken.trim() || !!busy}>{busy === "byo" ? "Inspecting…" : "Inspect ID-JAG"}</button>
              {inspection?.trusted === false && <div className="ijp-banner" role="alert" data-testid="ijp-byo-hint">{inspection.hint}</div>}
            </>
          ) : (
            <>
              {signedInHere && !isMock ? (
                <>
                  <p className="ijp-status ijp-status--ok" data-testid="ijp-signin-status" role="status">
                    ✓ {signInStatus.replace(/\.$/, "")}{!realSaml && config.signedInAs ? ` as ${config.signedInAs}` : ""}. Nothing more to do in this step: continue to step 2.
                  </p>
                  <button type="button" className="ijp-btn" onClick={realSaml ? () => signInApp(RETURN_TO) : signIn} disabled={!pfReady || !!busy}
                    title="Starts a brand new sign-in, for a clean session or a different user.">Sign in as someone else</button>
                </>
              ) : (
                <>
                  <p className="ijp-status" data-testid="ijp-signin-status">{signInStatus}</p>
                  <button type="button" className="ijp-btn ijp-btn--primary" onClick={realSaml ? () => signInApp(RETURN_TO) : signIn} disabled={isMock || !pfReady || !!busy}>{realSaml ? "Sign in to this app" : text.signInTitle}</button>
                </>
              )}
            </>
          )}
          {(mode === "pf-as" || isMock) && config && (
            <details className="ijp-clients" data-admin-only="">
              <summary>Run this flow from a real client (mcpc, VS Code)</summary>
              <p className="ijp-note">
                These clients sign in at {config.idp.name}, trade the ID token for an ID-JAG and call the MCP server themselves.
                One-time setup: <a href="/guides#desktop">Use mcpc or VS Code as the client</a>.
              </p>
              <h4>mcpc</h4>
              <pre className="ijp-code">{mcpcCommand({ pfUrl: config.idp.issuer, mcpUrl: config.request.resource })}</pre>
              <h4>VS Code: user settings.json</h4>
              <pre className="ijp-code">{vscodeSettings({ pfUrl: config.idp.issuer })}</pre>
              <h4>VS Code: user mcp.json</h4>
              <pre className="ijp-code">{vscodeMcpJson({ mcpUrl: config.request.resource })}</pre>
            </details>
          )}
          {gateAt("signin")}
        </Step>

        <Step n={2} mode={mode} title={isByo ? "Check your ID-JAG against the draft" : saml ? "Trade the SAML assertion for an ID-JAG" : "Get an ID-JAG from PingFederate"} note={isByo ? null : SPEC_NOTES.issue}>
          {!isByo && <button type="button" className="ijp-btn ijp-btn--primary" onClick={issue} disabled={!canRun || !!busy}>{busy === "issue" ? "Requesting…" : "Request ID-JAG"}</button>}
          {gateAt("issue")}
          {isByo && inspection && (
            <StepTabs title="Check your ID-JAG against the draft" request={inspection.request} labels={{ request: "Request to IdenX", decoded: "Decoded ID-JAG" }}
              decoded={{ header: inspection.header, claims: inspection.claims }} initial="decoded" />
          )}
          {issued?.assertion && <StepTabs title="The SAML assertion" decoded={{ ...issued.assertion, xml: undefined }} xml={issued.assertion.xml} labels={{ xml: "XML (redacted)" }} initial="decoded" />}
          {issued && !isByo && <StepTabs title={issued.assertion ? "SAML assertion → ID-JAG" : "Get an ID-JAG from PingFederate"} request={issued.request} response={issued.response} decoded={issued.token} />}
          {inspection && (
            <div className="ijp-checks" data-testid="ijp-checks">
              <h4>Spec check: {passed} of {inspection.checks.length} pass</h4>
              <table>
                <thead><tr><th>Check</th><th>Result</th><th>Expected</th><th>Actual</th><th>Rule</th></tr></thead>
                <tbody>
                  {inspection.checks.map((c) => (
                    <tr key={c.id} className={`is-${c.status}`}>
                      <td>{c.label}</td>
                      <td>{c.status === "pass" ? "✅ pass" : c.status === "warn" ? "⚠️ warn" : "❌ fail"}</td>
                      <td>{String(c.expected ?? "")}</td>
                      <td>{typeof c.actual === "object" ? JSON.stringify(c.actual) : String(c.actual ?? "")}</td>
                      <td className="ijp-cite">{c.cite}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Step>

        <Step n={3} mode={mode} title={text.redeemTitle} note={SPEC_NOTES.redeem}>
          <Lifetime id="idjag" label="ID-JAG" exp={idJagClaims?.exp} used={redeemed?.status === 200} now={nowMs}
            again={isByo ? "Get or paste a fresh one to redeem again." : "Request a new one to redeem again."} />
          <label className="ijp-field">Scope to request
            <select value={scopePick} disabled={!idJagClaims} onChange={(e) => setRedeemScope(e.target.value)}>
              <option value="">All scopes in this ID-JAG (recommended)</option>
              {scopeOptions.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          {!idJagClaims && <p className="ijp-note">{isByo ? "Paste and inspect your ID-JAG first." : "Request an ID-JAG first."}</p>}
          <button type="button" className="ijp-btn ijp-btn--primary" onClick={redeem} disabled={!canRun || !hasIdJag || !!busy}>{busy === "redeem" ? "Redeeming…" : "Redeem ID-JAG"}</button>
          {hasIdJag && (
            <button type="button" className="ijp-btn" onClick={startOver} disabled={!!busy} data-testid="ijp-start-over-step3"
              title="An ID-JAG works once. Clear the results and request a new one from step 2.">Start over from step 2</button>
          )}
          {gateAt("redeem")}
          {redeemed && (
            <StepTabs title={text.redeemTitle} request={redeemed.request} response={redeemed.response} decoded={redeemed.token}
              labels={{ response: `Response (HTTP ${redeemed.status})` }} />
          )}
          {redeemed && redeemed.status !== 200 && explain(redeemed.response, config?.request?.resource) && (
            <p className="ijp-fix" role="note">{explain(redeemed.response, config?.request?.resource)}</p>
          )}
          {redeemed?.status === 200 && (isMock || asRecord?.available) && <AsRecord rec={isMock ? MOCK_AS_RECORD : asRecord} sample={isMock} />}
          {(ownAs || isMock) && (
            <p className="ijp-note" data-testid="ijp-as-link">
              {ownAs && config?.resourceAs?.issuer
                ? <a href={`${config.resourceAs.issuer.replace(/\/$/, "")}/`} target="_blank" rel="noopener noreferrer">Open the resource AS ↗</a>
                : "Open the resource AS ↗ (not available in mock mode)."}
              {" "}It lists every redemption it accepted or refused, live.
            </p>
          )}
        </Step>

        <Step n={4} mode={mode} title="Call the resource with the new token" note={resourceKind === "rest" ? REST_NOTE : text.call}>
          <Lifetime id="token" label="Access token" exp={tokenExp} now={nowMs} again="Request and redeem a new ID-JAG." />
          <div className="ijp-toolbar__group"><span>Resource</span><Segmented label="Resource" options={RESOURCES} value={resourceKind} onPick={pickResource} disabled={!!busy} /></div>
          {resourceKind === "mcp" ? (<>
          <button type="button" className="ijp-btn" onClick={listTools} disabled={!canRun || !redeemed?.token || !!busy}>{busy === "list" ? "Listing…" : "List tools this token can see"}</button>
          {gateAt("call")}
          {tools && toolList.length > 0 && (
            <div className="ijp-call">
              <label className="ijp-field">Tool
                <select value={tool} onChange={(e) => pickTool(e.target.value)}>
                  {toolList.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
                </select>
              </label>
              {selected?.description && <p className="ijp-note">{selected.description}</p>}
              {useArgForm ? (
                <fieldset className="ijp-args">
                  <legend>Arguments</legend>
                  {Object.entries(schemaProps).map(([k, p]) => {
                    const req = required.includes(k);
                    const set = (v) => setArgForm((f) => ({ ...f, [k]: v }));
                    const label = <>{k}{req && <span className="ijp-req"> (required)</span>}</>;
                    if (p.type === "boolean") {
                      return <label key={k} className="ijp-check"><input type="checkbox" checked={!!argForm[k]} onChange={(e) => set(e.target.checked)} />{label}</label>;
                    }
                    return (
                      <label key={k} className="ijp-field">{label}
                        {Array.isArray(p.enum) ? (
                          <select value={argForm[k] ?? ""} required={req} onChange={(e) => set(e.target.value)}>
                            <option value="">(none)</option>
                            {p.enum.map((o) => <option key={String(o)} value={String(o)}>{String(o)}</option>)}
                          </select>
                        ) : (
                          <input type={p.type === "number" || p.type === "integer" ? "number" : "text"} value={argForm[k] ?? ""} required={req}
                            placeholder={p.description || (p.type === "object" || p.type === "array" ? "JSON" : "")} onChange={(e) => set(e.target.value)} />
                        )}
                      </label>
                    );
                  })}
                </fieldset>
              ) : (
                <label className="ijp-field">Arguments (JSON)
                  <textarea rows={3} value={args} onChange={(e) => setArgs(e.target.value)} />
                </label>
              )}
              <button type="button" className="ijp-btn ijp-btn--primary" onClick={callTool} disabled={!tool || !!busy}>{busy === "call" ? "Calling…" : "Call tool"}</button>
            </div>
          )}
          {(tools || callResult || errorAt("list", "call")) && (
            <div className="ijp-results" data-testid="ijp-results" aria-live="polite">
              <h3>Results</h3>
              {errorAt("list", "call")}
              {tools && (
                <div>
                  <h4 data-testid="ijp-tool-count">tools/list: {toolList.length} tools</h4>
                  {toolList.length === 0 && <p className="ijp-note">0 tools: the token's scope allows none of this server's tools. Check its scope in step 3.</p>}
                  {tools.deniedTools?.length > 0 && <p className="ijp-note">{`Hidden from this token by scope: ${tools.deniedTools.join(", ")}`}</p>}
                  <StepTabs title="tools/list" request={tools.request} initial="response"
                    response={toolList.length > 0 ? toolList.map(({ name, description }) => ({ name, description })) : undefined} />
                </div>
              )}
              {callResult && <StepTabs title="tools/call" request={callResult.request} response={callResult.result} labels={{ response: "Result" }} initial="response" />}
            </div>
          )}
          </>) : (
            <div data-testid="ijp-resource">
            {pfRedeems && !isMock && (
              <p className="ijp-banner">This mode's access token comes from PingFederate. mcp-sample trusts the resource AS's tokens only, so expect a refusal; PingFederate → resource AS shows it accepted.</p>
            )}
            <button type="button" className="ijp-btn ijp-btn--primary" onClick={() => openResource("token")} disabled={!redeemed?.token || !!busy}>Open with the access token</button>
            <button type="button" className="ijp-btn" onClick={() => openResource("no-token")} disabled={!config || !!busy}>Try without a token</button>
            <button type="button" className="ijp-btn" onClick={() => openResource("id-jag")} disabled={!hasIdJag || !!busy}>Try with the raw ID-JAG</button>
            {gateAt("resource")}
            {errorAt("resource")}
            {resource && (view === "json" ? <Data value={resource} /> : <ResourcePage r={resource} />)}
            </div>
          )}
        </Step>

        <Step n={5} mode={mode} title="Negative tests against the authorization server" note={isByo ? SPEC_NOTES.negativeByo : SPEC_NOTES.negative}>
          {(ownAs || isMock) && <p className="ijp-note">Refusals appear in the resource AS's own record too.</p>}
          <button type="button" className="ijp-btn" onClick={runAllNegatives} disabled={!canRun || (isByo && !hasIdJag) || !!busy}>{busy === "neg-all" ? "Running…" : "Run all"}</button>
          {gateAt("negative")}
          <ul className="ijp-negatives">
            {negatives.map((t) => {
              const r = negResults[t.id];
              return (
                <li key={t.id} className={r ? (r.pass ? "is-pass" : "is-fail") : ""}>
                  <div>
                    <strong>{t.label}</strong> <span className="ijp-cite">expects {t.expect}</span>
                    <p className="ijp-note">{t.why}</p>
                    {r && <p className="ijp-result">{r.skipped ? "skipped" : r.pass ? "✅ refused" : "❌ not refused"}{r.status ? ` (HTTP ${r.status}${r.error ? `, ${r.error}` : ""})` : ""}{r.note ? ` ${r.note}` : ""}</p>}
                  </div>
                  <button type="button" className="ijp-btn" onClick={() => runNegative(t.id)} disabled={!canRun || (isByo && !hasIdJag) || !!busy}>Run</button>
                </li>
              );
            })}
          </ul>
        </Step>

        {MODE_STEPS[mode].includes(6) && !saml && ( // SAML has no refresh token to revoke
          <Step n={6} mode={mode} title="Revoke and prove it" note={SPEC_NOTES.revoke}>
            <button type="button" className="ijp-btn ijp-btn--primary" onClick={revokeAndProve} disabled={!canRun || !!busy}>{busy === "revoke" ? "Revoking…" : "Revoke and retry"}</button>
            {gateAt("revoke")}
            {revoked && (
              <>
                <p className={`ijp-pill ${revoked.proved ? "is-ok" : "is-bad"}`} data-testid="ijp-revoke-verdict">{revokeVerdict(revoked)}</p>
                {revoked.control && (
                  <StepTabs title="Control: ask for an ID-JAG before revoking" request={revoked.control.request} labels={{ response: `Response (HTTP ${revoked.control.status})` }}
                    response={{ status: revoked.control.status, error: revoked.control.error, error_description: revoked.control.error_description }} />
                )}
                {revoked.revoke && (
                  <>
                    <StepTabs title="Revoke the refresh token" request={revoked.revoke.request} labels={{ response: `Response (HTTP ${revoked.revoke.status})` }}
                      response={{ status: revoked.revoke.status, error: revoked.revoke.error, error_description: revoked.revoke.error_description }} />
                    <StepTabs title="Ask for a new ID-JAG with it" request={revoked.retry.request} labels={{ response: `Response (HTTP ${revoked.retry.status})` }} initial="response"
                      response={{ status: revoked.retry.status, error: revoked.retry.error, error_description: revoked.retry.error_description }} />
                  </>
                )}
              </>
            )}
          </Step>
        )}

        <TrustedIdpsPanel api={client} endpoints={config?.publicEndpoints} />

        <section className="ijp-step" aria-labelledby="ijp-vendors">
          <header className="ijp-step__head"><h2 id="ijp-vendors">How other implementations do it</h2></header>
          <p className="ijp-note">Same draft, different products. Use this to explain where PingFederate fits and what to check when a customer brings Okta, Auth0 or Keycloak.</p>
          <table className="ijp-vendors">
            <thead><tr><th>Product</th><th>Issuing the ID-JAG</th><th>Redeeming it</th><th>Worth knowing</th></tr></thead>
            <tbody>{VENDORS.map((v) => <tr key={v.name}><td>{v.name}</td><td>{v.issue}</td><td>{v.redeem}</td><td>{v.notes}</td></tr>)}</tbody>
          </table>
          <p className="ijp-note">
            Sources: <a href="https://datatracker.ietf.org/doc/draft-ietf-oauth-identity-assertion-authz-grant/" target="_blank" rel="noopener noreferrer">IETF draft</a>,{" "}
            <a href="https://developer.okta.com/docs/guides/xaa-request-token-ex/main/" target="_blank" rel="noopener noreferrer">Okta XAA</a>,{" "}
            <a href="https://workos.com/blog/mcp-enterprise-managed-authorization-id-jag" target="_blank" rel="noopener noreferrer">WorkOS</a>,{" "}
            <a href="https://www.keycloak.org/nightly/securing-apps/identity-assertion-jwt-authorization-grant" target="_blank" rel="noopener noreferrer">Keycloak</a>,{" "}
            <a href="https://docs.mcpjam.com/inspector/xaa-debugger" target="_blank" rel="noopener noreferrer">MCPJam XAA debugger</a>,{" "}
            <a href="https://developer.okta.com/blog/2026/01/20/xaa-dev-playground" target="_blank" rel="noopener noreferrer">xaa.dev</a>.
          </p>
        </section>
      </main>
    </ViewContext.Provider>
  );
}

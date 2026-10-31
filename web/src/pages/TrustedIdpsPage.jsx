import { useEffect, useState } from "react";
import api from "../services/api";
import { useMe } from "../auth/useMe";
import { signIn } from "../utils/signIn";
import "./console.css";

// Trusted IdPs: anyone signed in registers their IdP (pending); an admin approves it before our
// resource AS or PingFederate trusts it. Owners get their resource AS client secret once.

const API = "/api/id-jag-playground/trusted-idps";
const PRODUCTS = [
  { id: "pingfederate", label: "PingFederate", guide: "pf-issuer", hint: [
    "Issuer: your PingFederate base URL, exactly as it appears in iss (for example https://pf.example.com).",
    "JWKS: https://<your PingFederate>/pf/JWKS. It lists the ID-JAG key only when a JWT access token manager publishes it.",
    "PingFederate ID-JAGs carry x5t and no kid: if our PingFederate redeems them, publish a single-key JWKS.",
  ] },
  { id: "okta", label: "Okta", guide: "okta", hint: [
    "Issuer: your Okta org authorization server, https://<org>.okta.com. Cross App Access does not use /oauth2/default.",
    "Discovery finds the JWKS (/oauth2/v1/keys).",
    "client_id in the ID-JAG is the requesting app's client id in Okta. ID-JAGs live 300 s.",
  ] },
  { id: "auth0", label: "Auth0", guide: "generic", hint: [
    "Issuer: https://<tenant>.<region>.auth0.com/ with the trailing slash, exactly as Auth0 writes iss (or your custom domain).",
    "Discovery finds the JWKS (/.well-known/jwks.json).",
    "Check the claims checklist: typ, a single aud and the client_id you register below.",
  ] },
  { id: "keycloak", label: "Keycloak", guide: "generic", hint: [
    "Issuer: https://<host>/realms/<realm>.",
    "Discovery finds the JWKS (/protocol/openid-connect/certs).",
    "Keycloak nightly redeems ID-JAGs but does not issue them yet: register it once your build mints ID-JAGs.",
  ] },
  { id: "generic", label: "Other IdP", guide: "generic", hint: [
    "Issuer: exactly the iss your IdP writes.",
    "Discovery reads /.well-known/openid-configuration, then /.well-known/oauth-authorization-server.",
    "Follow the claims checklist in the setup guides.",
  ] },
];
const TARGETS = [{ id: "resource-as", label: "Our resource AS" }, { id: "pingfederate", label: "Our PingFederate" }];
const STATUS = { pending: "Pending review", approved: "Approved", rejected: "Rejected", disabled: "Disabled" };
const EMPTY = { id: "", name: "", product: "pingfederate", issuer: "", jwksUrl: "", idJagClientId: "", pfClientId: "", scopes: "", targets: ["resource-as"] };
const FIELDS = Object.keys(EMPTY);

const errText = (e) => e.response?.data?.message || e.response?.data?.error || e.message;
const productLabel = (id) => PRODUCTS.find((p) => p.id === id)?.label || id;
const hasClient = (e) => e.status === "approved" && e.targets.includes("resource-as") && e.clientId === `idp-${e.id}`;

function StatusBadge({ status }) {
  return <span className={`kc-badge kc-badge--${status}`}>{STATUS[status] || status}</span>;
}

/** Results of "Test this IdP". */
function TestResult({ result }) {
  if (!result) return null;
  if (result.error) return <div className="kc-banner kc-banner--error" role="alert">{result.error}</div>;
  return (
    <div className="kc-test" aria-live="polite">
      <p>
        {result.keyCount} key{result.keyCount === 1 ? "" : "s"}, {result.distinctRsaKeys} distinct RSA, kid on {result.withKid}, x5t on {result.withX5t}.
      </p>
      {result.warnings.map((w) => <div key={w} className="kc-banner" role="alert">{w}</div>)}
      {result.keys.length > 0 && (
        <div className="kc-table-wrap">
          <table className="kc-table">
            <thead><tr><th>kty</th><th>alg</th><th>use</th><th>kid</th><th>x5t</th></tr></thead>
            <tbody>{result.keys.map((k, i) => <tr key={i}><td>{k.kty}</td><td>{k.alg || "-"}</td><td>{k.use || "-"}</td><td>{k.kid || "-"}</td><td>{k.x5t || "-"}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const runTest = (jwksUrl, targets) => api.post(`${API}/test`, { jwksUrl, targets }).then((r) => r.data).catch((e) => ({ error: errText(e) }));

function IdpCard({ e, showOwner, children }) {
  const [test, setTest] = useState(null);
  return (
    <li className="kc-idp" data-status={e.status}>
      <div className="kc-idp__head"><h3>{e.name}</h3><StatusBadge status={e.status} /></div>
      <dl className="kc-kv">
        <dt>Id</dt><dd>{e.id}</dd>
        <dt>Product</dt><dd>{productLabel(e.product)}</dd>
        <dt>Issuer</dt><dd>{e.issuer}</dd>
        <dt>JWKS</dt><dd>{e.jwksUrl}</dd>
        <dt>client_id in the ID-JAG</dt><dd>{e.idJagClientId}</dd>
        <dt>Redeemed at</dt><dd>{e.targets.map((t) => TARGETS.find((x) => x.id === t)?.label || t).join(", ")}</dd>
        {e.targets.includes("resource-as") && <><dt>Our client at the resource AS</dt><dd>{e.clientId}</dd></>}
        {e.targets.includes("pingfederate") && <><dt>Our client at PingFederate</dt><dd>{e.pfClientId}</dd></>}
        {e.scopes && <><dt>Scope cap</dt><dd>{e.scopes}</dd></>}
        {showOwner && <><dt>Owner</dt><dd>{e.owner}</dd></>}
        {e.reviewReason && <><dt>Review note</dt><dd>{e.reviewReason}</dd></>}
      </dl>
      <div className="kc-actions">
        <button type="button" className="kc-btn" onClick={async () => setTest(await runTest(e.jwksUrl, e.targets))}>Test this IdP</button>
        {children}
      </div>
      <TestResult result={test} />
    </li>
  );
}

function IdpForm({ initial, onCancel, onSaved }) {
  const editing = initial.editing;
  const [f, setF] = useState(() => Object.fromEntries(FIELDS.map((k) => [k, initial[k] ?? EMPTY[k]])));
  const [err, setErr] = useState("");
  const [found, setFound] = useState("");
  const [test, setTest] = useState(null);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const toggle = (t) => setF((x) => ({ ...x, targets: x.targets.includes(t) ? x.targets.filter((y) => y !== t) : [...x.targets, t] }));
  const product = PRODUCTS.find((p) => p.id === f.product) || PRODUCTS[PRODUCTS.length - 1];

  const discoverJwks = async () => {
    setErr(""); setFound("");
    try {
      const { data } = await api.post(`${API}/discover`, { issuer: f.issuer });
      set("jwksUrl", data.jwksUrl);
      setFound(`Found in ${data.metadataUrl}`);
    } catch (e) { setErr(errText(e)); }
  };
  const submit = async (ev) => {
    ev.preventDefault();
    setErr("");
    try {
      await (editing ? api.put(`${API}/${editing}`, f) : api.post(API, f));
      onSaved();
    } catch (e) { setErr(errText(e)); }
  };

  return (
    <form className="kc-form" onSubmit={submit} aria-label={editing ? `Edit ${editing}` : "Register an IdP"}>
      <h2>{editing ? `Edit ${editing}` : "Register an IdP"}</h2>
      {editing && initial.status === "approved" && (
        <p className="kc-banner">
          Changing the issuer, JWKS URL, client ids, targets or scope cap sends this IdP back to review and removes its resource AS client until an admin approves it again.
        </p>
      )}
      <fieldset className="kc-fieldset">
        <legend>Product</legend>
        {PRODUCTS.map((p) => (
          <label key={p.id} className="kc-choice">
            <input type="radio" name="product" value={p.id} checked={f.product === p.id} onChange={() => set("product", p.id)} />{p.label}
          </label>
        ))}
      </fieldset>
      <div className="kc-hint" data-testid="kc-product-hint">
        {product.hint.map((h) => <p key={h}>{h}</p>)}
        <p><a href={`/guides#${product.guide}`}>Setup guide</a></p>
      </div>
      <div className="kc-field">
        <label htmlFor="kc-id">Id (slug)</label>
        <input id="kc-id" value={f.id} disabled={!!editing} required aria-describedby="kc-id-help" onChange={(e) => set("id", e.target.value)} />
        <small id="kc-id-help">Lowercase letters, digits and dashes. Your resource AS client becomes idp-&lt;id&gt;.</small>
      </div>
      <label className="kc-field">Name<input value={f.name} required onChange={(e) => set("name", e.target.value)} /></label>
      <div className="kc-field">
        <label htmlFor="kc-issuer">Issuer</label>
        <div className="kc-inline">
          <input id="kc-issuer" type="url" value={f.issuer} required placeholder="https://" aria-describedby="kc-issuer-help" onChange={(e) => set("issuer", e.target.value)} />
          <button type="button" className="kc-btn" disabled={!f.issuer} onClick={discoverJwks}>Discover JWKS</button>
        </div>
        <small id="kc-issuer-help">Exactly the iss your IdP writes: compared byte for byte.</small>
      </div>
      <div className="kc-field">
        <label htmlFor="kc-jwks">JWKS URL</label>
        <input id="kc-jwks" type="url" value={f.jwksUrl} required placeholder="https://" aria-describedby="kc-jwks-help" onChange={(e) => set("jwksUrl", e.target.value)} />
        <small id="kc-jwks-help" aria-live="polite">{found}</small>
      </div>
      <label className="kc-field">client_id your IdP writes in the ID-JAG
        <input value={f.idJagClientId} required onChange={(e) => set("idJagClientId", e.target.value)} />
      </label>
      <fieldset className="kc-fieldset">
        <legend>Redeemed at</legend>
        {TARGETS.map((t) => (
          <label key={t.id} className="kc-choice"><input type="checkbox" checked={f.targets.includes(t.id)} onChange={() => toggle(t.id)} />{t.label}</label>
        ))}
      </fieldset>
      {f.targets.includes("pingfederate") && (
        <label className="kc-field">Our client at PingFederate (optional)<input value={f.pfClientId} onChange={(e) => set("pfClientId", e.target.value)} /></label>
      )}
      <label className="kc-field">Scope cap (optional, space-separated)<input value={f.scopes} onChange={(e) => set("scopes", e.target.value)} /></label>
      {err && <div className="kc-banner kc-banner--error" role="alert">{err}</div>}
      <div className="kc-actions">
        <button type="button" className="kc-btn" disabled={!f.jwksUrl} onClick={async () => setTest(await runTest(f.jwksUrl, f.targets))}>Test this IdP</button>
        <button type="submit" className="kc-btn kc-btn--primary">{editing ? "Save changes" : "Submit for review"}</button>
        <button type="button" className="kc-btn" onClick={onCancel}>Cancel</button>
      </div>
      <TestResult result={test} />
    </form>
  );
}

function SecretOnce({ secret, onDone }) {
  return (
    <section className="kc-secret" role="status" aria-label="New client secret">
      <h3>Client secret for {secret.clientId}</h3>
      <p className="kc-note">Shown once and stored nowhere here. Put it in your agent's secret store now; getting a new one replaces it.</p>
      <label className="kc-field">Client secret
        <input readOnly value={secret.clientSecret} onFocus={(e) => e.target.select()} />
      </label>
      <div className="kc-actions">
        <button type="button" className="kc-btn" onClick={() => navigator.clipboard?.writeText(secret.clientSecret)}>Copy</button>
        <button type="button" className="kc-btn kc-btn--primary" onClick={onDone}>I stored it</button>
      </div>
    </section>
  );
}

function MyIdps() {
  const [idps, setIdps] = useState(null);
  const [form, setForm] = useState(null);
  const [confirm, setConfirm] = useState("");
  const [secret, setSecret] = useState(null);
  const [err, setErr] = useState("");
  const load = () => api.get(`${API}/mine`).then((r) => setIdps(r.data.idps || [])).catch((e) => setErr(errText(e)));
  useEffect(() => { load(); }, []);
  const act = async (fn) => {
    setErr(""); setConfirm("");
    try { await fn(); await load(); } catch (e) { setErr(errText(e)); }
  };
  const getSecret = (e) => act(async () => setSecret((await api.post(`${API}/${e.id}/secret`, {})).data));

  return (
    <>
      {err && <div className="kc-banner kc-banner--error" role="alert">{err}</div>}
      {secret && <SecretOnce secret={secret} onDone={() => setSecret(null)} />}
      {idps === null && !err && <p className="kc-note">Loading…</p>}
      {idps?.length === 0 && !form && <p className="kc-note">You have not registered an IdP yet.</p>}
      {idps?.length > 0 && (
        <ul className="kc-list">
          {idps.map((e) => (
            <IdpCard key={e.id} e={e}>
              <button type="button" className="kc-btn" onClick={() => setForm({ ...e, editing: e.id })}>Edit</button>
              {hasClient(e) && (e.secretIssuedAt
                ? (confirm === `rotate:${e.id}`
                  ? <button type="button" className="kc-btn kc-btn--danger" onClick={() => getSecret(e)}>Confirm rotate</button>
                  : <button type="button" className="kc-btn" onClick={() => setConfirm(`rotate:${e.id}`)}>Rotate secret</button>)
                : <button type="button" className="kc-btn kc-btn--primary" onClick={() => getSecret(e)}>Get client secret</button>)}
              {confirm === `withdraw:${e.id}`
                ? <button type="button" className="kc-btn kc-btn--danger" onClick={() => act(() => api.delete(`${API}/${e.id}`))}>Confirm withdraw</button>
                : <button type="button" className="kc-btn kc-btn--danger" onClick={() => setConfirm(`withdraw:${e.id}`)}>Withdraw</button>}
              {confirm && confirm.endsWith(`:${e.id}`) && <button type="button" className="kc-btn" onClick={() => setConfirm("")}>Cancel</button>}
            </IdpCard>
          ))}
        </ul>
      )}
      {form
        ? <IdpForm key={form.editing || "new"} initial={form} onCancel={() => setForm(null)} onSaved={() => { setForm(null); load(); }} />
        : <button type="button" className="kc-btn kc-btn--primary" onClick={() => setForm({ ...EMPTY, editing: null })}>Register an IdP</button>}
    </>
  );
}

function ReviewQueue() {
  const [idps, setIdps] = useState(null);
  const [reasons, setReasons] = useState({});
  const [err, setErr] = useState("");
  const load = () => api.get(`${API}/all`).then((r) => setIdps(r.data.idps || [])).catch((e) => setErr(errText(e)));
  useEffect(() => { load(); }, []);
  const review = async (e, action) => {
    setErr("");
    try {
      // An approval names the version reviewed: the server refuses it if the owner edited since.
      await api.post(`${API}/${e.id}/${action}`, action === "approve" ? { updatedAt: e.updatedAt } : { reason: reasons[e.id] || "" });
      setReasons((r) => ({ ...r, [e.id]: "" }));
      await load();
    } catch (x) { setErr(errText(x)); }
  };
  const pending = idps?.filter((e) => e.status === "pending").length || 0;
  const sorted = idps && [...idps].sort((a, b) => (a.status === "pending" ? 0 : 1) - (b.status === "pending" ? 0 : 1));

  return (
    <>
      {err && <div className="kc-banner kc-banner--error" role="alert">{err}</div>}
      {idps && <p className="kc-note">{pending} waiting for review</p>}
      <ul className="kc-list">
        {sorted?.map((e) => (
          <IdpCard key={e.id} e={e} showOwner>
            {e.status !== "approved" && <button type="button" className="kc-btn kc-btn--primary" onClick={() => review(e, "approve")}>Approve</button>}
            {e.status === "approved" && <button type="button" className="kc-btn kc-btn--danger" onClick={() => review(e, "disable")}>Disable</button>}
            {e.status !== "rejected" && (
              <>
                <label className="kc-field">Reason (the owner sees it)
                  <textarea rows={2} value={reasons[e.id] || ""} onChange={(x) => setReasons((r) => ({ ...r, [e.id]: x.target.value }))} />
                </label>
                <button type="button" className="kc-btn kc-btn--danger" disabled={!reasons[e.id]?.trim()} onClick={() => review(e, "reject")}>Reject</button>
              </>
            )}
          </IdpCard>
        ))}
      </ul>
    </>
  );
}

const show = (v) => (Array.isArray(v) ? v.join(", ") : v === null || v === undefined || v === "" ? "(none)" : String(v));
function changes(ev) {
  if (!ev.before && ev.after) return ["registered"];
  if (ev.before && !ev.after) return ["removed"];
  const out = Object.keys({ ...ev.before, ...ev.after })
    .filter((k) => !["updatedAt", "reviewedAt", "secretIssuedAt"].includes(k) && JSON.stringify(ev.before?.[k]) !== JSON.stringify(ev.after?.[k]))
    .map((k) => `${k}: ${show(ev.before?.[k])} → ${show(ev.after?.[k])}`);
  if (ev.action === "rotate-secret") out.push("new client secret issued");
  return out;
}

function AuditLog() {
  const [rows, setRows] = useState(null);
  const [next, setNext] = useState(null);
  const [err, setErr] = useState("");
  const loadPage = (before) => api.get(before == null ? `${API}/audit` : `${API}/audit?before=${before}`)
    .then((r) => { setRows((x) => (before == null ? r.data.entries : [...x, ...r.data.entries])); setNext(r.data.next); })
    .catch((e) => setErr(errText(e)));
  useEffect(() => { loadPage(null); }, []);

  return (
    <>
      {err && <div className="kc-banner kc-banner--error" role="alert">{err}</div>}
      {rows?.length === 0 && <p className="kc-note">No changes yet.</p>}
      {rows?.length > 0 && (
        <div className="kc-table-wrap">
          <table className="kc-table">
            <caption className="kc-note">Every registry change, newest first. Append-only.</caption>
            <thead><tr><th>When</th><th>Who</th><th>Action</th><th>IdP</th><th>Changes</th></tr></thead>
            <tbody>
              {rows.map((ev, i) => (
                <tr key={`${ev.at}-${i}`}>
                  <td><time dateTime={ev.at}>{ev.at ? new Date(ev.at).toLocaleString() : "?"}</time></td>
                  <td>{ev.actor}</td>
                  <td>{ev.action}</td>
                  <td>{ev.id}</td>
                  <td>
                    <ul className="kc-changes">
                      {changes(ev).map((c) => <li key={c}>{c}</li>)}
                      {ev.reason && <li>reason: {ev.reason}</li>}
                    </ul>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next != null && <button type="button" className="kc-btn" onClick={() => loadPage(next)}>Load older</button>}
    </>
  );
}

export default function TrustedIdpsPage() {
  const me = useMe();
  const [tab, setTab] = useState("mine");
  const tabs = [["mine", "My IdPs"], ...(me?.isAdmin ? [["review", "Review queue"], ["audit", "Audit log"]] : [])];
  const onKeyDown = (e) => {
    const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (!d) return;
    const i = tabs.findIndex(([id]) => id === tab);
    const nextTab = tabs[(i + d + tabs.length) % tabs.length][0];
    setTab(nextTab);
    document.getElementById(`kc-tab-${nextTab}`)?.focus();
  };

  return (
    <main className="kc">
      <header className="kc-hero">
        <p className="kc-eyebrow">Bring your own IdP</p>
        <h1>Trusted IdPs</h1>
        <p className="kc-lede">
          Register the IdP that issues your ID-JAGs. An admin reviews it; once approved, our resource AS (and, if you pick it, our PingFederate)
          accepts its ID-JAGs, and you get a dedicated client to redeem them. <a href="/guides">Setup guides</a>
        </p>
      </header>
      {me === undefined && <p className="kc-note">Loading…</p>}
      {me === null && (
        <section className="kc-card">
          <h2>Sign in to register an IdP</h2>
          <p className="kc-note">Sign-in goes through PingFederate. Only verified pingidentity.com and pingone.com addresses can sign in.</p>
          <button type="button" className="kc-btn kc-btn--primary" onClick={() => signIn("/trusted-idps")}>Sign in</button>
        </section>
      )}
      {me && (
        <>
          <div role="tablist" aria-label="Trusted IdPs" className="kc-tabs" onKeyDown={onKeyDown}>
            {tabs.map(([id, label]) => (
              <button key={id} type="button" role="tab" id={`kc-tab-${id}`} aria-selected={tab === id} aria-controls={`kc-panel-${id}`}
                tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)}>{label}</button>
            ))}
          </div>
          <section role="tabpanel" id={`kc-panel-${tab}`} aria-labelledby={`kc-tab-${tab}`}>
            {tab === "mine" && <MyIdps />}
            {tab === "review" && <ReviewQueue />}
            {tab === "audit" && <AuditLog />}
          </section>
        </>
      )}
    </main>
  );
}

// What the resource AS shows about its own /token decisions: a bounded in-memory record
// (never an assertion, token or secret) and the small HTML page that lists it.
const MAX_EVENTS = 50;
const clip = (v) => (typeof v === 'string' ? v.slice(0, 200) : undefined);

/** j***@pingone.com for an email; anything else keeps its first 4 characters. */
export function maskSub(sub) {
  if (typeof sub !== 'string' || !sub) return undefined;
  const at = sub.indexOf('@');
  if (at > 0) return `${sub[0]}***${sub.slice(at, at + 120)}`;
  return `${sub.slice(0, 4)}…`;
}

export function createEvents() {
  const events = [];
  return {
    events,
    /** ctx = the decision log context; reason is set for refusals only. */
    record(decision, ctx, { error, reason } = {}) {
      events.unshift({
        at: new Date().toISOString(), decision, error, reason: clip(reason),
        iss: clip(ctx.iss), client_id: clip(ctx.client_id), sub: maskSub(ctx.sub), aud: clip(ctx.aud), scope: clip(ctx.scope),
        jti: typeof ctx.jti === 'string' && ctx.jti ? `${ctx.jti.slice(0, 8)}…` : undefined,
      });
      events.length = Math.min(events.length, MAX_EVENTS);
    },
  };
}

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function renderPage({ issuer, idps, events }) {
  const rows = events.map((e) => `<tr>
<td data-l="Time">${esc(e.at.replace('T', ' ').slice(0, 19))} UTC</td>
<td data-l="Decision"><span class="pill ${e.decision === 'accepted' ? 'ok' : 'no'}">${e.decision === 'accepted' ? '&#10003; Accepted' : '&#10007; Refused'}</span></td>
<td data-l="Client">${esc(e.client_id)}</td><td data-l="Issuer">${esc(e.iss)}</td><td data-l="Scope">${esc(e.scope)}</td>
<td data-l="Resource">${esc(e.aud)}</td><td data-l="Subject">${esc(e.sub)}</td><td data-l="jti">${esc(e.jti)}</td>
<td data-l="Reason">${esc(e.reason)}</td></tr>`).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="5"><title>Resource authorization server</title>
<style>
:root{--bg:#fff;--fg:#051727;--mut:#5b6773;--line:#dde2e7;--red:#d20e0f;--ok:#0a7a3b;--okbg:#e3f4ea;--nobg:#fde8e8}
@media (prefers-color-scheme:dark){:root{--bg:#051727;--fg:#eef2f6;--mut:#a3b0bd;--line:#26384a;--red:#ff5a5b;--ok:#5fd18b;--okbg:#0f3a24;--nobg:#4a1717}}
body{font-family:Montserrat,system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--fg);margin:0;padding:24px 16px;line-height:1.5}
main{max-width:1100px;margin:0 auto}h1{font-size:1.5rem;margin:0 0 4px;border-left:4px solid var(--red);padding-left:12px}
h2{font-size:1.05rem;margin:28px 0 8px}p,li{color:var(--mut)}a{color:var(--red)}code{overflow-wrap:anywhere}
table{border-collapse:collapse;width:100%;font-size:.85rem}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);overflow-wrap:anywhere;vertical-align:top}
.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-weight:600;white-space:nowrap}.ok{background:var(--okbg);color:var(--ok)}.no{background:var(--nobg);color:var(--red)}
@media (max-width:700px){thead{display:none}tr{display:block;border-bottom:1px solid var(--line);padding:6px 0}td{display:block;border:0;padding:2px 0}td::before{content:attr(data-l) ": ";color:var(--mut)}}
</style></head><body><main>
<h1>Resource authorization server</h1>
<p>Issuer <code>${esc(issuer)}</code></p>
<ul><li><a href="/.well-known/oauth-authorization-server">Metadata</a></li><li><a href="/jwks">JWKS</a></li></ul>
<h2>Trusted IdPs</h2>
${idps.length ? `<ul>${idps.map((i) => `<li>${esc(i.id)} &middot; <code>${esc(i.issuer)}</code></li>`).join('')}</ul>` : '<p>None configured.</p>'}
<h2>Recent decisions</h2>
${events.length ? `<table><thead><tr><th>Time</th><th>Decision</th><th>Client</th><th>Issuer</th><th>Scope</th><th>Resource</th><th>Subject</th><th>jti</th><th>Reason</th></tr></thead><tbody>
${rows}
</tbody></table>` : '<p>No redemptions yet. This page refreshes every 5 seconds.</p>'}
</main></body></html>
`;
}

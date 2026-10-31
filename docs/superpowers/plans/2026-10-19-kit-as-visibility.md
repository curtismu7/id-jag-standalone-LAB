# Let people see the resource AS receive the token

In the "PingFederate -> resource AS" mode the page shows the redeem request and response, but nothing proves the
resource authorization server itself saw it. The owner's ask: show that the AS got the ID-JAG and issued the token, so a
user knows step 3 completed correctly, and put a link at the bottom to open the resource AS and look for themselves.

## Contract

### resource-as (`resource-as/src/app.js`, tests in `resource-as/src/__tests__/`)
- Keep the last 50 `/token` decisions in memory (a ring buffer, newest first). Each entry:
  `{ at: ISO time, decision: "accepted"|"refused", error?, reason?, iss, client_id, sub, aud, scope, jti }` where `sub` is
  MASKED (an email becomes `j***@pingone.com`; anything else keeps its first 4 characters then `…`), and `jti` is only its
  first 8 characters followed by `…`. `reason` is the refusal's description, which never contains token or assertion text.
  The `decision` log lines already carry `client_id`, `iss`, `sub`, `aud`, `scope`; add the jti (read from the decoded
  assertion when it parses) to the context. Never store the assertion, a token or a secret. Entries are recorded for both
  accepted and refused redemptions.
- `GET /events` -> `{ issuer, events: [...] }`, `cache-control: no-store`, no CORS headers.
- `GET /` -> a small self-contained HTML page "Resource authorization server": its issuer, links to
  `/.well-known/oauth-authorization-server` and `/jwks`, the trusted IdPs (issuer and name only), and a table of the
  recent decisions (time, an accepted/refused pill with a text label, client, issuer, scope, resource, masked subject,
  jti prefix, refusal reason). Ping brand (Montserrat falls back to system fonts, red #d20e0f, navy #051727), light and
  dark via `prefers-color-scheme`, readable at phone width, `<meta http-equiv="refresh" content="5">`,
  `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`. EVERY dynamic value is HTML-escaped: client_id
  and iss come from the caller and are attacker-controlled. No scripts.

### Playground server (`server/src/idJagPlayground.js`, tests in `server/src/__tests__/`)
- `GET /api/id-jag-playground/as-events` -> `{ available, reason?, entry, recent }`.
  - `available` only when this session's redeeming AS is the kit's own resource AS: mode `pf-as`, or mode `byo` with the
    stored target `resource-as`. Otherwise `{available:false, reason:"This mode redeems at PingFederate, not at the kit's resource AS."}`.
  - It fetches `<origin of RESOURCE_AS_TOKEN_ENDPOINT>/events` with a 4 s timeout (fixed base, never a caller-supplied URL).
    On any failure answer `{available:true, entry:null, recent:[], reason:"Could not read the resource AS's record."}` with 200:
    this is a convenience and must never break the page.
  - `entry` = the newest event whose `jti` prefix equals the first 8 characters of the jti of the ID-JAG stored in this
    session (decoded server-side); `null` when none or no ID-JAG. `recent` = the 5 newest events.
- Nothing from `/events` is trusted as HTML; the browser renders it as text.

### Web (`web/src/pages/IdJagPlaygroundPage.jsx`, mock in `web/src/utils/idJagPlaygroundMock.js`)
- After a redeem that returns HTTP 200 (and when the negative tests finish), fetch `as-events` and show under the redeem
  results a panel "What the resource AS recorded" (`data-testid="ijp-as-record"`):
  found -> "✓ The resource AS received this ID-JAG and issued an access token" plus time, client, scope, resource, masked
  subject; not found/unreadable -> a plain sentence ("The resource AS has no record of this one yet" / the `reason`), never an error banner.
  Not shown when `available` is false. Mock mode shows a clearly marked sample record.
- At the bottom of step 3 add the link "Open the resource AS ↗" to `config.resourceAs.issuer` + `/` (new tab,
  `rel="noopener noreferrer"`) with the sentence "It lists every redemption it accepted or refused, live." Shown only
  when the AS is the kit's own (same condition as `available`); in mock mode show the sentence without a working link.
  In step 5 (negative tests) add one sentence: refusals appear there too.
- Respect the existing page style and the info/ok colour tokens (`--ijp-ok`, `--ijp-info`, `--ijp-warn`); no new red for
  information. Tests for each bullet.

### Docs
README: one short paragraph. `docs/setup-guides.md` only if a guide already mentions the resource AS endpoints.

## Done when
`npm test -w resource-as`, `-w server`, `-w web` all pass with tests for each bullet (including XSS escaping of the AS
page and that no token/assertion text reaches `/events` or the page).

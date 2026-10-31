# ID-JAG Standalone LAB

Repo: https://github.com/ping-sandbox/id-jag-standalone-LAB
Tier: Demo
Catalog: C1

A shareable playground, resource authorization server and PingFederate setup kit for
**ID-JAG** (Identity Assertion JWT Authorization Grant,
[draft-ietf-oauth-identity-assertion-authz-grant](https://datatracker.ietf.org/doc/draft-ietf-oauth-identity-assertion-authz-grant/)).

It runs the ID-JAG flow one step at a time: get an ID-JAG from an IdP (RFC 8693 token exchange), check it
against the draft, redeem it at a resource authorization server (RFC 7523 JWT bearer), call an MCP server
with the result, and run live negative tests. Raw tokens never reach the browser: the server keeps them in
the session and returns decoded claims and redacted requests only.

At runtime it depends on nothing but PingFederate servers (defaults below, configurable through env).

Mock mode works end to end with no network. The real modes run against our own resource AS (`resource-as/`)
and sample MCP server (`mcp-sample/`) once their settings exist; until then they answer `409 not_configured`,
and the pre-flight check names what to set.

## Quickstart

```sh
git clone <this repo> && cd id-jag-standalone
npm ci
npm run setup           # picks a mode, writes .env (never overwrites one), runs doctor, prints what to run next
npm run build && npm start
open http://localhost:4720
npm run doctor          # rerun any time before a demo
```

Mock mode needs no prompts and no network: `npm run setup -- --yes --mode=mock`. For a real mode, `npm run setup`
asks for the PingFederate URL, the exchange client and (optionally) the admin URL, or take them from flags and the
environment: `npm run setup -- --yes --mode=pf-as --pf-url=https://pf.example.com --pf-client-id=... --pf-admin-url=...`
(secrets are read without echo, or from `PF_EXCHANGE_CLIENT_SECRET`, `PF_ADMIN_PASSWORD`, `ACME_EXCHANGE_CLIENT_SECRET`).
`--run=docker` checks the Docker context is `orbstack` and prints the compose command instead. `--force` replaces an
existing `.env` after saving it as `.env.bak.<n>`. Setup generates `SESSION_SECRET`, `REGISTRATION_KEY` and
`ID_JAG_REGISTRY_TOKEN` and never prints them. PingFederate signs users in itself ("local PingFederate users", pi.flow);
PingOne behind PingFederate and AIC are listed as unavailable, with the reason.

Every real-mode button runs a **pre-flight check** first (`GET /api/id-jag-playground/preflight?step=`): pass,
warn or fail with the fix, and nothing is sent while a check fails. Each mode has a **ReactFlow diagram** at
`/diagram/<mode>` (`?step=N` lights one step; it opens in a new tab), and **Download report** saves the run
as Markdown or JSON, built in the browser with no raw token in it.

## Modes

| Mode | Issues the ID-JAG | Redeems it | Status |
| --- | --- | --- | --- |
| **Mock** | Sample data in the browser | Sample data | Works; sends nothing at all |
| **PingFederate → resource AS** (`pf-as`) | PingFederate (`PF_URL`) after a sign-in there | `resource-as`; step 4 calls `mcp-sample` | Works once `PF_EXCHANGE_*`, `RESOURCE_AS_*`, `ID_JAG_RESOURCE`, `MCP_URL`, `ID_JAG_REGISTRY_TOKEN` are set |
| **Acme PingFederate → PingFederate** (`pf-pf`) | The outside "Acme" PingFederate (`ACME_PF_URL`) | PingFederate (`PF_URL`) via an IdP connection | Works once `pingfederate/configure-acme-signin.js` has run on Acme and the redeemer client is in `.env` (see [setup guide](docs/setup-guides.md#acme-pingfederate--pingfederate)); `mcp-sample` refuses PingFederate's token (it trusts `resource-as` only) |
| **Your IdP → our resource AS** (`byo`) | Any IdP on the Trusted IdPs list; you paste the ID-JAG, or get one from xaa.dev's IdenX | `resource-as`, or PingFederate | Inspect works; redeem needs the target's secret |

Two PingFederates in `pf-pf` because an IdP must not redeem its own ID-JAG (draft §9.3).

The resource AS shows its own work: `GET /` on it is a live page of its last 50 redemptions (accepted or refused, with
the refusal reason; subject masked, jti truncated, never a token), and `GET /events` is the same as JSON. The playground reads
it through `GET /api/id-jag-playground/as-events` (only when the kit's own resource AS redeems) so step 3 can confirm the AS got the ID-JAG.

In `byo`, **Get an ID-JAG from xaa.dev** uses [xaa.dev](https://xaa.dev)'s IdP, IdenX, as a free outside IdP:
`GET /api/id-jag-playground/xaa/login` (code + PKCE + state + nonce at `https://idp.xaa.dev`), `/xaa/callback`
(id_token verified), then `POST /xaa/id-jag` (RFC 8693 at IdenX, `aud` = `RESOURCE_AS_ISSUER`, scope `read`) loads the
ID-JAG like a pasted one. It is redeemed as the IdenX entry's own `idp-<id>` client. It needs a public https
`RESOURCE_AS_ISSUER` registered at xaa.dev (`/config` says why when it is off). Setup:
[docs/setup-guides.md](docs/setup-guides.md#use-xaadev-idenx-as-a-free-outside-idp).

In `pf-as`, **SAML** swaps the refresh token for a signed SAML 2.0 assertion: this server plays a small SAML IdP, signs
an assertion naming the signed-in user (NameID = their email), and PingFederate trusts its certificate and returns the
ID-JAG in one token exchange (`tools/saml-spike`). No second sign-in. Provision it with `pingfederate/configure-saml.js`
and start with `deploy/docker-compose.saml.yml`: [docs/setup-guides.md](docs/setup-guides.md#saml-assertion-to-id-jag).

Step 4 calls `mcp-sample` server-side (`MCP_URL`; it sends no CORS headers), as either the **MCP server**
(`tools/list`, `tools/call`) or the **REST API** (`GET /protected/profile` with the access token, with no token,
or with the raw ID-JAG, which it must refuse, naming the check that failed). `resource-as` learns to trust
`PF_URL` from this server's registry read once `pf-as` is configured, so `ID_JAG_REGISTRY_TOKEN` must be set on both.

Around the steps:
- **Backends strip:** the server probes each backend the mode uses, showing up, slow (over 1.5 s) or down (no answer in 4 s).
- **The story:** what the mode shows, in two sentences.
- **Tabs on every step:** Request · Response · Decoded · **Code**. Code is the fetch call behind the step, with placeholders and never a token.
- **Step 6, Revoke and prove it:** revokes this session's refresh token at PingFederate (RFC 7009), then shows that a new ID-JAG is refused.
- **Real clients panel:** the same flow from mcpc or VS Code.
- **OIDC | SAML toggle:** SAML runs in Mock mode, and in `pf-as` once `pingfederate/configure-saml.js` has run (below).

The **Inspector** (`/inspect`) gets an ID-JAG for you (**Get an ID-JAG** reuses the playground's issue route, so it needs the
playground's step 1 sign-in; the token stays server-side, and only the decoded checks reach the browser unless you click **Show token**, which reveals your own session's ID-JAG in a read-only box with Copy), or takes any pasted
token (ID token, ID-JAG, access token, SAML assertion). It detects the type and checks it against the draft and the trusted-IdP
registry; a collapsed **Backends (discovery metadata)** section shows each backend's metadata, and **Live log** shows the resource
AS's decision record. Nothing pasted is stored.

Each step links its terms to **Learn** (`/learn`). Learn holds an index of the in-app docs, a searchable
glossary (`/learn#term-<id>`) and the source library, where every source carries how far we checked it and when.

The **Trusted IdPs** page (`/trusted-idps`) lists outside IdPs whose ID-JAGs we accept. Anyone signed in can
register an IdP. It stays `pending`, and is not trusted, until an admin approves it. Every change is audited.
The resource AS and the PingFederate sync script read the approved entries server to server with a Bearer
`ID_JAG_REGISTRY_TOKEN`. See [Sign-in and the Trusted IdPs registry](#sign-in-and-the-trusted-idps-registry).

## Running it

### Docker (OrbStack or any Docker engine)

```sh
docker compose -f deploy/docker-compose.yml up --build -d
open http://localhost:4720     # Mock mode works with no configuration
docker compose -f deploy/docker-compose.yml down
```

Three services: the playground (`HOST_PORT`, default 4720), `resource-as` (`AS_HOST_PORT`, 4721, issuer
`http://localhost:4721`) and `mcp-sample` (`MCP_HOST_PORT`, 4722, resource `http://localhost:4722/mcp`).
Secrets and PingFederate settings come from an optional `.env` at the repo root (copy `.env.example`), read
by every service. Compose sets the addresses the services use to find each other (`APP_ORIGIN`,
`RESOURCE_AS_ISSUER`, `RESOURCE_AS_TOKEN_ENDPOINT`, `ID_JAG_RESOURCE`, `MCP_URL`) from the host ports, so
they always agree; export one in the shell to override it.

### Local development (Node 22+)

```sh
npm ci
cp .env.example .env            # set APP_ORIGIN=http://localhost:4723 for the Vite dev server
npm run dev                     # API on :4720, Vite on :4723 (proxies /api and /auth)
npm start -w resource-as        # :9080 (see docs/resource-as.md); npm start -w mcp-sample  # :9090
npm test                        # vitest, all four workspaces
npm run build                   # web/dist, served by the server in production
```

`npm start` serves `web/dist` and the API on `PORT`.

## Mock and live

`MODE=mock|live` (default mock) decides what the app talks to; the **Mock / Live** switch in the header of every page shows it
and changes it, and `GET /api/health` reports it as `mode`. The choice is saved in `DATA_DIR/mode.json`, so it survives a restart; without
a saved choice `MODE` is read from the environment, `.env`, or the shared settings file (`STANDALONE_ENV`, else `~/Development/.env`).

- **Mock**: a PingFederate, an outside "Acme" PingFederate, a resource authorization server and an MCP server run inside the app and
  answer like the real ones (pi.flow with PKCE, RFC 8693 exchange, RFC 7523 redemption, single-use `jti`, scope-gated tools). Every token
  carries `"mock": true`, every playground answer says `simulated`, and a netguard refuses every outbound call except to the mock and to
  loopback, counting what it refuses (`npm run doctor` runs its self-test). Mock data lives in `DATA_DIR/mock`. xaa.dev, SAML and the
  interop panel need a real server and are Live only. The demo account is `alice@mock.example` / `mock-password`; mock sign-in needs
  `ALLOW_MOCK_SIGNIN=1`, a loopback bind (`HOST=127.0.0.1`, the default in mock mode, or `LAB_PUBLISH=loopback` in Docker) and no proxy.
- **Live**: today's behaviour, against the servers named in `.env`. It can be chosen only when `PF_URL`, `PF_EXCHANGE_CLIENT_ID` and
  `PF_EXCHANGE_CLIENT_SECRET` (or the Acme set) are present; otherwise the switch says what is missing.

`npm run reset` and `POST /api/admin/reset` clear the current mode's data and keep the saved choice.

## Layout

```text
web/            Vite + React playground (Mock mode, Form|JSON view, mode picker, pre-flight, diagrams, report, Trusted IdPs)
server/         Express: /api/id-jag-playground, serves web/dist
  src/auth/     OIDC sign-in (/auth/*, /api/me), email rules, fills the pf-as issuer session
  src/registry/ Trusted IdPs API, discovery + SSRF guard, resource AS clients, audit log
resource-as/    Our ID-JAG resource authorization server (docs/resource-as.md)
mcp-sample/     Sample MCP server + /protected/profile, trusts resource-as tokens
docs/           resource-as.md, setup-guides.md (also in the app at /guides)
pingfederate/   PingFederate setup scripts (copied from AI-DEMO2 and adapted)
tools/          outside-agent.js test harness (adapted)
deploy/         docker-compose.yml (all three services), overlays (desktop clients, SAML), service.Dockerfile
```

## Configuration

Every variable is in [`.env.example`](.env.example). None are needed for Mock mode.

| Variable | Default | Used for |
| --- | --- | --- |
| `PORT` | `4720` | Server port |
| `APP_ORIGIN` | `http://localhost:4720` | Browser origin: non-GET API calls must send exactly this `Origin`; issuer redirect URI |
| `SESSION_SECRET` | random per start | Session cookie signing |
| `DATA_DIR` | `.data` (`/data` in the image) | `trusted-idps.json` |
| `TRUST_PROXY` | unset | Express `trust proxy` behind a reverse proxy |
| `PF_URL` | `https://pf.example.invalid` | Issuer (`pf-as`) and redeemer (`pf-pf`, `byo`) PingFederate |
| `PF_EXCHANGE_CLIENT_ID` / `_SECRET` | unset | Sign-in + token exchange client at `PF_URL` (`pf-as`) |
| `PF_REDEEMER_CLIENT_ID` / `_SECRET` | `id-jag-redeemer` / unset | JWT bearer client at `PF_URL` |
| `PF_RESOURCE` | unset | `resource` sent when redeeming at PingFederate |
| `ACME_PF_URL` | `https://pf-acme.example.invalid` | Outside "Acme" issuer (`pf-pf`) |
| `ACME_EXCHANGE_CLIENT_ID` / `_SECRET` | unset | Sign-in + token exchange client at Acme; `pingfederate/configure-acme-signin.js` creates `id-jag-kit-acme` and writes both |
| `RESOURCE_AS_ISSUER` | unset | Our resource AS issuer = ID-JAG `aud` |
| `RESOURCE_AS_TOKEN_ENDPOINT` | `${RESOURCE_AS_ISSUER}/token` | Where ID-JAGs are redeemed (may be an internal address) |
| `RESOURCE_AS_CLIENT_ID` / `_SECRET` | `id-jag-playground` / unset | Our client at the resource AS; `resource-as` registers it from the same two |
| `MCP_URL` | unset | `mcp-sample`'s `/mcp` for step 4; `/protected/profile` sits beside it |
| `ID_JAG_RESOURCE`, `ID_JAG_SCOPE` | unset | `resource` and `scope` asked for in the exchange (`pf-as`) |
| `ID_JAG_REGISTRY_TOKEN` | unset (reads answer 503) | Bearer for the server-to-server registry reads (`resource-as` trusts `PF_URL` through it) |
| `OIDC_ISSUER` | `PF_URL` | App sign-in: PingFederate base URL, exactly its issuer |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | `PF_EXCHANGE_CLIENT_ID` / `_SECRET` (unset: `/auth/pi-flow/start` answers 503) | This app's OAuth client at PingFederate (client_secret_basic) |
| `OIDC_PRIVATE_KEY_JWT` / `OIDC_PRIVATE_KEY_KID` | unset | private_key_jwt instead of the secret: PEM or a path to one |
| `OIDC_REDIRECT_URI` | `${APP_ORIGIN}/auth/callback` | Redirect URI registered at PingFederate |
| `OIDC_EXTRA_SCOPES` | unset | Added to `openid profile email offline_access` |
| `ALLOWED_EMAIL_DOMAINS` | `pingidentity.com,pingone.com` | Exact email domains that may sign in |
| `ADMIN_CLAIM` / `ADMIN_CLAIM_VALUE` | `groups` / `demo-admins` | ID token claim (string or array) that makes an admin (the ID-JAG kit docs and `.env.example` use `id-jag-admins`) |
| `ADMIN_EMAILS` | unset | Extra admins by email (still subject to the email rules) |
| `REGISTRATION_KEY` | unset (account requests answer 503) | 16+ characters; encrypts a requester's password until an admin approves or rejects. Keep it stable |
| `PF_ADMIN_URL` / `PF_ADMIN_USER` / `PF_ADMIN_PASSWORD` | unset (approval answers 503) / `administrator` / unset | PingFederate admin API the server uses to add an approved user to the kit's users |
| `PF_ADMIN_INSECURE_TLS` | `false` | `true` accepts PingFederate's self-signed admin certificate (local runs) |
| `RESOURCE_AS_CLIENTS_FILE` | unset (resource-AS approvals answer 409) | The resource AS's `CLIENTS_FILE`: approved IdPs get an `idp-<id>` client there |
| `ALLOW_PRIVATE_ISSUERS` | `false` | Development only: allow private/loopback issuer and JWKS hosts |
| `SAML_SIGNING_KEY_FILE` / `SAML_SIGNING_CERT_FILE` | unset (SAML off) | PEM files this app signs SAML assertions with (`deploy/docker-compose.saml.yml` sets them) |
| `SAML_ISSUER` / `SAML_AUDIENCE` | `${APP_ORIGIN}/saml` / `idJagKitSamlAud` | The assertion's Issuer, and the Audience PingFederate's SAML token processor requires |
| `PF_SAML_CLIENT_ID` / `_SECRET` | `id-jag-kit-saml` / unset (SAML off) | Token-exchange client for the assertion at `PF_URL`; `configure-saml.js` writes the secret to `.env` |
| `XAA_DEV_IDP_CLIENT_ID` / `_SECRET` | unset (xaa.dev button off) | This app as a requesting app at xaa.dev (client_secret_post); redirect URI `${APP_ORIGIN}/api/id-jag-playground/xaa/callback` |
| `XAA_DEV_RESOURCE_AS_CLIENT_ID` / `_SECRET` | unset (xaa.dev button off) | The IdenX entry's `idp-<id>` client at the resource AS and the secret its owner fetched once |

Sessions use express-session's in-memory store: one process only, everyone is signed out on restart.
A shared store is needed before running more than one replica.

## Make it the customer's

Copy `customer.config.example.json` to `customer.config.json` (git-ignored), edit, and reload the page. No rebuild or restart.

```json
{
  "name": "Northwind Bank",
  "vertical": "banking",
  "persona": { "lena": "Priya" },
  "brand": { "primary": "#0b6bcb", "headerStart": "#0a2540", "headerEnd": "#12395f", "logoUrl": "/branding/northwind.png" }
}
```

- `name` (1-40 characters) replaces "ID-JAG Kit" in the top bar, next to the Ping logo.
- `vertical` is the default industry pack for the talk track (`generic`, `banking`, `healthcare`, `airlines`, `retail`). A viewer's own pick in the picker still wins; an id this build does not have shows `generic`.
- `persona` maps a cast id to a display name, so `{ "lena": "Priya" }` turns Lena into Priya in every story.
- `brand`: `primary` drives the accent colour and gradient, `headerStart`/`headerEnd` the top bar. Colours are `#rrggbb`. Text colour is chosen automatically for WCAG AA contrast; a colour that cannot be read on either theme is ignored and the Ping default stays. `logoUrl` is a `/branding/...` file under `web/public/branding/` or an `https://` URL.

The file is meant to be shared with customers, so any key containing `secret`, `password`, `token` or `key` is rejected. An invalid file is ignored as a whole (the server logs one line naming the bad field) and the kit shows its defaults. `CUSTOMER_CONFIG=/path/to/file.json` points elsewhere; in Docker, mount the file and set that variable. The sanitized result is public at `GET /api/customer-config`.

## Run doctor before a demo

```sh
npm run doctor                          # mock mode: needs no .env and no network
npm run doctor -- --mode=pf-as          # or pf-pf, byo; add --json for machine-readable output
```

It checks Node, `.env`, the settings the mode needs, `DATA_DIR`, the port, PingFederate discovery (the issuer must
match `PF_URL` byte for byte), the resource AS and MCP server, and, when `PF_ADMIN_URL` is set, the PingFederate
admin API, the `idJagKitPcv` validator and that the sign-in client allows pi.flow. Each non-passing line prints the
exact fix. Exit code 1 on any FAIL. Secrets show only as set/unset and length. Signed-in admins get the same report
from `GET /api/doctor?mode=pf-as`.

## Health for the demo shelf

`GET /api/health` is public and answers the `demo-health/1` contract: `state` (`ready`, `needs-setup`, `broken`,
`unknown`), `runtime` (`offline` or `live`) and the demo's id, name and version. Nothing else: no counts, messages or
secrets (detail stays on the admin-only `/api/doctor`). The state is the doctor's, run at boot and refreshed in the
background every 60 s, never per request, through the IdP adapter's doctor (so the PF admin failure latch applies and
health makes no PF admin call of its own). It describes the process and is answered from the default workspace in every
workspace. GET only: HEAD answers 405, so the shelf must poll with GET. Code: `server/src/health.js`. Full contract: [docs/health-contract.md](docs/health-contract.md).

## Sign-in and the Trusted IdPs registry

Sign-in is OIDC (authorization code + PKCE, state, nonce) at PingFederate, which federates to PingOne. The ID
token is validated (signature, `iss`, `aud`, `exp`, `nonce`) and then the app applies its own rules, whatever the
IdP is configured to do: the email domain must be exactly one of `ALLOWED_EMAIL_DOMAINS`, a `+` in the local
part is refused, and `email_verified` must be `true`. Refusals get a page naming the rule. The session is
regenerated at login. With the defaults (sign-in at `PF_URL` with the pf-as exchange client) the sign-in's refresh
token, kept server-side, is also the pf-as issuer session (`getIssuerSubjectToken(req, 'pf-as')`), so one sign-in serves both.
**Sign-in modal (pi.flow).** The Sign in buttons open a sign-in without a redirect (there is no redirect login): the server opens a
PingFederate pi.flow (`/auth/pi-flow/*`, and `/api/id-jag-playground/issuer/pi-flow/*` for the playground's issuer),
the web shows a username/password modal, and the server posts the credentials to PingFederate's Authentication API.
When the flow completes the browser goes to the usual callback with the code, which finishes the sign-in unchanged.
It needs PingFederate to sign the user in itself: PingFederate's Authentication API cannot run the PingOne connection
("the next step requires browser interaction"), so `node pingfederate/configure-local-signin.js --ns=<ns>
--users=a@pingidentity.com,b@pingone.com` gives the kit's client its own credential validator and HTML form adapter
holding only those users (plain addresses on `ALLOWED_EMAIL_DOMAINS`), and lets the client start a pi.flow. Passwords
are generated and written to `deploy/local/kit-users.json` (mode 600, gitignored), never printed; `--rotate=<email>`
replaces one; `--mode=pingone` puts the PingOne hop back, which the modal cannot drive (see Sign-in limits). Whenever the flow
cannot open or needs more than a password (MFA, a policy screen, another company's PingFederate) the modal shows a message
and a Close button; it never navigates to an authorize URL.
Credentials and codes are never logged or stored; at most 8 password attempts per session per 5 minutes.

Go-live setup (a new dedicated PingOne environment, the PingFederate client, the admin group): [docs/setup-guides.md](docs/setup-guides.md#sign-in-for-this-app-go-live).

### Sign-in limits

The kit signs in by pi.flow only. These limits are documented, not fixed; the modal shows a message for each.

- **L1** PingFederate's Authentication API cannot run an OIDC IdP connection hop, so a PingFederate policy that federates to PingOne cannot sign in by pi.flow. Any `OIDC_ISSUER` that is not the kit's PingFederate answers `409 pi_flow_unavailable` until a PingOne pi.flow driver exists.
- **L2** The driver handles `USERNAME_PASSWORD_REQUIRED` only (no MFA, policy screens or other states); anything else shows "This account needs a step the kit's sign-in cannot show."
- **L3** The sign-in client needs `allowAuthenticationApiInit` (`configure-local-signin.js`, and `configure-acme-signin.js` for `id-jag-kit-acme`). `npm run doctor` checks `PF_EXCHANGE_CLIENT_ID` only, not Acme's client.
- **L4** `configure-acme-signin.js` sets Acme's default authentication source only when none exists.
- **L5** In byo mode there is no issuer sign-in: the playground answers 409 `byo_mode` and the modal shows it.
- **L6** At most 8 attempts per flow and a 5-minute flow lifetime, counted in an in-process map (per instance).
- **L7** `prompt=login` is appended to the issuer's authorize request; whether pi.flow honours it is unverified.
- **L8** After `COMPLETED` the browser goes to this app's own `/auth/callback` or `/issuer/callback` with `code` and `state` (same origin, not an IdP redirect).

| Route (under `/api/id-jag-playground/trusted-idps`) | Who | What |
| --- | --- | --- |
| `GET /registry`, `GET /pingfederate` | Bearer `ID_JAG_REGISTRY_TOKEN` | Approved entries for the resource AS / PingFederate sync |
| `GET /` | anyone | Approved entries, no owner or review details |
| `GET /mine`, `POST /`, `PUT /:id`, `DELETE /:id` | signed in (owner, or admin) | Register (starts `pending`), edit, withdraw |
| `POST /discover`, `POST /test` | signed in | Issuer discovery; "Test this IdP" (JWKS report) |
| `POST /:id/secret` | owner | New secret for the `idp-<id>` client at the resource AS, shown once |
| `GET /all`, `GET /audit` | admin | Every entry; the audit log, newest first, paged with `before` |
| `POST /:id/approve`, `/reject` (reason required), `/disable` | admin | Review |

- Edits to an approved entry's issuer, JWKS URL, client ids, targets or scope cap send it back to `pending`.
- Approving an entry that targets the resource AS writes an `idp-<id>` client (sha256 of a discarded random secret)
  into `RESOURCE_AS_CLIENTS_FILE`; the owner then fetches a real secret once. Leaving `approved` removes the client.
- Discovery and Test this IdP fetch only `https` URLs on public addresses (checked on the resolved addresses at
  connect time), with a 4 s timeout and no redirects.
- The audit log is `DATA_DIR/audit.jsonl`, append-only, with before/after snapshots (entries hold no secrets).

## Reset between demos

Return the demo to a fresh state before the next customer:

```bash
npm run reset -- --dry-run   # print what would be cleared, change nothing
npm run reset -- --yes       # do it (refuses without --yes)
```

Or, signed in as an admin, `POST /api/admin/reset` with `{"confirm":"reset"}` (same-origin only).

It clears, under `DATA_DIR`, the registration requests and the Trusted IdPs registry (with each IdP's `idp-<id>`
client at the resource AS). The users that registration approved are removed from PingFederate's `idJagKitPcv`
(needs `PF_ADMIN_*`); users made by `pingfederate/configure-local-signin.js` are never touched. The audit log is
renamed `audit-<timestamp>.jsonl` and restarted with one `reset` line. The admin route also ends every web session
and empties the in-memory pre-flight and rate-limit caches. The CLI cannot reach a running server's memory: restart the
server or use the route for that.

If PingFederate is unreachable, local state is still reset; the users it could not remove are listed and the
command exits 1 (the route answers 502). `.env`, secrets and all other PingFederate configuration are left alone.

## PingFederate ID-JAG gotchas

1. The ID-JAG signing key is not in `/pf/JWKS` unless a JWT access token manager publishes it
   ("Publish Keys to the PingFederate JWKS Endpoint").
2. PingFederate ID-JAGs carry `x5t` and no `kid`. PingFederate's JWT bearer consumer does not pick keys by
   `x5t`, so the issuer must publish only its ID-JAG key (a static JWKS).
3. The consumer caches the issuer JWKS and never refetches without a `kid`. Only a PingFederate restart clears it.
4. A JWT bearer request with `resource` gets `invalid_target` unless an access token manager lists that
   resource in its selection settings.
5. `x5t` lookups must count distinct keys: a static JWKS lists one certificate under several `kid`s.

## Roadmap

See [docs/roadmap.md](docs/roadmap.md).

## License

All rights reserved. Private repository; not licensed for redistribution.

## Keeping secrets out
- Nothing secret is committed: `.env` is ignored, only `.env.example` ships.
- Three independent checks block a leaked secret: the `.githooks/pre-commit` gitleaks hook (installed by `npm install`), the `secrets` CI job (gitleaks over the full history of every PR), and GitHub secret scanning with push protection on this repository.
- Raw tokens never reach the browser or the logs (enforced by tests).
- Planned: secrets generated inside the cluster, external ones stored as SealedSecrets, `private_key_jwt` client authentication instead of client secrets, and a small encrypted vault for local development.

## Ports, and what to do if the port is taken

This app listens on **4720** (set with `PORT`). The Vite dev server uses **4723**. Docker host ports: `HOST_PORT` 4720 (playground), `AS_HOST_PORT` 4721 (resource-as), `MCP_HOST_PORT` 4722 (mcp-sample). Port range for this app: 4720-4729.

If the port is taken:
1. Find what is using it: `lsof -iTCP:<port> -sTCP:LISTEN -n -P`
2. If it is an old copy of this app, stop that process: `kill <PID>`
3. If it is something else, stop it, or start this app on another port: `PORT=4730 npm run dev` (and set `APP_ORIGIN` to match), or `HOST_PORT=4731 docker compose -f deploy/docker-compose.yml up -d`
4. Do not use 8080, 5173, 3000, 4000, 4400, 4510, 4600-4601, 18080, 19080 or 19090. Other demos and tools use them.

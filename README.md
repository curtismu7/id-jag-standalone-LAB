# ID-JAG Standalone LAB

A playground, a resource authorization server and a PingFederate setup kit for **ID-JAG** (Identity Assertion JWT Authorization Grant): it runs the flow one step at a time and shows every request, token and check.

Tier: Demo

Repo: https://github.com/ping-sandbox/id-jag-standalone-LAB

Catalog: C1

ID-JAG is an IETF draft ([draft-ietf-oauth-identity-assertion-authz-grant](https://datatracker.ietf.org/doc/draft-ietf-oauth-identity-assertion-authz-grant/)), so details can still change. Among Ping products, PingFederate is the one that supports ID-JAG, and it is also the only one that supports DPoP; PingOne and PingOne Advanced Identity Cloud do not issue or redeem ID-JAGs. That is why the live modes need PingFederate.

The flow: get an ID-JAG from an IdP (RFC 8693 token exchange), check it against the draft, redeem it at a resource authorization server (RFC 7523 JWT bearer), call an MCP server with the result, and run negative tests. Real tokens never reach the browser: in Live mode the server keeps them in the session and returns decoded claims and redacted requests only. Mock mode shows its mock tokens raw, labelled mock, for education.

## What is simulated

**Mock mode (the default)** runs fully offline, with no tenant and no setup. A PingFederate, a second ("Acme") PingFederate, a resource authorization server and an MCP server run inside this app and answer like the real ones: pi.flow sign-in with PKCE, the RFC 8693 exchange, the RFC 7523 redemption, a single-use `jti`, and scope-gated MCP tools. The cryptography is real (ES256 signatures, real JWT checks), but the keys belong to the simulation. Every mock token carries `"mock": true` and a `kid` that starts with `mock-`, every playground answer says it is simulated, and a netguard refuses every outbound call except to the in-process mock and to loopback. A mock token proves how the flow works; it proves nothing about a customer's PingFederate. xaa.dev sign-in, SAML and the interop panel need real servers and are Live only. The playground also keeps a separate **Sample data (browser)** mode, which answers from fixtures in the page and sends nothing at all.

**Gateway redeem (Ping release claim, mock only).** The playground mode **Gateway redeems the ID-JAG (mock only)** shows a feature of Ping's 2026-11-02 Privilege release: the MCP gateway, configured with an On-Behalf-Of spec, exchanges the caller's token at the exchange issuer (leg 1, RFC 8693) and, when a Redeem spec with a TokenURL is set, redeems the resulting ID-JAG at the target app's own issuer (leg 2, RFC 7523), so the target app sees the user with no shared credential. **Ping release claim (2026-11-02), UNVERIFIED on our tenant**: the release is not on our tenant, so everything runs against in-process mocks (a company IdP, a partner issuer the target does not trust, the target app's issuer and API, and the gateway). A banner on every page and in presenter mode says so. There is no Live form of this mode, and the Mock / Live toggle's note says why.

**Live mode (owner-run)** is the same app against the real PingFederate servers named in your settings, plus the kit's own `resource-as` and `mcp-sample`. It needs the settings in [Settings file](#settings-file) and is not used for a standard demo. The simulation banner on every page says which mode you are in.

## Run from a clone

Prerequisites: Node 26 or newer (Node 26 is what the tests and CI run on). Docker is needed only for the Docker form.

```sh
git clone https://github.com/ping-sandbox/id-jag-standalone-LAB.git
cd id-jag-standalone-LAB
npm ci
npm run build
ALLOW_MOCK_SIGNIN=1 npm start
```

Then open **http://localhost:4720**. Use `localhost`, not `127.0.0.1`: the server accepts sign-in and the Mock/Live switch only from its own `APP_ORIGIN`, which defaults to `http://localhost:4720`, and a page opened on `127.0.0.1` gets `invalid_origin`. It starts in Mock mode, which needs no `.env`, no network and no PingFederate (Mock mode is the start-up default only when the live `PF_*` settings are not set).

What works with no setup at all: every page; the playground in **Sample data (browser)** mode with no sign-in; the **PingFederate → resource AS**, **Acme PingFederate → PingFederate** and **Your IdP → our resource AS** modes against the in-app simulation (sign in with the demo account shown in the sign-in dialog, which needs `ALLOW_MOCK_SIGNIN=1` as above, and without it the dialog says so); the inspector, the Trusted IdPs page, the diagrams at `/diagram/<mode>`, the stories, and `npm run doctor`. Mock sign-in is refused behind a proxy and on any non-loopback bind.

For development, `npm run dev` starts the API on :4720 and Vite on :4723. The presenter script is [docs/talk-track.md](docs/talk-track.md) (press **Present** in the header).

## Settings file

All standalone apps read one settings file, `~/Development/.env` (mode 600). Set `STANDALONE_ENV=/path/to/file` to use another. The repo-root `.env` (copy `.env.example`; git-ignored) is also read, and real environment variables win. **None are needed for Mock mode.** Admin and worker credentials never go in the shared file; they belong in `~/.config/demo-kit/provisioning.json`, which only owner-run provisioning scripts read.

Keys this app uses (the full list, with defaults, is in [Configuration](#configuration)):

| Key | Optional? | What it is |
| --- | --- | --- |
| `MODE` | optional | `mock` or `live`. Unset: `live` when `PF_URL`, `PF_EXCHANGE_CLIENT_ID` and `PF_EXCHANGE_CLIENT_SECRET` are set (an existing install stays live), otherwise `mock`. The header switch saves its choice in `DATA_DIR/mode.json`, which wins |
| `ALLOW_MOCK_SIGNIN` | optional | `1` turns on the built-in demo account in Mock mode (Docker sets it) |
| `PORT`, `HOST`, `APP_ORIGIN`, `DATA_DIR` | optional | Where the server listens, its browser origin, where it keeps data |
| `SESSION_SECRET` | optional | Signs the session cookie; random per start if unset |
| `PF_URL` | live only | The issuer and redeeming PingFederate |
| `PF_EXCHANGE_CLIENT_ID`, `PF_EXCHANGE_CLIENT_SECRET` | live only | The sign-in and token-exchange client at `PF_URL` |
| `ACME_PF_URL`, `ACME_EXCHANGE_CLIENT_ID`, `ACME_EXCHANGE_CLIENT_SECRET` | live only | The outside "Acme" PingFederate (`pf-pf` mode) |
| `RESOURCE_AS_ISSUER`, `MCP_URL`, `ID_JAG_RESOURCE`, `ID_JAG_REGISTRY_TOKEN` | live only | Where the resource AS and MCP server are, and the registry token |
| `CUSTOMER_CONFIG` | optional | Path to a `customer.config.json` (branding, vertical, cast names) |

## Ports, and what to do if the port is taken

Ports: id-jag-standalone listens on 4720 (set with `PORT`, default 4720). The Vite dev server uses 4723. The Docker host ports are `HOST_PORT` 4720 (playground), `AS_HOST_PORT` 4721 (resource-as) and `MCP_HOST_PORT` 4722 (mcp-sample).
Port range for this app: 4720-4729.

If the port is taken:
1. Find what is using it:
   lsof -iTCP:4720 -sTCP:LISTEN -n -P
2. If it is an old copy of this app, stop that process: kill <PID>.
3. If it is something else, stop it, or start this app on another port:
   `PORT=4724 npm start` (set `APP_ORIGIN` to match, for example `APP_ORIGIN=http://localhost:4724`), or `HOST_PORT=4724 docker compose -f deploy/docker-compose.yml up -d`
4. Do not use 8080, 5173, 3000, 4000, 4400, 4510, 4600-4601, 18080, 19080 or 19090.

In Live mode on the host, the helper services `resource-as` and `mcp-sample` default to 9080 and 9090 in code. They are not started in Mock mode. Set `PORT=4721` and `PORT=4722` for them if you want them inside this app's block.

## Mock and live modes

`MODE=mock|live` decides (unset: mock, or live when `PF_URL`, `PF_EXCHANGE_CLIENT_ID` and `PF_EXCHANGE_CLIENT_SECRET` are already set) what the app talks to. The **Mock / Live** switch in the header of every page shows the mode and changes it, the banner on every page repeats it (presenter mode included), and `GET /api/health` reports it as `mode`. The choice is saved in `DATA_DIR/mode.json`, so it survives a restart. Switching ends every session. Mock data lives in `DATA_DIR/mock` and never mixes with live data.

- **Mock**: the in-app simulation described under [What is simulated](#what-is-simulated). Demo account `alice@mock.example` / `mock-password`, shown in the sign-in dialog (public, mock only). Mock sign-in needs `ALLOW_MOCK_SIGNIN=1`, a loopback bind (`HOST=127.0.0.1`, the default in Mock mode, or `LAB_PUBLISH=loopback` in Docker) and no proxy.
- **Gateway redeem has no Live form.** Live answers 409 `live_unavailable` for its routes and the mode is disabled in the picker with the reason; the header toggle and the banner say so on every page.
- **Live**: the servers named in your settings. It can be chosen only when `PF_URL`, `PF_EXCHANGE_CLIENT_ID` and `PF_EXCHANGE_CLIENT_SECRET` (or the Acme set) are present; otherwise the Live button is disabled and the banner names what is missing.

## Health, doctor and reset

```sh
npm run doctor   # checks Node, settings, the port and, in Live mode, PingFederate; exit 1 on any failure
npm run reset    # clears run state; saved settings and the saved mode are kept
```

`GET /api/health` is public and answers `demo-health/1`. `POST /api/admin/reset` (admin, same-origin) resets a running server. Details: [Run doctor before a demo](#run-doctor-before-a-demo), [Health for the demo shelf](#health-for-the-demo-shelf) and [Reset between demos](#reset-between-demos).

## Docker (optional)

```sh
docker compose -f deploy/docker-compose.yml up --build -d
```

It publishes to 127.0.0.1 only: 4720 (playground), 4721 (resource-as) and 4722 (mcp-sample). Mock mode works with no configuration, and the compose file turns on the mock demo account. Stop it with `docker compose -f deploy/docker-compose.yml down`. On a Mac use OrbStack.

## Tests

```sh
npm test
```

On Node 26 a good run is 1476 tests: web 529, server 793, resource-as 69, mcp-sample 22 and scripts 63. `check-css.sh` (in the AI-DEMO-Standalone repo) and `npm run check:forbidden` should also pass. Under heavy machine load a timing-based test can time out; rerun that file alone to confirm.

## Troubleshooting

- **The sign-in dialog says mock sign-in is off.** Start with `ALLOW_MOCK_SIGNIN=1 npm start`, and do not open the app through a proxy or on a non-loopback address.
- **The Live button is greyed out.** Live needs `PF_URL` and the exchange client in your settings. The banner names what is missing. Mock mode needs none of it.
- **A step says `409 not_configured`.** That mode needs the settings it names. The pre-flight check on the step says which, and `npm run doctor -- --mode=pf-as` lists them.
- **The page loads but is empty.** Run `npm run build` first: `npm start` serves `web/dist`.
- **The port is taken.** See [Ports, and what to do if the port is taken](#ports-and-what-to-do-if-the-port-is-taken).

## Ownership

- Owner: the Ping standalone demo kit owner.
- License: all rights reserved. This is an internal Ping repository, not licensed for redistribution.
- Found a problem? Open an issue on the repo.

---

## Reference

The sections below are the detail behind the ones above.

### Setup script (optional, for a live mode)

```sh
git clone https://github.com/ping-sandbox/id-jag-standalone-LAB.git && cd id-jag-standalone-LAB
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
`ID_JAG_REGISTRY_TOKEN` and never prints them. The extra mode `--mode=pf-local` is described in [PingFederate for ID-JAG](#pingfederate-for-id-jag); it writes the shared settings file instead of the repo `.env`. PingFederate signs users in itself ("local PingFederate users", pi.flow);
PingOne behind PingFederate and AIC are listed as unavailable, with the reason.

Every real-mode button runs a **pre-flight check** first (`GET /api/id-jag-playground/preflight?step=`): pass,
warn or fail with the fix, and nothing is sent while a check fails. Each mode has a **ReactFlow diagram** at
`/diagram/<mode>` (`?step=N` lights one step; it opens in a new tab), and **Download report** saves the run
as Markdown or JSON, built in the browser with no raw token in it.

### PingFederate for ID-JAG

One command sets this app up against a PingFederate on your own machine, installing it if you do not have one:

```sh
npm run setup -- --mode=pf-local --users=you@pingone.com
```

- **You need** Docker (OrbStack) running, and your `pingfederate.lic` at `~/Documents/pingfederate.lic` (or set `PF_LICENSE_FILE`). The license file comes from the owner; it is never committed.
- **YES.** If nothing answers on port 4731 the script installs the official PingFederate image in Docker, bound to `127.0.0.1` only, and asks you to type `YES`. Typing YES accepts Ping's terms for the image and PingFederate's in-product license agreement. Nothing is accepted for you; `PF_ACCEPT_EULA=YES` in your own environment is the only way to skip the question.
- **Login.** The local install uses the official image default: `administrator` / `2FederateM0re`. It is for `127.0.0.1` only; change it for anything else. The login is saved to `~/.config/demo-kit/provisioning.json` (mode 600) and nowhere else. It is never written to the settings file, printed, or put on a command line: setup hands it to the configure scripts through their environment.
- **Ports.** PingFederate admin `4731`, engine (runtime) `4732`. `PF_URL` is set to `https://127.0.0.1:4732`. If PingFederate is already running on 4731 setup uses it and checks the saved login (it asks for the admin login if the default does not work).
- **What it does after that.** `pingfederate/configure-signin.js --local` and `pingfederate/configure-local-signin.js` create the app's OAuth client, token manager, OIDC policy and a sign-in form holding only the users you name (`--users`, plain addresses on `ALLOWED_EMAIL_DOMAINS`; their generated passwords go to `deploy/local/kit-users.json`, not the screen). Then it writes the app's settings to the shared file, `~/Development/.env` (mode 600, or the file named by `STANDALONE_ENV`), adding keys and never replacing ones that are already there, and runs `npm run doctor -- --mode=pf-as`. It only ever contacts `https://127.0.0.1:4731`.
- **Rerun it any time.** A second run finds the install, keeps every object and setting, and changes nothing (`--users` is needed only the first time).
- **Not done for you:** the ID-JAG issuing policy at PingFederate (see [setup guide](docs/setup-guides.md#pingfederate-as-the-id-jag-issuer)), the Acme PingFederate for `pf-pf`, and a certificate Node trusts for `https://127.0.0.1:4732`. The image ships its own self-signed one; on 2026-10-31 it had expired, so `npm run doctor` fails `pf-discovery` with `CERT_HAS_EXPIRED` until you install a valid certificate in PingFederate's admin console.

If port 4731 or 4732 is taken by something that is not PingFederate:
1. Find what is using it: `lsof -iTCP:4731 -sTCP:LISTEN -n -P`
2. If it is an old copy of this install, stop that process: `kill <PID>` (or `docker stop pingfederate-lab`).
3. If it is something else, stop it. The local PingFederate ports are fixed at 4731 and 4732 for the standalone apps.
4. Do not use 8080, 5173, 3000, 4000, 4400, 4510, 4600-4601, 18080, 19080 or 19090.

### Modes

| Mode | Issues the ID-JAG | Redeems it | Status |
| --- | --- | --- | --- |
| **Mock** | Sample data in the browser | Sample data | Works; sends nothing at all |
| **PingFederate → resource AS** (`pf-as`) | PingFederate (`PF_URL`) after a sign-in there | `resource-as`; step 4 calls `mcp-sample` | Works once `PF_EXCHANGE_*`, `RESOURCE_AS_*`, `ID_JAG_RESOURCE`, `MCP_URL`, `ID_JAG_REGISTRY_TOKEN` are set |
| **Acme PingFederate → PingFederate** (`pf-pf`) | The outside "Acme" PingFederate (`ACME_PF_URL`) | PingFederate (`PF_URL`) via an IdP connection | Works once `pingfederate/configure-acme-signin.js` has run on Acme and the redeemer client is in `.env` (see [setup guide](docs/setup-guides.md#acme-pingfederate--pingfederate)); `mcp-sample` refuses PingFederate's token (it trusts `resource-as` only) |
| **Your IdP → our resource AS** (`byo`) | Any IdP on the Trusted IdPs list; you paste the ID-JAG, or get one from xaa.dev's IdenX | `resource-as`, or PingFederate | Inspect works; redeem needs the target's secret |

| **Gateway redeems the ID-JAG (mock only)** (`gateway-redeem`) | The company IdP (mock), by exchanging the caller's token for the gateway (leg 1) | The target app's own issuer (mock), by the gateway (leg 2); the target API (mock) accepts the result | Mock only. Ping release claim (2026-11-02), UNVERIFIED on our tenant |

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

### Gateway redeem

Ping release claim (2026-11-02), **UNVERIFIED on our tenant**. A mock of the gateway side of the claim; nothing here proves anything about the real release.

- **Spec.** The form edits the console swagger fields (2026-10-31, schema only; nothing was called): `OBO` `{TokenURL, ClientID, ClientSecret, AuthMethod, Resource, Scope, PrivateKeyPEM, KeyID, SubjectTokenType, RequestedTokenType, Redeem}` and `Redeem` `{TokenURL, ClientID, ClientSecret, AuthMethod, Scope, PrivateKeyPEM, KeyID}`. Leg 2 runs only when `Redeem.TokenURL` is set; without it the exchange result is not redeemed and the target API refuses it.
- **Write-only.** `ClientSecret` and `PrivateKeyPEM` are never returned: every answer reports `{ set }` and every response is scrubbed of stored and just-typed values. Write `null` to clear one; leave it out (or empty) to keep it.
- **Ten scenarios (lab-invented).** Both legs as configured; no Redeem; an issuer the target does not trust; the wrong audience; an expired assertion; a replayed one (the target issuer accepts each `jti` once); a tampered signature; a `Redeem.TokenURL` on a host that is not allow-listed (SSRF); one that redirects (`redirect: error`); the wrong client authentication method. Each verdict is computed from the run (stage, check, error), and the target API's refusal of the caller's original token and of the raw assertion comes from real requests to the mock.
- **Where every name comes from.** Each name is tagged *console swagger name, 2026-10-31, schema only*, *lab reading* or *lab-invented* (the panel's last section lists them; `CLAIMS` in `server/src/gatewayRedeem.js` is the one list). `AuthMethod` values, the token type URNs, the `act` claim shape and the single-use `jti` are the lab's reading. The cast, the scenarios, the allow-list and the mock hosts (all `.invalid`) are made up.
- **Routes.** `/api/id-jag-playground/gateway-redeem/` `state`, `spec` (PUT), `spec/reset`, `run`, `reset`. Writes are same-origin only. The mock servers live in `server/src/mock/gatewayWorld.js`, the gateway in `server/src/gatewayRedeem.js`.
- **Diagram.** `diagrams/gateway-redeem.json` (diagram-studio/1). Its boxes sit close together (120px apart, enough that a box dragged 70px still has a route; a test pins it) and, like every diagram, the view never zooms out below 0.9, so no on-screen text is under 10px; the view refits when the window is resized.
- **Why it matters.** The talk track and `content-pack.json` carry a Challenge, Technical and Business draft for the gateway redeem feature. It is written by the lab author from the swagger field names and the feature description, checked against the IETF draft and public vendor descriptions of the same problem, is not Ping wording, and is UNVERIFIED on our tenant; the owner replaces it with the real row.

### Layout

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

### Configuration

Every variable is in [`.env.example`](.env.example). None are needed for Mock mode.

**Where settings are read from**, first one wins per variable: real environment variables, then the shared file
`~/Development/.env` (mode 600, shared by every standalone app; `STANDALONE_ENV=/path/to/file` names another), then this
repo's own `.env` (still read, so existing setups keep working). Admin logins (`PF_ADMIN_USER`, `PF_ADMIN_PASSWORD`) never
go in the shared file: `npm run setup -- --mode=pf-local` keeps the local PingFederate admin login only in
`~/.config/demo-kit/provisioning.json`. To let a running app use the admin API (approving account requests), export
them in the shell that starts it.

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

### Make it the customer's

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

Stories name people as `{{cast.<id>}}` tokens and nouns as `{{vocab.<key>}}`, so a name written in one place is replaced everywhere; a test fails on an undefined token or a cast name written out.

### Diagrams

Each playground mode has a ReactFlow diagram at `/diagram/<mode>` (`?step=N` lights step N; it opens in a new tab). The diagrams are diagram-studio/1 data files in [`diagrams/`](diagrams/), loaded by name; nothing is hand-built in code. Boxes are movable, **Simulate** walks the steps (the **Speed** control sets the pause), and **Reset** stops the walk, shows the overview and puts every box back. The arrow labels (a numbered badge, and the words while a step lights the arrow or you hover it) keep one size on screen at any zoom and are placed in screen pixels, so none covers a box, a button or another label; a lit label with no clear place keeps only its badge, and its words stay in the step list and the badge tooltip. No diagram zooms out below 0.9, so no card text on screen is under 10px (a test reads the card font sizes from the CSS and pins it); the boxes sit 180px apart so that a 100px by 60px drag on screen still leaves every arrow a route (a test pins the spacing and the drags). The view refits when the window is resized. A map wider than the canvas, and any map on a phone, shows part of the diagram and pans; it sits on top, sticky, on a phone. Colours come from the shared stylesheet tokens only (`check-css.sh` passes). A step's callout is its `why` in the data file. After a change, evaluate the AI-DEMO-Standalone `scripts/diagram-overlap.js` on each diagram in a browser and expect `pass: true`.

### Run doctor before a demo

```sh
npm run doctor                          # mock mode: needs no .env and no network
npm run doctor -- --mode=pf-as          # or pf-pf, byo; add --json for machine-readable output
```

It checks Node, `.env`, the settings the mode needs, `DATA_DIR`, the port, PingFederate discovery (the issuer must
match `PF_URL` byte for byte), the resource AS and MCP server, and, when `PF_ADMIN_URL` is set, the PingFederate
admin API, the `idJagKitPcv` validator and that the sign-in client allows pi.flow. Each non-passing line prints the
exact fix. Exit code 1 on any FAIL. Secrets show only as set/unset and length. Signed-in admins get the same report
from `GET /api/doctor?mode=pf-as`.

### Health for the demo shelf

`GET /api/health` is public and answers the `demo-health/1` contract: `state` (`ready`, `needs-setup`, `broken`,
`unknown`), `runtime` (`offline` or `live`) and the demo's id, name and version. Nothing else: no counts, messages or
secrets (detail stays on the admin-only `/api/doctor`). The state is the doctor's, run at boot and refreshed in the
background every 60 s, never per request, through the IdP adapter's doctor (so the PF admin failure latch applies and
health makes no PF admin call of its own). It describes the process and is answered from the default workspace in every
workspace. GET only: HEAD answers 405, so the shelf must poll with GET. Code: `server/src/health.js`. Full contract: [docs/health-contract.md](docs/health-contract.md).

### Sign-in and the Trusted IdPs registry

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

#### Sign-in limits

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

### Reset between demos

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

### PingFederate ID-JAG gotchas

1. The ID-JAG signing key is not in `/pf/JWKS` unless a JWT access token manager publishes it
   ("Publish Keys to the PingFederate JWKS Endpoint").
2. PingFederate ID-JAGs carry `x5t` and no `kid`. PingFederate's JWT bearer consumer does not pick keys by
   `x5t`, so the issuer must publish only its ID-JAG key (a static JWKS).
3. The consumer caches the issuer JWKS and never refetches without a `kid`. Only a PingFederate restart clears it.
4. A JWT bearer request with `resource` gets `invalid_target` unless an access token manager lists that
   resource in its selection settings.
5. `x5t` lookups must count distinct keys: a static JWKS lists one certificate under several `kid`s.

### Roadmap

See [docs/roadmap.md](docs/roadmap.md).

### Keeping secrets out

- Nothing secret is committed: `.env` is ignored, only `.env.example` ships. The shared `~/Development/.env` and `provisioning.json` live outside the repo.
- Three independent checks block a leaked secret: the `.githooks/pre-commit` gitleaks hook (installed by `npm install`), the `secrets` CI job (gitleaks over the full history of every PR), and GitHub secret scanning with push protection on this repository.
- Real tokens never reach the browser or the logs (enforced by tests). Mock mode shows its own mock tokens raw (they carry `"mock": true`; the answer says it is simulated).
- Planned: secrets generated inside the cluster, external ones stored as SealedSecrets, `private_key_jwt` client authentication instead of client secrets, and a small encrypted vault for local development.

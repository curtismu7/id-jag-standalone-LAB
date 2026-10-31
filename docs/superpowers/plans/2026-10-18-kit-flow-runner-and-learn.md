# Kit Flow Runner v2 and Learn Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the kit's playground the xaa.dev-style flow runner (backends strip, story, REST|MCP, tabbed steps with code, revoke-and-prove, real clients, mock SAML) and a Learn page (docs index, glossary, source library) linked from every step.

**Architecture:** The playground stays one page (`IdJagPlaygroundPage.jsx`) with small new components; new server routes live in `server/src/idJagPlayground.js` and every one has a `mockApi` twin. Learn is a new page fed by two JSON files. Pure helpers (code snippets, real-client snippets) go in `web/src/utils/`.

**Tech Stack:** React 18 + Vite, Express, vitest + @testing-library/react + supertest. No new dependencies.

**Spec:** The roadmap report, options A and D (https://claude.ai/artifact/EUzyrVAKR8BP13CrS4AWzP), plus these session decisions: PingFederate is the only Ping ID-JAG/DPoP product (PingOne = sign-in only); Okta- and Auth0-built clients are out; the real clients are mcpc and VS Code; the demo playground (AI-DEMO2) gets the same features in a second plan after this one ships.

## Global Constraints

- Raw tokens and secrets never reach the browser. Code snippets use the placeholders `SUBJECT_TOKEN`, `ID_JAG`, `ACCESS_TOKEN`, `CLIENT_ID`, `CLIENT_SECRET`, never values.
- Mock mode sends nothing: every new server route has a `mockApi` answer in `web/src/utils/idJagPlaygroundMock.js`.
- Every new action button goes through `run(label, fn, checkFor(step))` (the pre-flight gate).
- SAML runs in Mock mode only. In real modes the SAML option is disabled with title `PingFederate SAML subject not verified yet (F2 spike)`.
- Our own wording and the kit's existing classes (`ijp-*`, `kc-*`): "Backends", "The story", tabs "Request · Response · Decoded · Code".
- New localStorage keys: `idjag.playground.resource` (`rest` | `mcp`, default `mcp`), `idjag.playground.protocol` (`oidc` | `saml`, default `oidc`), read through the existing `stored()` helper.
- Probe limits: 4000 ms timeout = down, over 1500 ms = slow.

## Review Focus

- A backend that never answers must show "down" within 4 s, not hang the strip. (Task 2 test: fetch never resolves.)
- The Code tab must not print a secret even if a request object carries one. (Task 3 test: `client_secret` and `Authorization` values absent from the snippet.)
- Revoke when not signed in, or a second click after revoking, must answer 409 `sign_in_required`, not 502. (Task 5 test.)
- Switching protocol or mode mid-run must clear the old results, so no OIDC tabs linger under a SAML run. (Task 7 test.)
- A glossary link to an unknown term, or a step term missing from `terms.json`, must not break the page. (Task 10 test: every step term exists; `/learn#term-nope` still renders.)

---

### Task 1: Make PingFederate → resource AS run locally

**Files:**
- Modify: `pingfederate/configure-desktop-clients.js` (SP connection mappings, trusted-IdP file aliases)

**Interfaces:**
- Produces: a working `pf-as` mode at `http://localhost:4720` for the later live checks.

- [ ] **Step 1:** In `configure-desktop-clients.js`, read PingFederate's default exchange policy (`GET /oauth/tokenExchange/processor/settings` → `defaultProcessorPolicyRef.id`) and give `idJagKitResourceAsSp` a second `processorPolicyMappings` entry for it (`TOKEN_SUBJECT` and `client_id` from the policy, `scope` TEXT `read mcp:invoke`). The connection already exists, so add an update: when no mapping names that policy, PUT the connection with it appended.
- [ ] **Step 2:** In the trusted-IdP file it writes, add `[PF_EXCHANGE_CLIENT_ID]: RESOURCE_AS_CLIENT_ID || 'id-jag-playground'` to `clientAliases` when `PF_EXCHANGE_CLIENT_ID` is set (the file entry shadows the registry's entry for the same issuer).
- [ ] **Step 3:** Add to `.env` when missing, generated and never printed: `RESOURCE_AS_CLIENT_SECRET`, `ID_JAG_REGISTRY_TOKEN`, `SESSION_SECRET` (`node -e` with `crypto.randomBytes(32).toString('base64url')`).
- [ ] **Step 4:** Run `node pingfederate/configure-signin.js --ns=demo-namespace --app-origin=http://localhost:4720` (adds the 4720 redirect URIs) and `node pingfederate/configure-desktop-clients.js --ns=demo-namespace`, then `docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.desktop-clients.yml up --build -d`.
- [ ] **Step 5: Verify:** `curl -s localhost:4720/api/id-jag-playground/config` → the `pf-as` entry in `modes` has `available: true`. Rerun the mcpc e2e script (scratchpad `mcpc/e2e.py`): still `exit 0`.
- [ ] **Step 6: Commit** `feat(pingfederate): kit pf-as mode runs locally (refresh-token mapping, aliases)`.

### Task 2: Backends strip and the story

**Files:**
- Modify: `server/src/idJagPlayground.js` (new `probeBackends`, `GET /backends`)
- Modify: `web/src/pages/IdJagPlaygroundPage.jsx` (new `BackendsStrip`), `IdJagPlaygroundPage.css`, `web/src/utils/idJagPlaygroundMock.js`
- Test: `server/src/__tests__/idJagPlayground.test.js`, `web/src/pages/__tests__/IdJagPlaygroundPage.test.jsx`

**Interfaces:**
- Produces: `export async function probeBackends(s, mcpUrl, fetchImpl = fetch): Promise<Backend[]>` where `Backend = { id: 'idp'|'resource-as'|'mcp', label: string, url: string, state: 'up'|'slow'|'down', ms: number|null, detail: string }`. `GET /api/id-jag-playground/backends` → `{ backends: Backend[] }` for the session's mode.

- [ ] **Step 1: Write the failing server tests** in a `describe('backends')` block (env `PF_AS_ENV` plus `MCP_URL=https://mcp.test/mcp`):
  - `it('reports each backend up with its probe url')`: fetch answers 200 → states `['up','up','up']`; urls `https://pf.test/.well-known/openid-configuration`, `${AS}/.well-known/oauth-authorization-server`, `https://mcp.test/.well-known/oauth-protected-resource`.
  - `it('marks a backend down when it never answers')`: fetch for the MCP url returns a promise that rejects with an `AbortError` → that entry is `state: 'down'`, `detail: 'no answer in 4 s'`.
  - `it('marks a non-2xx answer down with its status')`: 503 → `state: 'down'`, `detail: 'HTTP 503'`.
- [ ] **Step 2:** Run `npm test -w server` → the three fail (`probeBackends` is not exported).
- [ ] **Step 3: Implement `probeBackends`.** The idp url comes from `s.idp.issuer` (a missing issuer = `down`, `not configured`). The resource AS url is the origin of `s.resourceAs.tokenEndpoint` (that is the address the server can reach, e.g. `http://resource-as:9080`) + `/.well-known/oauth-authorization-server`, falling back to `/.well-known/openid-configuration` on 404 (PingFederate as redeemer). MCP is the origin of `MCP_URL` + `/.well-known/oauth-protected-resource`. Probe in parallel with `AbortSignal.timeout(4000)`. Over 1500 ms = `slow`. Add the route using `settingsFor(req)`.
- [ ] **Step 4:** Server tests pass.
- [ ] **Step 5: Write the failing web test** `it('shows a backends strip and re-checks on demand')`: `get` answers `/backends` with three entries (one `slow`) → three chips named by `label`, the slow one has class `is-slow`; clicking `Re-check` calls `/backends` a second time.
- [ ] **Step 6: Implement `BackendsStrip({ client, mode })`** above the actors section: loads on mount and mode change, chip `title` = `${url} ${detail}`, a `Re-check` button. Add mock answer (all `up`, sample urls). CSS: `.ijp-backends`, `.ijp-chip.is-up|is-slow|is-down` using existing theme variables.
- [ ] **Step 7: Write the failing web test** `it.each(MODES)('tells the %s story')`: the element `[data-testid=ijp-story]` holds that mode's `story` text.
- [ ] **Step 8: Implement:** add `story` to each `MODE_TEXT` entry. Render `<p className="ijp-story" data-testid="ijp-story"><strong>The story.</strong> {text.story}</p>` under the backends strip. Use this copy:
  - mock: "Jordan signs in once at their company's PingFederate. Their agent then reads Jordan's data from the sample MCP server without a second sign-in. In this mode every step uses sample data."
  - pf-as: "You sign in once at PingFederate. This app, acting as your agent, asks PingFederate for an ID-JAG addressed to our resource authorization server, trades it for an access token and calls the sample MCP server for you. PingFederate decides whether the agent may act; the resource AS decides what it may read."
  - pf-pf: "An outside company, Acme, runs its own PingFederate. You sign in there, and Acme's PingFederate issues an ID-JAG addressed to our PingFederate, which redeems it through a trusted IdP connection."
  - byo: "Your company's IdP issued an ID-JAG for our resource authorization server. Paste it: we check it against the draft and your Trusted IdP entry, redeem it and call the sample MCP server."
- [ ] **Step 9:** `npm test -w web` passes. **Commit** `feat(playground): backends strip and the story`.

### Task 3: Step tabs with a Code view

**Files:**
- Create: `web/src/utils/codeSnippet.js`, `web/src/utils/__tests__/codeSnippet.test.js`
- Modify: `web/src/pages/IdJagPlaygroundPage.jsx` (new `StepTabs`; steps 2, 3, 4 use it)

**Interfaces:**
- Produces: `export function codeSnippet(request): string` for both request shapes the server returns: `{ endpoint: 'POST <url>', body: {...}, authorization? }` and `{ method, url, authorization }`. `function StepTabs({ request, response, decoded, title })` (Decoded tab hidden when `decoded` is absent).

- [ ] **Step 1: Write the failing util tests:**
  - `it('turns a token exchange into fetch with placeholders')`: the issue request from the server → output contains `fetch("https://pf.test/as/token.oauth2"`, `new URLSearchParams({`, `subject_token: SUBJECT_TOKEN`, `Authorization: "Basic " + btoa(\`${CLIENT_ID}:${CLIENT_SECRET}\`)` and no `[`.
  - `it('never prints a secret')`: a request whose body has `client_secret: "s3cr3t"` and `authorization: "Bearer eyJabc"` → output contains `CLIENT_SECRET` and `ACCESS_TOKEN`, and neither `s3cr3t` nor `eyJabc`.
  - `it('sends JSON-RPC as JSON')`: `{ endpoint: 'POST https://mcp.test/mcp', authorization: 'Bearer [access token]', body: { jsonrpc: '2.0', method: 'tools/list' } }` → contains `"Content-Type": "application/json"`, `Accept: "application/json, text/event-stream"`, `body: JSON.stringify(`.
- [ ] **Step 2:** Run them → fail (module missing).
- [ ] **Step 3: Implement `codeSnippet`.** Key-based placeholders: `subject_token` → `SUBJECT_TOKEN`, `assertion` → `ID_JAG`, `client_secret` → `CLIENT_SECRET`, `token` → `SUBJECT_TOKEN`; any bracketed `[...]` value → its key's placeholder; `Bearer …` → `` `Bearer ${ACCESS_TOKEN}` `` (or `ID_JAG` when the shown value names the ID-JAG); a body with `jsonrpc` is JSON, otherwise form.
- [ ] **Step 4:** Util tests pass.
- [ ] **Step 5: Write the failing web test** `it('shows each step as Request, Response, Decoded and Code tabs')`: after Request ID-JAG, step 2 has tabs `Request`, `Response`, `Decoded`, `Code`; clicking `Code` shows text containing `fetch(`.
- [ ] **Step 6: Implement `StepTabs`** (`role="tablist"`, buttons `role="tab"` with `aria-selected`) and replace the `ijp-io` blocks in steps 2 (issued, byo inspection), 3 (redeemed) and 4 (tools request, call request).
- [ ] **Step 7:** `npm test -w web` passes (update existing assertions that looked for the stacked `Request`/`Response` headings). **Commit** `feat(playground): tabbed steps with a Code view`.

### Task 4: REST | MCP in step 4

**Files:** Modify `web/src/pages/IdJagPlaygroundPage.jsx`; Test `IdJagPlaygroundPage.test.jsx`

**Interfaces:** Consumes `StepTabs` (Task 3).

- [ ] **Step 1: Write the failing test** `it('step 4 calls the REST page or the MCP server, and remembers the choice')`: default shows `List tools this token can see`; pressing `REST API` shows `Open with the access token` and hides the tools button; remount → `REST API` is still pressed.
- [ ] **Step 2:** Run → fails.
- [ ] **Step 3: Implement:** step 4 title `Call the resource with the new token`, a `Segmented` labelled `Resource` with `[{ id: 'mcp', label: 'MCP server' }, { id: 'rest', label: 'REST API' }]` stored under `idjag.playground.resource`. The REST choice renders the current protected-resource block (moved inside step 4); the separate "Protected resource" section goes away. Its note becomes the step note when REST is picked.
- [ ] **Step 4:** Tests pass. **Commit** `feat(playground): REST or MCP in step 4`.

### Task 5: Revoke and prove it

**Files:**
- Modify: `server/src/idJagPlayground.js` (`POST /revoke`; pull the shown exchange request out of `mintIdJag` into `exchangeShown(s, scope)`), `web/src/pages/IdJagPlaygroundPage.jsx`, `web/src/utils/idJagPlaygroundMock.js`, and the preflight `step` list (`revoke` reuses the `issue` checks)
- Test: server and web test files

**Interfaces:**
- Produces: `POST /api/id-jag-playground/revoke` → `{ revoke: { request, status }, retry: { request, status, error }, proved: boolean }`. `proved` = revoke answered 200 AND the retried exchange failed with `invalid_grant`. The session's issuer sign-in is cleared in every case after the revoke call.

- [ ] **Step 1: Write the failing server tests:**
  - `it('revokes the refresh token, then proves PingFederate refuses a new ID-JAG')`: signed-in session; fetch → 200 for `https://pf.test/as/revoke_token.oauth2` (form `token`, `token_type_hint=refresh_token`, Basic `pf-exchange`), then 400 `{ error: 'invalid_grant' }` for the exchange → `proved: true`, `session.idJagIssuer` gone, response JSON has no refresh token value.
  - `it('answers 409 sign_in_required when there is nothing to revoke')`: no issuer session → 409 `sign_in_required`.
  - `it('refuses in byo mode')`: → 409 `byo_mode`.
- [ ] **Step 2:** Run → fail.
- [ ] **Step 3: Implement the route** (`requireReal`), reusing `mintIdJag` for the retry and `exchangeShown` for its shown request.
- [ ] **Step 4:** Server tests pass.
- [ ] **Step 5: Write the failing web test** `it('revoke and prove shows both calls and the verdict')`: `post('/revoke')` answers `proved: true` → `Proved: PingFederate refused a new ID-JAG`; the button is disabled when not signed in; the step is absent in byo mode.
- [ ] **Step 6: Implement step 6** `Revoke and prove it` (modes `pf-as`, `pf-pf`, `mock`), with note: "Revoking the refresh token at PingFederate stops new ID-JAGs from this session. Access tokens already minted stay valid until they expire; the resource AS is not told." It has a `Revoke and retry` button, two `StepTabs` (revoke, retry) and a verdict pill. Re-fetch `/config` after it so step 1 shows signed-out. Add the mock answer.
- [ ] **Step 7:** Web tests pass. **Commit** `feat(playground): revoke and prove it`.

### Task 6: Real clients panel

**Files:**
- Create: `web/src/utils/realClients.js`, `web/src/utils/__tests__/realClients.test.js`
- Modify: `web/src/pages/GuidesPage.jsx` (use the helpers), `web/src/pages/IdJagPlaygroundPage.jsx`

**Interfaces:**
- Produces: `mcpcCommand({ pfUrl, mcpUrl }): string`, `vscodeSettings({ pfUrl }): string`, `vscodeMcpJson({ mcpUrl }): string`, with the exact text now in `GuidesPage.jsx` (`id-jag-mcpc`, `id-jag-vscode`, `id-jag-desktop`, `@apify/mcpc@0.7.0`, `$MCPC_IDP_CLIENT_SECRET`, `$DESKTOP_RESOURCE_CLIENT_SECRET`, `<VSCODE_IDP_CLIENT_SECRET>`).

- [ ] **Step 1: Write the failing tests:** `mcpcCommand({ pfUrl: 'https://pf.test', mcpUrl: 'http://localhost:4722/mcp' })` contains `--idp https://pf.test` and `login http://localhost:4722/mcp`; `vscodeSettings` contains `"issuer": "https://pf.test"`; none contains a real secret pattern (only `$…` or `<…>` placeholders).
- [ ] **Step 2:** Run → fail.
- [ ] **Step 3: Implement** the helpers; `GuidesPage` calls them with `https://pf.example.invalid` and `http://localhost:4722/mcp`.
- [ ] **Step 4: Web test** `it('offers the same flow from mcpc and VS Code')`: in pf-as, a `<details>` titled `Run this flow from a real client (mcpc, VS Code)` holds a command containing `config.idp.issuer` and `config.request.resource`. Implement it in step 1 for `pf-as` and `mock`.
- [ ] **Step 5:** `npm test -w web` passes (GuidesPage tests unchanged). **Commit** `feat(playground): run the flow from mcpc or VS Code`.

### Task 7: OIDC | SAML (mock only)

**Files:** Modify `web/src/pages/IdJagPlaygroundPage.jsx`, `web/src/utils/idJagPlaygroundMock.js`; Test `IdJagPlaygroundPage.test.jsx`

**Interfaces:**
- Consumes `StepTabs`. Mock `POST /issue` with `{ protocol: 'saml' }` returns the usual `{ request, response, token }` plus `assertionExchange: { request, response }`. The request has `subject_token_type: urn:ietf:params:oauth:token-type:saml2` and `requested_token_type: …:refresh_token`, and the ID-JAG claims include `sub_id: { format: 'saml-nameid', issuer, nameid }`.

- [ ] **Step 1: Write the failing tests:**
  - `it('mock SAML shows the assertion exchange before the ID-JAG')`: mock mode, press `SAML`, Request ID-JAG → step 1 title `Sign in with SAML at PingFederate`; step 2 shows `Assertion → refresh token` and the decoded ID-JAG contains `sub_id`.
  - `it('SAML is disabled in real modes')`: pf-as → the `SAML` button is disabled with title `PingFederate SAML subject not verified yet (F2 spike)`.
  - `it('switching protocol clears the run')`: after an OIDC Request ID-JAG in mock, press `SAML` → no decoded ID-JAG shown.
- [ ] **Step 2:** Run → fail.
- [ ] **Step 3: Implement:** a `Segmented` labelled `Sign-in` in the toolbar, stored under `idjag.playground.protocol`. Picking clears results. Forced to `oidc` outside mock. Mock fixtures follow the interface above.
- [ ] **Step 4:** Tests pass. **Commit** `feat(playground): SAML variant in mock mode`.

### Task 8: Learn data

**Files:**
- Create: `web/src/data/terms.json`, `web/src/data/sources.json`, `web/src/__tests__/learnData.test.js`

**Interfaces:**
- Produces: `terms.json` = `[{ id, term, definition }]` with the report's 17 glossary terms plus `refresh-token-revocation`. `sources.json` = `[{ id, title, url, kind, use, status, checked }]` with the report library, where `status` is one of `verified`, `read`, `search-only` or `not-read`, and `checked` is `2026-10-18`. No Okta- or Auth0-built samples. The xaa.dev entries carry `(run by Okta)` in the title.

- [ ] **Step 1: Write the failing test** `learnData.test.js`: ids unique in each file and match `/^[a-z0-9-]+$/`; every source `url` starts with `https://`; every `status` is in the set; every `checked` matches `/^\d{4}-\d{2}-\d{2}$/`; `terms` has at least 18 entries and includes `id-jag`, `jti-replay`, `refresh-token-revocation`.
- [ ] **Step 2:** Run → fails (files missing).
- [ ] **Step 3:** Write both JSON files from the report's glossary and library sections.
- [ ] **Step 4:** Test passes. **Commit** `feat(learn): glossary terms and source library data`.

### Task 9: Learn page

**Files:**
- Create: `web/src/pages/LearnPage.jsx`, `web/src/pages/__tests__/LearnPage.test.jsx`
- Modify: `web/src/main.jsx` (`/learn`), `web/src/AppShell.jsx` (`PAGES` gets `["/learn", "Learn"]`), `web/src/pages/console.css` if needed

**Interfaces:**
- Consumes `terms.json` and `sources.json` (Task 8). Produces glossary anchors `id="term-<id>"`.

- [ ] **Step 1: Write the failing tests:**
  - `it('searches the glossary')`: typing `jti` shows `jti replay protection` and hides `CIMD`.
  - `it('filters the library by kind')`: pressing the `Client` chip shows only `kind === 'Client'` rows.
  - `it('opens the glossary at a term from the hash')`: `/learn#term-dpop` → the Glossary tab is selected and `#term-dpop` exists.
  - `it('survives an unknown term in the hash')`: `/learn#term-nope` renders the Glossary with no error.
- [ ] **Step 2:** Run → fail.
- [ ] **Step 3: Implement `LearnPage`** with tabs `Docs | Glossary | Library` (hash `#glossary`, `#library` or `#term-…` picks the tab). Docs is an index of in-app links: each `/guides#…` section, the playground, `/diagram/<mode>` for the four modes, and `/trusted-idps`. Glossary is a search box plus a `<dl>`. Library is kind chips (`All` + distinct kinds) and a table of title (external link), kind, use, status tag and checked. Route and nav link as listed.
- [ ] **Step 4:** Tests pass (and `shell.test.jsx`, updated for the new nav item). **Commit** `feat(learn): Learn page with docs index, glossary and library`.

### Task 10: Steps link to the glossary

**Files:** Modify `web/src/pages/IdJagPlaygroundPage.jsx`; Test `IdJagPlaygroundPage.test.jsx`

**Interfaces:**
- Consumes `terms.json` ids. Produces `STEP_TERMS = { 1: ['identity-assertion', 'requesting-app'], 2: ['id-jag', 'token-exchange', 'resource-authorization-server'], 3: ['jwt-bearer-grant', 'jti-replay', 'strict-client-binding'], 4: ['resource-server'], 5: ['jti-replay'], 6: ['refresh-token-revocation'] }`. `Step` gets a `terms` prop rendering `Terms:` links to `/learn#term-<id>` labelled with the term's `term`.

- [ ] **Step 1: Write the failing tests:** `it('every step term exists in the glossary')` (all `STEP_TERMS` ids are in `terms.json`, so export `STEP_TERMS`); `it('step 2 links its terms to the glossary')` → a link named `ID-JAG` with href `/learn#term-id-jag`.
- [ ] **Step 2:** Run → fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Tests pass. **Commit** `feat(playground): link each step to its glossary terms`.

### Task 11: Live verification, docs, PR

**Files:** Modify `README.md` (Learn page, new playground features), `docs/setup-guides.md` (nothing new unless Task 1 changed a step)

- [ ] **Step 1:** `npm test` (all four workspaces) and `npm run build` pass.
- [ ] **Step 2:** `docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.desktop-clients.yml up --build -d`.
- [ ] **Step 3: Headless Playwright pass** (scratchpad script, throwaway PingOne user created and deleted as in `mcpc/e2e.py`). Mock OIDC and SAML runs reach step 4 with tabs and a Code view. A live pf-as run goes: sign in at the issuer through the kit's PingOne → Request ID-JAG → Redeem → MCP list and call → REST page 200 → Revoke and prove (`proved: true`). The backends strip shows three `up`. `/learn` works: search, a filter chip, and `#term-dpop`. Save screenshots; record any failure and fix it in its task before going on.
- [ ] **Step 4:** Update `README.md`. **Commit**, push `feat/flow-runner-learn`, open the PR with the verification results, and hand the user the merge command.

---

Next plan (after this merges): port A and D to the AI-DEMO2 playground. That has its own constraints: a worktree, the new-SPA-route checklist, Learning Hub sync, and focused deploy.

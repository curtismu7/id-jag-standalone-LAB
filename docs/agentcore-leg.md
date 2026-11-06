# The AgentCore leg — what is real, what is owner-run, and how AWS fits

*Status: legs 1 and 2 run fully real through public endpoints (verified by decoded
claims). The runtime hop refuses `runtime_not_deployed` (409) until the owner-run
AWS steps in Part 3 are done. Everything else is checked into the repo.*

---

## Part 1 — the chain today (all real, nothing mocked)

```
browser sign-in  ──pi.flow──▶  PingFederate (SE, public)
  https://<pf-host>.ping-demo.example.invalid                client id-jag-kit-acme
        │  the playground server holds the refresh token in its session
        ▼
leg 1  RFC 8693 token exchange at PF's /as/token.oauth2
       refresh_token  ──▶  ID-JAG (typ oauth-id-jag+jwt, 5-minute life)
       aud = https://<ras-host>.ping-demo.example.invalid/resource-as   (the resource AS)
       resource = https://<ras-host>.ping-demo.example.invalid/mcp
        ▼
leg 2  RFC 7523 jwt-bearer redemption at the resource AS (SE-hosted container)
       https://<ras-host>.ping-demo.example.invalid/resource-as/token
       the AS verifies the ID-JAG against PF's public JWKS, checks the jti was
       never redeemed (replay cache), and mints the runtime's access token
       (typ at+jwt, aud = the resource, act-style info in the claims)
        ▼
runtime hop  ──▶  REFUSES 409 runtime_not_deployed
       (the redeemed token is discarded, never shown, never stored)
```

Verified 2026-11-04, decoded:

- leg 1: `{"typ":"oauth-id-jag+jwt","iss":"https://<pf-host>.ping-demo.example.invalid",
  "aud":"https://<ras-host>.ping-demo.example.invalid/resource-as","sub":"acme-user",
  "scope":"read mcp:invoke","client_id":"id-jag-playground"}`
- leg 2: `{"typ":"at+jwt","iss":"https://<ras-host>.ping-demo.example.invalid/resource-as",
  "sub":"acme-user","aud":"https://<ras-host>.ping-demo.example.invalid/mcp"}`

### Why every hop needed a public URL

This leg's chain crosses machine boundaries three times, and each boundary needs
a **public HTTPS** endpoint:

1. The local playground's sign-in needs PF reachable — satisfied because the SE
   PF is public.
2. The SE resource-as must fetch the **issuer's JWKS** to verify every ID-JAG —
   the issuer is the SE PF, so its `/pf/JWKS` must be public. (This is why the
   original `127.0.0.1:4732` local PF could never serve this leg.)
3. When the AgentCore runtime goes live, **AWS** fetches the resource-as's
   discovery document and JWKS — so the resource-as's issuer URL must be public.
   It is: `https://<ras-host>.ping-demo.example.invalid/resource-as` (a path on the
   existing id-jag host, rewritten by nginx to the container's root).

An issuer URL with a path is legal (RFC 8414); the discovery document advertises
the full path in `issuer` and `jwks_uri`, and every verifier resolves relative to
what it fetched.

## Part 2 — what was deployed to the SE cluster (all checked in)

`deploy/se/resource-as.yaml` — three objects:

| Object | What it is | The one thing that matters |
| --- | --- | --- |
| Deployment `id-jag-resource-as` | the kit's resource-as container (`ghcr.io/ping-sandbox/id-jag-resource-as`, built from `deploy/service.Dockerfile`, **linux/arm64** — the SE nodes are Graviton) | `ISSUER=https://<ras-host>.ping-demo.example.invalid/resource-as` — this exact string is the ID-JAG's audience and the access token's `iss` |
| Service `id-jag-resource-as` | ClusterIP :80 | nothing exotic |
| Ingress `id-jag-resource-as` | path route on the existing id-jag host | `rewrite-target /$2` with path `/resource-as(/|$)(.*)` — the container serves its root routes; the public URL keeps the path |

`deploy/se/trusted-idps.yaml` — a ConfigMap mounting
`/config/trusted-idps.json` (`TRUSTED_IDPS_FILE`). It trusts exactly one IdP: the
SE PF, with `clientAliases: {"id-jag-playground": "id-jag-playground"}` — the
ID-JAG's `client_id` claim must map to the redeeming client, and PF stamps
`id-jag-playground` into the token via the SP connection's `client_id` TEXT
mapping. The static file replaces the playground's registry endpoint: the SE
playground deployment is mock/scaled-0, and a registry the resource-as cannot
reach would leave it trusting nobody.

A secret holds the shared client secret:

```
kubectl -n <k8s-namespace> create secret generic id-jag-resource-as-secrets \
  --from-literal=RESOURCE_AS_CLIENT_SECRET="$(openssl rand -hex 24)"
```

The same value must be in the local `.env` as `RESOURCE_AS_CLIENT_SECRET` (and
`SE_RESOURCE_AS_CLIENT_SECRET`, which `scripts/dev-live.sh` re-exports). Leg 2's
client authentication is a plain secret comparison; a mismatch on either side is
the cryptic `invalid_client` at leg 2. This cost two debugging rounds.

### The PingFederate side (SE PF, done once via the admin API)

- **client `id-jag-kit-acme`** — grants AUTHORIZATION_CODE, REFRESH_TOKEN,
  TOKEN_EXCHANGE; `allowAuthenticationApiInit: true` (L3 in README's Sign-in
  limits: without it pi.flow cannot be started server-side); redirect URIs
  include `http://localhost:4720/api/id-jag-playground/issuer/callback`;
  `restrictedScopes` `openid profile email offline_access` (the scopes had to be
  added to the auth server settings first — a client cannot hold an undefined
  scope); `oidcPolicy.policyGroup` → the OIDC policy below.
- **OIDC policy `idJagAcmeOidc`** — ID token mapping. This PF had **no default
  OpenID Connect policy at all**, which made every pi.flow completion answer
  `500 … IllegalStateException: No default OpenID Connect Policy found`. The
  policy maps `sub` from the token's `username` extended attribute (the ATM's
  contract has no `sub` core attribute — the local kit's ATM did, this one does
  not), and the email/profile/groups claims are NO_MAPPING.
- **access token mapping `default|acmeAtm`** — an ATM with no token mapping
  fails the same 500 path (`Default Access Token mapping not configured for the
  selected token manager`). Cloned from the privilege mapping, reduced to
  `username ← USER_KEY`.
- **SP connection `idJagToSeResourceAs`** — the ID-JAG contract on PF's side:
  `entityId` = the resource-as issuer (PF validates the exchange's `audience`
  parameter against this), `resourceUris` = `["https://<ras-host>.ping-demo.example.invalid/mcp"]`
  (PF validates the `resource` parameter against this),
  `idJagEnabled: true`, `client_id` TEXT = `id-jag-playground` (stamped into the
  ID-JAG), processor policy `acmeIdJagPolicy` (the refresh-token exchange).
  Cloned from the existing `acmeToResourceAs` connection rather than mutating it
  — that one serves the pre-existing acme leg.

The diagnostic loop worth remembering: the `500 UNEXPECTED_ERROR` from PF's
Authentication API carries **no detail**; the real cause is only in the engine
container log (`kubectl logs pingfederate-0`, `grep "Caused by"`). Three
separate misconfigurations produced the same opaque 500.

## Part 3 — the AWS side (owner-run; written, not yet executed)

Everything below is prepared and checked in. The AgentCore runtime deploy needs
privileged IAM, which per the bedrock-agentcore-pingone skill is always a human
action.

### What AgentCore Runtime actually is

A managed container runtime for agents. You give it a zip (or ECR image), an
execution role, and an **authorizer**; AWS runs it, gives it an invoke endpoint,
and — the part that matters for this leg — validates **inbound JWTs against the
issuer you name** before any of your code runs. The whoami tool in
`agentcore-runtime/agent.py` never sees an unverified token.

### The three artifacts

1. **The code** — `agentcore-runtime/agent.py`: a `BedrockAgentCoreApp` with one
   `@app.entrypoint` handler that decodes the bearer token it was invoked with
   and answers with the claims (`sub`, `aud`, `scope`, `client_id`, `act`). It
   verifies nothing itself — the runtime's front door did. Packaging is CodeZip:
   a zip with the handler at `agent.py` plus vendored dependencies
   (`bedrock_agentcore` SDK 1.9.0 and friends), uploaded to S3. The prior
   runtimes in this account use the same shape (`PYTHON_3_12`,
   `entryPoint: ["agent.py"]`).
2. **The execution role** — what the runtime's code may do. Two files:
   - `deploy/agentcore/trust-policy.json`: trusts
     `bedrock-agentcore.amazonaws.com` scoped by `aws:SourceAccount` and
     `aws:SourceArn` (the role-not-user, principal-per-service pattern).
   - `deploy/agentcore/runtime-policy.json`: `s3:GetObject` on the code prefix
     only, and CloudWatch log writes. Nothing else — this runtime holds no
     secrets and calls nothing.
3. **The deploy script** — `deploy/agentcore/deploy-runtime.sh`: uploads the zip
   to `s3://agentcore-code-265988230536-us-east-2/idjag_whoami/code.zip`, then
   creates or updates the runtime. The authorizer config is the interesting
   part:

   ```
   "authorizerConfiguration": {
     "customJWTAuthorizer": {
       "discoveryUrl": "https://<ras-host>.ping-demo.example.invalid/resource-as/.well-known/oauth-authorization-server",
       "allowedClients": ["id-jag-playground"]
     }
   }
   ```

   AWS fetches that discovery document at configure time and the JWKS at verify
   time. `allowedClients` matches the token's `client_id` claim. The script also
   sets `requestHeaderAllowlist: ["Authorization"]` (AgentCore strips
   `x-amzn-*` and unlisted headers before the handler runs), and always includes
   `networkConfiguration` — `update_agent_runtime` rejects the call without it
   even when nothing changed.

### The human steps (in your own terminal, with admin credentials)

```
aws iam create-role --role-name AmazonBedrockAgentCore-idjag_whoami \
  --assume-role-policy-document file://deploy/agentcore/trust-policy.json
aws iam put-role-policy --role-name AmazonBedrockAgentCore-idjag_whoami \
  --policy-name runtime --policy-document file://deploy/agentcore/runtime-policy.json
```

Then (any profile that can deploy):

```
./deploy/agentcore/deploy-runtime.sh          # creates or updates the runtime
```

The name is `idjag_whoami` — runtime names must match
`[a-zA-Z][a-zA-Z0-9_]{0,47}`: no hyphens. Region is hardcoded `us-east-2`
(shell-exported `AWS_REGION` has overridden `.env` values before and made a
correct deploy look like an IAM failure).

### After it deploys: wiring the runtime hop (now wired)

`server/src/agentcoreRedeem.js`'s `liveRun()` now invokes the runtime when
`AGENTCORE_RUNTIME_URL` is set in `.env` (plus `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN`, allowed to invoke the runtime —
nothing more). The invoke is server-side SigV4 (aws4fetch, service
`bedrock-agentcore`): OAuth inbound auth cannot be driven by a bearer-only
fetch, and the ID-JAG must never reach the browser — the request is signed
here, the answer's decoded view is all that leaves the server. `scripts/dev-live.sh`
re-materializes the AWS session credentials from the profile on every start:
they expire, and expired ones answer `403 The security token included in the
request is invalid` — which looks like IAM misconfiguration but is only a stale
login (`aws login --profile agent-toolkit` fixes it). A first attempt with empty
credential variables answers `400`, both collected here so nobody re-derives
them.

The whoami answer's decoded claims become the leg's proof, the same way legs 1
and 2 are judged: by what the tokens say, not by a 200.

### Where the invoke stands (2026-11-05)

Three findings from driving the invoke against the READY runtime:

1. **The invoke URL must carry the full runtime ARN** (URL-encoded) —
   `/runtimes/<runtime-id>/invocations` answers `400 accountID is required when
   agentRuntimeArn is provided as agentId instead of agentRuntimeArn`.
2. **SigV4 and the JWT authorizer are mutually exclusive** — sending both
   answers `403 Authorization method mismatch`; with a non-JWT bearer AgentCore
   falls back to SigV4 and reports the missing SigV4 parameters. A JWT-authed
   runtime takes a plain `Authorization: Bearer <jwt>`.
3. **`403 OAuth authorization failed: Failed to parse token` / `Invalid
   Bearer token`** — resolved by isolating AgentCore from PingFederate's
   multi-key JWKS. Isolation tests (synthetic tokens with controlled headers)
   showed: unknown `kid` answers `Invalid inbound token` (JWKS fetch works),
   an `x5t`-matching-but-wrongly-signed token answers `Invalid Bearer token`
   (the same error the real ID-JAG got) — PF's JWKS publishes the signing key
   three times, and x5t-matching selects ambiguously. Fix: a curated root-ful
   discovery + single-key JWKS served from the ai-demo host
   (`deploy/se/jwks-curator.yaml`), with the runtime validating the leg-2
   `at+jwt` (iss = the resource-as, one RS256 key). The invoke sends the
   redeemed access token as a plain bearer — SigV4 and the JWT authorizer are
   mutually exclusive.

### Gotchas that already shaped this repo's artifacts

| Symptom | Cause | Fix |
| --- | --- | --- |
| `ErrImagePull: no match for platform` | SE nodes are arm64; the image was amd64 | build `--platform linux/arm64` |
| `CreateContainerConfigError: runAsNonRoot and image has non-numeric user` | Dockerfile `USER node` is a name | drop `runAsNonRoot: true` (the image already runs non-root) |
| `invalid_client` at leg 2 | the two sides held different `RESOURCE_AS_CLIENT_SECRET`s | one shared value in the k8s secret and local `.env` |
| opaque PF `500` on pi.flow completion | no default OIDC policy / no ATM token mapping | engine log says which; both fixed by API |
| `ParamValidation: list-agent-runtimes invalid choice` | deploy vs control plane split | `aws bedrock-agentcore-control …` for create/update, `aws bedrock-agentcore …` for invoke |

## Part 4 — the gate audit (2026-11-05): every playground mode proven or blocked

| Mode / feature | Verdict | Notes |
| --- | --- | --- |
| `pf-as` | ✅ live | sign-in, ID-JAG, redeem, MCP call, 4/4 negative tests, revoke proven |
| `aws-agentcore` | ✅ live | legs 1–2 + the real runtime; 10/10 mock scenarios |
| `gateway-redeem` | ✅ mock | 10/10 scenarios |
| SAML issue | ✅ live | `configure-saml.js --sp=<SP id>` against the SE PF; signed assertion → ID-JAG → redeem → MCP call. The OIDC policy needed `email` (TEXT) and `email_verified` (TEXT true) or app sign-in is refused |
| `byo` | ✅ live | desktop clients on the SE PF: mcpc signs in (auth code + PKCE) → ID token → ID-JAG (`client_id=id-jag-mcpc`) → redeemed as `id-jag-desktop` (CLIENTS_FILE secret on the deployment) → MCP call |
| `pf-pf` | ⛔ owner | needs the Acme three-key settings block; `setup-pf-pf.mjs` refuses a loopback Acme by design |
| xaa.dev | ⛔ owner | needs an xaa.dev registration (4 client secrets) |

### Hard-won facts from the byo/SAML work

- PingFederate 13.1's ID-JAG requested token type is
  `urn:ietf:params:oauth:token-type:id-jag` — `…id-jag+jwt` is the token's
  `typ` header, not the exchange URI. The wrong URI answers the misleading
  `Unable to find ATM, token generation policy instance or SP connection`.
- `acmeAtm` (Reference ATM) enforces its allowed-clients list at
  *authorize* time: a client missing from the list answers
  `The global default access token manager is not available for the selected
  client and authentication context` — for every client, even ones whose
  default ATM is that manager. The desktop script's admit step must keep the
  pre-existing clients.
- The SE resource-as reads clients from `CLIENTS_FILE`
  (k8s secret `id-jag-resource-as-clients`, mounted at `/config/clients`);
  secrets from a secret volume do not hot-reload — `rollout restart` after
  changing one.
- `pingfederate/configure-desktop-clients.js` now takes `--sp`, `--atm`,
  `--oidc`, `--processor`, `--policy`, `--selector`, `--skip-selector` so it
  can target a PingFederate that lacks the kit's default object names.
- The k8s `pingfederate-admin` port-forward dies often; kill the stale
  listener before re-establishing.
## Part 5 — pf-pf proven with a stand-in Acme PingFederate (2026-11-05)

A second PingFederate (`pingfederate-acme` StatefulSet in `ping-devops-cmuir`,
public at `https://cmuir-pf-acme2.ping-devops.com`) played Acme; the SE
PingFederate (`cmuir-pf-acme.ping-devops.com`) redeemed. The chain: sign in at
the stand-in as `acme-user` → Acme issues an ID-JAG addressed to our PF
(`client_id=id-jag-redeemer`) → our PF redeems it (JWT bearer, EXTENSION grant,
client `id-jag-redeemer`) → the MCP call returns the tools.

### Booting a fresh PingFederate stand-in (what bit)

| Symptom | Cause | Fix |
| --- | --- | --- |
| `CONTAINER FAILURE: 06-copy-product-bits.sh` | the PVC needs group 9031 | `securityContext: { fsGroup: 9031, runAsUser: 9031 }` |
| `license_agreement_not_accepted` forever | the license must be in the PERSISTENT `/opt/out` at first boot | mount `pingfederate-license` at `/opt/in/.../pingfederate.lic` and recreate the PVC so first boot sees it |
| admin 401 after accepting the agreement manually | the boot hook creates the admin user only when ITS OWN accept returns 200; a manual accept makes the next boot skip it | recreate the PVC and let the hook drive; or POST `/administrativeAccounts` unauthenticated right after accepting |
| public URL hangs while the engine is fine in-cluster | the ingress must say the backend speaks TLS | `nginx.ingress.kubernetes.io/backend-protocol: HTTPS` (+ force-ssl-redirect, proxy-buffer-size 16k) |

### Config gaps the kit scripts don't set for a remote redeemer

- `configure-acme-idp.js` / `configure-acme-signin.js` /
  `configure-pf-redeemer.js` now accept `PF_ADMIN_PASSWORD` (or
  `--admin-secret=<secret name>`), `--policy=`, `--key=`, `--allow-remote`,
  `--no-restart` — so they can drive a stand-in whose secret name and object
  ids differ from the local defaults.
- On the stand-in, `configure-acme-signin.js` must target the kit policy the
  idp script created (`--policy=acmeIdJagPolicy`); the hardcoded
  `idJagKitPolicy` does not exist there.
- The redeemer ATM (`idJagKitRedeemerAtm`) needs `Type Header Value=at+jwt`
  and `Audience Claim Value=<MCP resource>` — without them the MCP server
  refuses the token (`typ is "(none)"` / `aud undefined`).
- Acme's `acmeToPingFed` connection must list the MCP resource in
  `resourceUris`, or the ID-JAG exchange answers `invalid_target`.
- PingFederate caches the issuer's JWKS: after creating or changing the IdP
  connection, restart the redeemer PF (pod delete) before the first redeem.

### Recurring failure modes hit on 2026-11-06 (demouser work)

- The `acmeAtm` allowed-clients list regresses: any later PUT built from a
  stale copy rewrites it. Re-add the client(s) via the admin API and prefer
  read-modify-write against a FRESH GET every time.
- The PingFederate ADMIN account locked (`account_locked`) and then
  `invalid_credentials` — the lock persists in the data store across pod
  restarts, and the boot hook skips admin creation because the license
  agreement is already accepted. Recovery: set
  `license-agreement-accepted=false` in
  `data/config-store/com.pingidentity.page.Login.xml`, move away
  `data/pingfederate-admin-user.xml`, set
  `CREATE_INITIAL_ADMIN_USER=true` on the container, restart — the hook
  accepts the agreement and recreates the admin with
  `PING_IDENTITY_PASSWORD`; accept any remaining agreement prompt after boot.
- Deleting and recreating an OAuth client keeps its config but any client in
  an ATM's restricted list must be re-admitted.

### Demo user and the mailinator domain exception (2026-11-06)

`demouser@mailinator.com` / `DemoUser!2026` signs in everywhere (app, SE PF,
stand-in Acme). Two deliberate changes make it work:

- the validator rows use **email-shaped usernames** and the OIDC policy maps
  `email` ← `TOKEN.username` (the old static `TEXT` mapping gave every user
  the same email);
- `.env` adds `mailinator.com` to `ALLOWED_EMAIL_DOMAINS` — a visible
  weakening of the "only Ping identities" gate; mention it in the talk track,
  and remove the domain when the demo user no longer needs a public inbox.
  Nothing in the kit sends mail; the inbox is only relevant if a flow ever
  does (IdenX's verification code is demo-mode, no email).

### Resource AS URLs on the SE host (2026-11-06)

The SE ingress only routes `/resource-as/...` on `id-jag.ai-demo.ping-devops.com`
to the resource AS. Any other path on that host (bare `/jwks`,
`/.well-known/oauth-authorization-server`) hits the default backend → nginx
503. That looks like an attack block but is just "no route". The real URLs
(the issuer lives under a path, RFC 8414 style):

- metadata: `https://id-jag.ai-demo.ping-devops.com/resource-as/.well-known/oauth-authorization-server`
- JWKS: `https://id-jag.ai-demo.ping-devops.com/resource-as/jwks`
- events page: `https://id-jag.ai-demo.ping-devops.com/resource-as/`

The playground's `/as-events` bug fixed on 2026-11-06 was exactly this trap:
deriving the events URL from the token endpoint's ORIGIN dropped the
`/resource-as` path.

### Dual-homing: the kit serves through the family lab-proxy too (2026-11-06)

The kit answers on BOTH doors:

- direct: `http://localhost:4720` (what the real-client guides and dev-live use)
- lab-proxy: `https://local.ping-devops.com:8443/id-jag-kit/` (family standard, owner rule)

Mechanics (server/src/requestOrigin.js): a request through the proxy carries
`X-Forwarded-Host`; the server then uses `PROXY_ORIGIN` (bare origin) for
CSRF/same-origin checks and `PROXY_ORIGIN`+`PROXY_BASE` (`/id-jag-kit`) for
every OAuth redirect URI. `.env` sets both plus
`ALLOWED_HOSTS=id-jag-kit.local.ping-devops.com,local.ping-devops.com`.

PingFederate clients must register BOTH redirect URIs (localhost and the
proxy path) for `id-jag-kit-acme` and any app-level client:

- `https://local.ping-devops.com:8443/id-jag-kit/api/id-jag-playground/issuer/callback`
- `https://local.ping-devops.com:8443/id-jag-kit/auth/callback`

The lab-proxy entry (`shared/lab-proxy/nginx.conf` in the meta-repo) maps
`/id-jag-kit/` to `host.docker.internal:4720` with the forwarded headers and
sets the `lab` cookie, so the SPA's absolute `/api` and `/assets` requests
keep landing on this kit.

### PingOne as the user directory (2026-11-06, owner decision: ALL use cases)

Both kit PingFederates now validate passwords against the banking PingOne
environment (`01d89b06…`) through the PingOne (P14C) data store + PCV, the
same connector family AI-DEMO2's other PF instances use. The local
`acmeUsers`/`idjagpcv` rows are retired (still configured, unused).

Pieces, all scriptable:

- PingOne gateway `8fd16217…` ("AI Demo PF Directory Connection", roles
  Identity Data Admin + Environment Admin) — one credential per PF:
  `POST /v1/environments/{env}/gateways/{id}/credentials` →
  `POST /pf-admin-api/v1/pingOneConnections {name, credential}`
  (connection names cannot contain hyphens).
- Data store: `POST /dataStores` with `type: CUSTOM`, plugin
  `…datastore.p14c.PingOneForCustomersDataStore`, field
  `PingOne Environment = <connectionId>|<envId>`.
- PCV: `POST /passwordCredentialValidators` with plugin
  `…pcvs.p14c.PingOneForCustomersPCV`, field `PingOne For Customers
  Datastore = <dsId>`, Username Attribute `username`.
- Adapters: swap the HTML form adapters' "Credential Validators" table row
  to the new PCV (`idjagform`, `idJagKitAcmeForm` on both PFs).

Gotchas that cost an hour:

- Creating a user with an inline `password` in the POST body does NOT set
  it. Passwords must be set explicitly:
  `PUT /v1/environments/{env}/users/{id}/password`,
  Content-Type `application/vnd.pingidentity.password.set+json`, body
  `{"value":"…"}`. The PCV then answers PingOne's 400 `NO_PASSWORD` as a
  credential failure — enable DEBUG on `com.pingidentity.plugins` in the
  engine's log4j2.xml to see the wire call.
- POST /applications needs `protocol` and `enabled` set or validation
  fails; minting a secret for another app needs org-level grants the env
  workers lack (not needed here — the connection credential carries the
  authority).

Kit users live in the "Sample Users" population: `demouser@pingidentity.com`,
`acme-user@pingidentity.com` (same password as before, kept for demo
continuity).

### Standalone-lab audit after the PingOne directory switch (2026-11-06)

Swept all 62 standalone labs for PingFederate user sign-ins. Only three hit
the kit's PFs, and only one is exposed:

- **worker-demo-LAB** — its real-sign-in client is `privilege-demo-signin`
  on the SE PF (`http://localhost:6700/callback`), which rides `idjagform`
  → now the PingOne PCV. Its compose form runs MODE=local with no PF env
  (offline runtime, unaffected); the exposure is a local `npm run dev`
  with `.env` pointing at `cmuir-pf-acme`. Its personas
  (`eli,gwen,ben,cora,priya`) now exist as
  `<persona>@pingidentity.com` / `DemoUser!2026` in the Sample Users
  population, so any persona can sign in. `eli` verified COMPLETED via
  the PCV.
- privilege-demo-LAB — runs MODE=mock (in-process sign-in); unaffected.
- cimd-LAB, ping-services-stub-LAB — no real-PF user sign-in (stub/local
  PF); unaffected.

Rule of thumb going forward: anyone signing into `cmuir-pf-acme` needs a
PingOne user in env `01d89b06…` — the local validator rows are no longer
consulted.

### JWKS freshness after every resource-as deploy (2026-11-06)

The resource-as regenerates its signing key on re-deploy. Its JWKS is served
in three places that MUST agree:

- `https://id-jag.ai-demo.ping-devops.com/resource-as/jwks` (the AS itself)
- `https://ai-demo.ping-devops.com/jwks.json` (root path, for AgentCore's
  customJWTAuthorizer — served by the `id-jag-jwks-curator` deployment from
  the ConfigMap of the same name)
- the `jwks_uri` inside the curator's `discovery.json` (root, path-ful
  discovery is rejected by AgentCore)

After ANY resource-as deploy, refresh the curator ConfigMap from the live
endpoints (discovery with `jwks_uri` rewritten to the root path, JWKS
verbatim) and `rollout restart deploy/id-jag-jwks-curator`. A stale curator
serves the old kid and AgentCore rejects every new access token. Verify by
comparing the `kid` of a freshly redeemed access token against
`/jwks.json`.

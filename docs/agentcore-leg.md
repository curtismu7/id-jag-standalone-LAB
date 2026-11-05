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

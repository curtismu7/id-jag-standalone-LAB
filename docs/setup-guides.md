# Setup guides

The same guides are in the app at `/guides`. They set up each side of an ID-JAG flow; then you register
the IdP on the **Trusted IdPs** page (`/trusted-idps`), where an admin approves it.

- [Sign-in for this app (go live)](#sign-in-for-this-app-go-live)
- [PingFederate as the ID-JAG issuer](#pingfederate-as-the-id-jag-issuer)
- [SAML: assertion to ID-JAG](#saml-assertion-to-id-jag)
- [PingFederate as the redeemer](#pingfederate-as-the-redeemer)
- [Okta Cross App Access](#okta-cross-app-access)
- [Any other IdP: the ID-JAG checklist](#any-other-idp-the-id-jag-checklist)
- [Use xaa.dev (IdenX) as a free outside IdP](#use-xaadev-idenx-as-a-free-outside-idp)
- [Use mcpc or VS Code as the client](#use-mcpc-or-vs-code-as-the-client)

## Sign-in for this app (go live)

Users sign in at PingFederate (`PF_URL`), which federates to a **dedicated PingOne environment** created only
for this kit (nothing is shared with any other demo's PingOne; only the PingFederate servers are shared).
The app is the hard gate: whatever PingOne and PingFederate allow, it refuses any ID token whose email is not
exactly `@pingidentity.com` / `@pingone.com` (`ALLOWED_EMAIL_DOMAINS`), has a `+` in the local part, or whose
`email_verified` is not the JSON boolean `true`. PingOne self-registration cannot itself restrict sign-ups by
email domain or plus-addressing without an extra flow (for example DaVinci), so those rules live in the app.

Steps 1 to 5 are automated: `tools/provision-pingone-signin.js` (PingOne, with a worker app in the new environment) then
`pingfederate/configure-signin.js` (PingFederate). The steps below say what they create.

> **Sign-in without a redirect (default since 2026-10-18).** PingFederate's Authentication API cannot run the
> PingOne connection, so the app's sign-in modal (a pi.flow) needs PingFederate to sign the kit's users in itself.
> After `configure-signin.js`, run `node pingfederate/configure-local-signin.js --ns=<namespace>
> --users=a@pingidentity.com,b@pingone.com`: it gives the kit's client its own credential validator and HTML form
> adapter holding only those users, and lets the client start a pi.flow. Passwords are generated into
> `deploy/local/kit-users.json` (never printed). The dedicated PingOne environment below is then used only if you
> run it with `--mode=pingone` (the PingOne hop returns, which the modal cannot drive: see the README section Sign-in limits). The app's email rules still apply to the ID token.

### 1. PingOne: a new environment

1. In the PingOne console, **Environments → Add environment**. Name it (for example `id-jag-kit`), pick the
   type (Sandbox for trials, Production for SLA), the region (permanent) and the license. No extra services
   are needed: SSO is built in.
2. **Directory → Populations**: create (or rename the default to) `ID-JAG Kit users` and make it the default
   population, so self-registered users land there.
3. **Directory → Groups**: create `id-jag-admins` and add the kit's admins (after they register). This group
   name is what `ADMIN_CLAIM_VALUE` matches.

### 2. PingOne: self-registration with email verification

1. **Authentication → Policies**: create a sign-on policy for the kit with a **Login** action, turn on
   **Enable Registration**, and select the `ID-JAG Kit users` population.
2. Require email verification for new accounts, so a user proves the address before PingOne reports
   `email_verified: true`. Unverified users are refused by the app even if they reach it.
3. Optionally restrict the population's password policy and branding; nothing else is needed.

### 3. PingOne: an OIDC application for PingFederate

1. **Applications → Add application → OIDC Web App**, named `PingFederate (ID-JAG Kit)`.
2. Grant type **Authorization Code**; token endpoint authentication **Client Secret Basic** (or Post).
3. Redirect URI: the callback PingFederate shows on its OIDC IdP connection (step 4); trailing slashes matter.
4. Scopes `openid profile email` (the `email` scope carries `email` and `email_verified`).
5. **Attribute mappings**: keep `email`, `email_verified`, `name`; add `groups` mapped to the user's
   **Group Names** (`memberOfGroupNames`), so `id-jag-admins` membership travels in the ID token.
6. **Policies**: assign the sign-on policy from step 2. Turn the application on. Note its client id, secret
   and issuer (`https://auth.pingone.<region>/<environment id>/as`).

### 4. PingFederate: federate to PingOne

1. **IdP connection** to the PingOne application using the OpenID Connect protocol: issuer = the PingOne
   issuer above, the PingOne client id and secret, scopes `openid profile email`. Copy the redirect URI it
   shows into the PingOne application (step 3.3). Its attribute contract: `email`, `email_verified`, `name`, `groups`.
2. **Authentication policy** for this app's client: send users to that IdP connection, and map `email`,
   `email_verified`, `name` and `groups` into the policy contract that feeds the access token manager and
   the OIDC policy below.

### 5. PingFederate: one OAuth client for the kit

One client signs users in to the kit **and** runs the pf-as token exchange, so a single sign-in serves both
(the kit stores that sign-in's refresh token as the pf-as issuer session). Use it as `PF_EXCHANGE_CLIENT_ID`;
the kit's `OIDC_*` settings default to the `PF_*` ones.

- Grant types: authorization code, refresh token, token exchange (ID-JAG). PKCE required (S256).
- Redirect URIs, exactly: `${APP_ORIGIN}/auth/callback` (app sign-in) and
  `${APP_ORIGIN}/api/id-jag-playground/issuer/callback` (the playground's own issuer sign-in).
- Client authentication: secret (`PF_EXCHANGE_CLIENT_SECRET`), or private_key_jwt (`OIDC_PRIVATE_KEY_JWT`
  plus the matching public key or JWKS on the client).
- Scopes `openid profile email offline_access` allowed; refresh tokens issued.
- **OIDC policy**: the ID token carries `email`, `email_verified` (a JSON boolean, not the string `"true"`),
  `name` and `groups` (multi-valued).

### 6. The kit's settings

`PF_URL` (exactly PingFederate's issuer), `PF_EXCHANGE_CLIENT_ID` / `PF_EXCHANGE_CLIENT_SECRET`, `SESSION_SECRET`,
and `ADMIN_CLAIM` / `ADMIN_CLAIM_VALUE` (defaults `groups` / `demo-admins`; `.env.example` sets `id-jag-admins`) or `ADMIN_EMAILS`. Set `OIDC_ISSUER`
/ `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` only to sign in with a different PingFederate or client (then the
sign-in does not double as the pf-as issuer session). Set `RESOURCE_AS_CLIENTS_FILE` to the resource AS's
`CLIENTS_FILE` (shared volume) so approvals can provision clients.

## PingFederate as the ID-JAG issuer

On your own machine `npm run setup -- --mode=pf-local` does all of this (steps 1 to 3, with `idjagkit-signing`, `idJagKitKeyPublisher`,
`idJagKitPolicy` and `idJagKitResourceAsSp`) and checks the result; see the README, "PingFederate for ID-JAG". Do it by hand
for any other PingFederate:

PingFederate 13.1 issues ID-JAGs through token exchange. The user signs in to an OAuth client; that client
exchanges the user's refresh token (or ID token) for an ID-JAG addressed to our resource AS.

### 1. Signing key, published

1. Pick (or create) the RSA signing certificate PingFederate will sign ID-JAGs with.
2. Create a JWT access token manager that signs with that certificate and turn on **Publish Keys to the
   PingFederate JWKS Endpoint**. Without it the key never appears in `/pf/JWKS` and no redeemer can verify the ID-JAG.
3. Keep the JWKS to a **single static key**. PingFederate ID-JAGs carry `x5t` and no `kid`, and a PingFederate
   redeemer cannot pick a key by `x5t`. Test this IdP warns when more than one distinct RSA key is published.

### 2. Token processor and policy

1. Create a token exchange processor policy for the subject token type your client sends (refresh token or ID
   token) and map its subject (the user) into the policy contract.
2. Give the exchange client the token exchange grant, plus authorization code and refresh token for the user's sign-in.

### 3. ID-JAG SP connection

1. Create an SP connection of type OAuth token exchange with ID-JAG enabled. Its partner is our resource AS:
   the audience is our resource AS issuer, exactly.
2. Map `client_id` to the client id you register on Trusted IdPs as "client_id your IdP writes in the ID-JAG"
   (simplest: the `idp-<id>` client we issue you).
3. Map `scope` to the MCP scopes the user may use (for the sample MCP server, `read mcp:invoke`).
4. Set the ID-JAG lifetime to **5 minutes** (300 s).

### 4. Register it here

- Product PingFederate; issuer = the base URL exactly as in `iss`; JWKS = `https://<your PingFederate>/pf/JWKS`.
- Run Test this IdP: expect one distinct RSA key carrying `x5t`.
- After approval, fetch your client secret once from My IdPs and give it to the agent that redeems.

## SAML: assertion to ID-JAG

PingFederate 13.1.3 accepts a signed SAML 2.0 assertion as the `subject_token` of a token exchange and returns an
ID-JAG in **one** exchange (verified 2026-10-19, `tools/saml-spike`). The docs list only ID tokens and refresh tokens as
ID-JAG sources; the SAML 2.0 token processor works anyway. Here this app plays a tiny SAML identity provider: after
the normal app sign-in it signs an assertion naming you (NameID = your email), and PingFederate trusts the signer's
certificate. No second sign-in and no real SAML IdP. The subject is always the app session's user.

```
POST /as/token.oauth2   (Basic auth: client id-jag-kit-saml, a client allowed only the token-exchange grant)
  grant_type=urn:ietf:params:oauth:grant-type:token-exchange
  subject_token=<base64url of the signed assertion>   subject_token_type=urn:ietf:params:oauth:token-type:saml2
  requested_token_type=urn:ietf:params:oauth:token-type:id-jag
  audience=<resource AS issuer>   resource=<MCP resource>   scope=…
```

Run these once, after [PingFederate as the ID-JAG issuer](#pingfederate-as-the-id-jag-issuer) and
`pingfederate/configure-desktop-clients.js` (it creates the SP connection `idJagKitResourceAsSp` this adds to):

```
kubectl -n <ns> port-forward svc/pingfederate-admin 19999:9999 &
node pingfederate/configure-saml.js --ns=<ns>
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.saml.yml up -d
```

The script is idempotent (it prints `ok`, `keep` or `FAIL` per object) and creates, ids prefixed `idJagKit`:

1. The signer key pair in `deploy/local/saml/` (gitignored; the directory is mode 700, the key 600): a throwaway
   self-signed RSA-2048 certificate, valid 365 days. Made only if absent.
2. A **trusted CA** `idjagkitsamlca` from that certificate. Trust comes from the CA store, not from an IdP connection,
   and the id must be lower case.
3. A **SAML 2.0 token processor** `idJagKitSaml` whose only setting is the Audience the assertion must carry
   (`idJagKitSamlAud`), and a **token exchange processor policy** `idJagKitSamlPolicy` for `…token-type:saml2` (subject
   from the processor's `SAML_SUBJECT`; `client_id` = `PF_EXCHANGE_CLIENT_ID`, default `id-jag-kit`, so the resource AS's
   existing client-alias binding accepts it, as for the refresh-token path).
4. The OAuth client `id-jag-kit-saml`: confidential, token-exchange grant only, running that policy. Its secret is
   written to `.env` as `PF_SAML_CLIENT_SECRET` and never printed.
5. One processor policy mapping for the policy on the SP connection `idJagKitResourceAsSp`, with the same `scope` its
   other mappings use. Nothing else on that connection changes.

`node pingfederate/configure-saml.js --ns=<ns> --remove` deletes the mapping, client, policy, processor and CA, in that
order. It leaves `deploy/local/saml/` and the `.env` secret alone.

Then pick **SAML** on the playground in `pf-as` mode. Without the overlay (npm runs), set `SAML_SIGNING_KEY_FILE` and
`SAML_SIGNING_CERT_FILE` to the two files in `deploy/local/saml/`. `/api/id-jag-playground/config` reports
`saml.available` and, when it is false, `saml.reason`; the pre-flight for the issue step adds `saml-configured` and
`saml-client` checks. Another PingFederate can trust the same signer: fetch its certificate from
`GET /api/id-jag-playground/saml/cert`.

- The assertion is backdated 60 s (NotBefore and IssueInstant) so a PingFederate clock a few seconds behind does not
  read it as not yet valid, and expires after 300 s.
- PingFederate refuses, each with its own error: a tampered subject (`INVALID signature`), the wrong audience, an
  expired assertion (`Time condition`), a signer it does not trust (`Certificate path validation failed`) and an
  unsigned assertion (`NOT_PRESENT signature`).
- There is no refresh token behind a SAML ID-JAG, so the revoke step does not apply (the server answers 409
  `no_refresh_token`).
- A SAML run needs `PF_EXCHANGE_CLIENT_ID` (the policy's `client_id`) but not `PF_EXCHANGE_CLIENT_SECRET`.

## PingFederate as the redeemer

Our PingFederate can redeem ID-JAGs another IdP issued (the "Our PingFederate" target). An IdP must not redeem
its own ID-JAGs, so the issuer is always a different server.

1. **IdP connection** per trusted issuer, with the issuer as entity id and its JWKS URL.
   `pingfederate/sync-id-jag-trusted-idps.js` creates these from the approved registry entries.
2. **OAuth client** for the redeeming agent (the "Our client at PingFederate" value) with the **EXTENSION**
   grant type for the JWT bearer grant, and client authentication.
3. **Access token manager resource URIs**: list the MCP resource the agent sends as `resource` in an access
   token manager's selection settings, or PingFederate answers `invalid_target`.
4. **JWKS cache**: PingFederate caches the issuer's JWKS and never refetches it for an ID-JAG without a `kid`.
   After the issuer changes keys, restart PingFederate.
5. **Single-key JWKS** at the issuer, for the `x5t` reason above.

## Acme PingFederate → PingFederate

The `pf-pf` mode: an outside company's PingFederate ("Acme") issues the ID-JAG, and our PingFederate redeems it.
Acme is a second PingFederate that other deployments (the demo) also use, so the kit only ADDS `idJagKit` objects there.

1. Acme must already have the user store and exchange policy `configure-acme-idp.js` creates (`acmeUsers`, `acmeIdJagPolicy`) and
   an SP connection that issues ID-JAGs to `PF_URL` (the demo's `acmeToPingFed` does). That connection fixes the resource
   (`PF_RESOURCE`) and the client_id the ID-JAG carries, which must be the redeeming client at `PF_URL`.
2. `kubectl -n <acme ns> port-forward svc/pingfederate-admin 29999:9999 &` then
   `node pingfederate/configure-acme-signin.js --ns=<acme ns>`: an HTML form adapter on `acmeUsers`, the adapter mapping, Acme's
   default authentication source (only if none is set), IdP authentication policies and the Authentication API (pi.flow only),
   and the client `id-jag-kit-acme` (secret written to `.env`, never printed). `--remove` undoes the objects.
3. Put the redeemer client in `.env`: `PF_REDEEMER_CLIENT_ID` / `_SECRET` (the client the ID-JAG names) and `PF_RESOURCE`.
4. Sign in as an Acme user (the demo's `acme-user`). Acme defines no OIDC scopes, so the kit asks it for `offline_access` only.
   `mcp-sample` trusts `resource-as` only, so in this mode the call step runs and is refused by design.

## Okta Cross App Access

1. Issuer = your Okta **org authorization server**, `https://<org>.okta.com` (not a custom authorization
   server). Discovery finds its JWKS.
2. In Okta, set up Cross App Access: the requesting app (your agent) and a resource app connection for our
   resource AS, whose audience is our resource AS issuer.
3. The requesting app authenticates to Okta with **private_key_jwt** and exchanges the user's ID token or
   refresh token at `/oauth2/v1/token`.
4. `resource` must match what Okta has configured exactly, or Okta answers `invalid_target`.
5. Okta ID-JAGs live **300 s**. Register the requesting app's client id as "client_id your IdP writes in the ID-JAG".

## Any other IdP: the ID-JAG checklist

Our resource AS checks every item; one miss and it refuses with `invalid_grant`, `invalid_scope` or `invalid_target`.

- Header `typ` = `oauth-id-jag+jwt`; asymmetric `alg` (RS256); a `kid` or `x5t` that matches one key in your JWKS.
- `iss` = your issuer, byte for byte as registered.
- `sub` = the user.
- `aud` = our resource AS issuer, a **single** value.
- `client_id` = exactly the value you registered as "client_id your IdP writes in the ID-JAG" (simplest: the id we
  issued you, `idp-<id>`). Binding is strict: any other value is refused, even our own client id.
- `jti` unique per ID-JAG (each one redeems once); `iat` = now; `exp` no more than 300 s later.
- `resource` = the MCP server URL; `scope` = the MCP scopes granted (for example `read mcp:invoke`).

Redeem: `POST <resource AS>/token` with `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` and
`assertion=<the ID-JAG>`, authenticating as `idp-<id>` with the secret from My IdPs (HTTP Basic or client_secret_post).

## Use xaa.dev (IdenX) as a free outside IdP

[xaa.dev](https://xaa.dev) is Okta's free Cross App Access playground. Its IdP, IdenX (`https://idp.xaa.dev`), issues
real ID-JAGs, so the "Your IdP" mode can run end to end with an IdP that shares nothing with ours. In that mode,
**Get an ID-JAG from xaa.dev** signs you in at IdenX (code + PKCE), exchanges IdenX's refresh token for an ID-JAG
addressed to resource-as (RFC 8693, scope `read`) and loads it like a pasted one; then redeem, call and open the
protected page as usual.

xaa.dev addresses ID-JAGs to a **public https issuer registered at xaa.dev**, so a local run (`http://localhost`)
cannot use it: the button stays disabled and says why. Host this app (Phase 4) first.

### 1. Trusted IdPs: add IdenX

1. On the **Trusted IdPs** page register: issuer `https://idp.xaa.dev`, JWKS `https://idp.xaa.dev/jwks`, target
   **Resource AS**, scope cap `read`, and as "client_id your IdP writes in the ID-JAG" the client we issue it,
   `idp-<id>` (for id `xaa-dev`: `idp-xaa-dev`). An admin approves it.
2. IdenX lets **anyone sign in as any email**, so keep the cap at `read`. This app's own sign-in rules (Ping email
   domains, no `+`) do not apply to an outside IdP's users: trust is the IdP approval, and that is the admin's decision.
3. As the entry's owner, fetch its client secret once (My IdPs). Set `XAA_DEV_RESOURCE_AS_CLIENT_ID=idp-xaa-dev`
   and `XAA_DEV_RESOURCE_AS_CLIENT_SECRET` to it: the playground redeems IdenX's ID-JAGs as that client.

xaa.dev asks for an email first. It is only a namespace (no verification), and anyone who types the same address
sees your registered clients and their secrets: use a non-personal, hard-to-guess address (for example
`your-team-idjag-<random>@example.com`) and keep it with your other secrets.

### 2. xaa.dev: register our resource

At <https://xaa.dev/developer/test-resource>, **Register Resource** (a 4-step wizard):

1. **Basic Info.** Type **REST API**. Resource Identifier URL = `ID_JAG_RESOURCE` (it becomes the ID-JAG's
   `resource`; xaa.dev sends it with a trailing slash, which resource-as accepts).
2. **Auth Server.** Choose **Use My Own Auth Server**.
   - Token Endpoint = resource-as's public token endpoint.
   - xaa.dev tries to discover the issuer from your browser. That usually fails on CORS ("Could not discover issuer
     automatically"); then type **Auth Server URL** = `RESOURCE_AS_ISSUER`, exactly. It becomes the ID-JAG `aud`.
   - Target Client ID = the entry's `idp-<id>` from step 1 (written into the ID-JAG's `client_id`).
   - Target Client Secret = its secret. xaa.dev's tester sends it with `client_secret_post`.
3. **Scopes & Config.** Add scope `read`. Health check and API endpoint paths are joined onto the Resource
   Identifier URL, so the server must answer `<resource>/health` (and, for an endpoint, e.g. `GET <resource>/…`
   requiring `read`). Only needed for xaa.dev's own tester.
4. **Review**, then **Register Resource**.

### 3. xaa.dev: register this app

At <https://xaa.dev/developer/register>, **Register New App** (after step 2: you connect it to that resource):

- Redirect URI `${APP_ORIGIN}/api/id-jag-playground/xaa/callback`.
- Connect to Resource: the resource from step 2 (its scopes are pre-selected).
- The credentials appear once in a dialog. Use the **main** `client_id` / `client_secret` for
  `XAA_DEV_IDP_CLIENT_ID` / `XAA_DEV_IDP_CLIENT_SECRET`; the `…-at-…` resource client is for xaa.dev's own auth
  server and is not used with Own Auth Server. Restart the server.

### 4. Run it

The button's pre-flight (step `xaa`) checks that IdenX answers, that its entry is approved for the resource AS, and
that our redeeming client is configured, and names the fix for each miss.

- xaa.dev's own tester fails at its step 4 inside xaa.dev's proxy: use this app's step 4 instead.
- CORS for `https://xaa.dev` is only needed if you run xaa.dev's in-browser tester against this app (resource-as and
  mcp-sample send no CORS headers).

## Use mcpc or VS Code as the client

Two real MCP clients run the whole flow themselves: sign in at PingFederate, trade the **ID token** for an ID-JAG
addressed to our resource AS, redeem it, then call the sample MCP server. Both are free:
[mcpc](https://github.com/apify/mcpc) (Apache-2.0) and VS Code 1.123 or later (enterprise-managed MCP authentication,
preview).

### 1. Set up once

1. After `pingfederate/configure-signin.js`, run `node pingfederate/configure-desktop-clients.js --ns=<namespace>`. It
   adds the ID-token subject at PingFederate, an SP connection for this resource AS, the clients `id-jag-mcpc` and
   `id-jag-vscode`, and the resource AS's trust and client files under `deploy/local/`. Secrets go to `.env` only.
2. Start with the overlay:
   `docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.desktop-clients.yml up --build -d`.
3. Users sign in through this kit's PingOne environment, so register there first.

### 2. mcpc

With the two secrets from `.env` in your shell:

```sh
npx -y @apify/mcpc@0.7.0 login http://localhost:4722/mcp --grant id-jag \
  --idp https://pf.example.invalid --idp-client-id id-jag-mcpc --idp-client-secret "$MCPC_IDP_CLIENT_SECRET" \
  --client-id id-jag-desktop --client-secret "$DESKTOP_RESOURCE_CLIENT_SECRET" --scope "read mcp:invoke"
npx -y @apify/mcpc@0.7.0 connect http://localhost:4722/mcp @kit
npx -y @apify/mcpc@0.7.0 @kit tools-call whoami
```

The login opens your browser once. `whoami` answers with your subject, the client `id-jag-desktop` and scope
`read mcp:invoke`.

### 3. VS Code

1. User `settings.json` (for local testing; in production an admin pushes this setting by policy):

   ```json
   "mcp.enterpriseManagedAuth.idp": {
     "issuer": "https://pf.example.invalid",
     "clientId": "id-jag-vscode",
     "clientSecret": "<VSCODE_IDP_CLIENT_SECRET>"
   }
   ```

2. User `mcp.json`, then use the **Set Client Secret** code lens above `clientId` for `DESKTOP_RESOURCE_CLIENT_SECRET`
   (VS Code keeps it in the OS secret store):

   ```json
   "servers": {
     "id-jag-kit": {
       "type": "http",
       "url": "http://localhost:4722/mcp",
       "oauth": { "clientId": "id-jag-desktop", "enterpriseManaged": true }
     }
   }
   ```

3. Start the server and sign in once in the browser. Later enterprise-managed servers connect silently.

### Why it is set up this way

- Both clients send the ID token as the subject, so PingFederate needs an exchange policy for `id_token` next to the
  refresh-token one.
- PingFederate refuses ID-JAGs to public clients ("Public clients are not permitted to request an id-jag token"), so
  the IdP clients are confidential, even for a desktop app.
- MCP SDK clients require `authorization_endpoint` and `response_types_supported` in the resource AS metadata. Ours
  advertises none, and its `/authorize` answers `unsupported_response_type`.
- The MCP server must answer 401 with `WWW-Authenticate: Bearer resource_metadata=…`: VS Code only starts sign-in after
  a 401.

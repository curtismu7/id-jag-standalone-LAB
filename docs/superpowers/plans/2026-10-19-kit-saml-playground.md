# A real SAML path in the kit playground

Today the playground's SAML option is mock only. PingFederate 13.1.3 accepts a signed SAML 2.0 assertion as the
`subject_token` of a token exchange and returns an ID-JAG in ONE exchange (verified 2026-10-19, `tools/saml-spike`;
README there). xaa.dev's mock shows two exchanges (assertion -> refresh token -> ID-JAG); PingFederate does not need the
first. This makes SAML real for the `pf-as` mode, and brings the mock in line with what PingFederate does.

## Idea
The kit server plays a tiny SAML identity provider for the signed-in user: after the normal app sign-in it signs an
assertion naming that user (NameID = their email), and PingFederate trusts the signer's certificate (a trusted CA) and
its SAML 2.0 token processor. No second sign-in, no real SAML IdP needed. The subject is ALWAYS the app session's user;
a request can never choose it.

## Contract

### Provisioning: `pingfederate/configure-saml.js` (idempotent; `--remove` undoes it)
Model it on `tools/saml-spike/spike.mjs` (verified against the real PingFederate: same API paths and payload shapes; read
it) and the kit's `pingfederate/pf-admin.js` helpers.
1. Signer key pair: if absent, generate with `openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 365 -subj /CN=id-jag-kit-saml-idp`
   into `deploy/local/saml/signer.key.pem` (mode 600) and `signer.cert.pem`; directory mode 700. (`deploy/local/` is gitignored.)
2. Trusted CA `idjagkitsamlca` (the id MUST be lower case) from the cert.
3. SAML 2.0 token processor `idJagKitSaml` (Audience `idJagKitSamlAud`), exchange policy `idJagKitSamlPolicy`
   (`subjectTokenType urn:ietf:params:oauth:token-type:saml2`; subject and TOKEN_SUBJECT from the processor's
   `SAML_SUBJECT`; `client_id` = the constant `PF_EXCHANGE_CLIENT_ID` (default `id-jag-kit`) so the resource AS's existing
   client-alias binding accepts it, exactly as for the refresh-token path).
4. Client `id-jag-kit-saml`: confidential, grant TOKEN_EXCHANGE only, `tokenExchangeProcessorPolicyRef` = the policy,
   secret generated, written to the repo-root `.env` as `PF_SAML_CLIENT_SECRET` (never printed). If it exists keep it.
5. Add ONE `processorPolicyMappings` entry for the SAML policy to the kit's existing SP connection
   `idJagKitResourceAsSp` (copy the shape of its existing mappings: `scope` TEXT = the same scope they use, TOKEN_SUBJECT
   and client_id from the policy). Idempotent: skip when present. `--remove` removes that entry and every object above
   (client, policy, processor, CA) in reverse dependency order and leaves the SP connection otherwise untouched.
6. Print one `ok / keep / FAIL` line per object like the other kit scripts; at the end say how to restart with the SAML
   compose overlay.

### Server (`server/src/saml.js`, wired into `server/src/idJagPlayground.js`)
- Dependencies: add `xml-crypto` and `@xmldom/xmldom` to `server/package.json` (use the same versions as
  `tools/saml-spike`) and update `package-lock.json`.
- Config (env, documented in `.env.example` WITHOUT values for secrets): `SAML_SIGNING_KEY_FILE`, `SAML_SIGNING_CERT_FILE`
  (PEM paths), `SAML_ISSUER` (default `${APP_ORIGIN}/saml`), `SAML_AUDIENCE` (default `idJagKitSamlAud`), `PF_SAML_CLIENT_ID`
  (default `id-jag-kit-saml`), secret `PF_SAML_CLIENT_SECRET`. `samlUnavailableReason()` returns null or a plain-language
  reason (which file/secret is missing). Files are read at call time, so a restart is not needed after provisioning.
- `buildAssertion({subject, audience, issuer, nowMs})`: copy the verified construction from `tools/saml-spike/mk-saml.mjs`
  (unique `_uuid` ID, IssueInstant and NotBefore backdated 60 s, NotOnOrAfter now+300 s, AudienceRestriction, Subject
  NameID format emailAddress with SubjectConfirmation bearer, AuthnStatement, enveloped RSA-SHA256 exclusive-c14n
  signature placed right after Issuer, KeyInfo/X509Data). XML-escape every interpolated value.
- `describeAssertion(xml)` -> the browser view: `{issuer, nameId, nameIdFormat, audience, issueInstant, notBefore,
  notOnOrAfter, signature: {algorithm, canonicalization, certSha1}, xml}` where `xml` is the pretty-printed assertion with
  the DigestValue, SignatureValue and X509Certificate contents replaced by `[…]`. The raw assertion never leaves the server.
- `GET /api/id-jag-playground/saml/cert`: the signer certificate PEM (public; `Content-Type: application/x-pem-file`),
  `404 {error:"saml_not_configured"}` when unavailable. (The provisioning script does not need it; it is for people who
  configure another PingFederate.)
- `GET /api/id-jag-playground/config` gains `saml: { available, reason, audience, issuer, supportedModes: ["pf-as"] }`.
- `POST /api/id-jag-playground/issue` with body `{protocol:"saml"}`:
  - mode must be `pf-as`, else `409 {error:"saml_unsupported_mode"}`; unavailable -> `409 {error:"saml_not_configured", message}`;
  - needs an app sign-in with an email (`req.session.user.email`), else `401 {error:"sign_in_required"}`; the email must pass
    the kit's email rules (`server/src/auth/emailRules.js`), else `403`. Subject = that email, nothing from the request.
  - builds the assertion, then one exchange at the PingFederate token endpoint: Basic client auth with
    `PF_SAML_CLIENT_ID`/secret, form `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`,
    `subject_token=<base64url(assertion xml)>`, `subject_token_type=urn:ietf:params:oauth:token-type:saml2`,
    `requested_token_type=urn:ietf:params:oauth:token-type:id-jag`, plus the same `audience`, `resource`, `scope` the OIDC
    path sends. Reuse the existing exchange/mint code and the existing session storage of the ID-JAG (so inspect, redeem,
    call, negatives work unchanged).
  - success body: `{ assertion: describeAssertion(...), request, response, token }` where `request` is the exchange as the
    page shows it (subject_token shown as `[the signed SAML assertion, base64url, kept server-side]`, client_id shown),
    `response` redacted exactly like the OIDC one, `token` the decoded ID-JAG.
  - PingFederate refusals map to a clear error body like the OIDC path (`id_jag_issue_failed` + the PF error/description).
- `POST /api/id-jag-playground/revoke` in a session whose ID-JAG came from SAML -> `409 {error:"no_refresh_token",
  message:"A SAML sign-in has no refresh token to revoke."}`.
- Preflight (`GET .../preflight?step=issue&protocol=saml`) adds checks `saml-configured` (reason when not) and
  `saml-client` (secret present); the existing checks still run. Unknown/absent `protocol` behaves as today.
- Never log or echo the assertion, signature, secret or tokens.
- `deploy/docker-compose.saml.yml` overlay (like `docker-compose.desktop-clients.yml`): service `id-jag` gets
  `volumes: ./local/saml:/run/saml:ro` and env `SAML_SIGNING_KEY_FILE=/run/saml/signer.key.pem`,
  `SAML_SIGNING_CERT_FILE=/run/saml/signer.cert.pem`.

### Web (`web/src/pages/IdJagPlaygroundPage.jsx`, `web/src/utils/idJagPlaygroundMock.js`)
- The SAML option is enabled in mock mode (as today) and in `pf-as` mode when `config.saml.available`; otherwise it is
  disabled with `config.saml.reason` as its title (older servers: keep the current SAML_UNVERIFIED text).
- A "real SAML" run (not mock): step 1 note explains the idea (this app plays a small SAML IdP and signs an assertion
  for you; PingFederate trusts its certificate; no second sign-in) and step 1 shows the same "done" state as OIDC when the
  app sign-in exists. Step 2 is titled "Trade the SAML assertion for an ID-JAG" and shows two `StepTabs`: "The SAML
  assertion" (decoded fields, and the redacted XML) then the exchange (request / response / decoded ID-JAG).
- The mock SAML path is changed to the same single-exchange shape (an `assertion` object and one exchange), replacing the
  two-exchange `assertionExchange`; update `SAML_NOTE` to say PingFederate takes the assertion directly.
- The revoke step is hidden when the protocol is SAML (there is no refresh token). Start over works as before.
- Tests for each of the above (Testing Library; mock the api module like the other page tests).

### Docs
`docs/setup-guides.md` (a section "SAML: assertion to ID-JAG" with the exact commands), `README.md` (one short paragraph
and the new env names), `docs/interop-lab.md` is NOT edited. Do not touch `docs/sync-with-app.md` (another PR edits it).

## Done when
`npm test -w server` and `npm test -w web` pass with tests for every bullet; the provisioning script passes
`node --check` and is read line by line against `tools/saml-spike/spike.mjs` (it is NOT run against PingFederate by the
builders; the owner runs it); no secrets in code or logs; every new env name is in `.env.example`.

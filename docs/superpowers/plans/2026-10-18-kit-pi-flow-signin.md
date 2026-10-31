# Kit sign-in without a redirect (PingFederate pi.flow)

Rule from the owner (2026-10-18): logins are pi.flow only, never a redirect to a login page. The kit signed in with a
full-page redirect to PingFederate, which federated to PingOne. PingFederate's Authentication API cannot run an OIDC IdP
connection ("The next step requires browser interaction, which is not supported with the pi.flow response mode"), so the
owner chose: **PingFederate signs the kit's users in itself** (a kit-only credential validator and HTML form adapter),
and the kit drives that flow from its own server and shows it in a modal. The redirect login stays only as the
fallback when the flow cannot open. AIC is NOT part of the kit.

## Contract (server and web both build to this)

All new routes live in `server/src/auth/piFlow.js` (shared driver) and are mounted by `server/src/app.js`.

### App sign-in (replaces the click on "Sign in")
- `GET /auth/pi-flow/start?return_to=<path>`
  - Same preconditions as `GET /auth/login` (config present, discovery works). The issuer must be the kit's PingFederate
    (`config().pfUrl`); otherwise `409 {error:"pi_flow_unavailable"}` so the web falls back to the redirect.
  - Creates the SAME login state as `/auth/login` (`req.session.oidcLogin = {state, nonce, verifier, returnTo, at}`) and
    builds the SAME authorize URL plus `response_mode=pi.flow`. The server (not the browser) requests it
    (`Accept: application/json`, `redirect: 'manual'`, 10 s timeout).
  - Success only when HTTP 200, `id` matches `^[A-Za-z0-9_-]{6,64}$` and `status === "USERNAME_PASSWORD_REQUIRED"`.
    Stores `req.session.piFlow = {kind:"app", flowId, cookies:{…}, startedAt}`, answers `200 {flowId, status}`.
    Anything else (`FAILED`, other status, non-200, network) -> `502 {error:"pi_flow_unavailable"}` and the session's
    pending login state is removed. PingFederate's `FAILED` happens when the policy needs a browser.
- `POST /auth/pi-flow/credentials` (same-origin check: reuse `sameOrigin` from `oidc.js`)
  - Body `{username, password}`: both non-empty strings, each <= 256 chars, else `400 {error:"invalid_request"}`.
  - Needs `req.session.piFlow` (<= 5 min old) and `req.session.oidcLogin`, else `409 {error:"pi_flow_not_started"}`.
  - POST to `<pf origin>/pf-ws/authn/flows/<flowId>` with `Content-Type:
    application/vnd.pingidentity.checkUsernamePassword+json`, `Accept: application/json`, header
    `X-XSRF-Header: PingFederate`, the cookie jar (merge Set-Cookie from every response), body `{username,password}`.
  - HTTP 400 whose `details[].code` includes `CREDENTIAL_VALIDATION_FAILED` -> `401 {error:"invalid_credentials",
    message:"Username or password is incorrect."}` (flow stays open for another try).
  - `status === "COMPLETED"` with `authorizeResponse.code` and `authorizeResponse.state === oidcLogin.state` ->
    delete `req.session.piFlow`, answer `200 {redirectTo: "<redirectUri>?code=…&state=…"}` where redirectUri is the
    configured `OIDC_REDIRECT_URI` (default `${appOrigin}/auth/callback`). A state mismatch is a failure (no code leaves).
    The existing `/auth/callback` then does the code exchange, ID token validation, email rules and session creation,
    UNCHANGED.
  - Any other status (MFA, a policy screen) or non-ok -> `200 {fallback:true, status}` for the former, `502
    {error:"pi_flow_failed"}` for the latter. At most 8 credential attempts per flow (then `429`).
  - Never log or echo the username/password, the code, or tokens.

### Playground issuer sign-in (step 1 of the playground, modes whose issuer is a PingFederate)
- `GET /api/id-jag-playground/issuer/pi-flow/start?return_to=<path>` and
  `POST /api/id-jag-playground/issuer/pi-flow/credentials`: the same two handlers, built from the SAME driver, but they
  start from the mode's settings exactly like `GET /api/id-jag-playground/issuer/login` does today
  (`idJagIssuerLogin = {mode, state, verifier, returnTo, at}`, client `settings(mode).idp.exchangeClientId`,
  redirect URI `.../api/id-jag-playground/issuer/callback`), add `response_mode=pi.flow`, and finish with
  `redirectTo: <issuerRedirectUri>?code&state`, which the existing `/issuer/callback` completes UNCHANGED.
  byo mode -> 409 as `/issuer/login` does. If the issuer does not open a `USERNAME_PASSWORD_REQUIRED` flow (another
  company's PingFederate, a policy needing a browser) -> `502 {error:"pi_flow_unavailable"}` and the web redirects.
- Session key for the flow's driver state: `req.session.piFlow` with `kind:"issuer"`; the two kinds never share state.

### Web
- `web/src/utils/signIn.js`: `signIn(returnTo)` and a new `signInIssuer(returnTo)` dispatch a `CustomEvent`
  `idjag:signin` `{kind:"app"|"issuer", returnTo, handled:false}`; if no modal handles it (`detail.handled` stays
  false), they fall back to the existing redirects (`/auth/login?return_to=…` and
  `/api/id-jag-playground/issuer/login?return_to=…`).
- `web/src/components/SignInModal.jsx` (mounted once in `AppShell.jsx`): on the event it opens, calls the matching
  `start` endpoint (`credentials: include`), shows an accessible username/password form (labels, `role="dialog"`,
  `aria-modal`, focus into the Username field, Escape cancels, error text with `role="alert"`), posts the
  credentials, on `redirectTo` it navigates (`window.location.assign`), on `401` shows the message and clears the
  password, on `fallback`/non-ok/network it closes and falls back to the redirect login. Password input
  `type=password`, `autocomplete="current-password"`; the password is never stored anywhere but component state and is
  cleared after each submit. Ping brand (colors from `AppShell.css` / `console.css` tokens, Montserrat inherited).
- `IdJagPlaygroundPage.jsx` step 1's sign-in button uses `signInIssuer` instead of `window.location.assign(...)`.

## Out of scope
AIC. MFA/passkey/OTP steps (a flow needing them falls back to the redirect login). PingFederate configuration (done by
`pingfederate/configure-local-signin.js`, written separately by the owner of this task).

## Done when
`npm test -w server` and `npm test -w web` pass with the new tests; every path above has a test; no new lint/format
drift; README gets a short "Sign-in modal (pi.flow)" paragraph under the sign-in section.

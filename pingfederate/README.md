# PingFederate setup scripts

Copied from AI-DEMO2. `configure-acme-idp.js` is adapted to this repo; `sync-id-jag-trusted-idps.js` still assumes
AI-DEMO2 names (its default registry URL and token manager), so treat it as reference until it is.

- `configure-acme-idp.js` configures a fresh PingFederate as "Acme", an outside IdP that issues ID-JAGs to our
  authorization servers: one SP connection to our resource AS (`RESOURCE_AS_ISSUER`, `ID_JAG_RESOURCE`) and one to
  our PingFederate (`PF_URL`, `PF_RESOURCE`, `PF_REDEEMER_CLIENT_ID`). Every target comes from an option or this
  repo's settings (env, else the repo-root `.env`); a missing one stops it with the option and variable to set. On an
  Acme PingFederate another deployment also uses, it rewrites the shared `acmeToPingFed` connection with these values.
- `sync-id-jag-trusted-idps.js` reads `/api/id-jag-playground/trusted-idps/pingfederate` (Bearer `ID_JAG_REGISTRY_TOKEN`) and creates one PingFederate IdP connection per trusted IdP.
- `configure-signin.js` sets up this app's sign-in at our PingFederate: an OIDC IdP connection to the kit's own PingOne
  environment (from `tools/provision-pingone-signin.js`), the `id-jag-kit` client (written to `.env` as `PF_EXCHANGE_*`), a
  token manager and OIDC policy only that client uses (`email`, boolean `email_verified`, `name`, `groups` in the ID
  token), and a new FIRST authentication policy: the kit client goes to PingOne, every other client continues to the
  existing policies unchanged.
- `configure-desktop-clients.js` lets mcpc and VS Code (enterprise-managed MCP auth) act as ID-JAG clients: an ID-token
  subject at PingFederate, an SP connection for this kit's resource AS, the confidential clients `id-jag-mcpc` /
  `id-jag-vscode` (signing in through the kit's PingOne), and the resource AS files under `deploy/local/` used by
  `deploy/docker-compose.desktop-clients.yml`. `pf-admin.js` holds the helpers these scripts share.

`npm run setup -- --mode=pf-local` runs, against a PingFederate on 127.0.0.1:4731: `configure-signin.js --local`,
`configure-local-signin.js`, `configure-base-url.js` (issuer = `PF_URL`), `configure-local-tls.js` (a certificate for
127.0.0.1 and `PF_CA_FILE`), and `configure-idjag-issuer.js` (the ID-JAG signing key, static JWKS, exchange policy and the
`idJagKitResourceAsSp` connection), then a self-check. Their admin API is reached directly through `PF_ADMIN_URL`,
`PF_ADMIN_USER`, `PF_ADMIN_PASSWORD` and `PF_ADMIN_INSECURE_TLS=true` in the environment (no kubectl, no `--ns`), and
`PF_SETTINGS_FILE` names the file that receives the client id and secret and `PF_CA_FILE` (the shared `~/Development/.env`).
The three new scripts refuse to run unless `PF_ADMIN_URL` is a loopback address. The other scripts still use a cluster
port-forward. PingFederate key pair ids cannot hold upper case, hence `idjagkit-signing` and `idjagkit-local-tls`.

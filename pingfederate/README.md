# PingFederate setup scripts

Two kinds. **Local scripts** configure the kit's own PingFederate (admin `https://127.0.0.1:4731`) through `pf-admin.js` direct mode
(`PF_ADMIN_URL`, `PF_ADMIN_USER`, `PF_ADMIN_PASSWORD`, `PF_ADMIN_INSECURE_TLS=true` in the environment) and refuse any other admin address.
**Owner-run Acme scripts** write to the shared SE Acme PingFederate and are never run by an agent or a colleague
([runbook](../docs/acme-owner-runbook.md)). Settings written by any script go to `PF_SETTINGS_FILE`, else the one shared settings file
(`STANDALONE_ENV`, else `~/Development/.env`), never to the repo-root `.env`.

Local:

- `configure-signin.js --local`, `configure-local-signin.js`, `configure-base-url.js`, `configure-local-tls.js`, `configure-idjag-issuer.js`: what
  `npm run setup -- --mode=pf-local` runs (see below).
- `configure-pf-redeemer.js` is the pf-pf redeemer half, run by `npm run setup -- --mode=pf-pf --acme-settings=<file>`: a configuration backup
  (`GET /bulk/export`, mode 600, in `~/.config/demo-kit/id-jag-kit/backups/` or `--backup-dir`) before the first write, the IdP connection `idJagKit-acme`
  (entity id = `ACME_PF_URL`, JWKS `<ACME_PF_URL>/pf/JWKS`, mapped into the token manager), the JWT token manager `idJagKitRedeemerAtm` selected by
  `PF_RESOURCE` (default `http://localhost:9090/mcp`), and the JWT bearer client `id-jag-redeemer` whose generated secret becomes
  `PF_REDEEMER_CLIENT_SECRET` (kept while the settings file has it). It restarts the container after the IdP connection is created or changed,
  because PingFederate caches an issuer's JWKS forever. `--remove` deletes the three objects.
- `sync-id-jag-trusted-idps.js` reads `/api/id-jag-playground/trusted-idps/pingfederate` (Bearer `ID_JAG_REGISTRY_TOKEN`) and creates one IdP connection
  `idJagKit-<id>` per trusted IdP on the local PingFederate, mapped into `idJagKitRedeemerAtm`. `--dry-run`; restart the container afterwards.
- `configure-kid-workaround.js` clones the kit's JWT token manager `idJagKitKeyPublisher` into `kid`-carrying managers for outside resource servers
  (docs/interop-lab.md); client `id-jag-kit-kid`; `--remove`.

Owner-run (Acme):

- `configure-acme-kit-connection.js` is additive and tested only against a fake admin API: the SP connection `idJagKitAcmeToLocalPf`, the policy
  `idJagKitPolicy` and the processor `idJagKitRefreshToken`, and nothing else. `--inventory` (read-only), `--dry-run`, `--remove`.
- `configure-acme-signin.js` adds the pi.flow sign-in objects and the client `id-jag-kit-acme` (pointed at `idJagKitPolicy`; redirect URIs added, never replaced).
- Both need `--acme`, `PF_ADMIN_URL` unset, and `--expect-issuer=https://<acme-host>` equal to the admin API's base URL (`acme-guard.js`); `--context=<kube context>`
  names the cluster.
- `configure-acme-idp.js` configures a fresh PingFederate as the demo's Acme. **Do not run it against the shared Acme**: it rewrites the demo's
  `acmeToPingFed` connection. It stays as the reference for how Acme was built.

- `configure-signin.js` sets up this app's sign-in at our PingFederate: an OIDC IdP connection to the kit's own PingOne
  environment (from `tools/provision-pingone-signin.js`), the `id-jag-kit` client (written to the settings file as `PF_EXCHANGE_*`), a
  token manager and OIDC policy only that client uses (`email`, boolean `email_verified`, `name`, `groups` in the ID
  token), and a new FIRST authentication policy: the kit client goes to PingOne, every other client continues to the
  existing policies unchanged.
- `configure-desktop-clients.js` lets mcpc and VS Code (enterprise-managed MCP auth) act as ID-JAG clients: an ID-token
  subject at PingFederate, an SP connection for this kit's resource AS, the confidential clients `id-jag-mcpc` /
  `id-jag-vscode` (signing in through the kit's PingOne), and the resource AS files under `deploy/local/` used by
  `deploy/docker-compose.desktop-clients.yml`. These two and `configure-interop-targets.js` / `configure-saml.js` reach a cluster by port-forward
  unless `PF_ADMIN_URL` is set. `pf-admin.js` holds the helpers these scripts share.

`npm run setup -- --mode=pf-local` runs, against a PingFederate on 127.0.0.1:4731: `configure-signin.js --local`,
`configure-local-signin.js`, `configure-base-url.js` (issuer = `PF_URL`), `configure-local-tls.js` (a certificate for
127.0.0.1 and `PF_CA_FILE`), and `configure-idjag-issuer.js` (the ID-JAG signing key, static JWKS, exchange policy and the
`idJagKitResourceAsSp` connection), then a self-check. Their admin API is reached directly through `PF_ADMIN_URL`,
`PF_ADMIN_USER`, `PF_ADMIN_PASSWORD` and `PF_ADMIN_INSECURE_TLS=true` in the environment (no kubectl, no `--ns`), and
`PF_SETTINGS_FILE` names the file that receives the client id and secret and `PF_CA_FILE` (the shared `~/Development/.env`).
The local scripts refuse to run unless `PF_ADMIN_URL` is a loopback address. PingFederate key pair ids cannot hold upper case, hence `idjagkit-signing` and `idjagkit-local-tls`.

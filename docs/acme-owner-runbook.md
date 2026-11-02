# Acme owner runbook (pf-pf)

For the **owner of the shared Acme PingFederate**. Everything here is run by you, by hand, in your own terminal. No agent runs it:
these steps write to a PingFederate that the demo also uses. Colleagues never run anything on Acme; they only import the settings block
you give them (step 9) and set up their own machine.

Placeholders: `<acme-host>` is the host Acme publishes its issuer on, `<ctx>` is your kubectl context for the SE cluster, and `<acme-ns>` is the
namespace that holds Acme's PingFederate. Keep the real values in your shell only. Do not paste them into a repo, an issue or a chat.

Decisions already made:

| | Value |
| --- | --- |
| Resource the local PingFederate redeems for (`PF_RESOURCE`) | `http://localhost:9090/mcp` |
| Local PingFederate issuer (`PF_URL`, the ID-JAG `aud`) | `https://127.0.0.1:4732` |
| Redeemer client at the local PingFederate | `id-jag-redeemer` |
| Kit sign-in client at Acme | `id-jag-kit-acme` |

## What the scripts do, and never do

`pingfederate/configure-acme-kit-connection.js` is **additive**. It creates three objects and changes or deletes nothing else:

| Object | Purpose |
| --- | --- |
| SP connection `idJagKitAcmeToLocalPf` | Issues ID-JAGs to the local PingFederate: ID-JAG on, 5 minutes, signed with Acme's existing key `acme-idjag-signing` (referenced, not changed), `aud` = `https://127.0.0.1:4732`, `resource` = `http://localhost:9090/mcp`, `client_id` = `id-jag-redeemer`, scope `read mcp:invoke` |
| Token exchange policy `idJagKitPolicy` | Mapped by that connection only |
| Refresh token processor `idJagKitRefreshToken` | The policy's subject processor |

It never touches `acmeToPingFed`, `acmeToResourceAs`, `acmeIdJagPolicy`, `acmeAtm`, `acmeRefreshToken`, the `acme-agent` client, the signing key, the
static JWKS or the default exchange policy. Every write is checked against the list of the three ids above before it is sent, and a test records every
request against a fake admin API to prove none names a demo object. It refuses to run if `PF_RESOURCE` or the local issuer is already used by a
connection that is not the kit's.

`pingfederate/configure-acme-signin.js` then creates the sign-in objects (`idJagKitAcmeForm`, `id-jag-kit-acme`) and **points `id-jag-kit-acme` at
`idJagKitPolicy`**, so that client cannot ask Acme for an ID-JAG addressed to anything the demo uses. It can also switch on three Acme-wide settings,
each only when it is off or unset: the Authentication API (pi.flow only), IdP authentication policies, and the default authentication source
(only when none is set). Run its `--dry-run` first and read the plan.

Guards on both scripts, all checked before the first request: `--acme` must be passed; `PF_ADMIN_URL` must not be set (anywhere, including the
settings file), because `pf-admin.js` would then send every request to that URL; and the admin API's `federationInfo.baseUrl` must equal
`--expect-issuer`. The expected issuer is typed by you each time and is not in the repo. No message prints it.

## 1. Check the cluster (read-only)

```sh
kubectl config get-contexts
kubectl --context <ctx> get ns <acme-ns>
kubectl --context <ctx> -n <acme-ns> get svc pingfederate-admin
```

Take `<ctx>` and `<acme-ns>` from your own notes. Stop here if any command fails or names something else.

## 2. Port-forward the admin API

In its own terminal, leave it running:

```sh
kubectl --context <ctx> -n <acme-ns> port-forward svc/pingfederate-admin 29999:9999
```

## 3. Prepare the shell

```sh
unset PF_ADMIN_URL PF_ADMIN_USER PF_ADMIN_PASSWORD
grep -c '^PF_ADMIN_' ~/Development/.env      # must print 0: admin keys never belong in the shared file
export ACME_ISSUER=https://<acme-host>       # the issuer Acme publishes, no trailing slash
cd <your clone of id-jag-standalone-LAB>
```

Your kit must be set up for local use first (`npm run setup -- --mode=pf-local`), so `PF_URL` in `~/Development/.env` is `https://127.0.0.1:4732`.

## 4. Inventory (read-only) and dry run

```sh
A="--acme --expect-issuer=$ACME_ISSUER --ns=<acme-ns> --context=<ctx>"
node pingfederate/configure-acme-kit-connection.js $A --inventory | tee ~/acme-inventory-before.txt
node pingfederate/configure-acme-kit-connection.js $A --dry-run \
  --pf=https://127.0.0.1:4732 --pf-resource=http://localhost:9090/mcp --pf-client=id-jag-redeemer
```

`--inventory` prints only ids, entity ids and resource URIs, sorted, so two runs can be compared. `--dry-run` sends GET requests only and prints
`plan POST ...` lines. Read both. If the script refuses (the resource or the issuer is used by another connection), stop and pick another
`--pf-resource`; do not edit the other connection.

## 5. Create the connection

```sh
node pingfederate/configure-acme-kit-connection.js $A \
  --pf=https://127.0.0.1:4732 --pf-resource=http://localhost:9090/mcp --pf-client=id-jag-redeemer
```

Safe to rerun: a second run prints `keep` for each object.

## 6. Create the sign-in client

```sh
node pingfederate/configure-acme-signin.js $A --dry-run
node pingfederate/configure-acme-signin.js $A
```

This writes `ACME_EXCHANGE_CLIENT_ID` and `ACME_EXCHANGE_CLIENT_SECRET` to `~/Development/.env` (mode 600). The secret is never printed.
Its redirect URIs are a fixed list (`http://localhost:4720` and `http://127.0.0.1:4720`, plus `APP_ORIGIN` when set and port 4723 with `--dev`), added to
whatever the client already has.

## 7. Verify with public requests

These need no login. Run them from any shell.

```sh
curl -s https://<acme-host>/.well-known/openid-configuration | jq -r .issuer          # equals the issuer you expect
curl -s https://<acme-host>/pf/JWKS | jq '[.keys[] | select(.kty=="RSA") | .x5t] | unique | length'   # exactly 1
curl -s -H 'Accept: application/json' \
  'https://<acme-host>/as/authorization.oauth2?response_type=code&client_id=id-jag-kit-acme&redirect_uri=http://localhost:4720/api/id-jag-playground/issuer/callback&scope=offline_access&response_mode=pi.flow&state=check&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256' \
  | jq -r .status                                                                      # USERNAME_PASSWORD_REQUIRED
```

If `/pf/JWKS` lists more than one distinct `x5t`, stop: a PingFederate redeemer cannot pick the right key. That is an Acme setting (the static JWKS from
`configure-acme-idp.js`), not something these scripts change.

## 8. Confirm the demo is unchanged

```sh
node pingfederate/configure-acme-kit-connection.js $A --inventory | tee ~/acme-inventory-after.txt
diff ~/acme-inventory-before.txt ~/acme-inventory-after.txt
```

The only differences are lines ending `(kit)`, plus the `kit sign-in client` line. The `acmeToPingFed` and `acmeToResourceAs` lines, every
other connection, every policy and every signing key must be identical. Then run the demo's own pf-pf and ID-JAG checks as you usually do.

## 9. Hand off to colleagues (two channels)

Each colleague needs two things, and they travel separately.

**Channel 1: the settings block** through the approved secret channel, with an expiry (for example 24 hours). Build it as a file in mode 600,
outside any repo, from the values step 6 wrote:

```sh
umask 077
{ grep -E '^ACME_EXCHANGE_CLIENT_(ID|SECRET)=' ~/Development/.env; printf 'ACME_PF_URL=%s\n' "$ACME_ISSUER"; } > ~/acme-block.env
chmod 600 ~/acme-block.env
cut -d= -f1 ~/acme-block.env           # prints exactly the three key names; never `cat` the file
```

It holds `ACME_PF_URL`, `ACME_EXCHANGE_CLIENT_ID` and `ACME_EXCHANGE_CLIENT_SECRET` and nothing else. The importer rejects any other key.
Delete your copy when the channel has delivered it.

**Channel 2: the `acme-user` password**, in a separate message. The colleague types it into the sign-in modal; nothing stores it.

What the colleague does (their machine, their own local PingFederate):

```sh
npm run setup -- --mode=pf-local --users=<their email>            # once, if not done
chmod 600 <block file>
npm run setup -- --mode=pf-pf --acme-settings=<block file>
```

Setup merges the three keys into their `~/Development/.env`, deletes the block file, and runs `configure-pf-redeemer.js` on their local PingFederate
(an IdP connection for Acme, a token manager selected by `http://localhost:9090/mcp`, the JWT bearer client `id-jag-redeemer`, a backup first, then a
restart of the container because PingFederate caches Acme's keys forever). Then `npm run doctor -- --mode=pf-pf` checks Acme's discovery, its JWKS and a
pi.flow sign-in start.

Never hand out: the `acme-agent` credential (`OUTSIDE_IDP_CLIENT_SECRET`; `tools/outside-agent.js` uses it and is for you only), any admin
password, or anything else from your settings file.

For your own machine, add `ACME_PF_URL=$ACME_ISSUER` to `~/Development/.env` and run `npm run setup -- --mode=pf-pf` (no flag).

## 10. Rotation

- **Re-issue the block (new client secret).** `node pingfederate/configure-acme-signin.js $A --new-secret` gives `id-jag-kit-acme` a new secret and writes it to
  your settings file. The old secret stops working at once for everyone, so rebuild the block (step 9) and send it to each colleague, who reruns
  `npm run setup -- --mode=pf-pf --acme-settings=<file>`.
- **Acme signing key rotation.** If Acme's ID-JAG signing key or its static JWKS changes, **every colleague's PingFederate must be restarted**: it caches
  an issuer's JWKS forever. Tell them to run `docker restart <container>` (`id-jag-kit-pf`, or `pingfederate-lab` on an older install) and wait
  for it to come back. Rotating the key also affects the demo, which uses the same key.
- **Changing `PF_RESOURCE`.** It is fixed at `http://localhost:9090/mcp` for now. To change it, run step 5 with the new `--pf-resource` (it updates only the
  kit connection) and have each colleague change `PF_RESOURCE` in their settings file, then rerun `npm run setup -- --mode=pf-pf` (it adds the new resource to
  their token manager). The block does not carry it.

## 11. Rollback

Undo in this order. Each command is safe to rerun.

```sh
node pingfederate/configure-acme-signin.js $A --remove          # the sign-in objects first: the client uses the policy
node pingfederate/configure-acme-kit-connection.js $A --remove  # the connection, then the policy, then the processor
node pingfederate/configure-acme-kit-connection.js $A --inventory | diff ~/acme-inventory-before.txt -    # no output
```

`--remove` on the connection script refuses while `id-jag-kit-acme` still uses `idJagKitPolicy`. Acme-wide settings that the sign-in script switched on
(Authentication API, IdP authentication policies, default authentication source) are left on, because other things may use them now; turn them off by
hand in the Acme admin console if you want them back. Remove `ACME_*` from your settings file.

## Known risks

- The kit connection signs with `acme-idjag-signing`, the key the demo uses too. A rotation touches both (see step 10).
- `id-jag-kit-acme` holds a bearer refresh token for whoever signs in as `acme-user`. The ID-JAGs it can obtain are limited to the kit connection by the
  dedicated policy. This was tested against a fake admin API only; to prove it on Acme, ask Acme for an ID-JAG as that client with the demo's resource and
  expect a refusal (not tried by an agent).
- The importer cannot tell a real block from a forged one: send it only through the approved channel, and let it expire.

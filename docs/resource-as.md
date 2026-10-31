# Resource AS and MCP sample

Two small Node 26+ services that let the playground's **redeem** and **call MCP** steps run without anything but your IdP (for example PingFederate):

```
IdP (PingFederate) --ID-JAG--> resource-as  POST /token  --access token (aud = MCP resource)--> mcp-sample  POST /mcp
```

- `resource-as/` is the resource authorization server. It redeems an ID-JAG ([draft-ietf-oauth-identity-assertion-authz-grant](https://datatracker.ietf.org/doc/draft-ietf-oauth-identity-assertion-authz-grant/)) through the `jwt-bearer` grant and returns a short-lived JWT access token whose `aud` is the requested resource (RFC 8707).
- `mcp-sample/` is a minimal MCP server that accepts only those tokens.

Each one is a self-contained npm package:

```sh
cd resource-as && npm install && npm test
cd mcp-sample  && npm install && npm test   # its end-to-end test uses ../resource-as, so install that first
```

The default local setup needs no configuration beyond a client and an IdP for resource-as:

| Service | Listens on | Default identity |
|---|---|---|
| resource-as | `:9080` (plain HTTP) | issuer `http://localhost:9080` |
| mcp-sample | `:9090` (plain HTTP) | resource `http://localhost:9090/mcp` |

Neither service speaks TLS. For anything other than localhost, put a TLS terminator in front (for example resource-as on `https://as.example.com:9443` proxying to `:9080`), then set `ISSUER` / `MCP_RESOURCE` to the external `https://` URLs. Both values are compared exactly against `aud` claims.

---

## resource-as

### Endpoints

| Method and path | Purpose |
|---|---|
| `GET /.well-known/oauth-authorization-server` | RFC 8414 metadata: `issuer`, `token_endpoint`, `jwks_uri`, `grant_types_supported` (`urn:ietf:params:oauth:grant-type:jwt-bearer` only), `token_endpoint_auth_methods_supported`, `authorization_grant_profiles_supported: ["urn:ietf:params:oauth:grant-profile:id-jag"]` |
| `GET /jwks` | Public half of its RS256 signing key (`kid` = RFC 7638 thumbprint) |
| `POST /token` | `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`, `assertion=<ID-JAG>`, optional `scope`, optional `resource` |

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `9080` | Listen port |
| `ISSUER` | `http://localhost:$PORT` | This AS's issuer. Every ID-JAG `aud` must equal it, and every access token's `iss` is set to it. |
| `ACCEPTED_RESOURCES` | `http://localhost:9090/mcp` | Comma-separated resource URIs it issues tokens for. The ID-JAG `resource` claim must be one of them. |
| `CLIENTS_FILE` | none | JSON array of registered clients (see below). Without it (or the client below), every redemption is refused. Re-read on every token request, so clients the playground provisions (`idp-<id>`; set `RESOURCE_AS_CLIENTS_FILE` there to the same file) work without a restart. |
| `RESOURCE_AS_CLIENT_ID` / `RESOURCE_AS_CLIENT_SECRET` | `id-jag-playground` / none | One more confidential client, straight from the environment, hashed at start. Named like the playground server's settings so one `.env` gives both sides the same secret (docker compose). |
| `RESOURCE_AS_CLIENT_SCOPE` | `read mcp:invoke` | The most that environment client may be granted |
| `ALLOW_PUBLIC_CLIENTS` | `false` | `true` lets clients without a secret redeem. Clients are confidential by default, which is the spec's SHOULD. |
| `ACCESS_TOKEN_TTL` | `3600` | Access-token lifetime in seconds. No refresh token is ever issued. |
| `TRUSTED_IDPS_FILE` | none | JSON array of trusted IdPs (see below) |
| `TRUSTED_IDPS_REGISTRY_URL` | none | For example `https://playground.example.com/api/id-jag-playground/trusted-idps/registry` |
| `ID_JAG_REGISTRY_TOKEN` | none | Bearer token sent to the registry |
| `REGISTRY_CA_FILE` | none | PEM CA to pin for the registry's TLS. If unset, the default trust store is used. TLS verification is never disabled. |
| `SIGNING_KEY_PEM_FILE` | none | RSA private key (PKCS#8 or PKCS#1 PEM). If unset, the key is generated on first start. |
| `DATA_DIR` | `.data` | Holds `signing-key.pem` (mode 0600, generated once and then reused) and `replay.json` (the jti replay cache, 0600) |
| `NODE_EXTRA_CA_CERTS` | none | Standard Node variable. Set it when an IdP's JWKS URL uses a private or self-signed CA, as a lab PingFederate often does. |

### `CLIENTS_FILE`

```json
[
  { "client_id": "agent-1", "client_secret_hash": "<sha256 hex of the secret>", "scope": "read mcp:invoke" },
  { "client_id": "cli-public", "scope": "read" }
]
```

- `client_secret_hash` is `sha256(secret)` in hex. Use long random secrets, because the hash is unsalted. A `client_secret` field in plaintext is rejected at startup.
- An entry without `client_secret_hash` is a public client. It works only when `ALLOW_PUBLIC_CLIENTS=true`.
- `scope` is the most this client can ever be granted.

To generate a secret and its hash:

```sh
SECRET=$(openssl rand -base64 32); echo "secret: $SECRET"
printf %s "$SECRET" | shasum -a 256 | cut -d' ' -f1
```

### `TRUSTED_IDPS_FILE`

```json
[
  {
    "id": "pingfederate",
    "issuer": "https://pf.example.com:9031",
    "jwksUrl": "https://pf.example.com:9031/ext/oauth/jwks",
    "clientAliases": { "pf-client-id": "agent-1" },
    "scopes": "read mcp:invoke"
  }
]
```

- `issuer` must equal the ID-JAG `iss` exactly.
- `clientAliases` maps each `client_id` this IdP may write in an ID-JAG to the one client here that may redeem it. Binding is strict: an id that is not a key is refused, even when it equals the authenticated client, so list our own id too (`"agent-1": "agent-1"`) when the IdP writes it. PingFederate fills `client_id` from the client that owns the user's token, which is often not the id registered here.
- `scopes` is an optional extra cap on what this IdP's assertions can grant. An empty value means no extra cap.
- The file is read at startup. If an entry has no `issuer` or `jwksUrl`, startup fails.

### Registry

When `TRUSTED_IDPS_REGISTRY_URL` is set, resource-as fetches `{ "idps": [{ id, issuer, jwksUrl, clientAliases, scopes }] }` from that URL. It sends `Authorization: Bearer $ID_JAG_REGISTRY_TOKEN` and verifies TLS.

- The result is cached for 30 seconds.
- If a fetch fails, it keeps the last good list and logs a warning once.
- When the file and the registry list the same issuer, the file entry wins.
- The playground server's registry also lists its own `PF_URL` once its `pf-as` mode is configured, so in docker compose resource-as trusts that PingFederate with no file.

### What `/token` checks

An ID-JAG must pass every check below, or no token is issued:

1. **Client authentication.** `client_secret_basic` or `client_secret_post`, but not both. A failure returns `401 invalid_client`, plus `WWW-Authenticate: Basic` when Basic was used.
2. **Grant type.** Only `jwt-bearer` is accepted (`unsupported_grant_type`). An `assertion` is required (`invalid_request`).
3. **Trusted issuer.** The issuer is picked by the unverified `iss`. An unknown issuer returns `invalid_grant` "ID-JAG issuer is not trusted". All later checks run against that one IdP.
4. **Assertion.** Each failure returns `invalid_grant`:
   - The signature must be RS256 and verify against the IdP's JWKS. When the header carries `x5t`, it must match exactly one distinct key, even if the same key is listed under several `kid`s.
   - `typ` must be `oauth-id-jag+jwt`.
   - `aud` must be this issuer and must be a single value.
   - `exp` and `iat` are checked with 5 s tolerance.
   - `iss`, `sub`, `aud`, `client_id`, `jti`, `exp` and `iat` are required.
5. **Resource.** The `resource` claim must be listed in `ACCEPTED_RESOURCES`. A `resource` request parameter, if sent, must equal it. Otherwise `invalid_target`. A trailing slash is ignored on both (xaa.dev sends `<resource>/`); the access token's `aud` is the spelling in `ACCEPTED_RESOURCES`.
6. **Client binding.** The ID-JAG `client_id` must be one of the IdP's `clientAliases` keys, and the authenticated client its mapped value. Otherwise `invalid_grant` "ID-JAG client_id is not assigned to this IdP". This holds for file and registry entries alike.
7. **Scope.** The grant is the intersection of the ID-JAG `scope`, the client's `scope`, the request `scope` (if sent) and the IdP cap (if set). An empty result returns `invalid_scope`. Scope is never widened or filled in by default.
8. **Single use.** The `jti` is consumed last, so a request refused for any reason above does not burn the assertion. A replay returns `invalid_grant`. Replay entries expire at the ID-JAG `exp` and survive a restart.

The issued access token is an RS256 JWT with `typ: at+jwt` and a `kid` header. Its claims:

| Claim | Value |
|---|---|
| `iss` | `ISSUER` |
| `sub` | ID-JAG `sub` |
| `aud` | the resource |
| `client_id` | the redeeming client |
| `scope` | the granted scope |
| `jti` | a new unique id |
| `iat` | issue time |
| `exp` | `iat` + `ACCESS_TOKEN_TTL` |

The response is `{ access_token, token_type: "Bearer", expires_in, scope }` with `Cache-Control: no-store`.

Every `/token` decision is logged as one JSON line, for example `{"decision":"refused","error":"invalid_scope","reason":"…","client_id":"agent-1","iss":"…","sub":"…"}`. Assertions, tokens and secrets are never logged.

### curl

```sh
cd resource-as
CLIENTS_FILE=./clients.json TRUSTED_IDPS_FILE=./idps.json npm start

curl -s localhost:9080/.well-known/oauth-authorization-server | jq
curl -s localhost:9080/jwks | jq

# Redeem (client_secret_basic). $ID_JAG comes from your IdP's token exchange
# (requested_token_type=urn:ietf:params:oauth:token-type:id-jag).
curl -s localhost:9080/token -u "agent-1:$SECRET" \
  -d grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer \
  --data-urlencode "assertion=$ID_JAG" \
  -d resource=http://localhost:9090/mcp \
  -d scope='read mcp:invoke' | jq

# The same with client_secret_post
curl -s localhost:9080/token \
  -d grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer \
  --data-urlencode "assertion=$ID_JAG" \
  -d client_id=agent-1 --data-urlencode "client_secret=$SECRET" | jq
```

---

## mcp-sample

### Endpoints

| Method and path | Purpose |
|---|---|
| `GET /.well-known/oauth-protected-resource` (also with `/mcp` appended) | RFC 9728 metadata: `resource`, `authorization_servers: [AS_ISSUER]`, `scopes_supported: ["read","mcp:invoke"]` |
| `GET /protected/profile` | A plain REST page behind the same bearer validation as the tools, for the playground's protected-resource step. 200: `{ resource, verified: [{ check, ok, detail }], principal: { sub, client_id, scope }, data }`. A refusal is 401 (403 without `read`) with `WWW-Authenticate` and the `verified` list up to the check that failed: `bearer`, `token type` (an ID-JAG is refused here), `signature`, `expiry`, `issuer`, `audience`, `scope`. |
| `POST /mcp` | JSON-RPC 2.0, Streamable HTTP with JSON responses only. Handles `initialize`, `notifications/initialized` (202), `ping`, `tools/list` and `tools/call`. `GET /mcp` returns 405 because there is no SSE stream. |

Every `/mcp` request needs `Authorization: Bearer <access token>`. The token is verified against the AS JWKS: RS256, `iss` = `AS_ISSUER`, `aud` = `MCP_RESOURCE`, `typ` = `at+jwt`, and `exp` must not have passed.

- **No token:** `401` with `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource"`.
- **Bad token:** the same header, with `error="invalid_token"` added. `error_description` names the check that failed.

### Tools

| Tool | Needs scope | Input | Output |
|---|---|---|---|
| `whoami` | `read` | `{}` | JSON text `{ sub, client_id, scope }` from the token |
| `echo` | `mcp:invoke` | `{ "text": string }` | the same text |
| `server_time` | `mcp:invoke` | `{}` | ISO 8601 UTC time |

- `tools/list` returns only the tools the token's scope allows. The others appear in `result._meta.deniedTools` as `[{ "name": "echo", "requiredScope": "mcp:invoke" }]`.
- `tools/call` on a tool outside the scope returns HTTP 403 with `WWW-Authenticate: Bearer error="insufficient_scope", scope="<needed>", resource_metadata="…"`. The JSON-RPC error body is `{ code: -32003, message: "insufficient_scope", data: { tool, requiredScope } }`.

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `9090` | Listen port |
| `AS_ISSUER` | `http://localhost:9080` | Expected `iss`. It is also advertised in `authorization_servers`. |
| `AS_JWKS_URL` | `$AS_ISSUER/jwks` | Where the AS keys are fetched from |
| `MCP_RESOURCE` | `http://localhost:$PORT/mcp` | This server's resource URI, which is the required `aud`. It must be listed in resource-as `ACCEPTED_RESOURCES`. |

### curl

```sh
cd mcp-sample && npm start

# No token: 401, plus where to find the metadata
curl -si localhost:9090/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
curl -s localhost:9090/.well-known/oauth-protected-resource | jq

# With the access token from resource-as
mcp() { curl -s localhost:9090/mcp -H "authorization: Bearer $AT" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d "$1" | jq; }
mcp '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
mcp '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
mcp '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"whoami","arguments":{}}}'
mcp '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"echo","arguments":{"text":"hi"}}}'
```

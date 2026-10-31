// Step detail for the "pf" playground diagram (diagram id "pf-as": PingFederate issues, resource-as redeems,
// mcp-sample serves): { [step 1-5]: { forms, tokens, refs } }. See utils/idJagStepDetail.js.
// Grounded in server/src/idJagPlayground.js, resource-as/src/{app,idjag}.js and mcp-sample/src/app.js.
// All hosts, ids and values are teaching placeholders; no token here is real or verifiable.
import { RFC, DRAFT, SPEC, TOKEN_EXCHANGE, JWT_BEARER, JWT, AS_METADATA, PROTECTED_RESOURCE, BEARER, IDJAG } from "../idJagStandards.js";

const PF = "https://pf.example.com:9031"; // PF_URL
const RAS = "https://as.example.com"; // RESOURCE_AS_ISSUER
const MCP = "https://mcp.example.com/mcp"; // ID_JAG_RESOURCE = mcp-sample MCP_RESOURCE
const IAT = 1767225600;

const ID_TOKEN = {
  note: "ID token PingFederate returns with the code exchange. The server reads only its sub; the refresh token (opaque, not a JWT) is the thing it keeps for step 2.",
  header: { alg: "RS256", kid: "<pf signing key id>" },
  claims: { iss: PF, sub: "user.0042", aud: "id-jag-kit", iat: IAT, exp: IAT + 300, email: "user@example.com", email_verified: true, name: "Example User", groups: ["demo"] },
};

const ID_JAG = {
  note: "The ID-JAG as PingFederate mints it. typ oauth-id-jag+jwt is required; PingFederate signs with RS256 and puts x5t in the header and no kid. Lifetime is 300 s (set on the SP connection). client_id is the client that owns the user's refresh token (id-jag-kit here), not the client that will redeem: resource-as maps one to the other through the registry's clientAliases. scope is what the SP connection maps, here the MCP scopes.",
  header: { typ: "oauth-id-jag+jwt", alg: "RS256", x5t: "<sha-1 thumbprint of the PF signing cert>" },
  claims: { iss: PF, sub: "user.0042", aud: RAS, client_id: "id-jag-kit", jti: "<unique id, single use>", iat: IAT + 20, exp: IAT + 320, resource: MCP, scope: "read mcp:invoke" },
};

const ACCESS_TOKEN = {
  note: "The access token resource-as mints (RFC 9068 shape). Signed with resource-as's own RS256 key (kid is an RFC 7638 thumbprint), not PingFederate's. aud is the one resource from the ID-JAG, spelled as in ACCEPTED_RESOURCES. client_id is now the client that authenticated at resource-as (id-jag-playground), mapped from the ID-JAG's id-jag-kit. sub is carried over from the ID-JAG. Lifetime is ACCESS_TOKEN_TTL (3600 s by default); no refresh token is issued.",
  header: { typ: "at+jwt", alg: "RS256", kid: "<rfc 7638 thumbprint>" },
  claims: { iss: RAS, sub: "user.0042", aud: MCP, client_id: "id-jag-playground", scope: "read mcp:invoke", jti: "<new unique id>", iat: IAT + 40, exp: IAT + 40 + 3600 },
};

const REDEEM_HEAD = `POST /token HTTP/1.1
Host: as.example.com
Authorization: Basic <base64 of id-jag-playground:client secret>
Content-Type: application/x-www-form-urlencoded
Accept: application/json
`;
const redeemBody = (assertion, extra = "") =>
  `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${assertion}&client_id=id-jag-playground&resource=${encodeURIComponent(MCP)}${extra}`;

export default {
  1: {
    forms: [
      {
        title: "Authorize at PingFederate (code + PKCE)",
        code: `GET /as/authorization.oauth2?response_type=code
  &client_id=id-jag-kit
  &redirect_uri=https://playground.example.com/api/id-jag-playground/issuer/callback
  &scope=openid profile email offline_access
  &state=<random state>
  &code_challenge=<S256 of the verifier>&code_challenge_method=S256
  &prompt=login HTTP/1.1
Host: pf.example.com:9031

# 302 back to /api/id-jag-playground/issuer/callback?code=<code>&state=<random state>`,
      },
      {
        title: "Server swaps the code for tokens",
        code: `POST /as/token.oauth2 HTTP/1.1
Host: pf.example.com:9031
Authorization: Basic <base64 of id-jag-kit:client secret>
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&code=<code>
  &redirect_uri=https://playground.example.com/api/id-jag-playground/issuer/callback
  &code_verifier=<the PKCE verifier>

# 200 { "access_token": "<access token>", "refresh_token": "<refresh token>", "id_token": "<id token>", ... }
# The server stores refresh_token in the session. The browser never sees any of them.`,
      },
    ],
    tokens: [ID_TOKEN],
    refs: [
      RFC(6749, "The OAuth 2.0 Authorization Framework"),
      RFC(7636, "Proof Key for Code Exchange by OAuth Public Clients"),
      SPEC("OpenID Connect Core 1.0", "OpenID Connect Core 1.0"),
      ...JWT,
    ],
  },

  2: {
    forms: [
      {
        title: "Token exchange at PingFederate (RFC 8693)",
        code: `POST /as/token.oauth2 HTTP/1.1
Host: pf.example.com:9031
Authorization: Basic <base64 of id-jag-kit:client secret>
Content-Type: application/x-www-form-urlencoded
Accept: application/json

grant_type=urn:ietf:params:oauth:grant-type:token-exchange
&requested_token_type=urn:ietf:params:oauth:token-type:id-jag
&subject_token=<refresh token>
&subject_token_type=urn:ietf:params:oauth:token-type:refresh_token
&audience=${RAS}
&resource=${encodeURIComponent(MCP)}
&scope=read mcp:invoke`,
      },
      {
        title: "Response",
        code: `HTTP/1.1 200 OK
Content-Type: application/json

{
  "issued_token_type": "urn:ietf:params:oauth:token-type:id-jag",
  "token_type": "N_A",
  "access_token": "<ID-JAG, a JWT; the field is named access_token because RFC 8693 reuses it>"
}

# Failures are plain OAuth errors (invalid_request, invalid_grant, invalid_target, ...).
# The server keeps the ID-JAG in the session and shows the browser decoded claims only.`,
      },
      {
        title: "Sample vs draft: what the subject_token is",
        code: `The draft exchanges an identity assertion (an ID token) for the ID-JAG. This sample sends the REFRESH TOKEN
PingFederate issued in step 1 (subject_token_type ...:refresh_token); the server keeps only that, in the session.
PingFederate accepts either, but each type needs its own token exchange processor policy. The other IdP desktop clients here send the ID token (...:id_token) instead.`,
      },
      {
        title: "What PingFederate needs before this works (docs/setup-guides.md)",
        code: `1. Token exchange processor policy matching the subject token type sent (refresh_token or id_token); maps the
   user into the policy contract. No matching policy: the exchange is refused.
2. OAuth client with the token exchange, authorization code and refresh token grants. It must be CONFIDENTIAL:
   PingFederate refuses public clients ("Public clients are not permitted to request an id-jag token").
3. SP connection of type "OAuth token exchange" with ID-JAG enabled. It sets:
   audience = the resource AS issuer, exactly; the client_id claim mapping (the id the redeemer will see);
   the scope mapping (here read mcp:invoke); and the ID-JAG lifetime, 5 minutes (300 s).
4. A JWT access token manager signing with the chosen certificate, with "Publish Keys to the PingFederate JWKS
   Endpoint" on. Without it the key never reaches /pf/JWKS and no redeemer can verify the ID-JAG.
5. Keep the JWKS to one static key (see step 3).`,
      },
    ],
    tokens: [ID_JAG],
    refs: [
      ...TOKEN_EXCHANGE,
      ...IDJAG,
      ...JWT,
      RFC(6749, "The OAuth 2.0 Authorization Framework"),
    ],
  },

  3: {
    forms: [
      {
        title: "Redeem the ID-JAG at resource-as (RFC 7523 JWT bearer)",
        code: `${REDEEM_HEAD}
${redeemBody("<ID-JAG>")}`,
      },
      {
        title: "Response",
        code: `HTTP/1.1 200 OK
Cache-Control: no-store
Content-Type: application/json

{
  "access_token": "<access token>",
  "token_type": "Bearer",
  "expires_in": 3600,
  "scope": "read mcp:invoke"
}`,
      },
      {
        title: "Trust lookup resource-as makes first",
        code: `GET /api/id-jag-playground/trusted-idps/registry HTTP/1.1
Host: playground.example.com
Authorization: Bearer <ID_JAG_REGISTRY_TOKEN>

{ "idps": [ {
    "id": "pf-as",
    "issuer": "${PF}",
    "jwksUrl": "${PF}/pf/JWKS",
    "clientAliases": { "id-jag-kit": "id-jag-playground", "id-jag-playground": "id-jag-playground" },
    "scopes": ""
} ] }

# resource-as picks the entry by the UNVERIFIED iss in the assertion, then verifies against that entry only.
# No entry: 400 invalid_grant "ID-JAG issuer is not trusted". Cached 30 s.`,
      },
      {
        title: "Signature key from PingFederate",
        code: `GET /pf/JWKS HTTP/1.1
Host: pf.example.com:9031

{ "keys": [ { "kty": "RSA", "alg": "RS256", "use": "sig", "x5t": "<sha-1 thumbprint>", "n": "<modulus>", "e": "AQAB" } ] }

# The ID-JAG header carries x5t and no kid, so resource-as selects the key by x5t and requires exactly one distinct match.
# Sample vs real PingFederate: resource-as has its own key resolver for x5t. PingFederate's own JWT bearer consumer
# (the "Our PingFederate" redeemer target) cannot pick a key by x5t, which is why the issuer JWKS must hold ONE
# static key, and it caches that JWKS and does not refetch without a kid (restart PingFederate after a key change).
# On a JWT bearer request PingFederate also answers invalid_target for a resource no access token manager lists.`,
      },
      {
        title: "What resource-as checks, in order",
        code: `1. client authentication: Basic AND client_secret in the
   body                                                    -> 400 invalid_request "use one client authentication method, not two"
   unknown client, bad secret, malformed Basic, or a
   public client with ALLOW_PUBLIC_CLIENTS off             -> 401 invalid_client
2. grant_type is jwt-bearer, assertion present             -> unsupported_grant_type / invalid_request
   more than one resource parameter                        -> invalid_target "request at most one resource"
3. iss is a trusted IdP (registry or file)                 -> invalid_grant "ID-JAG issuer is not trusted"
4. RS256 signature vs the IdP's JWKS (x5t or kid)          -> invalid_grant
   typ = oauth-id-jag+jwt, iss, aud = our issuer (one value),
   exp/iat (5 s tolerance), iss/sub/aud/client_id/jti/exp/iat present
5. resource claim is in ACCEPTED_RESOURCES; a resource
   parameter, if sent, equals it                           -> invalid_target
6. client_id is an alias key for this IdP and maps to
   the authenticated client                                -> invalid_grant "client_id is not assigned to this IdP"
7. scope = ID-JAG scope AND client scope AND request
   scope AND IdP cap; empty is an error                    -> invalid_scope
8. jti consumed last (single use, kept until exp)          -> invalid_grant "already redeemed"`,
      },
    ],
    tokens: [ID_JAG, ACCESS_TOKEN],
    refs: [
      ...JWT_BEARER,
      ...IDJAG,
      ...JWT,
      ...TOKEN_EXCHANGE,
      ...AS_METADATA,
      ...BEARER,
      RFC(8725, "JSON Web Token Best Current Practices"),
      RFC(7638, "JSON Web Key (JWK) Thumbprint"),
    ],
  },

  4: {
    forms: [
      {
        title: "Discovery: no token, so a challenge (RFC 9728)",
        code: `POST /mcp HTTP/1.1
Host: mcp.example.com
Content-Type: application/json

{"jsonrpc":"2.0","id":1,"method":"tools/list"}

HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"

GET /.well-known/oauth-protected-resource  ->
{ "resource": "${MCP}",
  "authorization_servers": ["${RAS}"],
  "scopes_supported": ["read", "mcp:invoke"],
  "bearer_methods_supported": ["header"] }

# The playground already holds the token, so it skips straight to the calls below. A real MCP client follows this
# document to resource-as (RFC 8414 metadata at /.well-known/oauth-authorization-server) to learn where to go.
# Sample vs RFC 9728 section 3.1: for a resource at /mcp the RFC puts the well-known segment between host and path,
# /.well-known/oauth-protected-resource/mcp. mcp-sample advertises the root form in its challenge and answers ANY path
# starting with /.well-known/oauth-protected-resource, so both spellings return the same document.`,
      },
      {
        title: "tools/list with resource-as's token",
        code: `POST /mcp HTTP/1.1
Host: mcp.example.com
Authorization: Bearer <access token>
Content-Type: application/json
Accept: application/json, text/event-stream

{"jsonrpc":"2.0","id":1,"method":"tools/list"}

HTTP/1.1 200 OK
{ "jsonrpc": "2.0", "id": 1, "result": {
    "tools": [ { "name": "whoami" }, { "name": "echo" }, { "name": "server_time" } ],
    "_meta": { "deniedTools": [] } } }
# mcp-sample checks the token against resource-as's keys (AS_JWKS_URL, default ${RAS}/jwks), NOT PingFederate's:
# PingFederate signed the ID-JAG, but the access token is resource-as's own and is verified with its own kid.
# With scope "read" only, echo and server_time move to _meta.deniedTools with requiredScope "mcp:invoke".`,
      },
      {
        title: "tools/call whoami",
        code: `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"whoami","arguments":{}}}

{ "jsonrpc": "2.0", "id": 1, "result": { "content": [ { "type": "text",
    "text": "{\\"sub\\":\\"user.0042\\",\\"client_id\\":\\"id-jag-playground\\",\\"scope\\":\\"read mcp:invoke\\"}" } ] } }

# A tool outside the token's scope: HTTP 403, WWW-Authenticate: Bearer error="insufficient_scope", scope="mcp:invoke", ...
# body error { code: -32003, message: "insufficient_scope", data: { tool, requiredScope } }`,
      },
      {
        title: "Protected page: the token, no token, the raw ID-JAG",
        code: `GET /protected/profile HTTP/1.1
Host: mcp.example.com
Authorization: Bearer <access token>

200 { "resource": "https://mcp.example.com/protected/profile",   (the page URL, not the MCP resource)
      "verified": [ { "check": "bearer", "ok": true, "detail": "Authorization: Bearer present." },
                    { "check": "token type", "ok": true, "detail": "JWT access token (typ at+jwt), not an ID-JAG." },
                    { "check": "signature", "ok": true, "detail": "Verified against the authorization server's keys (${RAS}/jwks)." },
                    { "check": "expiry", "ok": true, "detail": "<n> s left." },
                    { "check": "issuer", "ok": true, "detail": "iss ${RAS} is trusted." },
                    { "check": "audience", "ok": true, "detail": "aud \"${MCP}\" is this resource server." },
                    { "check": "scope", "ok": true, "detail": "Has read." } ],
      "principal": { "sub": "user.0042", "client_id": "id-jag-playground", "scope": "read mcp:invoke" },
      "data": { "subject": "user.0042", "status": "active", "servedBy": "id-jag-mcp-sample", ... } }

No Authorization header          -> 401 invalid_request, verified stops at "bearer"
Authorization: Bearer <ID-JAG>   -> 401 invalid_token, verified stops at "token type":
  "This is an ID-JAG (typ oauth-id-jag+jwt): a grant for the authorization server to redeem, never an access token for a resource."`,
      },
    ],
    tokens: [
      ACCESS_TOKEN,
      {
        note: "The raw ID-JAG, sent to the protected page on purpose. mcp-sample reads typ oauth-id-jag+jwt in the header and refuses it before it even checks a signature: an ID-JAG is a grant for the authorization server, never a bearer token for a resource. (Its aud is resource-as, so the audience check would also fail.)",
        header: ID_JAG.header,
        claims: ID_JAG.claims,
      },
    ],
    refs: [
      SPEC("MCP authorization", "Model Context Protocol: Authorization"),
      ...PROTECTED_RESOURCE,
      ...BEARER,
      ...AS_METADATA,
      ...JWT,
    ],
  },

  5: {
    forms: [
      {
        title: "Replay: redeem the same ID-JAG twice",
        code: `${REDEEM_HEAD}
${redeemBody("<ID-JAG, already redeemed once>")}

HTTP/1.1 400 Bad Request
{ "error": "invalid_grant", "error_description": "ID-JAG already redeemed (replay rejected)" }

# jti is consumed last and remembered until the ID-JAG's exp (survives a resource-as restart).
# The draft lets a client resubmit; this sample refuses, which is stricter.`,
      },
      {
        title: "Tampered signature",
        code: `${REDEEM_HEAD}
${redeemBody("<ID-JAG with the last bytes of its signature changed>")}

HTTP/1.1 400 Bad Request
{ "error": "invalid_grant", "error_description": "ID-JAG verification failed: signature verification failed" }`,
      },
      {
        title: "Different client",
        code: `POST /token HTTP/1.1
Host: as.example.com
Content-Type: application/x-www-form-urlencoded

grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<ID-JAG>&client_id=some-other-client

HTTP/1.1 401 Unauthorized
{ "error": "invalid_client", "error_description": "client authentication failed" }

# A registered client that is not mapped for this IdP gets invalid_grant "ID-JAG client_id is not assigned to this IdP" instead.`,
      },
      {
        title: "Scope the ID-JAG never granted",
        code: `${REDEEM_HEAD}
${redeemBody("<ID-JAG>", "&scope=admin:delete")}

HTTP/1.1 400 Bad Request
{ "error": "invalid_scope", "error_description": "ID-JAG grants no scope this client may use for this request" }

# Granted scope is the intersection of the ID-JAG scope, the client's scope, the request scope and the IdP cap.
# It is never widened and never defaulted.`,
      },
    ],
    tokens: [
      {
        note: "Each test first asks PingFederate for a fresh ID-JAG (step 2 again, because PingFederate's are single-use here), then breaks exactly one thing: repeats it, flips signature bytes, authenticates as another client, or asks for admin:delete. The claims below are the untouched ID-JAG. A pass is an OAuth error and no access token.",
        header: ID_JAG.header,
        claims: { ...ID_JAG.claims, jti: "<fresh unique id>" },
      },
    ],
    refs: [
      ...JWT_BEARER,
      ...IDJAG,
      ...JWT,
      RFC(6749, "The OAuth 2.0 Authorization Framework"),
      RFC(8725, "JSON Web Token Best Current Practices"),
      DRAFT("draft-ietf-oauth-identity-assertion-authz-grant", "Identity Assertion JWT Authorization Grant"),
    ],
  },
};

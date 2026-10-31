// Step detail for the "byo" playground diagram: { [step 1-5]: { forms, tokens, refs } }. See utils/idJagStepDetail.js.
// Bring your own IdP: an admin approves the issuer on the Trusted IdPs registry, you paste an ID-JAG,
// resource-as validates it against the registry. Every value is a teaching placeholder, never a secret.
import { RFC, SPEC, TOKEN_EXCHANGE, JWT_BEARER, JWT, AS_METADATA, PROTECTED_RESOURCE, BEARER, IDJAG } from "../idJagStandards.js";

const OAUTH = RFC(6749, "The OAuth 2.0 Authorization Framework");
const JWT_BCP = RFC(8725, "JSON Web Token Best Current Practices");
const PKCE = RFC(7636, "Proof Key for Code Exchange by OAuth Public Clients");
const OIDC = SPEC("OpenID Connect Core 1.0", "OpenID Connect Core 1.0");

// The ID-JAG as the outside IdP mints it (decoded). client_id is the id the IdP writes for us:
// the registry entry's "client_id your IdP writes in the ID-JAG" (idp-<id> by default).
const ID_JAG = {
  note: "ID-JAG from the outside IdP: typ oauth-id-jag+jwt, aud = our resource AS issuer (one value), client_id = the id the registry entry maps, resource = the MCP server. Lives 300 s.",
  header: { typ: "oauth-id-jag+jwt", alg: "RS256", kid: "partner-signing-1" },
  claims: {
    iss: "https://idp.partner.example.com",
    sub: "user-1234",
    aud: "https://as.example.com",
    client_id: "idp-partner",
    jti: "5c0f9d3e-2b7a-4e61-9a8d-3f1c7e2b4a90",
    iat: 1790000000,
    exp: 1790000300,
    resource: "https://mcp.example.com/mcp",
    scope: "read mcp:invoke",
  },
};

// What resource-as issues: a JWT access token (RFC 9068 profile, typ at+jwt), audience = the one resource.
const ACCESS_TOKEN = {
  note: "Access token resource-as mints: iss = resource-as, aud = the MCP resource (from the ID-JAG), client_id = the redeeming client, scope = the intersection. 1 h, no refresh token.",
  header: { typ: "at+jwt", alg: "RS256", kid: "<thumbprint of resource-as signing key>" },
  claims: {
    iss: "https://as.example.com",
    sub: "user-1234",
    aud: "https://mcp.example.com/mcp",
    client_id: "idp-partner",
    scope: "read mcp:invoke",
    jti: "e8a41b6c-90d2-4f37-b5a1-7c2d9e0f3b18",
    iat: 1790000100,
    exp: 1790003700,
  },
};

const TOKEN_FORM = [
  "POST /token HTTP/1.1",
  "Host: as.example.com",
  "Authorization: Basic <base64 of client_id:client_secret>",
  "Content-Type: application/x-www-form-urlencoded",
  "",
  "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer",
  "&assertion=<ID-JAG>",
  "&client_id=idp-partner",
  "&resource=https%3A%2F%2Fmcp.example.com%2Fmcp",
  "&scope=read%20mcp%3Ainvoke",
].join("\n");

export default {
  1: {
    forms: [
      {
        title: "Your IdP: RFC 8693 token exchange for an ID-JAG (not our code)",
        code: [
          "POST /oauth2/v1/token HTTP/1.1",
          "Host: idp.partner.example.com",
          "Content-Type: application/x-www-form-urlencoded",
          "",
          "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange",
          "&requested_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aid-jag",
          "&subject_token=<ID token>",
          "&subject_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aid_token",
          "&audience=https%3A%2F%2Fas.example.com",
          "&resource=https%3A%2F%2Fmcp.example.com%2Fmcp",
          "&scope=read%20mcp%3Ainvoke",
          "&client_id=<the agent's client at its own IdP>",
          "",
          "// Endpoint path and client authentication are your IdP's (PingFederate: /as/token.oauth2).",
          "// subject_token: the draft names an ID token (or SAML 2.0 assertion) as the subject token; some IdPs accept more (see the xaa.dev form).",
          "// audience = the resource AS issuer; response: { access_token: <ID-JAG>, issued_token_type: ...:id-jag, token_type: N_A }",
        ].join("\n"),
      },
      {
        title: "Paste: this server keeps the ID-JAG and checks it",
        code: [
          "POST /api/id-jag-playground/byo/inspect HTTP/1.1",
          "Content-Type: application/json",
          "",
          '{ "idJag": "<ID-JAG>", "target": "resource-as" }',
          "",
          "// 400 invalid_id_jag unless it is a compact JWT (header.payload.signature, max 16384 chars).",
          '// target is "resource-as" or "pingfederate". The raw ID-JAG stays in the server session; the browser sees decoded claims.',
        ].join("\n"),
      },
      {
        title: "Or xaa.dev: code + PKCE sign-in, then RFC 8693 at IdenX",
        code: [
          "GET /api/id-jag-playground/xaa/login        -> 302 to IdenX authorize",
          "  response_type=code&scope=openid profile email offline_access&prompt=consent",
          "  &code_challenge=<S256 challenge>&code_challenge_method=S256&state=<state>&nonce=<nonce>",
          "",
          "POST /api/id-jag-playground/xaa/id-jag      -> server calls IdenX:",
          "POST <token_endpoint from https://idp.xaa.dev/.well-known/openid-configuration>",
          "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange",
          "&requested_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aid-jag",
          "&subject_token=<IdenX refresh token>&subject_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Arefresh_token",
          "// A refresh token as subject_token is what IdenX accepts here; it is IdP-specific, not what the draft describes (ID token or SAML assertion).",
          "&audience=<resource-as public issuer>&resource=<MCP resource>&scope=read",
          "&client_id=<requesting app>&client_secret=<client secret>",
        ].join("\n"),
      },
    ],
    tokens: [ID_JAG],
    refs: [...TOKEN_EXCHANGE, ...IDJAG, ...JWT, JWT_BCP, PKCE, OIDC],
  },

  2: {
    forms: [
      {
        title: "Trust root: an admin approves the issuer on the Trusted IdPs registry",
        code: [
          "POST /api/id-jag-playground/trusted-idps HTTP/1.1      (signed in; entry starts pending)",
          "Content-Type: application/json",
          "",
          "{",
          '  "id": "partner", "name": "Partner IdP", "product": "generic",',
          '  "issuer": "https://idp.partner.example.com",',
          '  "jwksUrl": "https://idp.partner.example.com/jwks",',
          '  "idJagClientId": "idp-partner",',
          '  "targets": ["resource-as"], "scopes": "read mcp:invoke"',
          "}",
          "",
          "POST /api/id-jag-playground/trusted-idps/partner/approve      (admin only)",
          "// An approved resource-as entry also gets its own client idp-partner, with the scope cap above.",
          "// Entries hold no secrets. Editing issuer, jwksUrl, client id, targets or scopes sends an approved entry back to pending.",
        ].join("\n"),
      },
      {
        title: "Lookup: the unverified iss picks the entry, then the IdP's JWKS verifies",
        code: [
          "// This server (inspect): trustedIdps.findByIssuer(iss) -> approved entry whose targets include the target.",
          "// No entry, or not for this target: trusted:false, hint \"Add this issuer on the Trusted IdPs panel\".",
          "GET /jwks HTTP/1.1",
          "Host: idp.partner.example.com",
          "",
          "// A plain GET of the registry entry's jwksUrl; the key is picked by kid, or by x5t when the header carries it.",
          "// resource-as (step 3) reads the same registry server-to-server:",
          "GET /api/id-jag-playground/trusted-idps/registry HTTP/1.1",
          "Authorization: Bearer <ID_JAG_REGISTRY_TOKEN>",
          "",
          '{ "idps": [ { "id": "partner", "issuer": "https://idp.partner.example.com",',
          '    "jwksUrl": "https://idp.partner.example.com/jwks",',
          '    "clientAliases": { "idp-partner": "idp-partner" }, "scopes": "read mcp:invoke" } ] }',
          "",
          "// resource-as caches the list 30 s and keeps the last good list if a fetch fails.",
        ].join("\n"),
      },
    ],
    tokens: [ID_JAG],
    refs: [...IDJAG, ...JWT, ...AS_METADATA, JWT_BCP],
  },

  3: {
    forms: [
      {
        title: "RFC 7523 JWT bearer grant at resource-as",
        code: TOKEN_FORM + "\n\n// client_secret_basic or client_secret_post, never both. client_id is the registry entry's idp-<id>.\n// resource, if sent, must equal the ID-JAG resource (a trailing slash is ignored).",
      },
      {
        title: "What resource-as checks, in order (any miss: no token)",
        code: [
          "1 client auth                     401 invalid_client",
          "2 grant_type = jwt-bearer         unsupported_grant_type / invalid_request",
          "3 iss is a trusted IdP            400 invalid_grant  ID-JAG issuer is not trusted",
          "4 RS256 signature via IdP JWKS (x5t honoured when present), typ oauth-id-jag+jwt,",
          "  aud = this issuer (single value), exp/iat (5 s skew), iss sub aud client_id jti exp iat present",
          "                                  400 invalid_grant",
          "5 resource claim is in ACCEPTED_RESOURCES   400 invalid_target",
          "6 client_id is a clientAliases key mapped to the redeeming client   400 invalid_grant",
          "7 scope = ID-JAG scope AND client scope AND request scope AND IdP cap   400 invalid_scope when empty",
          "8 jti consumed last (iss + jti, kept until exp)   400 invalid_grant  already redeemed",
        ].join("\n"),
      },
      {
        title: "Response",
        code: [
          "HTTP/1.1 200 OK",
          "Cache-Control: no-store",
          "Content-Type: application/json",
          "",
          '{ "access_token": "<access token>", "token_type": "Bearer", "expires_in": 3600, "scope": "read mcp:invoke" }',
        ].join("\n"),
      },
      {
        title: "Target = our PingFederate (the other redeemer)",
        code: [
          "POST /as/token.oauth2 HTTP/1.1",
          "Host: <PF_URL>",
          "Authorization: Basic <base64 of client_id:client secret>",
          "Content-Type: application/x-www-form-urlencoded",
          "",
          "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=<ID-JAG>",
          "&client_id=<entry pfClientId, default PF_REDEEMER_CLIENT_ID>&resource=<PF_RESOURCE>",
          "",
          "// For this target the ID-JAG is addressed to PingFederate: aud = the PF_URL issuer, resource = PF_RESOURCE (see the third token),",
          "// and the redeeming client is the entry's pfClientId, not the idp-<id> client of the resource-as variant.",
          "// pingfederate/sync-id-jag-trusted-idps.js builds one IdP connection per approved entry (id idjag-<id>,",
          "// entity id = issuer, its JWKS), mapped to an access token manager. The client needs the EXTENSION grant type,",
          "// and the resource must be listed on the access token manager or PingFederate answers invalid_target.",
          "// PingFederate caches the IdP's JWKS: restart it after the issuer rotates keys.",
        ].join("\n"),
      },
    ],
    tokens: [
      ID_JAG,
      ACCESS_TOKEN,
      {
        ...ID_JAG,
        note: "Target = our PingFederate: the same ID-JAG addressed to PingFederate instead. aud = the PF_URL issuer and resource = PF_RESOURCE; the redeeming client_id sent is the entry's pfClientId. PingFederate's own access token is not mocked here (its format depends on the access token manager).",
        claims: { ...ID_JAG.claims, aud: "https://pf.example.com", resource: "https://pf-resource.example.com" },
      },
    ],
    refs: [
      ...JWT_BEARER, ...IDJAG, ...JWT, ...BEARER, OAUTH, JWT_BCP,
      RFC(8707, "Resource Indicators for OAuth 2.0 (the resource parameter)"),
    ],
  },

  4: {
    forms: [
      {
        title: "Discovery: protected resource metadata (RFC 9728)",
        code: [
          "POST /mcp HTTP/1.1                     (no token)",
          "Host: mcp.example.com",
          "",
          "HTTP/1.1 401 Unauthorized",
          'WWW-Authenticate: Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
          "",
          "GET /.well-known/oauth-protected-resource HTTP/1.1",
          "",
          '{ "resource": "https://mcp.example.com/mcp", "authorization_servers": ["https://as.example.com"],',
          '  "scopes_supported": ["read", "mcp:invoke"], "bearer_methods_supported": ["header"] }',
          "",
          "// authorization_servers names resource-as; its RFC 8414 metadata (/.well-known/oauth-authorization-server)",
          "// lists the jwt-bearer grant and /jwks. The playground skips discovery and calls the configured MCP_URL.",
        ].join("\n"),
      },
      {
        title: "tools/list with the access token",
        code: [
          "POST /mcp HTTP/1.1",
          "Host: mcp.example.com",
          "Authorization: Bearer <access token>",
          "Content-Type: application/json",
          "Accept: application/json, text/event-stream",
          "",
          '{ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }',
          "",
          '// result.tools = tools the scope allows (whoami needs read; echo and server_time need mcp:invoke);',
          '// result._meta.deniedTools = [{ "name": "echo", "requiredScope": "mcp:invoke" }] for the rest.',
          "// tools/call outside the scope: HTTP 403, WWW-Authenticate error=\"insufficient_scope\", JSON-RPC code -32003.",
        ].join("\n"),
      },
      {
        title: "Protected page, and the refusals it demonstrates",
        code: [
          "GET /protected/profile HTTP/1.1",
          "Authorization: Bearer <access token>",
          "",
          '200 { "resource": ..., "verified": [ bearer, token type, signature, expiry, issuer, audience, scope ], "principal": { "sub", "client_id", "scope" }, "data": ... }',
          "",
          "// Same request with the raw ID-JAG: 401, failed check \"token type\" (typ oauth-id-jag+jwt is a grant, never an access token).",
          "// With no token: 401 invalid_request. With a token from our PingFederate: refused, because",
          "// mcp-sample trusts resource-as's JWKS and issuer only (which check fails first depends on the PF token format; not verified here).",
        ].join("\n"),
      },
    ],
    tokens: [ACCESS_TOKEN],
    refs: [...PROTECTED_RESOURCE, SPEC("MCP authorization", "Model Context Protocol: Authorization"), ...BEARER, ...AS_METADATA],
  },

  5: {
    forms: [
      {
        title: "Tampered signature (last two characters of the signature changed)",
        code: TOKEN_FORM.replace("<ID-JAG>", "<your ID-JAG with a flipped signature>") + "\n\nHTTP/1.1 400\n" + '{ "error": "invalid_grant", "error_description": "ID-JAG verification failed: signature verification failed" }',
      },
      {
        title: "Redeemed by a different client (no credentials)",
        code: [
          "POST /token HTTP/1.1",
          "Content-Type: application/x-www-form-urlencoded",
          "",
          "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=<ID-JAG>&client_id=some-other-client",
          "",
          "HTTP/1.1 401",
          '{ "error": "invalid_client", "error_description": "client authentication failed" }',
          "",
          "// Had the client authenticated, the strict clientAliases binding would answer invalid_grant:",
          '// "ID-JAG client_id is not assigned to this IdP".',
        ].join("\n"),
      },
      {
        title: "Scope the IdP did not grant",
        code: [
          TOKEN_FORM.replace("&scope=read%20mcp%3Ainvoke", "&scope=admin%3Adelete").replace("<ID-JAG>", "<your ID-JAG>"),
          "",
          "HTTP/1.1 400",
          '{ "error": "invalid_scope", "error_description": "ID-JAG grants no scope this client may use for this request" }',
        ].join("\n"),
      },
      {
        title: "Replay: skipped in this mode",
        code: [
          "// A replay test redeems your pasted ID-JAG once, then again: the first redeem uses it up.",
          "// resource-as would answer the second with 400 invalid_grant \"ID-JAG already redeemed (replay rejected)\".",
          "// The sample's single-use jti is a hardening beyond the draft; entries are kept until exp and survive a restart.",
        ].join("\n"),
      },
    ],
    tokens: [
      {
        ...ID_JAG,
        note: "Your pasted ID-JAG, reused for each test (we cannot mint at your IdP). Claims are unchanged: the bad-signature test only alters the signature, the others change the client or the requested scope. A refused request issues no token.",
      },
    ],
    refs: [...JWT_BEARER, ...IDJAG, ...JWT, OAUTH, JWT_BCP],
  },
};

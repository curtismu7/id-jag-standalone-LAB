// Step detail for the "mock" playground diagram: { [step 1-5]: { forms, tokens, refs }, ... }. See utils/idJagStepDetail.js.
// Hosts, ids and claims mirror idJagPlaygroundMock.js (what the page shows). Request shapes mirror what the real
// server (server/src/idJagPlayground.js), resource-as and mcp-sample send and accept. Nothing here is a real secret.
import {
  RFC, DRAFT, SPEC, TOKEN_EXCHANGE, JWT_BEARER, JWT, AS_METADATA, PROTECTED_RESOURCE, BEARER, IDJAG, MCP_AUTH,
} from "../idJagStandards.js";

const IAT = 1790000000; // sample clock: fixed so the decoded tokens read the same on every visit
const AS = "https://mcp-as.example.com";
const MCP = "https://mcp.example.com/mcp";
const PF = "https://pingfederate.example.com";
const MOCK_NOTE = "(Mock) values are shown URL-decoded; on the wire each is form-encoded.";

// The ID-JAG as the mock mints it (typ oauth-id-jag+jwt, aud = the resource AS issuer, resource = the MCP server).
const idJagToken = (note) => ({
  note,
  header: { typ: "oauth-id-jag+jwt", alg: "RS256", kid: "pf-signing-2026" },
  claims: {
    iss: PF, sub: "user.0042", aud: AS, client_id: "agent-mcp-client", jti: "b3f1c6e2-7a4d-4c1e-9f2a-5d8e0c3a1b77",
    iat: IAT, exp: IAT + 300, resource: MCP, scope: "openid mcp:read mcp:write",
  },
});

// The access token resource-as mints (typ at+jwt, aud = the MCP resource, 3600 s).
const accessToken = (note) => ({
  note,
  header: { typ: "at+jwt", alg: "RS256", kid: "as-signing-1" },
  claims: {
    iss: AS, sub: "user.0042", aud: MCP, client_id: "agent-mcp-client", scope: "openid mcp:read mcp:write",
    iat: IAT + 20, exp: IAT + 20 + 3600, jti: "8c2d4e1f-0b3a-4f6e-a1d2-9e7c5b3a2f10",
  },
});

// Step 4 follows the Mock fixtures (tools search_records, get_record, create_note; scopes mcp:read, mcp:write, mcp:admin).
// The shipped mcp-sample differs, and each step-4 form says so rather than mixing the two.
const REAL_SCOPE_NOTE = "Mock values. The shipped mcp-sample has other tools (whoami, echo, server_time) and other scopes (read, mcp:invoke).";

export default {
  1: {
    forms: [
      {
        title: "Mock: the page asks for its config (no network)",
        code: [
          "GET /api/id-jag-playground/config      <- answered by mockApi.get() inside the page",
          "",
          "200 OK",
          '{ "mode": "mock", "signedIn": true,',
          '  "idp": { "issuer": "https://pingfederate.example.com", "tokenEndpoint": "https://pingfederate.example.com/as/token.oauth2" },',
          '  "resourceAs": { "issuer": "https://mcp-as.example.com", "clientId": "agent-mcp-client" },',
          '  "request": { "audience": "https://mcp-as.example.com", "resource": "https://mcp.example.com/mcp", "scope": "openid mcp:read mcp:write" } }',
        ].join("\n"),
      },
      {
        title: "Real modes (not Mock): the sign-in this step skips",
        code: [
          "GET https://<your PingFederate>/as/authorization.oauth2?",
          "    response_type=code",
          "    &client_id=<exchange client id>",
          "    &redirect_uri=<playground>/api/id-jag-playground/issuer/callback",
          "    &scope=openid profile email offline_access",
          "    &state=<random>&code_challenge=<PKCE challenge>&code_challenge_method=S256",
          "    (the issuer sign-in also adds prompt=login and response_mode=pi.flow)",
          "",
          "# Back at /issuer/callback the server swaps the code:",
          "POST /as/token.oauth2",
          "Authorization: Basic <exchange client id:secret>",
          "Content-Type: application/x-www-form-urlencoded",
          "",
          "grant_type=authorization_code&code=<authorization code>",
          "&redirect_uri=<playground>/api/id-jag-playground/issuer/callback&code_verifier=<PKCE verifier>",
          "",
          "# The refresh token it returns is held server-side and is the subject_token of step 2.",
          "# Mock mode has no user, so it has no refresh token.",
        ].join("\n"),
      },
    ],
    tokens: [],
    refs: [RFC(6749, "The OAuth 2.0 Authorization Framework"), RFC(7636, "Proof Key for Code Exchange (PKCE)"), ...IDJAG],
  },

  2: {
    forms: [
      {
        title: "Browser to page: the button press (Mock, no network)",
        code: "POST /api/id-jag-playground/issue      <- mockApi.post(); real modes send this to the playground server (cookie only)",
      },
      {
        title: "The RFC 8693 token exchange the Mock stands in for",
        code: [
          "POST /as/token.oauth2 HTTP/1.1",
          "Host: pingfederate.example.com",
          "Authorization: Basic <exchange client id:secret>",
          "Content-Type: application/x-www-form-urlencoded",
          "",
          "grant_type=urn:ietf:params:oauth:grant-type:token-exchange",
          "&requested_token_type=urn:ietf:params:oauth:token-type:id-jag",
          "&subject_token=<refresh token, kept server-side>",
          "&subject_token_type=urn:ietf:params:oauth:token-type:refresh_token",
          "&audience=https://mcp-as.example.com",
          "&resource=https://mcp.example.com/mcp",
          "&scope=openid mcp:read mcp:write",
          "",
          MOCK_NOTE,
          "audience = the resource AS issuer (who will redeem it); resource = the MCP server (what the access token is for).",
          "Differs from the draft: as I read it, the draft's subject token is an identity assertion (an OIDC ID Token or a SAML 2.0",
          "assertion). This sample, and so the Mock, exchanges a refresh token held server-side. Check the current draft revision.",
        ].join("\n"),
      },
      {
        title: "Response: the ID-JAG travels in access_token",
        code: [
          "HTTP/1.1 200 OK",
          "",
          "{ \"issued_token_type\": \"urn:ietf:params:oauth:token-type:id-jag\",",
          "  \"token_type\": \"N_A\",",
          "  \"access_token\": \"<the ID-JAG>\" }",
          "",
          "token_type is N_A (RFC 8693 §2.2.1): the value is not a bearer token, it is a grant for the resource AS.",
          "The page never receives the raw value; it shows the decoded claims below.",
        ].join("\n"),
      },
      {
        title: "SAML variant (Mock fixture only): an assertion first buys a refresh token",
        code: [
          "POST /as/token.oauth2",
          "grant_type=urn:ietf:params:oauth:grant-type:token-exchange",
          "&requested_token_type=urn:ietf:params:oauth:token-type:refresh_token",
          "&subject_token=<signed SAML assertion, base64url>",
          "&subject_token_type=urn:ietf:params:oauth:token-type:saml2",
          "&scope=openid offline_access",
          "",
          "# then the exchange above runs with that refresh token.",
          "# Only idJagPlaygroundMock.js models this: server/ and resource-as have no SAML path. The Mock's SAML ID-JAG adds a",
          '# sub_id claim { "format": "saml-nameid", ... } that is its own fixture, not tied to a cited spec, and not in the token decoded below.',
        ].join("\n"),
      },
    ],
    tokens: [
      idJagToken("(Mock) The ID-JAG: typ oauth-id-jag+jwt, aud is the resource AS issuer, resource names the MCP server, 300 s lifetime. The subject_token (a refresh token) is opaque, so it is not decoded. Real PingFederate signs with x5t and no kid; the Mock header shows a kid for readability."),
    ],
    refs: [
      ...TOKEN_EXCHANGE, ...IDJAG, ...JWT,
      RFC(8725, "JSON Web Token Best Current Practices"),
      DRAFT("draft-ietf-oauth-identity-assertion-authz-grant", "Identity Assertion JWT Authorization Grant (the ID-JAG, typ oauth-id-jag+jwt)"),
    ],
  },

  3: {
    forms: [
      {
        title: "RFC 7523 jwt-bearer redemption at the resource AS",
        code: [
          "POST /token HTTP/1.1",
          "Host: mcp-as.example.com",
          "Authorization: Basic <agent-mcp-client:secret>",
          "Content-Type: application/x-www-form-urlencoded",
          "",
          "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer",
          "&assertion=<the ID-JAG>",
          "&client_id=agent-mcp-client",
          "&resource=https://mcp.example.com/mcp",
          "&scope=openid mcp:read mcp:write",
          "",
          MOCK_NOTE,
          "resource-as accepts client_secret_basic or client_secret_post, never both. Real resource-as refuses an unauthenticated client (invalid_client).",
        ].join("\n"),
      },
      {
        title: "What resource-as checks, in order (resource-as/src/app.js, idjag.js)",
        code: [
          "1. client authentication            -> 401 invalid_client",
          "2. grant_type is jwt-bearer         -> unsupported_grant_type; assertion present -> invalid_request;",
          "   more than one resource parameter -> invalid_target",
          "3. iss (unverified) is a trusted IdP -> invalid_grant  'ID-JAG issuer is not trusted'",
          "4. signature via the IdP JWKS (RS256 pinned; x5t must match exactly one distinct key)",
          "   typ = oauth-id-jag+jwt, iss = IdP, aud = this issuer (single value),",
          "   iss/sub/aud/client_id/jti/exp/iat present, exp valid (5 s clock tolerance) -> invalid_grant",
          "5. the resource CLAIM is in ACCEPTED_RESOURCES -> invalid_target",
          "6. client_id is a clientAliases key of that IdP and maps to the redeeming client -> invalid_grant",
          "7. a resource PARAMETER, if sent, equals the resource claim -> invalid_target",
          "8. scope = ID-JAG scope AND client scope AND request scope AND IdP cap; empty -> invalid_scope",
          "9. jti consumed last (single use); a replay -> invalid_grant",
        ].join("\n"),
      },
      {
        title: "Where trust comes from: the JWKS read (dashed arrow)",
        code: [
          "GET https://pingfederate.example.com/pf/JWKS",
          "",
          "# PingFederate publishes one static key. Its ID-JAGs carry x5t and no kid, so resource-as matches on x5t.",
          "# resource-as only fetches a JWKS for an issuer its trusted-IdP list (file or registry) names.",
        ].join("\n"),
      },
      {
        title: "Response: the access token",
        code: [
          "HTTP/1.1 200 OK",
          "Cache-Control: no-store",
          "",
          "{ \"access_token\": \"<access token>\", \"token_type\": \"Bearer\", \"expires_in\": 3600,",
          "  \"scope\": \"openid mcp:read mcp:write\" }",
          "",
          "No refresh token is ever issued. aud of the access token is the resource, not the AS.",
        ].join("\n"),
      },
    ],
    tokens: [
      idJagToken("In: the ID-JAG the AS verifies and consumes (jti is recorded so a second redemption fails)."),
      accessToken("Out: resource-as mints its own at+jwt. aud is the MCP resource (RFC 8707), sub is copied from the ID-JAG, client_id is the redeeming client, scope is the intersection of grants."),
    ],
    refs: [
      ...JWT_BEARER, ...TOKEN_EXCHANGE, ...JWT, ...AS_METADATA, ...IDJAG,
      RFC(8725, "JSON Web Token Best Current Practices"),
      DRAFT("draft-ietf-oauth-identity-assertion-authz-grant", "Identity Assertion JWT Authorization Grant (redeeming an ID-JAG at the resource AS)"),
      RFC(9068, "JSON Web Token (JWT) Profile for OAuth 2.0 Access Tokens"),
    ],
  },

  4: {
    forms: [
      {
        title: "Discovery: a request with no token (RFC 9728)",
        code: [
          "POST /mcp HTTP/1.1",
          "Host: mcp.example.com",
          "Content-Type: application/json",
          "",
          '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
          "",
          "HTTP/1.1 401 Unauthorized",
          'WWW-Authenticate: Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
          "",
          "RFC 9728 puts the well-known segment before the resource path (here /.well-known/oauth-protected-resource/mcp).",
          "The Mock and mcp-sample advertise the origin-only URL, which mcp-sample also answers with the path appended.",
        ].join("\n"),
      },
      {
        title: "Protected resource metadata",
        code: [
          "GET /.well-known/oauth-protected-resource HTTP/1.1",
          "Host: mcp.example.com",
          "",
          '{ "resource": "https://mcp.example.com/mcp",',
          '  "authorization_servers": ["https://mcp-as.example.com"],',
          '  "scopes_supported": ["mcp:read", "mcp:write", "mcp:admin"],',
          '  "bearer_methods_supported": ["header"] }',
          "",
          "The client learns which AS to ask from authorization_servers, then reads its RFC 8414 metadata.",
          "Mock scopes. The shipped mcp-sample advertises scopes_supported [\"read\", \"mcp:invoke\"].",
        ].join("\n"),
      },
      {
        title: "tools/list then tools/call with the Bearer token",
        code: [
          "POST /mcp HTTP/1.1",
          "Host: mcp.example.com",
          "Authorization: Bearer <access token>",
          "Content-Type: application/json",
          "Accept: application/json, text/event-stream",
          "",
          '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
          "",
          "POST /mcp   (same headers)",
          '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search_records","arguments":{"query":"renewals","limit":5}}}',
          "",
          REAL_SCOPE_NOTE,
        ].join("\n"),
      },
      {
        title: "Insufficient scope (mcp-sample's response shape, with the Mock's denied tool)",
        code: [
          "HTTP/1.1 403 Forbidden",
          'WWW-Authenticate: Bearer error="insufficient_scope", scope="mcp:admin", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
          "",
          '{"jsonrpc":"2.0","id":4,"error":{"code":-32003,"message":"insufficient_scope","data":{"tool":"delete_record","requiredScope":"mcp:admin"}}}',
          "",
          "The Mock lists delete_record (needs mcp:admin) as denied: the token holds only mcp:read mcp:write.",
          "Real mcp-sample uses the same shape for its own tools, e.g. tool echo, requiredScope mcp:invoke.",
        ].join("\n"),
      },
      {
        title: "The protected page: it also refuses an ID-JAG",
        code: [
          "GET /protected/profile HTTP/1.1",
          "Host: mcp.example.com",
          "Authorization: Bearer <access token>            -> 200, verified: bearer, token type, signature, expiry, issuer, audience, scope",
          "  (the Mock page shows this 200. Real mcp-sample needs scope read here, so a token with only mcp:read mcp:write gets 403 insufficient_scope)",
          "Authorization: Bearer <the ID-JAG>              -> 401 invalid_token  (typ oauth-id-jag+jwt: a grant, never a resource token)",
          "(no Authorization header)                        -> 401 invalid_request + resource_metadata challenge",
        ].join("\n"),
      },
    ],
    tokens: [
      accessToken("The only token the MCP server accepts: it checks RS256 signature via resource-as /jwks, typ at+jwt, iss = the AS, aud = this server's resource URI, and exp. The ID-JAG never reaches this hop."),
    ],
    refs: [
      ...PROTECTED_RESOURCE, ...BEARER, ...AS_METADATA,
      ...MCP_AUTH.filter((r) => r.kind === "spec"), // the client-id-metadata draft governs client registration, not this hop
      SPEC("JSON-RPC 2.0", "JSON-RPC 2.0 Specification (MCP messages)"),
    ],
  },

  5: {
    forms: [
      {
        title: "Replay: redeem the same ID-JAG twice",
        code: [
          "POST /token   grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<the ID-JAG>   (second time)",
          "",
          "HTTP/1.1 400 Bad Request",
          '{"error":"invalid_grant","error_description":"ID-JAG already redeemed (replay rejected)"}',
          "",
          "Single use is a hardening resource-as adds (jti kept until exp, across restarts); the draft lets a client resubmit.",
          "",
          'These error_description strings are the real resource-as. The Mock page shows its own fixture text: "Assertion jti has already been used".',
        ].join("\n"),
      },
      {
        title: "Tampered signature",
        code: [
          "POST /token   assertion=<header>.<payload>.<last signature bytes flipped>",
          "",
          "HTTP/1.1 400 Bad Request",
          '{"error":"invalid_grant","error_description":"ID-JAG verification failed: signature verification failed"}',
          "",
          'Real resource-as text. The Mock page shows: "Assertion signature is invalid".',
        ].join("\n"),
      },
      {
        title: "Redeemed by a different client",
        code: [
          "POST /token   client_id=some-other-client (no secret)&assertion=<the ID-JAG>",
          "",
          "HTTP/1.1 401 Unauthorized",
          '{"error":"invalid_client","error_description":"client authentication failed"}',
          "",
          "With valid credentials for a different client the refusal is invalid_grant: 'ID-JAG client_id is not assigned to this IdP'.",
          "",
          'Real resource-as text. The Mock page shows invalid_client: "client_id does not match the assertion".',
        ].join("\n"),
      },
      {
        title: "Scope the ID-JAG did not grant",
        code: [
          "POST /token   scope=admin:delete&assertion=<the ID-JAG>",
          "",
          "HTTP/1.1 400 Bad Request",
          '{"error":"invalid_scope","error_description":"ID-JAG grants no scope this client may use for this request"}',
          "",
          "The grant is an intersection and is never widened. Also refused: aud not this AS or not single-valued,",
          "expired exp, wrong typ (invalid_grant), and a resource not in ACCEPTED_RESOURCES (invalid_target).",
          "",
          'Real resource-as text. The Mock page shows: "Requested scope exceeds the ID-JAG grant".',
        ].join("\n"),
      },
    ],
    tokens: [
      idJagToken("Each test redeems a fresh ID-JAG (the exchange in step 2 runs again, so the jti differs) and breaks exactly one thing. None of them produces an access token."),
    ],
    refs: [
      ...JWT_BEARER, ...JWT, ...IDJAG,
      RFC(6749, "The OAuth 2.0 Authorization Framework (§5.2 error responses)"),
      RFC(8707, "Resource Indicators for OAuth 2.0 (invalid_target)"),
      RFC(8725, "JSON Web Token Best Current Practices"),
    ],
  },
};

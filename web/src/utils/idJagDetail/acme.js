// Step detail for the "acme" playground diagram (pf-pf): Acme PingFederate issues the ID-JAG, our PingFederate redeems it.
// { [step 1-5]: { forms, tokens, refs } }. See utils/idJagStepDetail.js. Hosts, ids and values are sample placeholders.
import {
  RFC, SPEC, TOKEN_EXCHANGE, JWT_BEARER, JWT, PROTECTED_RESOURCE, BEARER, IDJAG,
} from "../idJagStandards.js";

const ACME = "https://acme-pf.example.com"; // ACME_PF_URL
const OUR_PF = "https://our-pf.example.com"; // PF_URL
const MCP = "https://mcp.example.com/mcp"; // MCP_URL, also the resource PF_RESOURCE names
const PROFILE = "https://mcp.example.com/protected/profile";

// What Acme's PingFederate signs (acmeToPingFed SP connection): typ and x5t in the header, no kid.
const ID_JAG_HEADER = { typ: "oauth-id-jag+jwt", alg: "RS256", x5t: "<x5t thumbprint of the signing cert>" };
const ID_JAG_CLAIMS = {
  iss: ACME,
  sub: "acme-user",
  aud: OUR_PF,
  client_id: "<PF_REDEEMER_CLIENT_ID>",
  jti: "<unique id>",
  iat: 1790000000,
  exp: 1790000300,
  resource: MCP,
  scope: "read mcp:invoke",
};
const idJagToken = (note) => ({ note, header: ID_JAG_HEADER, claims: ID_JAG_CLAIMS });

// The access token our PingFederate mints from its access token manager. ILLUSTRATIVE: the repo only shows the IdP connection
// mapping sub, client_id and scope into the manager's contract; aud, kid and typ at+jwt are assumptions about that manager.
const PF_ACCESS_TOKEN = {
  header: { typ: "at+jwt", alg: "RS256", kid: "<our PF key id>" },
  claims: { iss: OUR_PF, sub: "acme-user", aud: MCP, client_id: "<PF_REDEEMER_CLIENT_ID>", scope: "read mcp:invoke", exp: 1790003600 },
};

const BASIC = (what) => `Authorization: Basic <base64(${what})>`;
const REDEEM_HEAD = `POST /as/token.oauth2 HTTP/1.1\nHost: our-pf.example.com\n${BASIC("PF_REDEEMER_CLIENT_ID:secret")}\nContent-Type: application/x-www-form-urlencoded\n\n`;
const redeemBody = (assertion, extra = "") =>
  `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer\n&assertion=${assertion}\n&client_id=<PF_REDEEMER_CLIENT_ID>\n&resource=${MCP}\n&scope=read mcp:invoke${extra}`;

export default {
  1: {
    forms: [
      {
        title: "Sign in at Acme PingFederate (pi.flow in a dialog, code + PKCE)",
        code: [
          "GET .../issuer/pi-flow/start   (this app, same origin)",
          "  -> the server requests the authorize URL below with response_mode=pi.flow;",
          "     the dialog posts the username and password to .../issuer/pi-flow/credentials;",
          "     on COMPLETED the browser goes to /issuer/callback?code&state (this app).",
          "",
          "GET /as/authorization.oauth2 HTTP/1.1",
          "Host: acme-pf.example.com",
          "  ?response_type=code",
          "  &client_id=<ACME_EXCHANGE_CLIENT_ID>",
          "  &redirect_uri=<APP_ORIGIN>/api/id-jag-playground/issuer/callback",
          "  &scope=openid profile email offline_access",
          "  &state=<random state>",
          "  &code_challenge=<S256 challenge>",
          "  &code_challenge_method=S256",
          "  &prompt=login",
          "  &response_mode=pi.flow",
        ].join("\n"),
      },
      {
        title: "Server swaps the code for tokens (GET /issuer/callback)",
        code: [
          "POST /as/token.oauth2 HTTP/1.1",
          "Host: acme-pf.example.com",
          BASIC("ACME_EXCHANGE_CLIENT_ID:secret"),
          "Content-Type: application/x-www-form-urlencoded",
          "",
          "grant_type=authorization_code",
          "&code=<authorization code>",
          "&redirect_uri=<APP_ORIGIN>/api/id-jag-playground/issuer/callback",
          "&code_verifier=<PKCE verifier>",
        ].join("\n"),
      },
    ],
    tokens: [
      {
        note: "ID token from Acme's code exchange (sample claims). The server reads only sub from it; the browser never sees a raw token.",
        header: { alg: "RS256", kid: "<Acme key id>" },
        claims: { iss: ACME, sub: "acme-user", aud: "<ACME_EXCHANGE_CLIENT_ID>", iat: 1789999000, exp: 1790002600 },
      },
      {
        note: "The refresh token is what step 2 exchanges. offline_access is why Acme issues one. It is an opaque PingFederate reference, shown here as what the server stores (session.idJagIssuer).",
        claims: { token_type: "refresh_token", mode: "pf-pf", sub: "acme-user", value: "<refresh token, kept server-side>" },
      },
    ],
    refs: [
      RFC(6749, "The OAuth 2.0 Authorization Framework"),
      RFC(7636, "Proof Key for Code Exchange by OAuth Public Clients"),
      SPEC("OpenID Connect Core 1.0", "OpenID Connect Core 1.0"),
      RFC(7519, "JSON Web Token (JWT)"),
    ],
  },

  2: {
    forms: [
      {
        title: "Token exchange at Acme PingFederate (POST /issue)",
        code: [
          "POST /as/token.oauth2 HTTP/1.1",
          "Host: acme-pf.example.com",
          BASIC("ACME_EXCHANGE_CLIENT_ID:secret"),
          "Content-Type: application/x-www-form-urlencoded",
          "",
          "grant_type=urn:ietf:params:oauth:grant-type:token-exchange",
          "&requested_token_type=urn:ietf:params:oauth:token-type:id-jag",
          "&subject_token=<Acme refresh token>",
          "&subject_token_type=urn:ietf:params:oauth:token-type:refresh_token",
          `&audience=${OUR_PF}`,
          `&resource=${MCP}`,
          "&scope=read mcp:invoke",
        ].join("\n"),
      },
      {
        title: "Response",
        code: [
          "// Differs from the draft: it takes an ID token or SAML assertion as subject_token. Acme's acmeIdJagPolicy takes the",
          "// refresh token (subject_token_type ...:refresh_token) because the server keeps no raw ID token for the exchange.",
          "HTTP/1.1 200 OK",
          "Content-Type: application/json",
          "",
          JSON.stringify({ issued_token_type: "urn:ietf:params:oauth:token-type:id-jag", token_type: "N_A", access_token: "<the ID-JAG>" }, null, 2),
        ].join("\n"),
      },
    ],
    tokens: [
      {
        note: "In: the refresh token. Acme's acmeRefreshToken processor resolves it to these attributes (opaque on the wire, so these are what the exchange policy maps from it).",
        claims: { TOKEN_SUBJECT: "acme-user", client_id: "<ACME_EXCHANGE_CLIENT_ID>", scope: "openid profile email offline_access", expires_at: "<refresh expiry>" },
      },
      idJagToken(
        "Out: the ID-JAG. audience becomes aud, so aud is OUR PingFederate's issuer. The acmeToPingFed SP connection (configure-acme-idp.js) is selected by its resourceUris and maps TOKEN_SUBJECT, client_id (our redeemer) and scope; whether PingFederate also writes a resource claim is not shown in the repo, so treat that claim as what the draft expects (the playground's inspector only warns when it is missing). PingFederate signs with the x5t header and no kid. Lifetime is about 5 minutes (minutesBefore/After 5; the script cites the spec and Okta) and aud is a single value. The playground uses a separate Acme PingFederate because an IdP must not redeem its own ID-JAG.",
      ),
    ],
    refs: [...TOKEN_EXCHANGE, ...IDJAG, ...JWT, RFC(8725, "JSON Web Token Best Current Practices")],
  },

  3: {
    forms: [
      {
        title: "JWT bearer grant at our PingFederate (POST /redeem)",
        code: `${REDEEM_HEAD}${redeemBody("<the ID-JAG>")}`,
      },
      {
        title: "Our PingFederate fetches Acme's keys (IdP connection, not sent by the browser)",
        code: [
          "GET /pf/JWKS HTTP/1.1",
          "Host: acme-pf.example.com",
          "",
          "// Acme publishes ONE key (static JWKS, only the ID-JAG signing key):",
          JSON.stringify({ keys: [{ kty: "RSA", alg: "RS256", use: "sig", kid: "acme-idjag", x5t: "<x5t thumbprint of the signing cert>", n: "<modulus>", e: "AQAB" }] }, null, 2),
        ].join("\n"),
      },
      {
        title: "Response (redacted: the access token stays on the server)",
        code: [
          "HTTP/1.1 200 OK",
          "Content-Type: application/json",
          "",
          JSON.stringify({ access_token: "<access token>", token_type: "Bearer", expires_in: 3600, scope: "read mcp:invoke" }, null, 2),
          "",
          "// Wrong or stale key set: the playground surfaces the text \"Invalid JWT token\". The error code is EXPECTED to be",
          "// invalid_grant (RFC 7523) but the repo does not confirm which code PingFederate returns:",
          JSON.stringify({ error: "invalid_grant", error_description: "Invalid JWT token" }, null, 2),
          "",
          "// resource not listed on the access token manager's selection settings (docs/setup-guides.md):",
          JSON.stringify({ error: "invalid_target" }, null, 2),
        ].join("\n"),
      },
    ],
    tokens: [
      idJagToken(
        "In: the ID-JAG from step 2. PingFederate checks the signature against the key its IdP connection (entityId = Acme's issuer; pingfederate/sync-id-jag-trusted-idps.js is the reference for creating it, though the repo notes it still assumes AI-DEMO2 names) fetched from /pf/JWKS. PingFederate cannot pick a key by x5t, so Acme must publish a single key, and PingFederate caches it and never refetches without a kid: restart PingFederate after a key change (README, docs/setup-guides.md).",
      ),
      {
        note: "Out: the access token our PingFederate mints from its access token manager. ILLUSTRATIVE: the repo only shows the IdP connection mapping sub, client_id and scope from the ID-JAG into the manager's contract. aud = the MCP resource, the kid and typ at+jwt are assumptions about that manager, not shown in the repo.",
        header: PF_ACCESS_TOKEN.header,
        claims: PF_ACCESS_TOKEN.claims,
      },
    ],
    refs: [...JWT_BEARER, ...IDJAG, ...JWT, RFC(8707, "Resource Indicators for OAuth 2.0")],
  },

  4: {
    forms: [
      {
        title: "Discover the protected resource (RFC 9728)",
        code: [
          "GET /.well-known/oauth-protected-resource HTTP/1.1",
          "Host: mcp.example.com",
          "",
          JSON.stringify({ resource: MCP, authorization_servers: ["<RESOURCE_AS_ISSUER>"], scopes_supported: ["read", "mcp:invoke"], bearer_methods_supported: ["header"] }, null, 2),
          "",
          "// authorization_servers names resource-as, not our PingFederate: the sample trusts one issuer.",
        ].join("\n"),
      },
      {
        title: "tools/list with our PingFederate's token (POST /call)",
        code: [
          "POST /mcp HTTP/1.1",
          "Host: mcp.example.com",
          "Content-Type: application/json",
          "Accept: application/json, text/event-stream",
          "Authorization: Bearer <access token>",
          "",
          JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        ].join("\n"),
      },
      {
        title: "GET /protected/profile with the same token (POST /resource, variant token)",
        code: `GET ${new URL(PROFILE).pathname} HTTP/1.1\nHost: mcp.example.com\nAuthorization: Bearer <access token>`,
      },
      {
        title: "Refusal (expected outcome here, illustrative: assumes the manager stamps typ at+jwt)",
        code: [
          "HTTP/1.1 401 Unauthorized",
          'WWW-Authenticate: Bearer error="invalid_token", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
          "",
          "// If the access token manager does not stamp typ at+jwt, mcp-sample stops one check earlier:",
          '//   { "check": "token type", "ok": false, "detail": "typ is \"(none)\", not at+jwt." }',
          JSON.stringify({
            resource: PROFILE,
            error: "invalid_token",
            error_description: "Does not verify against <resource-as>/jwks: <jose error>.",
            verified: [
              { check: "bearer", ok: true, detail: "Authorization: Bearer present." },
              { check: "token type", ok: true, detail: "JWT access token (typ at+jwt), not an ID-JAG." },
              { check: "signature", ok: false, detail: "Does not verify against the authorization server's keys." },
            ],
          }, null, 2),
        ].join("\n"),
      },
    ],
    tokens: [
      {
        note: "In: our PingFederate's access token (sample). mcp-sample validates bearer, typ at+jwt, signature against ONE authorization server's JWKS, expiry, iss and aud, in that order, and stops at the first failure. It trusts resource-as only, so this token fails. The header shown stamps typ at+jwt (an assumption about the manager), so it fails at 'signature'; without that typ it fails at 'token type'. PingFederate to resource AS shows the accepted path. A real deployment would point the resource at the issuer that minted the token (here PF_URL) and publish that in its RFC 9728 metadata.",
        header: PF_ACCESS_TOKEN.header,
        claims: PF_ACCESS_TOKEN.claims,
      },
    ],
    refs: [...PROTECTED_RESOURCE, ...BEARER, SPEC("MCP authorization", "Model Context Protocol: Authorization"), RFC(7519, "JSON Web Token (JWT)")],
  },

  5: {
    forms: [
      {
        title: "Each test mints a fresh ID-JAG at Acme first (same form as step 2), then breaks one thing",
        code: "POST /as/token.oauth2 HTTP/1.1\nHost: acme-pf.example.com\n// grant_type=token-exchange, requested_token_type=...:id-jag, audience=PF_URL, resource=PF_RESOURCE (see step 2)",
      },
      {
        title: "replay: the same ID-JAG redeemed twice",
        code: `${REDEEM_HEAD}${redeemBody("<the same ID-JAG>")}\n\n// first call: 200. Second call must be refused (expect invalid_grant).`,
      },
      {
        title: "bad-signature: last two characters of the signature changed",
        code: `${REDEEM_HEAD}${redeemBody("<header>.<payload>.<tampered signature>")}\n\n// expect invalid_grant, no token`,
      },
      {
        title: "client-mismatch: redeemed by a different client, no secret",
        code: `POST /as/token.oauth2 HTTP/1.1\nHost: our-pf.example.com\nContent-Type: application/x-www-form-urlencoded\n\ngrant_type=urn:ietf:params:oauth:grant-type:jwt-bearer\n&assertion=<the ID-JAG>\n&client_id=some-other-client\n&resource=${MCP}\n\n// expect invalid_grant or invalid_client`,
      },
      {
        title: "scope-not-granted: asks for a scope the ID-JAG does not carry",
        code: `${REDEEM_HEAD}${redeemBody("<the ID-JAG>").replace("scope=read mcp:invoke", "scope=admin:delete")}\n\n// expect invalid_scope`,
      },
    ],
    tokens: [
      idJagToken(
        "A fresh ID-JAG per test (single-use). The test passes when our PingFederate answers 4xx with no access_token. Here our PingFederate stands in for resource-as, whose own 8-step validation (docs/resource-as.md) does not run in this mode. What the repo evidences about PingFederate: it verifies the signature against the IdP connection's JWKS, answers invalid_target when the resource is not on the access token manager, and its ID-JAGs are single-use (server comment). Audience, client binding and scope checks are EXPECTED from RFC 7523 and the draft but not verified here, and the codes and text are PingFederate's own, so the expect lines are what the playground asserts, not guaranteed codes. Single-use jti is a hardening beyond the draft, which lets clients resubmit.",
      ),
    ],
    refs: [...JWT_BEARER, ...IDJAG, ...TOKEN_EXCHANGE, RFC(8725, "JSON Web Token Best Current Practices"), RFC(6749, "The OAuth 2.0 Authorization Framework")],
  },
};

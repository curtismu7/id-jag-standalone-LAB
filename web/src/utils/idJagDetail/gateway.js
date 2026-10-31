// Step detail for the "gateway-redeem" playground diagram: { [step 1-5]: { forms, tokens, refs } }. See utils/idJagStepDetail.js.
// Ping release claim (2026-11-02), UNVERIFIED on our tenant. Field names OBO{...} and Redeem{...} are the console swagger names
// (2026-10-31, schema only); the wire shapes below are the lab's reading of RFC 8693 and RFC 7523. Every value is a teaching placeholder.
import { RFC, TOKEN_EXCHANGE, JWT_BEARER, JWT, BEARER, IDJAG } from "../idJagStandards.js";

const CLIENT_AUTH = RFC(7523, "JSON Web Token (JWT) Profile for OAuth 2.0 Client Authentication and Authorization Grants");
const JWT_BCP = RFC(8725, "JSON Web Token Best Current Practices");

const CALLER = {
  note: "The caller token the company IdP issued to the agent app for the signed-in user: aud = the gateway. Mock token, 10 minutes.",
  header: { typ: "at+jwt", alg: "ES256", kid: "mock-exchange-idp-1" },
  claims: { iss: "https://exchange-idp.mock.invalid", sub: "alice@mock.example", aud: "https://gateway.mock.invalid/mcp", client_id: "agent-app", scope: "gateway:use ledger:read ledger:write", mock: true },
};
const ID_JAG = {
  note: "Leg 1 result: typ oauth-id-jag+jwt, aud = OBO.Resource (the target app's issuer), sub = the user, act = the calling client, 300 s.",
  header: { typ: "oauth-id-jag+jwt", alg: "ES256", kid: "mock-exchange-idp-1" },
  claims: { iss: "https://exchange-idp.mock.invalid", sub: "alice@mock.example", aud: "https://target-idp.mock.invalid", client_id: "gateway-redeem", scope: "ledger:read", act: { sub: "agent-app" }, jti: "<random>", mock: true },
};
const ACCESS_TOKEN = {
  note: "Leg 2 result: the target issuer's own access token. sub = the user, aud = the target API, no shared credential. One hour.",
  header: { typ: "at+jwt", alg: "ES256", kid: "mock-target-idp-1" },
  claims: { iss: "https://target-idp.mock.invalid", sub: "alice@mock.example", aud: "https://target-api.mock.invalid/ledger", client_id: "gateway-redeem", scope: "ledger:read", act: { sub: "agent-app" }, mock: true },
};

export default {
  1: {
    forms: [{
      title: "The agent calls the gateway (in-process in the mock)",
      code: [
        "POST /mcp HTTP/1.1",
        "Host: gateway.mock.invalid",
        "Authorization: Bearer <caller token>",
        "Content-Type: application/json",
        "",
        '{ "jsonrpc": "2.0", "method": "tools/call", "params": { "name": "ledger_entries" } }',
        "",
        "// The gateway verifies the caller token (signature, exp, iss, aud = this gateway) before it does anything else.",
      ].join("\n"),
    }],
    tokens: [CALLER],
    refs: [...BEARER, ...JWT],
  },
  2: {
    forms: [{
      title: "Leg 1: the gateway exchanges the caller token (modelMcpOBOSpec)",
      code: [
        "POST <OBO.TokenURL> HTTP/1.1",
        "Authorization: Basic <OBO.ClientID:OBO.ClientSecret, write-only>      (OBO.AuthMethod)",
        "Content-Type: application/x-www-form-urlencoded",
        "traceparent: 00-<trace-id>-<span-id>-01",
        "",
        "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange",
        "&subject_token=<caller token>",
        "&subject_token_type=<OBO.SubjectTokenType>",
        "&requested_token_type=<OBO.RequestedTokenType>",
        "&resource=<OBO.Resource>",
        "&scope=<OBO.Scope>",
        "",
        "// private_key_jwt: client_assertion signed with OBO.PrivateKeyPEM (kid = OBO.KeyID). client_secret_post: client_secret in the body.",
      ].join("\n"),
    }],
    tokens: [ID_JAG],
    refs: [...TOKEN_EXCHANGE, ...IDJAG, CLIENT_AUTH, ...JWT],
  },
  3: {
    forms: [{
      title: "Leg 2: the gateway redeems the ID-JAG (modelMcpOBORedeemSpec)",
      code: [
        "POST <Redeem.TokenURL> HTTP/1.1",
        "Content-Type: application/x-www-form-urlencoded",
        "traceparent: 00-<trace-id>-<span-id>-01",
        "",
        "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer",
        "&assertion=<the ID-JAG>",
        "&scope=<Redeem.Scope>",
        "&client_id=<Redeem.ClientID>",
        "&client_assertion_type=urn%3Aietf%3Aparams%3Aoauth%3Aclient-assertion-type%3Ajwt-bearer",
        "&client_assertion=<signed with Redeem.PrivateKeyPEM, kid = Redeem.KeyID>      (Redeem.AuthMethod = private_key_jwt)",
        "",
        "// Only sent when Redeem.TokenURL is set. The gateway follows no redirect and calls only allow-listed https hosts.",
      ].join("\n"),
    }],
    tokens: [ACCESS_TOKEN],
    refs: [...JWT_BEARER, ...IDJAG, JWT_BCP],
  },
  4: {
    forms: [{
      title: "The gateway calls the target API with the redeemed token",
      code: [
        "GET /ledger/entries HTTP/1.1",
        "Host: target-api.mock.invalid",
        "Authorization: Bearer <access token from the target issuer>",
        "traceparent: 00-<trace-id>-<span-id>-01",
        "",
        "// 200 { principal: { sub: the user, act: the calling client }, data: { entries: [...] } }",
      ].join("\n"),
    }],
    tokens: [ACCESS_TOKEN],
    refs: [...BEARER, ...JWT],
  },
  5: {
    forms: [{
      title: "What the target API refuses",
      code: [
        "GET /ledger/entries      Authorization: Bearer <the caller's original token>",
        "  -> 401 invalid_token   check: signature   (not minted by the target app's issuer)",
        "",
        "GET /ledger/entries      Authorization: Bearer <the unredeemed ID-JAG>",
        "  -> 401 invalid_token   check: token type  (typ oauth-id-jag+jwt is a grant, not an access token)",
        "",
        "// Both answers come from real requests to the mock API in each run.",
      ].join("\n"),
    }],
    tokens: [],
    refs: [...BEARER, ...IDJAG, ...JWT_BEARER],
  },
};

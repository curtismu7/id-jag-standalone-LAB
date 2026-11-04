// Step detail for the "aws-agentcore" playground diagram: { [step 1-5]: { forms, tokens, refs } }. See utils/idJagStepDetail.js.
// The AWS side is a lab simulation: no AWS service is called, nothing here is a product test of AgentCore. The wire
// shapes below are the lab's reading of RFC 8693 and RFC 7523. Every value is a teaching placeholder.
import { RFC, TOKEN_EXCHANGE, JWT_BEARER, JWT, BEARER, IDJAG } from "../idJagStandards.js";

const CLIENT_AUTH = RFC(7523, "JSON Web Token (JWT) Profile for OAuth 2.0 Client Authentication and Authorization Grants");

const CALLER = {
  note: "The caller token the exchange issuer issued to the agent app for the signed-in user. Mock token, 10 minutes.",
  header: { typ: "at+jwt", alg: "ES256", kid: "ac-exchange-key-1" },
  claims: { iss: "https://agentcore-idp.mock.invalid", sub: "alice@mock.example", aud: "https://agentcore-idp.mock.invalid", client_id: "agent-app", scope: "gateway:use tools:invoke tools:list", mock: true },
};
const ID_JAG = {
  note: "Leg 1 result: typ oauth-id-jag+jwt, aud = Exchange.Resource (the AgentCore target issuer), sub = the user, act = the calling client, 300 s.",
  header: { typ: "oauth-id-jag+jwt", alg: "ES256", kid: "ac-exchange-key-1" },
  claims: { iss: "https://agentcore-idp.mock.invalid", sub: "alice@mock.example", aud: "https://agentcore-target.mock.invalid", client_id: "agentcore-redeem", scope: "tools:invoke", act: { sub: "agent-app" }, jti: "<random>", mock: true },
};
const ACCESS_TOKEN = {
  note: "Leg 2 result: the target issuer's own access token for the runtime. sub = the user, act = the calling client, wid = the workload identity the runtime resolves for the redeeming client (lab-invented). One hour.",
  header: { typ: "at+jwt", alg: "ES256", kid: "mock-ac-idp-1" },
  claims: { iss: "https://agentcore-target.mock.invalid", sub: "alice@mock.example", aud: "https://agentcore-runtime.mock.invalid/tools", client_id: "agentcore-redeem", scope: "tools:invoke", act: { sub: "agent-app" }, wid: "ac-wid-<random>", mock: true },
};

export default {
  1: {
    forms: [{
      title: "The agent hands its caller token to the runner (in-process in the lab)",
      code: [
        "// in-process: the runner is part of this lab's server",
        "callerToken = <the token the exchange issuer issued to the agent app>",
        "",
        "// The runner never sees the user's password or session, only this token.",
      ].join("\n"),
    }],
    tokens: [CALLER],
    refs: [...BEARER, ...JWT],
  },
  2: {
    forms: [{
      title: "Leg 1: the runner exchanges the caller token for an ID-JAG (Exchange spec)",
      code: [
        "POST <Exchange.TokenURL> HTTP/1.1",
        "Authorization: Basic <Exchange.ClientID:Exchange.ClientSecret, write-only>      (Exchange.AuthMethod)",
        "Content-Type: application/x-www-form-urlencoded",
        "traceparent: 00-<trace-id>-<span-id>-01",
        "",
        "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange",
        "&subject_token=<caller token>",
        "&subject_token_type=<Exchange.SubjectTokenType>",
        "&requested_token_type=<Exchange.RequestedTokenType>",
        "&resource=<Exchange.Resource>",
        "&scope=<Exchange.Scope>",
        "",
        "// Exchange.Resource becomes the aud of the ID-JAG, so it is addressed to the AgentCore target issuer.",
      ].join("\n"),
    }],
    tokens: [ID_JAG],
    refs: [...TOKEN_EXCHANGE, ...IDJAG, CLIENT_AUTH, ...JWT],
  },
  3: {
    forms: [{
      title: "Leg 2: the runner redeems the ID-JAG at the target issuer (Redeem spec)",
      code: [
        "POST <Redeem.TokenURL> HTTP/1.1",
        "Content-Type: application/x-www-form-urlencoded",
        "traceparent: 00-<trace-id>-<span-id>-01",
        "",
        "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer",
        "&assertion=<the ID-JAG>",
        "&scope=<Redeem.Scope>",
        "&client_id=<Redeem.ClientID>",
        "&client_secret=<Redeem.ClientSecret, write-only>      (Redeem.AuthMethod = client_secret_post)",
        "",
        "// The target issuer checks signature, trusted issuer, aud, expiry, client binding and single-use jti.",
        "// The runner follows no redirect and calls only allow-listed https hosts.",
      ].join("\n"),
    }],
    tokens: [ACCESS_TOKEN],
    refs: [...JWT_BEARER, CLIENT_AUTH, ...JWT],
  },
  4: {
    forms: [{
      title: "The runner invokes the mock AgentCore runtime",
      code: [
        "POST https://agentcore-runtime.mock.invalid/invoke HTTP/1.1",
        "Authorization: Bearer <the access token the target issuer minted>",
        "Content-Type: application/json",
        "traceparent: 00-<trace-id>-<span-id>-01",
        "",
        '{ "tool": "get_account_summary" }',
        "",
        "// The runtime answers with the tool result, the principal (sub, act) and the workload identity it resolved.",
      ].join("\n"),
    }],
    refs: [...BEARER],
  },
  5: {
    forms: [{
      title: "What the runtime refuses",
      code: [
        "HTTP/1.1 401 Unauthorized",
        "",
        '// the caller\'s original token: signature does not verify (a different issuer minted it)',
        '// the raw ID-JAG: "This is an ID-JAG (typ oauth-id-jag+jwt): a grant for an authorization server',
        '//   to redeem, never an access token for a runtime."',
        "",
        "// Both refusals come from the runtime's own answer to a real request, not from a fixed message.",
      ].join("\n"),
    }],
    refs: [...IDJAG, ...JWT],
  },
};

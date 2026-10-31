// Standards a playground step can cite. kind: "rfc" (published RFC), "spec" (a maintained spec),
// "emerging" (an Internet-Draft or other in-progress work: status can change). Only entries known to exist.
export const RFC = (num, title) => ({ id: `RFC ${num}`, title, kind: "rfc" });
export const DRAFT = (id, title) => ({ id, title, kind: "emerging" });
export const SPEC = (id, title) => ({ id, title, kind: "spec" });

const R8693 = RFC(8693, "OAuth 2.0 Token Exchange");
const R8707 = RFC(8707, "Resource Indicators for OAuth 2.0");
const R9728 = RFC(9728, "OAuth 2.0 Protected Resource Metadata");

export const TOKEN_EXCHANGE = [R8693, R8707];
export const JWT_BEARER = [
  RFC(7523, "JSON Web Token (JWT) Profile for OAuth 2.0 Client Authentication and Authorization Grants"),
  RFC(7521, "Assertion Framework for OAuth 2.0 Client Authentication and Authorization Grants"),
];
export const JWT = [RFC(7519, "JSON Web Token (JWT)"), RFC(7517, "JSON Web Key (JWK)"), RFC(7515, "JSON Web Signature (JWS)")];
export const AS_METADATA = [RFC(8414, "OAuth 2.0 Authorization Server Metadata")];
export const PROTECTED_RESOURCE = [R9728, R8707];
export const BEARER = [
  RFC(6750, "The OAuth 2.0 Authorization Framework: Bearer Token Usage"),
  RFC(9068, "JSON Web Token (JWT) Profile for OAuth 2.0 Access Tokens"),
];
export const SENDER_CONSTRAINED = [
  RFC(9449, "OAuth 2.0 Demonstrating Proof of Possession (DPoP)"),
  RFC(8705, "OAuth 2.0 Mutual-TLS Client Authentication and Certificate-Bound Access Tokens"),
];
export const IDJAG = [
  DRAFT("draft-ietf-oauth-identity-assertion-authz-grant", "Identity Assertion JWT Authorization Grant"),
  DRAFT("draft-ietf-oauth-identity-chaining", "OAuth Identity and Authorization Chaining Across Domains"),
];
export const MCP_AUTH = [
  SPEC("MCP authorization", "Model Context Protocol: Authorization"),
  R9728,
  DRAFT("draft-ietf-oauth-client-id-metadata-document", "OAuth Client ID Metadata Document"),
];

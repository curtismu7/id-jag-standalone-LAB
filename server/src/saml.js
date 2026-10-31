// The SAML half of the ID-JAG playground: this app plays a tiny SAML identity provider for the signed-in user. It signs
// a SAML 2.0 assertion naming them; PingFederate trusts the signer's certificate and trades the assertion for an ID-JAG
// in one token exchange (verified 2026-10-19, tools/saml-spike). Key and certificate files are read at call time, so
// provisioning (pingfederate/configure-saml.js) needs no server restart. Nothing here logs an assertion, key or secret.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DOMParser } from '@xmldom/xmldom';
import { SignedXml } from 'xml-crypto';
import { config, secret } from './config.js';

const SAML_NS = 'urn:oasis:names:tc:SAML:2.0:assertion';
const DS_NS = 'http://www.w3.org/2000/09/xmldsig#';
const ASSERTION = "//*[local-name(.)='Assertion']";
const env = (k, fallback = '') => String(process.env[k] ?? '').trim() || fallback;

export function samlSettings() {
  return {
    keyFile: env('SAML_SIGNING_KEY_FILE'),
    certFile: env('SAML_SIGNING_CERT_FILE'),
    issuer: env('SAML_ISSUER', `${config().appOrigin}/saml`),
    audience: env('SAML_AUDIENCE', 'idJagKitSamlAud'),
    clientId: env('PF_SAML_CLIENT_ID', 'id-jag-kit-saml'),
  };
}

const readable = (file) => { try { return fs.statSync(file).isFile() && (fs.accessSync(file, fs.constants.R_OK), true); } catch { return false; } };

/** Why the key/certificate files are unusable, or null (names the setting, never a path). */
export function samlFilesProblem() {
  const { keyFile, certFile } = samlSettings();
  const bad = [['SAML_SIGNING_KEY_FILE', keyFile], ['SAML_SIGNING_CERT_FILE', certFile]].filter(([, f]) => !f || !readable(f)).map(([k]) => k);
  return bad.length ? `SAML needs ${bad.join(' and ')} to name a readable PEM file. Run pingfederate/configure-saml.js, then start with deploy/docker-compose.saml.yml (see the setup guides).` : null;
}

/** Why there is no client secret for the SAML exchange, or null. */
export const samlClientProblem = () => (secret('PF_SAML_CLIENT_SECRET') ? null
  : 'SAML needs PF_SAML_CLIENT_SECRET (written to .env by pingfederate/configure-saml.js), then restart the server.');

/** null when this server can sign and exchange, else why not. */
export const samlUnavailableReason = () => samlFilesProblem() || samlClientProblem();

/** The signer certificate as PEM: the CERTIFICATE block only, whatever else the file holds. */
export function signerCertPem() {
  const m = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(fs.readFileSync(samlSettings().certFile, 'utf8'));
  if (!m) throw new Error('SAML_SIGNING_CERT_FILE holds no certificate');
  return `${m[0]}\n`;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');

/** A signed assertion for `subject` (an email), addressed to `audience`. Same construction as tools/saml-spike/mk-saml.mjs. */
export function buildAssertion({ subject, audience, issuer = samlSettings().issuer, nowMs = Date.now() }) {
  if (!subject || !audience) throw new Error('subject and audience are required');
  const { keyFile, certFile } = samlSettings();
  const key = fs.readFileSync(keyFile, 'utf8');
  const cert = fs.readFileSync(certFile, 'utf8');
  const id = `_${randomUUID()}`;
  // Backdated 60 s: a PingFederate clock a few seconds behind this server must not read as 'not yet valid'.
  const now = iso(nowMs - 60000);
  const end = iso(nowMs + 300000);
  const xml = `<saml:Assertion xmlns:saml="${SAML_NS}" ID="${id}" Version="2.0" IssueInstant="${now}">`
    + `<saml:Issuer>${esc(issuer)}</saml:Issuer>`
    + `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${esc(subject)}</saml:NameID>`
    + `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${end}"/></saml:SubjectConfirmation></saml:Subject>`
    + `<saml:Conditions NotBefore="${now}" NotOnOrAfter="${end}"><saml:AudienceRestriction><saml:Audience>${esc(audience)}</saml:Audience></saml:AudienceRestriction></saml:Conditions>`
    + `<saml:AuthnStatement AuthnInstant="${now}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>`
    + `</saml:Assertion>`;
  const sx = new SignedXml({
    privateKey: key, publicCert: cert,
    signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
  });
  sx.addReference({
    xpath: ASSERTION, digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'],
  });
  sx.computeSignature(xml, { prefix: 'ds', location: { reference: "//*[local-name(.)='Issuer']", action: 'after' } }); // SAML: Signature follows Issuer
  return { xml: sx.getSignedXml(), id };
}

const TRUNCATED = /<((?:\w+:)?(?:DigestValue|SignatureValue|X509Certificate))>[^<]*<\/\1>/g;

/** One element per line, indented; an element holding only text stays on one line. */
function prettyPrint(xml) {
  const tokens = xml.match(/<[^>]+>|[^<]+/g) || [];
  const lines = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t[0] !== '<') continue;
    const pad = '  '.repeat(Math.max(depth - (t[1] === '/' ? 1 : 0), 0));
    if (t[1] === '/') { depth = Math.max(depth - 1, 0); lines.push(pad + t); } else if (t.endsWith('/>')) lines.push(pad + t);
    else if (tokens[i + 1]?.[0] !== '<' && tokens[i + 2]?.[1] === '/') { lines.push(pad + t + tokens[i + 1] + tokens[i + 2]); i += 2; } else { lines.push(pad + t); depth++; }
  }
  return lines.join('\n');
}

/** The browser's view of a signed assertion. The signature, digest and certificate bytes are replaced by […]; the raw assertion stays server-side. */
export function describeAssertion(xml) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const one = (ns, name) => doc.getElementsByTagNameNS(ns, name)[0];
  const text = (ns, name) => one(ns, name)?.textContent || '';
  const attr = (ns, name, a) => one(ns, name)?.getAttribute(a) || '';
  const certB64 = text(DS_NS, 'X509Certificate').replace(/\s+/g, '');
  const certSha1 = certB64 ? crypto.createHash('sha1').update(Buffer.from(certB64, 'base64')).digest('hex').toUpperCase().match(/../g).join(':') : '';
  return {
    issuer: text(SAML_NS, 'Issuer'),
    nameId: text(SAML_NS, 'NameID'),
    nameIdFormat: attr(SAML_NS, 'NameID', 'Format'),
    audience: text(SAML_NS, 'Audience'),
    issueInstant: doc.documentElement.getAttribute('IssueInstant'),
    notBefore: attr(SAML_NS, 'Conditions', 'NotBefore'),
    notOnOrAfter: attr(SAML_NS, 'Conditions', 'NotOnOrAfter'),
    signature: {
      algorithm: attr(DS_NS, 'SignatureMethod', 'Algorithm'),
      canonicalization: attr(DS_NS, 'CanonicalizationMethod', 'Algorithm'),
      certSha1,
    },
    xml: prettyPrint(xml.replace(TRUNCATED, '<$1>[…]</$1>')),
  };
}

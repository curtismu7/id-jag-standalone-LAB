#!/usr/bin/env node
// Signed SAML 2.0 assertion with a throwaway key/cert. Prints JSON {certPemPath, assertionB64url, assertionB64, audience, subject}.
//   node mk-saml.mjs [--audience A] [--subject S] [--issuer I] [--lifetime-seconds N]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, chmodSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { SignedXml } from 'xml-crypto';
import { DOMParser } from '@xmldom/xmldom';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// SAML_SPIKE_WORK lets a second key pair live elsewhere (negatives.mjs signs one assertion with a key PingFederate does not trust).
const WORK = process.env.SAML_SPIKE_WORK ? path.resolve(process.env.SAML_SPIKE_WORK) : path.join(HERE, 'work');
export const CERT = path.join(WORK, 'cert.pem');
const KEY = path.join(WORK, 'key.pem');
const ASSERTION = "//*[local-name(.)='Assertion']";

function ensureKeyPair() {
  mkdirSync(WORK, { recursive: true, mode: 0o700 });
  if (!existsSync(KEY) || !existsSync(CERT)) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '30',
      '-subj', '/CN=idjag-spike-idp', '-keyout', KEY, '-out', CERT], { stdio: 'ignore' });
  }
  chmodSync(KEY, 0o600); chmodSync(CERT, 0o600);
  return { key: readFileSync(KEY, 'utf8'), cert: readFileSync(CERT, 'utf8') };
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');

/** Verify the enveloped signature of a signed assertion string against `cert` (PEM). */
export function verify(xml, cert) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const sig = doc.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'Signature')[0];
  if (!sig) return false;
  const v = new SignedXml({ publicCert: cert });
  v.loadSignature(sig);
  try { return v.checkSignature(xml); } catch { return false; }
}

export function buildAssertion({ audience, subject = 'idjag-spike@example.com', issuer = 'https://spike-idp.example.com', lifetimeSeconds = 300, nowMs = Date.now() }) {
  if (!audience) throw new Error('audience is required');
  const { key, cert } = ensureKeyPair();
  const id = `_${randomUUID()}`;
  // Backdated 60 s: a PingFederate pod clock a few seconds behind this machine must not read as 'not yet valid'.
  const now = iso(nowMs - 60000), end = iso(nowMs + lifetimeSeconds * 1000);
  const xml = `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="${now}">`
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
  const signed = sx.getSignedXml();
  if (!verify(signed, cert)) throw new Error('self-check FAILED: the signature just made does not verify');
  return { xml: signed, cert, id };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values: v } = parseArgs({ options: { audience: { type: 'string' }, subject: { type: 'string' }, issuer: { type: 'string' }, 'lifetime-seconds': { type: 'string' } } });
    const { xml } = buildAssertion({ audience: v.audience, subject: v.subject, issuer: v.issuer, lifetimeSeconds: v['lifetime-seconds'] ? Number(v['lifetime-seconds']) : undefined });
    const b = Buffer.from(xml, 'utf8');
    console.log(JSON.stringify({ certPemPath: CERT, assertionB64url: b.toString('base64url'), assertionB64: b.toString('base64'), audience: v.audience, subject: v.subject || 'idjag-spike@example.com' }));
  } catch (e) { console.error(`mk-saml: ${e.message}`); process.exit(1); }
}

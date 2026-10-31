import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DOMParser } from '@xmldom/xmldom';
import { SignedXml } from 'xml-crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAssertion, describeAssertion, samlSettings, samlUnavailableReason, signerCertPem } from '../saml.js';

const DS = 'http://www.w3.org/2000/09/xmldsig#';
let dir;
let keyFile;
let certFile;

// A throwaway key pair made the way pingfederate/configure-saml.js makes the real one.
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idjag-saml-'));
  keyFile = path.join(dir, 'signer.key.pem');
  certFile = path.join(dir, 'signer.cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-subj', '/CN=test-saml-idp',
    '-keyout', keyFile, '-out', certFile], { stdio: 'ignore' });
});

beforeEach(() => {
  vi.stubEnv('APP_ORIGIN', 'https://app.test');
  vi.stubEnv('SAML_SIGNING_KEY_FILE', keyFile);
  vi.stubEnv('SAML_SIGNING_CERT_FILE', certFile);
  vi.stubEnv('PF_SAML_CLIENT_SECRET', 'saml-client-secret');
});
afterEach(() => vi.unstubAllEnvs());

function verifies(xml, cert) {
  const sig = new DOMParser().parseFromString(xml, 'text/xml').getElementsByTagNameNS(DS, 'Signature')[0];
  const v = new SignedXml({ publicCert: cert });
  v.loadSignature(sig);
  try { return v.checkSignature(xml); } catch { return false; }
}
const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
const build = (over = {}) => buildAssertion({ subject: 'a@pingidentity.com', audience: 'aud1', issuer: 'https://app.test/saml', nowMs: NOW, ...over });

describe('saml settings', () => {
  it('defaults the issuer, audience and client id', () => {
    expect(samlSettings()).toEqual(expect.objectContaining({ issuer: 'https://app.test/saml', audience: 'idJagKitSamlAud', clientId: 'id-jag-kit-saml' }));
  });

  it('takes them from the environment', () => {
    vi.stubEnv('SAML_ISSUER', 'https://idp.test/x');
    vi.stubEnv('SAML_AUDIENCE', 'other-aud');
    vi.stubEnv('PF_SAML_CLIENT_ID', 'other-client');
    expect(samlSettings()).toEqual(expect.objectContaining({ issuer: 'https://idp.test/x', audience: 'other-aud', clientId: 'other-client' }));
  });

  it('is available when both files read and the secret is set', () => {
    expect(samlUnavailableReason()).toBeNull();
  });

  it.each([
    ['SAML_SIGNING_KEY_FILE', ''],
    ['SAML_SIGNING_CERT_FILE', ''],
    ['SAML_SIGNING_KEY_FILE', '/nonexistent/key.pem'],
    ['SAML_SIGNING_CERT_FILE', '/nonexistent/cert.pem'],
    ['PF_SAML_CLIENT_SECRET', ''],
  ])('says what is missing when %s is %j', (name, value) => {
    vi.stubEnv(name, value);
    expect(samlUnavailableReason()).toContain(name);
  });

  it('reads the files at call time: provisioning needs no restart', () => {
    vi.stubEnv('SAML_SIGNING_KEY_FILE', path.join(dir, 'later.key.pem'));
    expect(samlUnavailableReason()).toContain('SAML_SIGNING_KEY_FILE');
    fs.copyFileSync(keyFile, path.join(dir, 'later.key.pem'));
    expect(samlUnavailableReason()).toBeNull();
  });

  it('signerCertPem returns the certificate block only', () => {
    const pem = signerCertPem();
    expect(pem).toMatch(/^-----BEGIN CERTIFICATE-----\n[\s\S]+\n-----END CERTIFICATE-----\n$/);
    expect(new crypto.X509Certificate(pem).subject).toContain('test-saml-idp');
  });
});

describe('buildAssertion', () => {
  it('signs the assertion and the signature verifies', () => {
    const { xml } = build();
    expect(verifies(xml, signerCertPem())).toBe(true);
  });

  it('tampering with the subject breaks the signature', () => {
    const { xml } = build();
    expect(verifies(xml.replace('a@pingidentity.com', 'b@pingidentity.com'), signerCertPem())).toBe(false);
  });

  it('is signed with a different key: it does not verify against another certificate', () => {
    const other = path.join(dir, 'other.cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-subj', '/CN=other',
      '-keyout', path.join(dir, 'other.key.pem'), '-out', other], { stdio: 'ignore' });
    expect(verifies(build().xml, fs.readFileSync(other, 'utf8'))).toBe(false);
  });

  it('backdates IssueInstant and NotBefore 60 s and expires after 300 s', () => {
    const { xml } = build();
    expect(xml).toContain('IssueInstant="2026-10-19T11:59:00Z"');
    expect(xml).toContain('NotBefore="2026-10-19T11:59:00Z"');
    expect(xml).toContain('NotOnOrAfter="2026-10-19T12:05:00Z"');
    expect(xml).toContain('AuthnInstant="2026-10-19T11:59:00Z"');
  });

  it('names the issuer, audience and an emailAddress bearer NameID, with the signature after the Issuer', () => {
    const { xml } = build();
    expect(xml).toContain('<saml:Issuer>https://app.test/saml</saml:Issuer>');
    expect(xml).toContain('<saml:Audience>aud1</saml:Audience>');
    expect(xml).toContain('Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">a@pingidentity.com</saml:NameID>');
    expect(xml).toContain('urn:oasis:names:tc:SAML:2.0:cm:bearer');
    expect(xml).toMatch(/<\/saml:Issuer><ds:Signature/);
    expect(xml).toContain('xmldsig-more#rsa-sha256');
    expect(xml).toContain('<ds:X509Certificate>');
  });

  it('gives every assertion a fresh ID', () => {
    expect(build().id).toMatch(/^_[0-9a-f-]{36}$/);
    expect(build().id).not.toBe(build().id);
  });

  it('escapes < > & " \' in every interpolated value and still verifies', () => {
    const nasty = `a<b>&"c'@pingidentity.com`;
    const { xml } = build({ subject: nasty, audience: nasty, issuer: nasty });
    expect(xml).not.toContain(nasty);
    // The serializer may leave quotes bare in text nodes (valid XML); < > & must never be.
    expect(xml).toContain('a&lt;b&gt;&amp;');
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    expect(doc.getElementsByTagName('saml:NameID')[0].textContent).toBe(nasty);
    expect(doc.getElementsByTagName('saml:Audience')[0].textContent).toBe(nasty);
    expect(verifies(xml, signerCertPem())).toBe(true);
  });

  it('needs a subject and an audience', () => {
    expect(() => build({ subject: '' })).toThrow();
    expect(() => build({ audience: '' })).toThrow();
  });
});

describe('describeAssertion', () => {
  const view = () => describeAssertion(build().xml);

  it('lists the fields the browser shows', () => {
    const v = view();
    expect(v).toEqual(expect.objectContaining({
      issuer: 'https://app.test/saml', nameId: 'a@pingidentity.com', nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      audience: 'aud1', issueInstant: '2026-10-19T11:59:00Z', notBefore: '2026-10-19T11:59:00Z', notOnOrAfter: '2026-10-19T12:05:00Z',
    }));
    expect(v.signature.algorithm).toBe('http://www.w3.org/2001/04/xmldsig-more#rsa-sha256');
    expect(v.signature.canonicalization).toBe('http://www.w3.org/2001/10/xml-exc-c14n#');
    const der = new crypto.X509Certificate(signerCertPem()).raw;
    expect(v.signature.certSha1).toBe(crypto.createHash('sha1').update(der).digest('hex').toUpperCase().match(/../g).join(':'));
  });

  it('truncates DigestValue, SignatureValue and X509Certificate in the pretty-printed xml', () => {
    const { xml } = build();
    const v = describeAssertion(xml);
    for (const tag of ['DigestValue', 'SignatureValue', 'X509Certificate']) {
      expect(v.xml).toContain(`<ds:${tag}>[…]</ds:${tag}>`);
    }
    expect(v.xml).not.toContain(xml.match(/<ds:SignatureValue>([^<]+)</)[1]);
    expect(v.xml).not.toContain(xml.match(/<ds:X509Certificate>([^<]+)</)[1]);
    expect(v.xml).not.toContain(xml.match(/<ds:DigestValue>([^<]+)</)[1]);
  });

  it('pretty-prints one element per line, keeping text with its element', () => {
    const lines = view().xml.split('\n');
    expect(lines.length).toBeGreaterThan(15);
    expect(lines).toContain('  <saml:Issuer>https://app.test/saml</saml:Issuer>');
    expect(lines[0]).toMatch(/^<saml:Assertion /);
    expect(lines.at(-1)).toBe('</saml:Assertion>');
  });

  it('never carries the signed xml itself', () => {
    expect(JSON.stringify(view())).not.toContain('<ds:Signature><');
  });
});

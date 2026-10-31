import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAssertion, verify } from './mk-saml.mjs';

const opts = { audience: 'idJagSpikeAud', subject: 'a@example.com', lifetimeSeconds: 120, nowMs: Date.UTC(2026, 0, 1, 12, 0, 0) };

test('signature verifies and carries KeyInfo/X509Data', () => {
  const { xml, cert } = buildAssertion(opts);
  assert.ok(verify(xml, cert));
  assert.match(xml, /<ds:KeyInfo>.*<ds:X509Data>.*<ds:X509Certificate>/s);
  assert.ok(xml.indexOf('</saml:Issuer><ds:Signature') > 0);
});

test('tampering with the subject breaks the signature', () => {
  const { xml, cert } = buildAssertion(opts);
  assert.equal(verify(xml.replace('a@example.com', 'evil@example.com'), cert), false);
});

test('audience and lifetimes are as asked; IDs are unique', () => {
  const a = buildAssertion(opts), b = buildAssertion(opts);
  assert.match(a.xml, /<saml:Audience>idJagSpikeAud<\/saml:Audience>/);
  assert.match(a.xml, /NotBefore="2026-01-01T11:59:00Z" NotOnOrAfter="2026-01-01T12:02:00Z"/);
  assert.notEqual(a.id, b.id);
});

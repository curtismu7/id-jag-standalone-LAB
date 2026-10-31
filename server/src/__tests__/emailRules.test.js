import { describe, expect, it } from 'vitest';
import { allowedDomains, checkEmail } from '../auth/emailRules.js';

const DOMAINS = ['pingidentity.com', 'pingone.com'];
const ok = (email, extra = {}) => ({ email, email_verified: true, ...extra });

describe('email rules', () => {
  it.each([
    'alice@pingidentity.com',
    'bob.smith@pingone.com',
    'Alice@PingIdentity.COM', // domains compare case-insensitively
    'x_y-z@PINGONE.com',
  ])('allows %s', (email) => {
    expect(checkEmail(ok(email), DOMAINS)).toBeNull();
  });

  it.each([
    ['subdomain', 'a@eng.pingidentity.com', 'domain'],
    ['lookalike suffix', 'a@pingidentity.com.evil.test', 'domain'],
    ['lookalike prefix', 'a@evilpingidentity.com', 'domain'],
    ['other TLD', 'a@pingidentity.co', 'domain'],
    ['trailing dot', 'a@pingidentity.com.', 'domain'],
    ['homoglyph (Cyrillic i)', 'a@pіngidentity.com', 'domain'],
    ['outside domain', 'a@gmail.com', 'domain'],
    ['plus address', 'alice+test@pingidentity.com', 'plus'],
    ['plus at the start', '+alice@pingone.com', 'plus'],
    ['quoted plus', '"a+b"@pingidentity.com', 'plus'],
    ['two @', 'a@evil.test@pingidentity.com', 'format'],
    ['whitespace', 'a b@pingidentity.com', 'format'],
    ['no @', 'pingidentity.com', 'format'],
    ['missing', undefined, 'missing'],
    ['not a string', ['a@pingidentity.com'], 'missing'],
  ])('refuses %s', (_name, email, rule) => {
    expect(checkEmail(ok(email), DOMAINS)?.rule).toBe(rule);
  });

  it.each([
    ['false', false],
    ['absent', undefined],
    ['the string "true"', 'true'],
    ['1', 1],
  ])('refuses email_verified %s', (_name, value) => {
    expect(checkEmail({ email: 'a@pingidentity.com', email_verified: value }, DOMAINS)?.rule).toBe('unverified');
  });

  it('every refusal carries a human explanation', () => {
    expect(checkEmail(ok('a@gmail.com'), DOMAINS).message).toMatch(/pingidentity\.com, pingone\.com/);
  });

  it('reads ALLOWED_EMAIL_DOMAINS, defaulting to the two Ping domains', () => {
    expect(allowedDomains({})).toEqual(DOMAINS);
    expect(allowedDomains({ ALLOWED_EMAIL_DOMAINS: ' Example.TEST , ,other.test ' })).toEqual(['example.test', 'other.test']);
  });
});

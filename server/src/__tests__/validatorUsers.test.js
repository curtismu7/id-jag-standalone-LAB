import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const { missingFirstUser } = createRequire(import.meta.url)('../../../pingfederate/validator-users.js');

describe('configure-local-signin: PingFederate needs a first user', () => {
  it('refuses to create the validator when no user was given, naming the flag', () => {
    expect(missingFirstUser({ exists: false, wanted: [] })).toMatch(/--users=you@pingidentity\.com/);
  });
  it('is fine when a user is given', () => {
    expect(missingFirstUser({ exists: false, wanted: ['a@pingidentity.com'] })).toBeNull();
  });
  it('is fine when the validator already exists, even with no new users', () => {
    expect(missingFirstUser({ exists: true, wanted: [] })).toBeNull();
  });
});

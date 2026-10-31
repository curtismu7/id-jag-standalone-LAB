import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const { ID, adapterBody, clientBody, REDIRECT } = createRequire(import.meta.url)('../../../pingfederate/configure-acme-signin.js');

describe('configure-acme-signin helpers', () => {
  it('never targets the demo\'s acme-agent, and prefixes what it creates', () => {
    expect(ID).toEqual({ adapter: 'idJagKitAcmeForm', client: 'id-jag-kit-acme' });
  });

  it('the adapter uses the descriptor defaults plus acmeUsers as its only credential validator', () => {
    const b = adapterBody({ configDescriptor: { fields: [{ name: 'Challenge Retries', defaultValue: 3 }, { name: 'Unset' }] } });
    expect(b.configuration.fields).toEqual([{ name: 'Challenge Retries', value: '3' }]);
    expect(b.configuration.tables[0].rows[0].fields).toEqual([{ name: 'Password Credential Validator Instance', value: 'acmeUsers' }]);
    expect(b.attributeContract.coreAttributes.map((a) => a.name)).toEqual(['policy.action', 'username']);
  });

  it('the client is authorization code + pi.flow, restricted to offline_access, with the playground callback', () => {
    const c = clientBody('s3cret');
    expect(c).toEqual(expect.objectContaining({ clientId: 'id-jag-kit-acme', allowAuthenticationApiInit: true, restrictScopes: true, restrictedScopes: ['offline_access'] }));
    expect(c.grantTypes).toEqual(['AUTHORIZATION_CODE', 'REFRESH_TOKEN', 'TOKEN_EXCHANGE']);
    expect(c.redirectUris).toEqual([REDIRECT]);
    expect(REDIRECT).toMatch(/\/api\/id-jag-playground\/issuer\/callback$/);
    expect(c.clientAuth.secret).toBe('s3cret');
    expect(clientBody(null).clientAuth).toBeUndefined(); // an existing client keeps its secret
  });
});

// Offline checks of the pure helpers in pingfederate/configure-saml.js (the script itself runs against PingFederate).
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const { ID, pickDescriptor, policyMapping, withMapping, withoutMapping, scopeOf } = createRequire(import.meta.url)('../../../pingfederate/configure-saml.js');

const existing = { processorPolicyRef: { id: 'idJagKitIdTokenPolicy' }, attributeContractFulfillment: { scope: { source: { type: 'TEXT' }, value: 'read mcp:invoke' } } };
const sp = (mappings) => ({ id: ID.sp, entityId: 'https://as.test', oauthTokenExchangeSettings: { idJagEnabled: true, resourceUris: ['https://mcp.test/mcp'], processorPolicyMappings: mappings } });

describe('configure-saml helpers', () => {
  it('the ids are the contract\'s (the CA id lower case)', () => {
    expect(ID).toEqual({ ca: 'idjagkitsamlca', proc: 'idJagKitSaml', policy: 'idJagKitSamlPolicy', sp: 'idJagKitResourceAsSp', client: 'id-jag-kit-saml' });
  });

  it('adds one SAML mapping with the scope the existing mappings use, and leaves the rest of the connection alone', () => {
    const before = sp([existing]);
    const after = withMapping(before, ID.policy);
    expect(after.oauthTokenExchangeSettings.processorPolicyMappings).toEqual([existing, policyMapping(ID.policy, 'read mcp:invoke')]);
    expect(after.oauthTokenExchangeSettings).toEqual(expect.objectContaining({ idJagEnabled: true, resourceUris: ['https://mcp.test/mcp'] }));
    expect(after.entityId).toBe('https://as.test');
    expect(before.oauthTokenExchangeSettings.processorPolicyMappings).toHaveLength(1);
  });

  it('takes the scope from any existing mapping, else the mcp-sample default', () => {
    expect(scopeOf(sp([{ processorPolicyRef: { id: 'x' }, attributeContractFulfillment: {} }, { ...existing, attributeContractFulfillment: { scope: { value: 'a b' } } }]))).toBe('a b');
    expect(scopeOf(sp([]))).toBe('read mcp:invoke');
  });

  it('is idempotent: a second add returns the same object', () => {
    const once = withMapping(sp([existing]), ID.policy);
    expect(withMapping(once, ID.policy)).toBe(once);
  });

  it('an existing SAML mapping with the old client_id is corrected, and nothing else of it changes', () => {
    const old = { processorPolicyRef: { id: ID.policy }, attributeContractFulfillment: { client_id: { source: { type: 'TOKEN_EXCHANGE_PROCESSOR_POLICY' }, value: 'client_id' }, scope: { source: { type: 'TEXT' }, value: 'a b' } } };
    const after = withMapping(sp([existing, old]), ID.policy).oauthTokenExchangeSettings.processorPolicyMappings;
    expect(after[0]).toBe(existing);
    expect(after[1].attributeContractFulfillment).toEqual({ client_id: { source: { type: 'TEXT' }, value: 'id-jag-playground' }, scope: { source: { type: 'TEXT' }, value: 'a b' } });
  });

  it('the mapping takes the subject from the policy and pins client_id to the resource AS client (draft 4.4.1)', () => {
    expect(policyMapping(ID.policy, 'read').attributeContractFulfillment).toEqual({
      TOKEN_SUBJECT: { source: { type: 'TOKEN_EXCHANGE_PROCESSOR_POLICY' }, value: 'TOKEN_SUBJECT' },
      client_id: { source: { type: 'TEXT' }, value: 'id-jag-playground' },
      scope: { source: { type: 'TEXT' }, value: 'read' },
    });
  });

  it('remove drops only the SAML mapping; with none to drop it returns the same object', () => {
    const both = withMapping(sp([existing]), ID.policy);
    expect(withoutMapping(both, ID.policy).oauthTokenExchangeSettings.processorPolicyMappings).toEqual([existing]);
    const plain = sp([existing]);
    expect(withoutMapping(plain, ID.policy)).toBe(plain);
  });

  describe('pickDescriptor', () => {
    const saml = { id: 'com.pingidentity.plugins.tokenprocessors.saml20.Saml20TokenProcessor', name: 'SAML 2.0 Token Processor',
      configDescriptor: { fields: [{ name: 'Audience' }] }, attributeContract: [{ name: 'SAML_SUBJECT' }, { name: 'x' }] };
    const jwt = { id: 'jwt.Processor', name: 'JWT Token Processor', configDescriptor: { fields: [] }, attributeContract: [] };

    it('finds the SAML 2.0 processor and its subject attribute', () => {
      expect(pickDescriptor([jwt, saml])).toEqual(expect.objectContaining({ desc: saml, subjectAttr: 'SAML_SUBJECT', contract: ['SAML_SUBJECT', 'x'] }));
    });

    it.each([
      ['no SAML processor', [jwt], /no SAML token processor.*jwt\.Processor/],
      ['no Audience field', [{ ...saml, configDescriptor: { fields: [{ name: 'Other' }] } }], /no "Audience" field/],
      ['no attribute contract', [{ ...saml, attributeContract: [] }], /no attribute contract/],
    ])('says why on %s', (_n, items, msg) => {
      expect(pickDescriptor(items).error).toMatch(msg);
    });
  });
});

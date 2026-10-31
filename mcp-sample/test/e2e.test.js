// End to end, the way an MCP client would do it: 401 -> protected-resource
// metadata -> AS metadata -> redeem an ID-JAG from a test IdP -> tools/list.
// Uses ../resource-as directly, so it needs `npm install` there first.
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createHandler as createMcp } from '../src/app.js';
import { listen, rpc } from './helpers.js';

const resourceAsInstalled = fs.existsSync(new URL('../../resource-as/node_modules/jose', import.meta.url));

describe.skipIf(!resourceAsInstalled)('end to end (needs: cd ../resource-as && npm install)', () => {
  it('test IdP -> resource-as /token -> mcp-sample tools/list', async () => {
    const { createHandler: createAs } = await import('../../resource-as/src/app.js');
    const { startTestIdp, mintIdJag, newRsaKey } = await import('../../resource-as/test/helpers.js');
    const idp = await startTestIdp();
    const mcp = await listen();
    const as = await listen();
    try {
      const resource = `${mcp.url}/mcp`;
      mcp.handler = createMcp({ asIssuer: as.url, asJwksUrl: `${as.url}/jwks`, resource });
      as.handler = createAs({
        issuer: as.url,
        acceptedResources: [resource],
        clients: [{ client_id: 'agent-1', client_secret_hash: createHash('sha256').update('s3cret').digest('hex'), scope: 'read mcp:invoke' }],
        signingKey: newRsaKey(),
        idps: [{ id: 'test', issuer: idp.issuer, jwksUrl: idp.jwksUrl, clientAliases: { 'agent-1': 'agent-1' }, scopes: '' }],
        log: () => {},
      });

      // Discovery from the 401 alone.
      const challenge = (await rpc(mcp.url, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).headers.get('www-authenticate');
      const prm = await (await fetch(/resource_metadata="([^"]+)"/.exec(challenge)[1])).json();
      const asMeta = await (await fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json();
      expect(asMeta.authorization_grant_profiles_supported).toContain('urn:ietf:params:oauth:grant-profile:id-jag');

      const idJag = await mintIdJag(idp, { audience: asMeta.issuer, resource: prm.resource, scope: 'read' });
      const tokenRes = await fetch(asMeta.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: idJag, resource: prm.resource,
          client_id: 'agent-1', client_secret: 's3cret',
        }),
      });
      expect(tokenRes.status).toBe(200);
      const { access_token: accessToken } = await tokenRes.json();

      const list = await rpc(mcp.url, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, accessToken);
      expect(list.status).toBe(200);
      expect(list.body.result.tools.map((t) => t.name)).toEqual(['whoami']);
      expect(list.body.result._meta.deniedTools.map((t) => t.name)).toEqual(['echo', 'server_time']);

      const who = await rpc(mcp.url, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'whoami', arguments: {} } }, accessToken);
      expect(JSON.parse(who.body.result.content[0].text)).toEqual({ sub: 'user-123', client_id: 'agent-1', scope: 'read' });
    } finally {
      await Promise.all([idp.close(), mcp.close(), as.close()]);
    }
  });
});

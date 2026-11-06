import fs from 'node:fs';
for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] ??= m[2].trim();
}
const { config } = await import('./server/src/config.js');
const { requestOrigin } = await import('./server/src/requestOrigin.js');
console.log('proxyOrigin:', config().proxyOrigin);
const req = { headers: { 'x-forwarded-host': 'local.ping-devops.com:8443' } };
console.log('requestOrigin:', requestOrigin(req));

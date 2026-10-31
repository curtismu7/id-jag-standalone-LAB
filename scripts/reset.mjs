// Return the demo to a fresh state between customers: npm run reset -- --yes [--dry-run]
// Clears DATA_DIR registrations and Trusted IdPs, archives the audit log, removes registered PingFederate users.
// A running server's web sessions live in its memory: they end when it restarts, or use POST /api/admin/reset instead.
import { fileURLToPath } from 'node:url';
import { removeUserForReset as removeUser } from '../server/src/idp/index.js';
import { removeClient } from '../server/src/registry/clients.js';
import { reset } from '../server/src/reset.js';
import { DEFAULT_WORKSPACE, dataDir } from '../server/src/workspace.js';

try { process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url))); } catch { /* no .env */ }

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
if (!dryRun && !args.includes('--yes')) {
  console.error('This clears registrations, Trusted IdPs, the audit log (archived) and registered PingFederate users.\nRe-run with --yes to do it, or --dry-run to see what it would clear.');
  process.exit(2);
}
const r = await reset({ dataDir: dataDir(DEFAULT_WORKSPACE), now: new Date(), actor: 'cli', dryRun, removeUser, removeClient });
console.log(`${dryRun ? 'Would clear' : 'Cleared'} in ${dataDir(DEFAULT_WORKSPACE)}: ${r.registrations} registration request(s), ${r.idps} trusted IdP(s), ${r.clients.length} resource-AS client(s); audit log ${r.auditArchive ? `archived as ${r.auditArchive}` : 'had nothing to archive'}.`);
console.log(`${dryRun ? 'Would remove' : 'Removed'} PingFederate users: ${r.users.join(', ') || 'none'}`);
if (!dryRun) console.log('Web sessions of a running server are not touched by the CLI (restart it, or use the admin route).');
for (const e of r.pfKept || []) console.log(`Kept ${e} in PingFederate: it is the last user and PingFederate needs at least one.`);
for (const f of r.pfFailed) console.error(`Could not remove ${f.email} from PingFederate: ${f.error}`);
for (const c of r.clientsFailed) console.error(`Could not remove resource-AS client ${c}`);
process.exit(r.ok ? 0 : 1);

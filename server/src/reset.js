// Return a demo to a fresh state between customers. Clears only what the demo itself created:
//   DATA_DIR/registrations.json (and the PingFederate users it approved), DATA_DIR/trusted-idps.json (and the
//   resource-AS client each approved IdP got), the audit log (archived, then restarted), web sessions, in-memory caches.
// It never touches .env, secrets, kit-users.json or any PingFederate setting other than the registered users.
// Everything it needs from outside is injected, so tests run it against a temp dir and fakes.

import fs from 'node:fs';
import path from 'node:path';

const readJson = (f) => { try { const p = JSON.parse(fs.readFileSync(f, 'utf8')); return Array.isArray(p) ? p : []; } catch { return []; } };
const exists = (f) => fs.existsSync(f);

/**
 * @param {object} o
 * @param {string} o.dataDir
 * @param {Date} o.now                   names the archived audit file and stamps the 'reset' line
 * @param {string} o.actor               who asked (admin email or 'cli')
 * @param {boolean} [o.dryRun]           report only, change nothing
 * @param {(email:string)=>Promise<boolean>} o.removeUser     PingFederate user removal
 * @param {(clientId:string)=>void} o.removeClient            resource-AS client removal
 * @param {(cb:Function)=>void} [o.clearSessions]             e.g. sessionStore.clear.bind(sessionStore)
 * @param {Function[]} [o.clearMemory]   in-memory caches to empty
 * @returns {Promise<{dryRun:boolean, registrations:number, users:string[], pfFailed:{email:string,error:string}[], pfKept:string[], clients:string[], clientsFailed:string[], idps:number, auditArchive:string|null, sessionsCleared:boolean, ok:boolean}>}
 */
export async function reset({ dataDir, now, actor, dryRun = false, removeUser, removeClient, clearSessions, clearMemory = [] }) {
  const regFile = path.join(dataDir, 'registrations.json');
  const idpFile = path.join(dataDir, 'trusted-idps.json');
  const auditFile = path.join(dataDir, 'audit.jsonl');
  const regs = readJson(regFile);
  const idps = readJson(idpFile);
  const users = [...new Set(regs.filter((r) => r.status === 'approved' && r.email).map((r) => String(r.email).toLowerCase()))];
  const clients = idps.filter((e) => e?.id && Array.isArray(e.targets) && e.targets.includes('resource-as')).map((e) => `idp-${e.id}`);
  const archive = exists(auditFile) ? `audit-${now.toISOString().replace(/[:.]/g, '-')}.jsonl` : null;
  const report = {
    dryRun, registrations: regs.length, users, pfFailed: [], pfKept: [], clients, clientsFailed: [], idps: idps.length,
    auditArchive: archive, sessionsCleared: false, ok: true,
  };
  if (dryRun) return report;

  // PingFederate first and best-effort: an unreachable PF must not stop the local reset.
  for (const email of users) {
    try { await removeUser(email); } catch (err) {
      // The last user cannot be removed (PingFederate needs one): expected, not a failure.
      if (err.lastUser) report.pfKept.push(email); else report.pfFailed.push({ email, error: err.message });
    }
  }
  for (const id of clients) {
    try { removeClient(id); } catch { report.clientsFailed.push(id); }
  }
  fs.rmSync(regFile, { force: true });
  fs.rmSync(idpFile, { force: true });
  if (archive) fs.renameSync(auditFile, path.join(dataDir, archive));
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(auditFile, `${JSON.stringify({ at: now.toISOString(), actor, action: 'reset', archivedAudit: archive })}\n`);
  for (const fn of clearMemory) fn();
  if (clearSessions) {
    await new Promise((resolve) => { clearSessions(() => resolve()); });
    report.sessionsCleared = true;
  }
  report.ok = !report.pfFailed.length && !report.clientsFailed.length;
  return report;
}

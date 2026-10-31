#!/usr/bin/env node
// npm run setup -- [--yes] [--mode=mock|pf-as|pf-pf|byo|pf-local] [--idp=local] [--users=a@x,b@y] [--pf-url=...] [--pf-client-id=...]
//   [--pf-admin-url=...] [--acme-client-id=...] [--run=npm|docker] [--force]
// Secrets are read without echo, or from the environment (PF_EXCHANGE_CLIENT_SECRET, PF_ADMIN_PASSWORD,
// ACME_EXCHANGE_CLIENT_SECRET), never from flags.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { runSetup } from './setup-lib.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

let rl;
const reader = () => (rl ??= createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY }));
const io = {
  log: (...lines) => lines.forEach((l) => console.log(l)),
  err: (l) => console.error(l),
  ask: async (q, def) => (await reader().question(def ? `${q} [${def}]: ` : `${q}: `)).trim() || def,
  askSecret: async (q) => {
    const r = reader();
    const write = r._writeToOutput;
    process.stdout.write(`${q} (hidden): `);
    r._writeToOutput = () => {};
    try { return (await r.question('')).trim(); } finally { r._writeToOutput = write; process.stdout.write('\n'); }
  },
};
// opts.env is added to the environment (how pf-local hands the admin login to a child: never on a command line).
// opts.stdio 'inherit' gives the child the terminal (the PingFederate installer asks for YES), so our reader lets go of it.
const exec = async (cmd, args, opts = {}) => {
  const inherit = opts.stdio === 'inherit';
  if (inherit) { rl?.close(); rl = undefined; }
  const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', env: { ...process.env, ...opts.env }, stdio: inherit ? 'inherit' : 'pipe' });
  return { code: r.error ? 127 : r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};
const fsp = { existsSync: fs.existsSync, ...fs.promises };

const { code } = await runSetup({ argv: process.argv.slice(2), env: process.env, root, home: os.homedir(), io, fs: fsp, exec });
rl?.close();
process.exit(code);

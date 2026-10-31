#!/usr/bin/env node
// npm run doctor -- [--json] [--mode=mock|pf-as|pf-pf|byo]   Exit 1 if any check fails. Never prints secret values.
// Works in both app modes (MODE=mock|live, or the choice saved by the toggle): in mock mode it also proves the netguard and the mock servers.
import { fileURLToPath } from 'node:url';
import { formatReport, MODES, runDoctor } from '../server/src/doctor.js';
import { loadSettings } from '../server/src/settings.js';

const envFile = fileURLToPath(new URL('../.env', import.meta.url));
const loaded = loadSettings({ repoEnv: envFile }); // real env, then the shared settings file, then the repo .env

const args = process.argv.slice(2);
const mode = args.find((a) => a.startsWith('--mode='))?.slice(7) || 'mock';
if (!MODES.includes(mode)) {
  console.error(`unknown mode ${mode}; use one of ${MODES.join(', ')}`);
  process.exit(2);
}
const report = await runDoctor({ mode, envFile: loaded[0] });
console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : formatReport(report));
process.exit(report.ok ? 0 : 1);

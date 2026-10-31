#!/usr/bin/env node
/**
 * The kit is the source of truth for the playground pieces that are plain functions and data, which the AI-DEMO2
 * app vendors (copies) instead of re-writing: the code snippet builder, the real-client setup text, the run report builder, and the Learn
 * glossary and source library. This copies them into an AI-DEMO2 checkout and writes a manifest of their hashes; the
 * app's CI fails when a vendored file no longer matches its manifest entry (scripts/check-id-jag-core.js there).
 *
 *   node scripts/sync-to-app.mjs --app=/path/to/AI-DEMO2          copy + write the manifest (kit files must be committed)
 *   node scripts/sync-to-app.mjs --app=/path/to/AI-DEMO2 --check  compare only; exit 1 on any difference
 *
 * Flow code (sign-in, the playground page, servers) is NOT shared: it differs by design. See docs/sync-with-app.md.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** [path in the kit, path in the app]. */
export const FILES = [
  ['web/src/utils/codeSnippet.js', 'demo_api_ui/src/utils/codeSnippet.js'],
  ['web/src/utils/__tests__/codeSnippet.test.js', 'demo_api_ui/src/utils/__tests__/codeSnippet.test.js'],
  ['web/src/utils/realClients.js', 'demo_api_ui/src/utils/realClients.js'],
  ['web/src/utils/runReport.js', 'demo_api_ui/src/utils/runReport.js'],
  ['web/src/data/terms.json', 'demo_api_ui/src/data/idJagTerms.json'],
  ['web/src/data/sources.json', 'demo_api_ui/src/data/idJagSources.json'],
];
export const MANIFEST = 'demo_api_ui/src/data/idJagCore.manifest.json';

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Copy (or, with check, only compare) every shared file; returns { problems, manifest }. */
export function sync({ kit, app, commit, check = false }) {
  const problems = [];
  const files = {};
  for (const [from, to] of FILES) {
    const src = path.join(kit, from);
    const dst = path.join(app, to);
    const want = sha(src);
    if (check) {
      if (!fs.existsSync(dst)) problems.push(`${to}: missing in the app`);
      else if (sha(dst) !== want) problems.push(`${to}: differs from the kit's ${from}`);
    } else {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
    files[to] = want;
  }
  const manifest = { source: 'id-jag-standalone', commit, files };
  const mpath = path.join(app, MANIFEST);
  if (check) {
    let have = null;
    try { have = JSON.parse(fs.readFileSync(mpath, 'utf8')); } catch { /* reported below */ }
    if (!have) problems.push(`${MANIFEST}: missing or not JSON`);
    else for (const [to, h] of Object.entries(files)) if (have.files?.[to] !== h) problems.push(`${MANIFEST}: entry for ${to} is not the kit's current hash`);
  } else {
    fs.writeFileSync(mpath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return { problems, manifest };
}

function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.length ? v.join('=') : true]; }));
  const kit = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (!args.app || args.app === true) { console.error('pass --app=/path/to/AI-DEMO2'); process.exit(2); }
  const app = path.resolve(String(args.app));
  if (!fs.existsSync(path.join(app, 'demo_api_ui'))) { console.error(`${app} does not look like an AI-DEMO2 checkout (no demo_api_ui/)`); process.exit(2); }
  const git = (...a) => execFileSync('git', ['-C', kit, ...a]).toString().trim();
  if (!args.check) {
    const dirty = git('status', '--porcelain', '--', ...FILES.map(([from]) => from));
    if (dirty) { console.error(`commit your changes to these kit files first, so the manifest names a real commit:\n${dirty}`); process.exit(1); }
  }
  const { problems } = sync({ kit, app, commit: git('rev-parse', 'HEAD'), check: Boolean(args.check) });
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
  console.log(args.check ? 'in sync' : `synced ${FILES.length} files into ${app}; commit them with the manifest in the app repo`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

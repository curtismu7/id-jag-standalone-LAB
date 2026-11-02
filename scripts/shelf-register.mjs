#!/usr/bin/env node
// Puts this app on the demo shelf if it is not there yet. Vendored into every standalone app's scripts/
// (check-drift.sh keeps the copies identical) and run by the app's `prestart`.
//   - Reads <app>/docs/shelf-entry.json.
//   - Finds the shelf: SHELF_DATA_DIR, else a demo-shelf-LAB (or older demo-shelf) checkout beside the app.
//   - On the shelf already (seed data/demos.json or .data/demos.local.json, matched by id): does nothing.
//   - Not there: appends the entry to .data/demos.local.json (git-ignored).
//   - No shelf found, SHELF_AUTOREGISTER=0, or anything goes wrong: logs one line and exits 0. It never blocks a start.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ID = /^[a-z0-9][a-z0-9-]{0,39}[a-z0-9]$/;

// The shelf stops at startup on an invalid entry, so only write one it will accept (its rules, in short).
function entryProblem(e) {
  if (!e || !ID.test(e.id || '')) return 'needs an id of lower case letters, digits and -';
  for (const k of ['name', 'description']) {
    if (typeof e[k] !== 'string' || !e[k] || e[k].length > 300) return `${k} must be 1 to 300 characters`;
  }
  try {
    const u = new URL(e.url);
    if (!/^https?:$/.test(u.protocol) || u.pathname !== '/' || u.search || u.hash || u.username) return 'url must be a plain http(s) origin';
  } catch {
    return 'url is not a valid URL';
  }
  return null;
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const idsOf = (file) => {
  try { return (readJson(file).demos || []).map((d) => d.id); } catch { return []; }
};

function findShelf(appRoot, env) {
  if (env.SHELF_DATA_DIR) {
    const data = path.resolve(env.SHELF_DATA_DIR);
    return { dataDir: data, seed: path.join(path.dirname(data), 'data', 'demos.json'), root: path.dirname(data) };
  }
  for (const rel of ['../demo-shelf-LAB', '../demo-shelf']) {
    const root = path.resolve(appRoot, rel);
    if (fs.existsSync(path.join(root, 'data', 'demos.json'))) {
      return { dataDir: path.join(root, '.data'), seed: path.join(root, 'data', 'demos.json'), root };
    }
  }
  return null;
}

// Entries name composeFile relative to the demo root (the folder the repos sit in). Some name it relative to the
// app instead; if only that reading finds a file, rewrite it so the shelf can too.
function fixCompose(entry, appRoot, demoRoot) {
  const f = entry.composeFile;
  if (!f || path.isAbsolute(f) || fs.existsSync(path.join(demoRoot, f))) return entry;
  const inApp = path.join(appRoot, f);
  if (!fs.existsSync(inApp)) return entry;
  return { ...entry, composeFile: path.relative(demoRoot, inApp) };
}

export function registerOnShelf({ appRoot, env = process.env, log = console.log }) {
  if (env.SHELF_AUTOREGISTER === '0') return 'disabled';
  const entryFile = path.join(appRoot, 'docs', 'shelf-entry.json');
  if (!fs.existsSync(entryFile)) return 'no-entry';
  let entry;
  try {
    const raw = readJson(entryFile);
    entry = Array.isArray(raw.demos) ? raw.demos[0] : raw;
  } catch (e) {
    log(`[shelf] cannot read docs/shelf-entry.json (${e.message}); not registering`);
    return 'bad-entry';
  }
  const problem = entryProblem(entry);
  if (problem) {
    log(`[shelf] docs/shelf-entry.json ${problem}; not registering (the shelf refuses to start on a bad entry)`);
    return 'bad-entry';
  }
  const shelf = findShelf(appRoot, env);
  if (!shelf) {
    log('[shelf] no demo-shelf-LAB folder beside this app; skipping');
    return 'no-shelf';
  }
  const local = path.join(shelf.dataDir, 'demos.local.json');
  if (idsOf(shelf.seed).includes(entry.id) || idsOf(local).includes(entry.id)) {
    log(`[shelf] ${entry.id} is already on the shelf`);
    return 'present';
  }
  let doc = { demos: [] };
  if (fs.existsSync(local)) {
    try { doc = readJson(local); } catch (e) {
      log(`[shelf] ${local} is not valid JSON (${e.message}); leaving it alone`);
      return 'bad-local';
    }
    if (!Array.isArray(doc.demos)) doc.demos = [];
  }
  const demoRoot = env.SHELF_DEMO_ROOT ? path.resolve(env.SHELF_DEMO_ROOT) : path.dirname(shelf.root);
  doc.demos.push(fixCompose(entry, appRoot, demoRoot));
  fs.mkdirSync(shelf.dataDir, { recursive: true });
  const tmp = `${local}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
  fs.renameSync(tmp, local);
  log(`[shelf] added ${entry.id} to ${local}. Restart the shelf to see it.`);
  return 'added';
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    registerOnShelf({ appRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') });
  } catch (e) {
    console.log(`[shelf] skipped: ${e.message}`);
  }
}

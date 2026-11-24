// The vendored run-observability files (rule 27) are byte-identical to the canonical pin in run-observability.sha256.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PIN_FILE, checkPin } from './run-observability-checkPin.mjs';

const labRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CODE = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx']);

// Every code file under web/src and server/src, as a lab-relative path with forward slashes.
function codeFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) codeFiles(full, out);
    else if (entry.isFile() && CODE.has(extname(entry.name))) out.push(relative(labRoot, full).split(sep).join('/'));
  }
  return out;
}

test('run-observability vendored files match the canonical pin', () => {
  assert.deepEqual(checkPin(labRoot), []);
});

test('no RUN_OBS_* name outside the pinned vendored files (this lab reads no logs, CLAUDE.md)', () => {
  // The exemption is exact: a path listed in the pin file (never a suffix match).
  const pinned = new Set(
    fs.readFileSync(resolve(labRoot, PIN_FILE), 'utf8').split('\n')
      .filter((l) => /^[0-9a-f]{64} {2}\S/.test(l)).map((l) => l.slice(66).trim()),
  );
  const files = ['web/src', 'server/src'].flatMap((d) => codeFiles(resolve(labRoot, d)));
  const hits = files.filter((f) => !pinned.has(f) && /RUN_OBS_/.test(fs.readFileSync(resolve(labRoot, f), 'utf8')));
  assert.deepEqual(hits, []);
});

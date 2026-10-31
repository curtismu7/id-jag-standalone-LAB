import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FILES, MANIFEST, sync } from './sync-to-app.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idjag-sync-'));
function fixture() {
  const kit = tmp();
  const app = tmp();
  for (const [from] of FILES) { fs.mkdirSync(path.dirname(path.join(kit, from)), { recursive: true }); fs.writeFileSync(path.join(kit, from), `// ${from}\n`); }
  return { kit, app };
}

test('copies every shared file and writes a manifest naming the commit and each hash', () => {
  const { kit, app } = fixture();
  const { problems, manifest } = sync({ kit, app, commit: 'abc123' });
  assert.deepEqual(problems, []);
  for (const [from, to] of FILES) assert.equal(fs.readFileSync(path.join(app, to), 'utf8'), `// ${from}\n`);
  assert.equal(manifest.commit, 'abc123');
  assert.equal(Object.keys(manifest.files).length, FILES.length);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(app, MANIFEST), 'utf8')), manifest);
});

test('--check passes right after a sync, and names the file when an app copy is edited', () => {
  const { kit, app } = fixture();
  sync({ kit, app, commit: 'c1' });
  assert.deepEqual(sync({ kit, app, commit: 'c1', check: true }).problems, []);
  fs.appendFileSync(path.join(app, FILES[0][1]), '// hand edit\n');
  const { problems } = sync({ kit, app, commit: 'c1', check: true });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /codeSnippet\.js: differs from the kit/);
});

test('--check names a kit change the app has not been synced to, and a missing manifest', () => {
  const { kit, app } = fixture();
  sync({ kit, app, commit: 'c1' });
  fs.appendFileSync(path.join(kit, FILES[2][0]), '// new kit change\n');
  assert.ok(sync({ kit, app, commit: 'c2', check: true }).problems.some((p) => p.includes('realClients.js')));
  fs.rmSync(path.join(app, MANIFEST));
  assert.ok(sync({ kit, app, commit: 'c2', check: true }).problems.some((p) => p.includes('missing or not JSON')));
});

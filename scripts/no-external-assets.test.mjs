// Mock mode makes no outbound calls (rule 3), and that includes the browser: the page may not load a font, script,
// stylesheet or image from another site. The fonts are bundled (@fontsource), not fetched from Google.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

test('web/index.html links nothing from another origin', () => {
  const html = read('web', 'index.html');
  const external = [...html.matchAll(/\b(?:href|src)\s*=\s*"(?:https?:)?\/\/[^"]+"/g)].map((m) => m[0]);
  assert.deepEqual(external, []);
});

test('the fonts the shared stylesheet names (Montserrat, IBM Plex Mono) are bundled by main.jsx', () => {
  const main = read('web', 'src', 'main.jsx');
  assert.match(main, /@fontsource\/montserrat\/400\.css/);
  assert.match(main, /@fontsource\/montserrat\/700\.css/);
  assert.match(main, /@fontsource\/ibm-plex-mono\/400\.css/);
  const pkg = JSON.parse(read('web', 'package.json'));
  assert.ok(pkg.dependencies['@fontsource/montserrat'] && pkg.dependencies['@fontsource/ibm-plex-mono']);
});

test('no app stylesheet imports or loads a remote font or file', () => {
  const dirs = [path.join(root, 'web', 'src')];
  const css = [];
  while (dirs.length) {
    for (const e of fs.readdirSync(dirs.pop(), { withFileTypes: true })) {
      const p = path.join(e.parentPath ?? e.path, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') dirs.push(p); } else if (e.name.endsWith('.css')) css.push(p);
    }
  }
  assert.ok(css.length > 0);
  for (const f of css) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /(?:@import|url\()\s*['"]?(?:https?:)?\/\//, path.relative(root, f));
});

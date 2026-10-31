// The demo's declaration file (design 4.1). Base code may read `demo/demo.json` and no other demo file.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const FILE = fileURLToPath(new URL('../../demo/demo.json', import.meta.url));
let cached;

export function demoJson() {
  if (!cached) {
    try { cached = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { throw new Error(`demo/demo.json is missing or invalid: ${e.message}`); }
  }
  return cached;
}

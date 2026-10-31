// Append-only audit log of registry changes: one JSON object per line in DATA_DIR/audit.jsonl.
// Entries hold who, when, what, and before/after snapshots of registry entries (which carry no secrets).

import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from '../workspace.js';

const file = () => path.resolve(dataDir(), 'audit.jsonl');

export function append(event) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.appendFileSync(file(), `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
}

const parse = (line) => { try { return JSON.parse(line); } catch { return { at: null, action: 'unreadable-line' }; } };

/**
 * Newest first. `before` is the line index to page back from (the `next` of the previous page).
 * ponytail: reads the whole file per page; fine to ~100k events, index by offset if it grows past that.
 */
export function page({ before, limit } = {}) {
  let lines = [];
  try { lines = fs.readFileSync(file(), 'utf8').split('\n').filter(Boolean); } catch { /* no events yet */ }
  const n = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const b = Number.parseInt(before, 10);
  const end = Number.isInteger(b) && b >= 0 ? Math.min(b, lines.length) : lines.length;
  const start = Math.max(0, end - n);
  return { entries: lines.slice(start, end).map(parse).reverse(), next: start > 0 ? start : null, total: lines.length };
}

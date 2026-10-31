#!/usr/bin/env node
// npm run check:forbidden
// Fails if a tracked file contains: any line of FORBIDDEN_STRINGS_FILE (never committed; matched case-insensitively,
// reported by line number and entry number, not by value); a UUID in docs/examples that forbidden-allowlist.json does
// not list; or a private Ping hostname that it does not list.
// No FORBIDDEN_STRINGS_FILE: notice and exit 0 locally, exit 1 when CI=true so CI cannot skip the check.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const PRIVATE_HOST = /\b(?:[a-z0-9-]+\.)+ping-devops\.com\b/gi;
const DOC_FILE = /(^|\/)(\.env[^/]*|[^/]+\.md|docs\/.*|deploy\/.*)$/;
// This script, its allowlist and its tests name the things they look for.
const SELF = new Set(['scripts/check-forbidden-strings.mjs', 'scripts/check-forbidden-strings.test.mjs', 'scripts/forbidden-allowlist.json', 'package-lock.json']);

export function loadForbidden(env, fsImpl = fs) {
  const file = env.FORBIDDEN_STRINGS_FILE;
  if (!file) return { configured: false, strings: [] };
  const strings = fsImpl.readFileSync(file, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
  return { configured: true, strings };
}

const isText = (buf) => !buf.subarray(0, 8000).includes(0);

/** files: repo-relative paths; read(file) returns a Buffer. Returns findings: { file, line, rule, detail }. */
export function scan({ files, read, forbidden, allowlist }) {
  const hosts = new Set(allowlist.hosts.map((h) => h.host.toLowerCase()));
  const uuids = new Set(allowlist.uuids.map((u) => u.value.toLowerCase()));
  const needles = forbidden.map((s) => s.toLowerCase());
  const findings = [];
  for (const file of files) {
    if (SELF.has(file)) continue;
    const buf = read(file);
    if (!isText(buf)) continue;
    buf.toString('utf8').split('\n').forEach((text, i) => {
      const line = i + 1;
      const lower = text.toLowerCase();
      needles.forEach((n, idx) => { if (lower.includes(n)) findings.push({ file, line, rule: 'forbidden-string', detail: `entry #${idx + 1}` }); });
      for (const h of text.match(PRIVATE_HOST) ?? []) {
        if (!hosts.has(h.toLowerCase())) findings.push({ file, line, rule: 'private-host', detail: h });
      }
      if (DOC_FILE.test(file)) {
        for (const u of text.match(UUID) ?? []) {
          if (!uuids.has(u.toLowerCase())) findings.push({ file, line, rule: 'uuid', detail: u });
        }
      }
    });
  }
  return findings;
}

export function main({ env = process.env, root, trackedFiles, fsImpl = fs, out = console.log, err = console.error }) {
  let forbidden;
  try { forbidden = loadForbidden(env, fsImpl); } catch (e) { err(`cannot read FORBIDDEN_STRINGS_FILE: ${e.message}`); return 1; }
  if (!forbidden.configured) {
    if (env.CI === 'true') { err('FORBIDDEN_STRINGS_FILE is not set in CI: the gate cannot be skipped. Provide the strings (see the FORBIDDEN_STRINGS secret in .github/workflows/ci.yml).'); return 1; }
    out('check-forbidden-strings: FORBIDDEN_STRINGS_FILE not configured; skipping the forbidden-string list (host and UUID checks still run).');
  } else if (!forbidden.strings.length) {
    err('FORBIDDEN_STRINGS_FILE has no entries; an empty list checks nothing.');
    return 1;
  }
  const allowlist = JSON.parse(fsImpl.readFileSync(path.join(root, 'scripts', 'forbidden-allowlist.json'), 'utf8'));
  const findings = scan({ files: trackedFiles, read: (f) => fsImpl.readFileSync(path.join(root, f)), forbidden: forbidden.strings, allowlist });
  for (const f of findings) err(`${f.file}:${f.line}  ${f.rule}  ${f.detail}`);
  if (findings.length) { err(`${findings.length} finding(s). Remove them, or (host/UUID only) add an allowlist entry with a reason.`); return 1; }
  out(`check-forbidden-strings: ok (${trackedFiles.length} files${forbidden.configured ? `, ${forbidden.strings.length} forbidden strings` : ''})`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const trackedFiles = execFileSync('git', ['-C', root, 'ls-files', '-z']).toString().split('\0').filter(Boolean);
  process.exit(main({ root, trackedFiles }));
}

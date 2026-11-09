import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// scripts/check-no-ai-attribution.sh: the owner's own GitHub noreply Co-authored-by (added by GitHub's squash merge)
// passes; any other Co-Authored-By, or the "Generated with" line, still fails.
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-no-ai-attribution.sh');
// The trailer text is assembled at runtime: the script also scans tracked files, so this file must not contain it literally.
const T = 'Co-' + 'authored-by: ';
const TU = 'Co-' + 'Authored-By: ';
const dirs = [];

function run(message) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noai-'));
  dirs.push(dir);
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.name', 't');
  git('config', 'user.email', 't@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', '/dev/null'); // a global commit-msg hook would refuse the very messages under test
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.copyFileSync(SCRIPT, path.join(dir, 'scripts', 'check-no-ai-attribution.sh'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
  git('add', '.');
  // A future date keeps the commit inside the script's "since the rule date" window whatever the clock says.
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: dir, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_DATE: '2030-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2030-01-01T00:00:00Z' } });
  return spawnSync('bash', ['scripts/check-no-ai-attribution.sh'], { cwd: dir, encoding: 'utf8' }).status;
}

after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

test('passes a plain commit', () => {
  assert.equal(run('fix: plain'), 0);
});

test('passes the owner noreply Co-authored-by that GitHub squash adds (with and without the numeric id)', () => {
  assert.equal(run(`fix: x\n\n${T}curtismu7 <curtismu7@users.noreply.github.com>`), 0);
  assert.equal(run(`fix: x\n\n${T}Curtis Muir <49688644+curtismu7@users.noreply.github.com>`), 0);
});

test('fails an AI Co-Authored-By trailer', () => {
  assert.equal(run(`fix: x\n\n${TU}Some Assistant <assistant@example.invalid>`), 1);
});

test('fails an AI trailer even when the owner trailer is also present', () => {
  assert.equal(run(`fix: x\n\n${T}curtismu7 <curtismu7@users.noreply.github.com>\n${TU}Bot <bot@example.invalid>`), 1);
});

test('fails a lookalike address', () => {
  assert.equal(run(`fix: x\n\n${T}curtismu7 <curtismu7@users.noreply.github.com.evil.invalid>`), 1);
});

test('fails the Generated-with line', () => {
  assert.equal(run('fix: x\n\nGenerated with [Claude' + ' Code](https://claude.com/claude-code)'), 1);
});

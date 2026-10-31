// Settings order: real env, then the shared file (STANDALONE_ENV, else ~/Development/.env), then the repo .env.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSettings, sharedEnvPath } from '../settings.js';

const KEYS = ['IDJAG_T_REAL', 'IDJAG_T_BOTH', 'IDJAG_T_SHARED_ONLY', 'IDJAG_T_REPO_ONLY'];
afterEach(() => { for (const k of KEYS) delete process.env[k]; });

describe('sharedEnvPath', () => {
  it('is ~/Development/.env, or STANDALONE_ENV when set', () => {
    expect(sharedEnvPath({ env: {}, home: '/h' })).toBe(path.join('/h', 'Development', '.env'));
    expect(sharedEnvPath({ env: { STANDALONE_ENV: '/x/y.env' }, home: '/h' })).toBe('/x/y.env');
  });
});

describe('loadSettings', () => {
  it('reads the shared file first, then the repo .env, and tells which it found', () => {
    const order = [];
    const found = loadSettings({ repoEnv: '/repo/.env', env: {}, home: '/h', load: (f) => order.push(f) });
    expect(order).toEqual([path.join('/h', 'Development', '.env'), '/repo/.env']);
    expect(found).toEqual(order);
  });

  it('STANDALONE_ENV replaces the default shared path; the repo .env is still the fallback', () => {
    const order = [];
    loadSettings({ repoEnv: '/repo/.env', env: { STANDALONE_ENV: '/s.env' }, home: '/h', load: (f) => order.push(f) });
    expect(order).toEqual(['/s.env', '/repo/.env']);
  });

  it('a missing file is skipped without error', () => {
    const found = loadSettings({ repoEnv: '/repo/.env', env: {}, home: '/h', load: (f) => { if (f === '/repo/.env') throw new Error('ENOENT'); } });
    expect(found).toEqual([path.join('/h', 'Development', '.env')]);
  });

  it('real files: env beats shared, shared beats repo, and each file fills the gaps', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idjag-settings-'));
    const shared = path.join(dir, 'shared.env');
    const repo = path.join(dir, 'repo.env');
    fs.writeFileSync(shared, 'IDJAG_T_REAL=shared\nIDJAG_T_BOTH=shared\nIDJAG_T_SHARED_ONLY=shared\n');
    fs.writeFileSync(repo, 'IDJAG_T_REAL=repo\nIDJAG_T_BOTH=repo\nIDJAG_T_REPO_ONLY=repo\n');
    process.env.IDJAG_T_REAL = 'real';
    loadSettings({ repoEnv: repo, env: { STANDALONE_ENV: shared }, home: dir });
    expect(process.env.IDJAG_T_REAL).toBe('real');
    expect(process.env.IDJAG_T_BOTH).toBe('shared');
    expect(process.env.IDJAG_T_SHARED_ONLY).toBe('shared');
    expect(process.env.IDJAG_T_REPO_ONLY).toBe('repo');
  });
});

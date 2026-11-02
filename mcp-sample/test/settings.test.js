import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { loadSettings } from '../src/settings.js';

afterEach(() => { for (const k of ['KIT_T_REAL', 'KIT_T_BOTH', 'KIT_T_SHARED', 'KIT_T_REPO']) delete process.env[k]; });

it('reads the shared file (STANDALONE_ENV, else ~/Development/.env) then the repo .env; the real environment wins', () => {
  const order = [];
  expect(loadSettings({ repoEnv: '/r/.env', env: {}, home: '/h', load: (f) => order.push(f) })).toEqual([path.join('/h', 'Development', '.env'), '/r/.env']);
  expect(order).toEqual([path.join('/h', 'Development', '.env'), '/r/.env']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-settings-'));
  fs.writeFileSync(path.join(dir, 'shared.env'), 'KIT_T_REAL=shared\nKIT_T_BOTH=shared\nKIT_T_SHARED=shared\n');
  fs.writeFileSync(path.join(dir, 'repo.env'), 'KIT_T_REAL=repo\nKIT_T_BOTH=repo\nKIT_T_REPO=repo\n');
  process.env.KIT_T_REAL = 'real';
  loadSettings({ repoEnv: path.join(dir, 'repo.env'), env: { STANDALONE_ENV: path.join(dir, 'shared.env') } });
  expect([process.env.KIT_T_REAL, process.env.KIT_T_BOTH, process.env.KIT_T_SHARED, process.env.KIT_T_REPO]).toEqual(['real', 'shared', 'shared', 'repo']);
});

it('a missing file is skipped', () => {
  expect(loadSettings({ repoEnv: '/nope/.env', env: { STANDALONE_ENV: '/nope/shared.env' } })).toEqual([]);
});

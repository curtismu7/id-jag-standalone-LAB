import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetMode, currentMode, liveReadiness, loadSharedMode, runtimeEnv, setMode } from '../mode.js';

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idjag-mode-'));
  vi.stubEnv('DATA_DIR', dir);
  vi.stubEnv('MODE', '');
  for (const k of ['PF_URL', 'PF_EXCHANGE_CLIENT_ID', 'PF_EXCHANGE_CLIENT_SECRET', 'ACME_PF_URL', 'ACME_EXCHANGE_CLIENT_ID', 'ACME_EXCHANGE_CLIENT_SECRET', 'PF_REDEEMER_CLIENT_SECRET']) vi.stubEnv(k, '');
  _resetMode();
});
afterEach(() => { _resetMode(); vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true }); });

const configureLive = () => {
  vi.stubEnv('PF_URL', 'https://pf.example.invalid');
  vi.stubEnv('PF_EXCHANGE_CLIENT_ID', 'client');
  vi.stubEnv('PF_EXCHANGE_CLIENT_SECRET', 'secret');
};

describe('which mode runs', () => {
  it('is mock when nothing says otherwise', () => {
    expect(currentMode()).toBe('mock');
  });

  it('follows MODE, and ignores a value that is not mock or live', () => {
    vi.stubEnv('MODE', 'live');
    expect(currentMode()).toBe('live');
    vi.stubEnv('MODE', 'LIVE ');
    expect(currentMode()).toBe('live');
    vi.stubEnv('MODE', 'nonsense');
    expect(currentMode()).toBe('mock');
  });

  it('the choice saved by the toggle beats MODE and survives a restart', () => {
    vi.stubEnv('MODE', 'live');
    configureLive();
    setMode('mock');
    expect(currentMode()).toBe('mock');
    _resetMode(); // a new process: nothing cached, the file is read
    expect(currentMode()).toBe('mock');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'mode.json'), 'utf8'))).toEqual({ mode: 'mock' });
    expect(fs.statSync(path.join(dir, 'mode.json')).mode & 0o777).toBe(0o600);
  });

  it('an unreadable or invalid mode.json is ignored, not fatal', () => {
    fs.writeFileSync(path.join(dir, 'mode.json'), '{not json');
    expect(currentMode()).toBe('mock');
    _resetMode();
    fs.writeFileSync(path.join(dir, 'mode.json'), JSON.stringify({ mode: 'both' }));
    expect(currentMode()).toBe('mock');
  });
});

describe('live needs the live settings', () => {
  it('names what is missing and saves nothing', () => {
    const readiness = liveReadiness();
    expect(readiness).toEqual({ ready: false, missing: ['PF_URL', 'PF_EXCHANGE_CLIENT_ID', 'PF_EXCHANGE_CLIENT_SECRET'] });
    expect(() => setMode('live')).toThrow(expect.objectContaining({ code: 'live_not_configured', missing: readiness.missing }));
    expect(fs.existsSync(path.join(dir, 'mode.json'))).toBe(false);
    expect(currentMode()).toBe('mock');
  });

  it('is ready with the PingFederate to resource AS settings, or with the Acme pairing', () => {
    configureLive();
    expect(liveReadiness().ready).toBe(true);
    vi.stubEnv('PF_EXCHANGE_CLIENT_ID', '');
    expect(liveReadiness().ready).toBe(false);
    vi.stubEnv('ACME_PF_URL', 'https://acme.example.invalid');
    vi.stubEnv('ACME_EXCHANGE_CLIENT_ID', 'a');
    vi.stubEnv('ACME_EXCHANGE_CLIENT_SECRET', 'b');
    vi.stubEnv('PF_REDEEMER_CLIENT_SECRET', 'c');
    expect(liveReadiness().ready).toBe(true);
  });

  it('switches to live once configured', () => {
    configureLive();
    expect(setMode('live')).toBe('live');
    expect(currentMode()).toBe('live');
  });

  it('refuses a mode that is not mock or live', () => {
    expect(() => setMode('both')).toThrow(expect.objectContaining({ code: 'invalid_mode' }));
  });
});

describe('the shared settings file (STANDALONE_ENV, else ~/Development/.env)', () => {
  const write = (text) => { const f = path.join(dir, 'shared.env'); fs.writeFileSync(f, text); return f; };

  it('supplies MODE, and only MODE', () => {
    const env = {};
    loadSharedMode({ env, file: write('MODE=live\nPF_URL=https://elsewhere.invalid\nPF_ADMIN_PASSWORD=x\n') });
    expect(env).toEqual({ MODE: 'live' });
  });

  it('never overrides a MODE that is already set', () => {
    const env = { MODE: 'mock' };
    loadSharedMode({ env, file: write('MODE=live\n') });
    expect(env.MODE).toBe('mock');
  });

  it('reads the file named by STANDALONE_ENV', () => {
    const env = { STANDALONE_ENV: write('MODE=live\n') };
    loadSharedMode({ env });
    expect(env.MODE).toBe('live');
  });

  it('ignores a missing file and a MODE that is not mock or live', () => {
    const env = {};
    loadSharedMode({ env, file: path.join(dir, 'absent.env') });
    loadSharedMode({ env, file: write('MODE=sideways\n') });
    expect(env).toEqual({});
  });
});

describe('runtimeEnv', () => {
  it('is the real environment in live mode', () => {
    vi.stubEnv('MODE', 'live');
    expect(runtimeEnv()).toBe(process.env);
  });

  it('in mock mode hides every real-system setting and supplies the mock\'s own', () => {
    vi.stubEnv('PF_URL', 'https://real-pf.example.invalid');
    vi.stubEnv('PF_EXCHANGE_CLIENT_SECRET', 'real-exchange-secret');
    vi.stubEnv('PF_ADMIN_PASSWORD', 'real-admin-password');
    vi.stubEnv('ADMIN_EMAILS', 'owner@example.invalid');
    vi.stubEnv('SESSION_SECRET', 'kept-as-is');
    const env = runtimeEnv();
    expect(env.PF_URL).toBe('https://pf.mock.invalid');
    expect(JSON.stringify(env)).not.toMatch(/real-exchange-secret|real-admin-password|real-pf|owner@example/);
    expect(env.SESSION_SECRET).toBe('kept-as-is'); // the app's own settings are not touched
    expect(env.DATA_DIR).toBe(path.join(dir, 'mock')); // mock data never mixes with live data
  });
});

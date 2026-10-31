import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { config } from '../config.js';
import { allowedHosts } from '../hostCheck.js';

beforeEach(() => {
  vi.stubEnv('APP_ORIGIN', 'http://localhost:4720');
  vi.stubEnv('SESSION_SECRET', 'test-session-secret');
  vi.stubEnv('ALLOWED_HOSTS', '');
});
afterEach(() => vi.unstubAllEnvs());

const get = (url, host) => request(createApp()).get(url).set('Host', host);

describe('Host header check (rule 3, DNS rebinding)', () => {
  it('answers localhost, 127.0.0.1 and [::1], with or without a port', async () => {
    for (const host of ['localhost', 'localhost:4720', '127.0.0.1:4720', 'LOCALHOST:9', '[::1]:4720']) {
      expect((await get('/api/health', host)).status, host).toBe(200);
    }
  });

  it('refuses any other Host on a read route, and says nothing else', async () => {
    for (const host of ['evil.example', 'evil.example:4720', 'localhost.evil.example', '127.0.0.1.evil.example:4720', '0.0.0.0:4720']) {
      for (const url of ['/api/health', '/api/mode', '/']) {
        const res = await get(url, host);
        expect([url, host, res.status]).toEqual([url, host, 403]);
        expect(res.body).toMatchObject({ error: 'invalid_host' });
      }
    }
  });

  it('refuses an empty or malformed Host', async () => {
    for (const host of ['', 'a b', '@evil.example', 'evil.example/..']) expect((await get('/api/health', host)).status, host).toBe(403);
  });

  it('also answers the host of APP_ORIGIN and the names in ALLOWED_HOSTS', async () => {
    vi.stubEnv('APP_ORIGIN', 'https://demo.example:8443');
    vi.stubEnv('ALLOWED_HOSTS', 'id-jag, other.invalid');
    expect((await get('/api/health', 'demo.example:8443')).status).toBe(200);
    expect((await get('/api/health', 'id-jag:4720')).status).toBe(200);
    expect((await get('/api/health', 'other.invalid')).status).toBe(200);
    expect((await get('/api/health', 'evil.example')).status).toBe(403);
    expect([...allowedHosts()].sort()).toEqual(['127.0.0.1', '[::1]', 'demo.example', 'id-jag', 'localhost', 'other.invalid']);
  });

  it('a write with a refused Host never reaches its route', async () => {
    const res = await request(createApp()).post('/api/mode').set('Host', 'evil.example').set('Origin', 'http://evil.example').send({ mode: 'live' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('invalid_host');
  });
});

describe('the address the docs tell you to open', () => {
  it('is the default APP_ORIGIN, so the first click is not invalid_origin', () => {
    vi.stubEnv('APP_ORIGIN', '');
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
    const shelf = JSON.parse(fs.readFileSync(path.join(root, 'docs/shelf-entry.json'), 'utf8'));
    expect(new URL(shelf.url).origin).toBe(config().appOrigin);
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    expect(readme).toContain(`Then open **${config().appOrigin}**`);
    expect(fs.readFileSync(path.join(root, 'docs/talk-track.md'), 'utf8')).toContain(`open ${config().appOrigin}`);
  });
});

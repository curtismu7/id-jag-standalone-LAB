import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';

afterEach(() => { vi.unstubAllEnvs(); });

describe('GET /api/shelf', () => {
  it('is reachable with no web build: returns the SHELF_URL (trailing slash trimmed); POST is not 200', async () => {
    vi.stubEnv('WEB_DIST', '/nonexistent/web-dist');
    vi.stubEnv('SHELF_URL', 'https://shelf.example:8443/');
    const app = createApp();
    const res = await request(app).get('/api/shelf');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ shelfUrl: 'https://shelf.example:8443' });
    expect((await request(app).post('/api/shelf').send({})).status).not.toBe(200);
  });
});

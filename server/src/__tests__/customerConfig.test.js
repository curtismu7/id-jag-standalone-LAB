import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { customerConfig, validateCustomerConfig } from '../customerConfig.js';

const GOOD = {
  name: 'Northwind Bank', vertical: 'banking', persona: { lena: 'Priya' },
  brand: { primary: '#0B6BCB', headerStart: '#0a2540', headerEnd: '#12395f', logoUrl: '/branding/northwind.png' },
};

describe('validateCustomerConfig', () => {
  it('accepts a full file and normalises colours to lower case', () => {
    const { config, errors } = validateCustomerConfig(GOOD);
    expect(errors).toEqual([]);
    expect(config.brand.primary).toBe('#0b6bcb');
    expect(config.persona).toEqual({ lena: 'Priya' });
  });

  it('accepts an empty object and partial files', () => {
    expect(validateCustomerConfig({})).toEqual({ config: {}, errors: [] });
    expect(validateCustomerConfig({ name: 'Acme' }).config).toEqual({ name: 'Acme' });
  });

  it.each([
    [{ name: '' }, 'name'],
    [{ name: 'x'.repeat(41) }, 'name'],
    [{ name: 7 }, 'name'],
    [{ vertical: 'Banking!' }, 'vertical'],
    [{ persona: [] }, 'persona'],
    [{ persona: { lena: '' } }, 'persona.lena'],
    [{ persona: { Lena: 'Priya' } }, 'persona.Lena'],
    [{ brand: { primary: 'red' } }, 'brand.primary'],
    [{ brand: { headerStart: '#fff' } }, 'brand.headerStart'],
    [{ brand: { headerEnd: '#12345g' } }, 'brand.headerEnd'],
    [{ brand: { logoUrl: 'http://x.test/a.png' } }, 'brand.logoUrl'],
    [{ brand: { logoUrl: '/branding/../etc/passwd' } }, 'brand.logoUrl'],
    [{ brand: { logoUrl: '/elsewhere/a.png' } }, 'brand.logoUrl'],
    [{ brand: { color: '#ffffff' } }, 'brand.color'],
    [{ colour: 1 }, 'colour'],
  ])('rejects %j and names %s', (file, field) => {
    const { config, errors } = validateCustomerConfig(file);
    expect(config).toEqual({});
    expect(errors.join(' ')).toContain(field);
  });

  it.each([
    [{ clientSecret: 'x' }, 'clientSecret'],
    [{ brand: { apiKey: 'x' } }, 'brand.apiKey'],
    [{ persona: { Password: 'x' } }, 'persona.Password'],
    [{ nested: { deep: { accessToken: 'x' } } }, 'nested.deep.accessToken'],
  ])('rejects the credential-looking key in %j', (file, field) => {
    const { config, errors } = validateCustomerConfig(file);
    expect(config).toEqual({});
    expect(errors.join(' ')).toContain(`${field}: key name looks like a credential`);
  });

  it('accepts an https logo', () => {
    expect(validateCustomerConfig({ brand: { logoUrl: 'https://cdn.test/a.svg' } }).errors).toEqual([]);
  });
});

describe('customerConfig() and GET /api/customer-config', () => {
  let dir; let warn;
  const ours = () => warn.mock.calls.map((c) => c[0]).filter((m) => m.includes('customer config'));
  const file = () => path.join(dir, 'customer.config.json');
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
    process.env.CUSTOMER_CONFIG = file();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { delete process.env.CUSTOMER_CONFIG; fs.rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it('serves {} when the file is missing, without a warning', async () => {
    const r = await request(createApp()).get('/api/customer-config');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({});
    expect(ours()).toEqual([]);
  });

  it('serves the sanitized object and nothing else (no paths, no extra fields)', async () => {
    fs.writeFileSync(file(), JSON.stringify(GOOD));
    const r = await request(createApp()).get('/api/customer-config');
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toEqual({ ...GOOD, brand: { ...GOOD.brand, primary: '#0b6bcb' } });
    expect(JSON.stringify(r.body)).not.toContain(dir);
  });

  it('falls back to {} on an invalid file, logging one line that names the bad field', async () => {
    fs.writeFileSync(file(), JSON.stringify({ name: 'Acme', brand: { primary: 'blue' } }));
    const app = createApp();
    expect((await request(app).get('/api/customer-config')).body).toEqual({});
    await request(app).get('/api/customer-config');
    expect(ours()).toHaveLength(1);
    expect(ours()[0]).toContain('brand.primary');
    expect(ours()[0]).not.toContain(dir);
  });

  it('falls back on broken JSON and on a credential key, without throwing', () => {
    fs.writeFileSync(file(), '{ nope');
    expect(customerConfig()).toEqual({});
    expect(ours()[0]).toContain('not valid JSON');
    fs.writeFileSync(file(), JSON.stringify({ name: 'Acme', clientSecret: 'x' }), { flag: 'w' });
    fs.utimesSync(file(), new Date(), new Date(Date.now() + 5000));
    expect(customerConfig()).toEqual({});
    expect(ours()[1]).toContain('clientSecret');
    expect(ours()[1]).not.toContain('"x"');
  });

  it('picks up an edit on the next request (mtime cache)', async () => {
    const app = createApp();
    fs.writeFileSync(file(), JSON.stringify({ name: 'One' }));
    expect((await request(app).get('/api/customer-config')).body.name).toBe('One');
    fs.writeFileSync(file(), JSON.stringify({ name: 'Two' }));
    fs.utimesSync(file(), new Date(), new Date(Date.now() + 5000));
    expect((await request(app).get('/api/customer-config')).body.name).toBe('Two');
  });
});

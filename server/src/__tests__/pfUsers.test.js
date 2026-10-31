import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addUser, removeUser } from '../pfUsers.js';

// A tiny stand-in for the PingFederate admin API that enforces the one rule found against a real PF 13.1.3:
// a credential validator cannot have an empty Users table (HTTP 422).
const USERNAME = (r) => r.fields.find((f) => f.name === 'Username').value;
const row = (u) => ({ defaultRow: false, fields: [{ name: 'Username', value: u }, { name: 'Password', value: 'x' }, { name: 'Confirm Password', value: 'x' }] });

let server;
let validator;
let puts;
let dataDir;
beforeEach(async () => {
  puts = 0;
  validator = { id: 'idJagKitPcv', configuration: { fields: [], tables: [{ name: 'Users', rows: [row('setup@pingidentity.com')] }] } };
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.url.endsWith('/passwordCredentialValidators/idJagKitPcv') && req.method === 'GET') return send(200, validator);
      if (req.url.endsWith('/passwordCredentialValidators/idJagKitPcv') && req.method === 'PUT') {
        puts += 1;
        const next = JSON.parse(body);
        if (!next.configuration.tables[0].rows.length) return send(422, { validationErrors: [{ message: "Please add at least one user to the 'Users' table." }] });
        validator = next;
        return send(200, validator);
      }
      return send(404, {});
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.PF_ADMIN_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.PF_ADMIN_PASSWORD = 'test-only';
  // Removal is allowed only for users the app added, which it records as approved registrations.
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfu-'));
  process.env.DATA_DIR = dataDir;
  fs.writeFileSync(path.join(dataDir, 'registrations.json'), JSON.stringify([{ email: 'new@pingidentity.com', status: 'approved' }]));
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  return new Promise((r) => server.close(r));
});

const users = () => validator.configuration.tables[0].rows.map(USERNAME);

describe('pfUsers against a PingFederate-like admin API', () => {
  it('adds a user and refuses a duplicate with 409', async () => {
    await addUser('new@pingidentity.com', 'a-long-enough-password');
    expect(users()).toEqual(['setup@pingidentity.com', 'new@pingidentity.com']);
    await expect(addUser('NEW@pingidentity.com', 'a-long-enough-password')).rejects.toMatchObject({ status: 409 });
  });

  it('removes only the named user and returns false, with no write, for one that is not there', async () => {
    await addUser('new@pingidentity.com', 'a-long-enough-password');
    puts = 0;
    expect(await removeUser('missing@pingidentity.com')).toBe(false);
    expect(puts).toBe(0);
    expect(await removeUser('New@pingidentity.com')).toBe(true);
    expect(users()).toEqual(['setup@pingidentity.com']);
  });

  it('keeps the last user: throws a lastUser error without making the write PingFederate would refuse', async () => {
    puts = 0;
    await expect(removeUser('setup@pingidentity.com')).rejects.toMatchObject({ lastUser: true, status: 409 });
    expect(puts).toBe(0);
    expect(users()).toEqual(['setup@pingidentity.com']);
  });
});

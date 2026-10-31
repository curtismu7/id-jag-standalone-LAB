// Optional customer.config.json: re-skins the kit for one customer (name, vertical, persona names, brand colours).
// The file is shared with customers, so it never holds credentials: any key that looks like one is rejected.
// Read per request with an mtime cache; a bad or missing file means defaults (never an error for the app).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as appConfig } from './config.js';

const DEFAULT_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../customer.config.json');
const SECRETISH = /secret|password|token|key/i;
const HEX = /^#[0-9a-f]{6}$/i;
const ID = /^[a-z][a-z0-9-]*$/;
const TOP = ['name', 'vertical', 'persona', 'brand'];
const BRAND = ['primary', 'headerStart', 'headerEnd', 'logoUrl'];

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
const text = (v, max) => typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= max;

function logoOk(u) {
  if (typeof u !== 'string' || u.length > 300) return false;
  if (u.startsWith('/branding/')) return !u.includes('..') && !u.includes('//') && !u.includes('\\');
  try { return new URL(u).protocol === 'https:'; } catch { return false; }
}

function secretKeys(v, at, out) {
  if (!isObject(v)) return;
  for (const [k, child] of Object.entries(v)) {
    const here = at ? `${at}.${k}` : k;
    if (SECRETISH.test(k)) out.push(`${here}: key name looks like a credential (this file must never hold secrets)`);
    secretKeys(child, here, out);
  }
}

/** Pure check of a parsed file. Returns { config, errors }; config is the sanitized object, only when errors is empty. */
export function validateCustomerConfig(raw) {
  const errors = [];
  if (!isObject(raw)) return { config: {}, errors: ['file: must be a JSON object'] };
  secretKeys(raw, '', errors);
  if (errors.length) return { config: {}, errors };
  for (const k of Object.keys(raw)) if (!TOP.includes(k)) errors.push(`${k}: unknown field`);

  const config = {};
  if (raw.name !== undefined) {
    if (text(raw.name, 40)) config.name = raw.name.trim(); else errors.push('name: must be 1-40 characters');
  }
  if (raw.vertical !== undefined) {
    if (typeof raw.vertical === 'string' && ID.test(raw.vertical) && raw.vertical.length <= 40) config.vertical = raw.vertical;
    else errors.push('vertical: must be a vertical pack id such as "banking"');
  }
  if (raw.persona !== undefined) {
    if (!isObject(raw.persona)) errors.push('persona: must be an object of cast id to display name');
    else {
      config.persona = {};
      for (const [id, name] of Object.entries(raw.persona)) {
        if (!ID.test(id)) errors.push(`persona.${id}: cast id must be lowercase letters, digits or dashes`);
        else if (!text(name, 40)) errors.push(`persona.${id}: must be 1-40 characters`);
        else config.persona[id] = name.trim();
      }
    }
  }
  if (raw.brand !== undefined) {
    if (!isObject(raw.brand)) errors.push('brand: must be an object');
    else {
      config.brand = {};
      for (const [k, v] of Object.entries(raw.brand)) {
        if (!BRAND.includes(k)) errors.push(`brand.${k}: unknown field`);
        else if (k === 'logoUrl') { if (logoOk(v)) config.brand[k] = v; else errors.push('brand.logoUrl: must be a /branding/ path or an https URL'); }
        else if (typeof v === 'string' && HEX.test(v)) config.brand[k] = v.toLowerCase();
        else errors.push(`brand.${k}: must be a #rrggbb colour`);
      }
    }
  }
  return errors.length ? { config: {}, errors } : { config, errors };
}

let cache = { file: null, stamp: null, config: {} };

/** The sanitized config for this moment: {} when the file is missing or invalid (the invalid case logs once per file change). */
export function customerConfig() {
  const file = process.env.CUSTOMER_CONFIG || DEFAULT_FILE;
  let stamp = 'missing';
  try { stamp = String(fs.statSync(file).mtimeMs); } catch { /* no file: defaults */ }
  if (cache.file === file && cache.stamp === stamp) return cache.config;
  let config = {};
  if (stamp !== 'missing') {
    let errors;
    try { ({ config, errors } = validateCustomerConfig(JSON.parse(fs.readFileSync(file, 'utf8')))); }
    catch (e) { errors = [`file: not valid JSON (${e.message})`]; }
    if (errors.length) {
      console.warn(`[${appConfig().slug}] customer config ${path.basename(file)} ignored, using defaults: ${errors.join('; ')}`);
      config = {};
    }
  }
  cache = { file, stamp, config };
  return config;
}

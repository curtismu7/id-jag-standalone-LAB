#!/usr/bin/env node
'use strict';
/**
 * Give the kit's own local PingFederate a runtime TLS certificate that the app can verify. The image's default one is
 * self-signed for CN=localhost with no SANs and expired on 2024-07-13, so every call to https://127.0.0.1:4732 fails
 * (CERT_HAS_EXPIRED). If the active runtime certificate is expired, expires within 30 days, or lacks the SANs
 * 127.0.0.1 and localhost, this generates idjagkit-local-tls (CN 127.0.0.1, SAN IP 127.0.0.1 + DNS localhost; a dated id if an old one of ours exists), makes it the
 * active runtime certificate (the admin console keeps its own), and exports its PEM to --ca-out. The PEM is public.
 * The app, doctor, preflight and resource-as then trust it for PF_URL's origin only (PF_CA_FILE; server/src/pfTrust.js).
 * Idempotent. Local only (see pf-admin.js). Prints "restart: runtime certificate" when it changed the certificate.
 *
 *   PF_ADMIN_URL=https://127.0.0.1:4731 PF_ADMIN_PASSWORD=… PF_ADMIN_INSECURE_TLS=true \
 *     node pingfederate/configure-local-tls.js --ca-out=<file.pem>      # writes PF_CA_FILE=<file.pem> to the settings file
 */
const fs = require('fs');
const path = require('path');
const pf = require('./pf-admin');

const ID = 'idjagkit-local-tls'; // key pair ids may not hold upper case
const SOON_MS = 30 * 24 * 3600 * 1000;
// PingFederate lists SANs as "DNS: 'localhost'" and "IP: '127.0.0.1'".
const names = (cert) => (cert.subjectAlternativeNames || []).map((n) => String(n).replace(/^(DNS|IP)\s*:\s*/i, '').replace(/^'|'$/g, '').toLowerCase());

/** Why this certificate is not good enough for 127.0.0.1, or null. */
function problem(cert, now = Date.now()) {
  if (!cert) return 'no active runtime certificate';
  if (cert.status === 'EXPIRED' || Date.parse(cert.expires) < now) return `expired ${cert.expires}`;
  if (Date.parse(cert.expires) < now + SOON_MS) return `expires ${cert.expires}`;
  const have = names(cert);
  const lacking = ['127.0.0.1', 'localhost'].filter((n) => !have.includes(n));
  return lacking.length ? `no SAN for ${lacking.join(', ')}` : null;
}

/** Returns { changed, pem }: pem is the exported certificate when it is self-signed, else undefined. */
async function run(api, { now = Date.now() } = {}) {
  const settings = await api('GET', '/keyPairs/sslServer/settings');
  const all = await api('GET', '/keyPairs/sslServer');
  if (settings.status !== 200 || all.status !== 200) { pf.report('read TLS settings', settings.status !== 200 ? settings : all); return { changed: false }; }
  const items = all.body.items || [];
  const activeId = settings.body.runtimeServerCertRef?.id;
  let cert = items.find((c) => c.id === activeId);
  const why = problem(cert, now);
  let changed = false;
  if (why) {
    console.log(`  runtime certificate: ${why}`);
    cert = items.find((c) => c.id.startsWith(ID) && !problem(c, now));
    if (cert) console.log(`  keep certificate ${cert.id}`);
    else {
      // An expired one of ours may still be the active certificate, which PingFederate will not delete: make a dated one beside it.
      const id = items.some((c) => c.id === ID) ? `${ID}-${new Date(now).toISOString().slice(0, 10).replace(/-/g, '')}` : ID;
      const made = await api('POST', '/keyPairs/sslServer/generate', {
        id, commonName: '127.0.0.1', organization: 'ID-JAG Kit (local)', country: 'US', validDays: 825,
        keyAlgorithm: 'RSA', keySize: 2048, signatureAlgorithm: 'SHA256withRSA', subjectAlternativeNames: ['127.0.0.1', 'localhost'],
      });
      if (!pf.report(`generate certificate ${id} (CN 127.0.0.1, SAN 127.0.0.1 + localhost)`, made)) return { changed: false };
      cert = made.body;
    }
    const ref = { id: cert.id };
    changed = pf.report(`make ${cert.id} the runtime certificate`, await api('PUT', '/keyPairs/sslServer/settings', {
      ...settings.body, runtimeServerCertRef: ref, activeRuntimeServerCerts: [ref],
    }));
  } else console.log('  keep runtime certificate (valid, SANs present)');
  if (!cert || cert.issuerDN !== cert.subjectDN) return { changed }; // CA-signed: the system roots decide, nothing to pin
  const pem = await api('GET', `/keyPairs/sslServer/${encodeURIComponent(cert.id)}/certificate`);
  if (pem.status !== 200 || typeof pem.body !== 'string' || !pem.body.includes('BEGIN CERTIFICATE')) { pf.report('export the certificate', pem); return { changed }; }
  return { changed, pem: pem.body };
}

module.exports = { run, problem, ID };

if (require.main === module) {
  pf.requireLocalAdmin();
  const out = pf.args['ca-out'];
  if (!out || out === true) { console.error('pass --ca-out=<file.pem>: where to write the certificate the app will trust'); process.exit(2); }
  run(pf.adminApi('direct', 0)).then(({ changed, pem }) => {
    if (pem) {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, pem.endsWith('\n') ? pem : `${pem}\n`, { mode: 0o644 }); // public certificate
      pf.writeEnv({ PF_CA_FILE: path.resolve(out) });
      console.log('  wrote the certificate and PF_CA_FILE to the settings file');
    }
    if (changed) console.log('restart: runtime certificate');
    pf.done('local-tls', '[local-tls] done.');
  }).catch(pf.fail('local-tls', 0));
}

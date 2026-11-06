import fs from 'node:fs';
for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] ??= m[2].trim();
}
const express = (await import('express')).default;
const { createApp } = await import('./server/src/app.js');
const app = createApp ? createApp() : null;
console.log('createApp?', !!app);

// Builds the host and the four remotes and serves them from their sibling checkouts:
// host 5000, catalog 5001, cart 5002, account 5003, checkout 5004. Keeps running until stopped (Ctrl+C).
// The host's dev proxy stands in for the gateway; point it at the gateway (port 8080) once the stack is up.
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const apps = [
  { dir: 'shoplab-host', port: 5000 },
  { dir: 'shoplab-catalog-mfe', port: 5001 },
  { dir: 'shoplab-cart-mfe', port: 5002 },
  { dir: 'shoplab-account-mfe', port: 5003 },
  { dir: 'shoplab-checkout-mfe', port: 5004 },
];

for (const a of apps) {
  const r = spawnSync('npm', ['run', 'build'], { cwd: resolve(root, a.dir), stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const children = apps.map((a) => spawn('npx', ['vite', 'preview', '--port', String(a.port), '--strictPort'], { cwd: resolve(root, a.dir), stdio: 'ignore' }));
const stop = () => { for (const c of children) c.kill(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

for (const a of apps) {
  for (let i = 0; ; i++) {
    try { if ((await fetch(`http://localhost:${a.port}/`)).status < 500) break; } catch {}
    if (i > 60) throw new Error(`${a.dir} did not start on ${a.port}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}
console.log('frontends ready: http://localhost:5000');
await new Promise(() => {});

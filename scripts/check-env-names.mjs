// Fails when a Helm values env var is never read by the service, or a service reads an env var the chart does not set.
// Looks for sibling checkouts (../shoplab-<name>); services that are not checked out are skipped.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const READ = /(?:process\.env|\benv)\.([A-Z][A-Z0-9_]+)/g;
// Set by the platform or only used in tests, never by Helm.
const IGNORE = new Set(['NODE_ENV', 'TEST_DATABASE_URL']);

function files(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

function chartEnvNames(values) {
  const lines = values.split('\n');
  const start = lines.findIndex((l) => l.trim() === 'env:');
  const names = [];
  for (const l of lines.slice(start + 1)) {
    const m = l.match(/^ {2}([A-Z][A-Z0-9_]+):/);
    if (m) names.push(m[1]);
    else if (l.trim() && !l.startsWith(' ')) break;
  }
  return names;
}

let problems = 0;
for (const chart of readdirSync(join(root, 'charts'))) {
  const src = resolve(root, '..', `shoplab-${chart}`, 'src');
  if (!existsSync(src)) {
    console.log(`skip  ${chart} (no sibling checkout)`);
    continue;
  }
  const declared = new Set(chartEnvNames(readFileSync(join(root, 'charts', chart, 'values.yaml'), 'utf8')));
  const read = new Set();
  for (const f of files(src)) for (const m of readFileSync(f, 'utf8').matchAll(READ)) if (!IGNORE.has(m[1])) read.add(m[1]);
  for (const n of declared) if (!read.has(n)) (problems++, console.error(`FAIL  ${chart}: chart sets ${n} but the service never reads it`));
  for (const n of read) if (!declared.has(n) && n !== 'PORT') (problems++, console.error(`FAIL  ${chart}: service reads ${n} but the chart does not set it`));
  console.log(`ok    ${chart} (${declared.size} vars)`);
}
process.exit(problems ? 1 : 0);

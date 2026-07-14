#!/usr/bin/env node
/**
 * Boundary lint — the layer rules from CLAUDE.md, enforced mechanically
 * (master plan §5.6: "lint rules banning raw DB/fetch access"; §10 enforcement
 * table). Scope:
 *
 *   engines/<e>/src/**            all of it is module code
 *   demos/<d>/src/**              module code, EXCEPT the harness files
 *                                 seed.ts / server.ts / index.ts
 *
 * Rules:
 *   R1 star topology   an engine never imports another @substrat-run/engine-*
 *   R2 no raw access   module code imports no better-sqlite3, no adapters,
 *                      no node builtins — data access is ctx.sql only
 *   R3 no network      module code never calls fetch() or imports an HTTP client
 *   R4 spine is sacred module code never writes _substrat_* tables (reads are
 *                      fine — timelines are projections)
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const failures = [];

const NODE_BUILTINS = new Set([
  'assert', 'buffer', 'child_process', 'cluster', 'crypto', 'dgram', 'dns',
  'events', 'fs', 'http', 'http2', 'https', 'net', 'os', 'path', 'perf_hooks',
  'process', 'readline', 'stream', 'string_decoder', 'timers', 'tls', 'url',
  'util', 'v8', 'vm', 'worker_threads', 'zlib',
]);
const HTTP_CLIENTS = new Set(['undici', 'node-fetch', 'axios', 'got', 'ky']);
const HARNESS = new Set(['seed.ts', 'server.ts', 'index.ts']);

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) yield p;
  }
}

function importsOf(source) {
  const specs = [];
  const re = /(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;
  for (let m; (m = re.exec(source)); ) specs.push(m[1] ?? m[2]);
  return specs;
}

function checkModuleFile(file, { ownEngine } = {}) {
  const rel = relative(root, file);
  const source = readFileSync(file, 'utf8');

  for (const spec of importsOf(source)) {
    if (ownEngine && spec.startsWith('@substrat-run/engine-') && spec !== ownEngine) {
      failures.push(`${rel}: R1 star topology — engine imports sibling engine '${spec}'`);
    }
    const bare = spec.startsWith('node:') ? spec.slice(5) : spec;
    if (spec === 'better-sqlite3' || spec.startsWith('@substrat-run/adapter-')) {
      failures.push(`${rel}: R2 raw data access — module code imports '${spec}' (use ctx.sql)`);
    } else if (spec.startsWith('node:') || NODE_BUILTINS.has(bare)) {
      failures.push(`${rel}: R2 platform escape — module code imports '${spec}'`);
    } else if (HTTP_CLIENTS.has(bare)) {
      failures.push(`${rel}: R3 network — module code imports HTTP client '${spec}'`);
    }
  }

  if (/\bfetch\s*\(/.test(source)) {
    failures.push(`${rel}: R3 network — module code calls fetch()`);
  }

  const spineWrite = /(insert\s+into|update|delete\s+from)\s+["'`]?_substrat_/i.exec(source);
  if (spineWrite) {
    failures.push(`${rel}: R4 spine write — module code mutates a _substrat_* table (${spineWrite[1]})`);
  }
}

for (const group of ['engines', 'demos']) {
  const groupDir = join(root, group);
  let pkgs;
  try {
    pkgs = readdirSync(groupDir);
  } catch {
    continue;
  }
  for (const pkg of pkgs) {
    const srcDir = join(groupDir, pkg, 'src');
    let pkgName = null;
    try {
      pkgName = JSON.parse(readFileSync(join(groupDir, pkg, 'package.json'), 'utf8')).name;
    } catch {
      continue;
    }
    for (const file of walk(srcDir)) {
      const isHarness =
        group === 'demos' &&
        HARNESS.has(relative(srcDir, file).split(sep).join('/'));
      if (isHarness) continue;
      checkModuleFile(file, group === 'engines' ? { ownEngine: pkgName } : {});
    }
  }
}

if (failures.length) {
  console.error(`boundary-lint: ${failures.length} violation(s)\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('boundary-lint: all layer rules hold');

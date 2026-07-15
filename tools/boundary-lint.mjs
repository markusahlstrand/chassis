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
 *   R5 tables private  module code never references another module's tables in
 *                      SQL (decision 28) — engine data is reached via exported
 *                      in-scope functions; the stable surface is entity ids,
 *                      EntityRefs, and event payloads. One-time extraction
 *                      handoffs (decision 27) opt out explicitly with a
 *                      `boundary-lint-allow R5` … `boundary-lint-end R5` block.
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
// Harness = edge/server wiring, not module code reachable from a
// ModuleRegistration. auth.ts / auth-adapters.ts wire an authentication adapter
// (Better Auth, OIDC, …) at the server edge — legitimately node/DB-touching.
// worker.ts is the Cloudflare deployment entry (the composition root that mounts
// the adapter + engines onto a Worker) — the workerd analogue of server.ts.
const HARNESS = new Set([
  'seed.ts',
  'server.ts',
  'index.ts',
  'auth.ts',
  'auth-adapters.ts',
  'worker.ts',
]);

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

// tableOwners: table name → package key ('engines/workorder', 'demos/fsm', …),
// built from every CREATE TABLE in every package's src before the rule pass.
const tableOwners = new Map();

function collectTables(file, pkgKey) {
  const source = readFileSync(file, 'utf8');
  const re = /CREATE TABLE (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)/gi;
  for (let m; (m = re.exec(source)); ) tableOwners.set(m[1], pkgKey);
}

function checkForeignTables(rel, source, pkgKey) {
  const lines = source.split('\n');
  let allowed = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('boundary-lint-allow R5')) allowed = true;
    else if (lines[i].includes('boundary-lint-end R5')) allowed = false;
    if (allowed) continue;
    for (const [table, owner] of tableOwners) {
      if (owner === pkgKey) continue;
      if (new RegExp(`\\b${table}\\b`).test(lines[i])) {
        failures.push(
          `${rel}:${i + 1}: R5 tables private — references '${table}' owned by ${owner} (use its in-scope functions)`,
        );
      }
    }
  }
}

function checkModuleFile(file, { ownEngine, pkgKey } = {}) {
  const rel = relative(root, file);
  const source = readFileSync(file, 'utf8');

  checkForeignTables(rel, source, pkgKey);

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

const packages = [];
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
    packages.push({ group, srcDir, pkgName, pkgKey: `${group}/${pkg}` });
  }
}

// Pass 1: table ownership (harness included — a table is owned wherever created).
for (const { srcDir, pkgKey } of packages) {
  for (const file of walk(srcDir)) collectTables(file, pkgKey);
}

// Pass 2: the rules.
for (const { group, srcDir, pkgName, pkgKey } of packages) {
  for (const file of walk(srcDir)) {
    const isHarness =
      group === 'demos' &&
      HARNESS.has(relative(srcDir, file).split(sep).join('/'));
    if (isHarness) continue;
    checkModuleFile(file, {
      pkgKey,
      ...(group === 'engines' ? { ownEngine: pkgName } : {}),
    });
  }
}

if (failures.length) {
  console.error(`boundary-lint: ${failures.length} violation(s)\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('boundary-lint: all layer rules hold');

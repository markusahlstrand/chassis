#!/usr/bin/env node
// `substrat push` — build a vertical and push its bundle to the platform (self-serve-deploy.md).
//
//   node tools/substrat-push.mjs <verticalDir> --slug <slug> --version <v> \
//        --cp <controlPlaneUrl> --actor <PlatformActorId> [--name <name>]
//
// It builds the worker with `wrangler --dry-run --outdir`, derives the manifest from the
// vertical's wrangler config (entry, compat date, DO classes, bindings), computes content
// digests, and POSTs a multipart bundle to `<cp>/verticals/<slug>/deploy`. The control
// plane holds the Cloudflare credential; this never does (D-34). The version lands PENDING.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { webcrypto } from 'node:crypto';

function arg(name, required = true) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || !process.argv[i + 1]) {
    if (required) throw new Error(`missing --${name}`);
    return undefined;
  }
  return process.argv[i + 1];
}

async function sha256(bytes) {
  const d = await webcrypto.subtle.digest('SHA-256', bytes);
  return Buffer.from(d).toString('hex').slice(0, 32);
}

// A tiny JSONC reader: strip // and /* */ comments, then JSON.parse.
function readJsonc(path) {
  const raw = readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  return JSON.parse(raw);
}

const dir = process.argv[2];
if (!dir || dir.startsWith('--')) throw new Error('usage: substrat-push <verticalDir> --slug … --version … --cp … --actor …');
const slug = arg('slug');
const version = arg('version');
const cp = arg('cp').replace(/\/$/, '');
const actor = arg('actor');
const name = arg('name', false);

const cfg = readJsonc(join(dir, 'wrangler.jsonc'));
const doBindings = cfg.durable_objects?.bindings ?? [];
const bindings = doBindings.map((b) => ({
  type: 'durable_object_namespace',
  name: b.name,
  class_name: b.class_name,
  ...(b.script_name ? { script_name: b.script_name } : {}),
}));
const doClasses = (cfg.migrations ?? []).flatMap((m) => m.new_sqlite_classes ?? []);
const compatibilityDate = cfg.compatibility_date ?? '2025-01-01';

// Build the bundle.
const out = mkdtempSync(join(tmpdir(), 'substrat-build-'));
console.log(`building ${slug}@${version} …`);
execFileSync('npx', ['wrangler', 'deploy', '--dry-run', '--outdir', out], {
  cwd: dir,
  stdio: 'inherit',
});

// Collect the built modules; the entry is the bundled basename of `main`.
const mainBase = basename(cfg.main).replace(/\.[cm]?ts$|\.[cm]?js$/, '');
const files = readdirSync(out).filter((f) => /\.(m?js)$/.test(f) && !f.endsWith('.map'));
const entry = files.find((f) => f.replace(/\.[cm]?js$/, '') === mainBase) ?? files[0];
if (!entry) throw new Error(`no built module found in ${out}`);

const modules = files.map((f) => ({ name: f, content: readFileSync(join(out, f)) }));
const concat = Buffer.concat(modules.map((m) => m.content));

const manifest = {
  version,
  name: name ?? slug,
  entry,
  compatibilityDate,
  doClasses,
  bindings,
  digests: {
    manifest: await sha256(concat),
    permission: await sha256(Buffer.from(JSON.stringify(bindings))),
    migration: await sha256(Buffer.from(JSON.stringify(doClasses))),
  },
};

const form = new FormData();
form.set('manifest', JSON.stringify(manifest));
for (const m of modules) {
  form.set(m.name, new Blob([m.content], { type: 'application/javascript+module' }), m.name);
}

console.log(`pushing ${entry} (+${modules.length - 1} modules) → ${cp}/verticals/${slug}/deploy`);
const res = await fetch(`${cp}/verticals/${slug}/deploy`, {
  method: 'POST',
  headers: { 'x-platform-actor': actor },
  body: form,
});
const body = await res.text();
if (!res.ok) {
  console.error(`push failed (${res.status}): ${body}`);
  process.exit(1);
}
const v = JSON.parse(body);
console.log(`✓ pushed. version ${v.id} is ${v.admission}; deploymentRef=${v.deploymentRef}`);
console.log(`  admit it in the console to let a scope bind it.`);

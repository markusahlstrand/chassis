import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { webcrypto } from 'node:crypto';

interface DeclaredBinding {
  type: string;
  name: string;
  class_name?: string;
  script_name?: string;
  id?: string;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await webcrypto.subtle.digest('SHA-256', bytes);
  return Buffer.from(digest).toString('hex').slice(0, 32);
}

/** A tiny JSONC reader: strip // and block comments, then JSON.parse. */
function readJsonc(path: string): Record<string, unknown> {
  const raw = readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  return JSON.parse(raw) as Record<string, unknown>;
}

export interface PushOptions {
  dir: string;
  slug: string;
  version: string;
  name?: string;
  controlPlaneUrl: string;
  /** The auth header to send — a bearer session or an x-service-token (see config.resolveAuth). */
  authHeader: Record<string, string>;
}

/**
 * Build a vertical and push its bundle to the platform's deploy endpoint
 * (self-serve-deploy.md). The worker is built with `wrangler --dry-run --outdir` — the
 * control plane holds the Cloudflare credential, this never does (D-34). The version
 * lands PENDING; admission still gates serving. Authenticated with the caller's own
 * credential (`opts.authHeader` — a browser session or a service token), never a
 * hand-picked `--actor`.
 */
export async function push(opts: PushOptions): Promise<{ id: string; admission: string; deploymentRef: string }> {
  const cfg = readJsonc(join(opts.dir, 'wrangler.jsonc'));

  // A vertical's OWN stores travel with the bundle: its DO classes, and its D1 databases
  // (e.g. a Better-Auth AUTH_DB). The control plane re-checks these against the §4 sandbox
  // contract before the upload reaches the namespace.
  const doBindings = (cfg.durable_objects as { bindings?: { name: string; class_name: string; script_name?: string }[] } | undefined)?.bindings ?? [];
  const d1 = (cfg.d1_databases as { binding: string; database_id: string }[] | undefined) ?? [];
  const bindings: DeclaredBinding[] = [
    ...doBindings.map((b) => ({
      type: 'durable_object_namespace',
      name: b.name,
      class_name: b.class_name,
      ...(b.script_name ? { script_name: b.script_name } : {}),
    })),
    ...d1.map((b) => ({ type: 'd1', name: b.binding, id: b.database_id })),
  ];
  const migrations = (cfg.migrations as { new_sqlite_classes?: string[] }[] | undefined) ?? [];
  const doClasses = migrations.flatMap((m) => m.new_sqlite_classes ?? []);
  const compatibilityDate = (cfg.compatibility_date as string | undefined) ?? '2025-01-01';
  const mainPath = cfg.main as string;

  // Build the bundle (runs the vertical's own wrangler `build.command` first).
  const out = mkdtempSync(join(tmpdir(), 'substrat-build-'));
  console.log(`building ${opts.slug}@${opts.version} …`);
  execFileSync('npx', ['wrangler', 'deploy', '--dry-run', '--outdir', out], {
    cwd: opts.dir,
    stdio: 'inherit',
  });

  // Collect the built modules; the entry is the bundled basename of `main`.
  const mainBase = basename(mainPath).replace(/\.[cm]?ts$|\.[cm]?js$/, '');
  const files = readdirSync(out).filter((f) => /\.(m?js)$/.test(f) && !f.endsWith('.map'));
  const entry = files.find((f) => f.replace(/\.[cm]?js$/, '') === mainBase) ?? files[0];
  if (!entry) throw new Error(`no built module found in ${out}`);

  const modules = files.map((f) => ({ name: f, content: readFileSync(join(out, f)) }));
  const concat = Buffer.concat(modules.map((m) => m.content));

  const manifest = {
    version: opts.version,
    name: opts.name ?? opts.slug,
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

  const url = `${opts.controlPlaneUrl}/verticals/${opts.slug}/deploy`;
  console.log(`pushing ${entry} (+${modules.length - 1} modules) → ${url}`);
  const res = await fetch(url, {
    method: 'POST',
    headers: opts.authHeader,
    body: form,
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`push failed (${res.status}): ${body}`);
  }
  return JSON.parse(body) as { id: string; admission: string; deploymentRef: string };
}

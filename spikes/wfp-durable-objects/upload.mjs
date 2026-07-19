/**
 * Upload the user worker into a dispatch namespace, WITH a Durable Object class.
 *
 * This is the fork-decider (see README). It uses the raw API rather than wrangler
 * because wrangler's dispatch-namespace support is not the thing under test — the
 * platform's own upload path is, and that is what our orchestration layer would
 * call with our credentials.
 *
 * Run: node upload.mjs        (see README for the env vars)
 */

const {
  CF_ACCOUNT_ID,
  CF_API_TOKEN,
  WFP_NAMESPACE = 'substrat-spike',
  WFP_SCRIPT = 'spike-vertical',
} = process.env;

if (!CF_ACCOUNT_ID || !CF_API_TOKEN) {
  console.error('Set CF_ACCOUNT_ID and CF_API_TOKEN. See README.md.');
  process.exit(2);
}

const api = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}`;
const auth = { Authorization: `Bearer ${CF_API_TOKEN}` };

async function call(path, init = {}) {
  const res = await fetch(`${api}${path}`, { ...init, headers: { ...auth, ...init.headers } });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok && body.success !== false, status: res.status, body };
}

/** Cloudflare returns structured errors; the code is what makes a failure diagnosable. */
const errorsOf = (body) =>
  (body.errors ?? []).map((e) => `${e.code ?? '?'}: ${e.message ?? JSON.stringify(e)}`);

console.log(`\n▸ namespace "${WFP_NAMESPACE}"`);
const ns = await call('/workers/dispatch/namespaces', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: WFP_NAMESPACE }),
});
// Already-exists is success for our purposes; this script is safe to re-run.
if (ns.ok) console.log('  created');
else if (ns.status === 409 || errorsOf(ns.body).some((e) => /exist/i.test(e)))
  console.log('  already exists');
else {
  console.error('  FAILED', ns.status, errorsOf(ns.body));
  process.exit(1);
}

console.log(`\n▸ uploading "${WFP_SCRIPT}" WITH a Durable Object class`);

const metadata = {
  main_module: 'user-worker.mjs',
  // A recent date: SQLite-backed Durable Objects need one.
  compatibility_date: '2025-01-01',
  bindings: [
    // No `script_name`: the class is defined by THIS script. That is the whole
    // question — a binding with `script_name` would only prove we can point at
    // someone else's DO, which is a different (and weaker) architecture.
    { type: 'durable_object_namespace', name: 'SCOPE', class_name: 'ScopeDO' },
  ],
  tags: ['substrat-spike'],
};

/**
 * The docs call `migrations` an "array object" without pinning the shape, and
 * wrangler and the upload API have historically differed. Both shapes are tried,
 * because a rejection on FORMATTING would look exactly like a rejection on
 * capability — and reading "you may not define a DO class here" off what was really
 * a malformed field would send the architecture down the wrong fork.
 *
 * `new_sqlite_classes`, not `new_classes`: every Substrat scope is SQLite-backed.
 */
const MIGRATION_SHAPES = [
  { label: 'object', value: { new_tag: 'v1', new_sqlite_classes: ['ScopeDO'] } },
  { label: 'array', value: [{ new_tag: 'v1', new_sqlite_classes: ['ScopeDO'] }] },
];

const source = await (await import('node:fs/promises')).readFile(
  new URL('./user-worker.mjs', import.meta.url),
);

async function attempt(migrations) {
  const form = new FormData();
  form.set(
    'metadata',
    new Blob([JSON.stringify({ ...metadata, migrations })], { type: 'application/json' }),
  );
  form.set(
    'user-worker.mjs',
    new Blob([source], { type: 'application/javascript+module' }),
    'user-worker.mjs',
  );
  return call(`/workers/dispatch/namespaces/${WFP_NAMESPACE}/scripts/${WFP_SCRIPT}`, {
    method: 'PUT',
    body: form,
  });
}

let up;
for (const shape of MIGRATION_SHAPES) {
  up = await attempt(shape.value);
  console.log(`  migrations as ${shape.label}: ${up.ok ? 'accepted' : `HTTP ${up.status}`}`);
  if (up.ok) break;
  for (const e of errorsOf(up.body)) console.log(`    ${e}`);
}

if (up.ok) {
  console.log('  ✅ ACCEPTED — a user worker may define its own SQLite Durable Object class.');
  console.log('     Upload is necessary, not sufficient: run the dispatcher to prove it RUNS.');
  console.log(`\n  next: cd dispatcher && pnpm run deploy   (then curl the printed URL)`);
} else {
  console.log(`  ❌ REJECTED (HTTP ${up.status})`);
  for (const e of errorsOf(up.body)) console.log(`     ${e}`);
  console.log('\n  This is the fork. See README → "If it is rejected".');
  process.exit(1);
}

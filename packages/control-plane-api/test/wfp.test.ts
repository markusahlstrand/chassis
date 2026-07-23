import { describe, it, expect, vi, afterEach } from 'vitest';
import { createWfpUploader } from '../src/wfp.js';
import type { VerticalBundle } from '../src/deploy.js';

/**
 * The WfP uploader's one job worth testing without a real account: the multipart
 * metadata it builds — specifically that platform-owned secrets are injected as
 * `secret_text` bindings (so a pushed vertical can verify inbound platform/router
 * calls) alongside the vertical's own bindings, and that empty ones are skipped.
 */
const bundle: VerticalBundle = {
  entry: 'worker.js',
  compatibilityDate: '2025-01-01',
  compatibilityFlags: ['nodejs_compat'],
  doClasses: ['ScopeDO'],
  bindings: [{ type: 'durable_object_namespace', name: 'SCOPE', class_name: 'ScopeDO' }],
  modules: [{ name: 'worker.js', content: new Uint8Array([1, 2, 3]), contentType: 'application/javascript+module' }],
};

afterEach(() => vi.unstubAllGlobals());

async function metadataOf(injectSecrets: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  let body: FormData | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init: { body?: FormData }) => {
      body = init.body;
      return new Response('{}', { status: 200 });
    }),
  );
  const upload = createWfpUploader({ accountId: 'acct', namespace: 'ns', apiToken: 'tok', injectSecrets });
  await upload('callout-01k', bundle);
  const meta = await (body!.get('metadata') as File).text();
  return JSON.parse(meta) as Record<string, unknown>;
}

describe('createWfpUploader — secret injection', () => {
  it('injects platform secrets as secret_text bindings, keeping the vertical’s own', async () => {
    const meta = await metadataOf({ PLATFORM_SECRET: 'p-val', ROUTER_SECRET: 'r-val' });
    const bindings = meta['bindings'] as { type: string; name: string; text?: string }[];
    expect(bindings).toContainEqual({ type: 'secret_text', name: 'PLATFORM_SECRET', text: 'p-val' });
    expect(bindings).toContainEqual({ type: 'secret_text', name: 'ROUTER_SECRET', text: 'r-val' });
    // The vertical's own binding survives, and the compat flags carry through.
    expect(bindings).toContainEqual({ type: 'durable_object_namespace', name: 'SCOPE', class_name: 'ScopeDO' });
    expect(meta['compatibility_flags']).toEqual(['nodejs_compat']);
  });

  it('skips a secret whose value is unset (a half-configured platform)', async () => {
    const meta = await metadataOf({ PLATFORM_SECRET: 'p-val', ROUTER_SECRET: undefined });
    const secrets = (meta['bindings'] as { type: string; name: string }[]).filter((b) => b.type === 'secret_text');
    expect(secrets.map((s) => s.name)).toEqual(['PLATFORM_SECRET']);
  });
});

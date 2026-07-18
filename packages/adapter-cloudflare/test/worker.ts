/**
 * The test Worker entry. It bundles the contract-test module set into a ScopeDO
 * (a Durable Object cannot receive handler closures over RPC, so the modules are
 * code-time), exports the two DO classes wrangler binds, and a no-op fetch
 * handler so the Worker is valid. The contract tests drive everything through
 * the exported bindings via `CloudflareScopeHost` — see contract.test.ts.
 */
import { brokenMod, contractTestModules, contractTestBareOps } from '@substrat-run/contract-tests';
import { defineScopeDO } from '../src/scope-do.js';

export const ScopeDO = defineScopeDO(contractTestModules, contractTestBareOps);

/**
 * A second scope-DO class carrying ONLY the module whose migration cannot apply.
 * It needs its own class because a DO closes over a code-time module set — putting
 * `brokenMod` in `ScopeDO` would fail every scope in every suite. Bound as
 * BROKEN_SCOPE so migration-failure.test.ts can point a host at it.
 */
export const BrokenScopeDO = defineScopeDO([brokenMod], {});

export { ControlPlaneDO } from '../src/control-plane-do.js';

export default {
  fetch(): Response {
    return new Response('substrat adapter-cloudflare test worker', { status: 200 });
  },
};

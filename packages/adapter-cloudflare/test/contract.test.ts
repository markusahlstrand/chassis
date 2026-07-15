import { env } from 'cloudflare:test';
import { UNSAFE_allowAllChecker } from '@substrat-run/kernel';
import { permissionContractSuite, scopeHostContractSuite } from '@substrat-run/contract-tests';
import { CloudflareScopeHost } from '../src/host.js';

// The scope-host suite runs against an allow-all checker (it exercises no
// ctx.check). Runtime module registration is unsupported on CF — the ScopeDO
// closes over a code-time module set — so that one late-registration test is
// skipped; every other test is shared unchanged (D-14).
scopeHostContractSuite(
  'adapter-cloudflare',
  async () => {
    const host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      checker: UNSAFE_allowAllChecker,
    });
    return { host, cleanup: async () => host.close() };
  },
  { supportsRuntimeRegistration: false },
);

// The permission suite runs against the DO's default tuple checker (scope tuples
// in the ScopeDO, tenant tuples + roles in the ControlPlaneDO).
permissionContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });
  return { host, cleanup: async () => host.close() };
});

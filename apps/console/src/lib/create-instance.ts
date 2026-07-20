import type { PrincipalId, ScopeId, TenantId } from '@substrat-run/contracts';
import type { Api } from './api';

/**
 * Creating one instance of a vertical, as a sequence rather than a component.
 *
 * The ORDER is the load-bearing part, so it lives here where it can be tested. A
 * dialog can be re-laid-out freely; this sequence cannot be reordered without
 * breaking a property something else depends on:
 *
 *   1. tenant    — the directory root everything hangs from
 *   2. instance  — the VERTICAL provisions, because only it can create a usable scope
 *                  DO: the class bundles the modules and lives in its deployment (K-31)
 *   3. scope     — the directory row, AFTER the vertical succeeds, so a failure leaves
 *                  an invisible orphan rather than a row promising a scope that is not
 *                  there. `scopeStatus.provisioning` exists to model this properly and
 *                  is still unused, so ordering is what carries the property today
 *   4. hostname  — bound, not yet serving
 *   5. activate  — last, because a hostname must never resolve before the thing behind
 *                  it exists (K-26)
 */

export const INSTANCE_STEPS = [
  { key: 'tenant', label: 'Create tenant' },
  { key: 'instance', label: 'Provision instance in the vertical' },
  { key: 'scope', label: 'Record the scope' },
  { key: 'hostname', label: 'Bind the hostname' },
  { key: 'activate', label: 'Activate' },
] as const;

export type InstanceStep = (typeof INSTANCE_STEPS)[number]['key'];

export interface CreateInstanceInput {
  verticalSlug: string;
  slug: string;
  name: string;
  /** Optional. Without one the instance exists and is unreachable. */
  hostname?: string;
  /** Ids are caller-minted so every call is idempotent on retry (§4.1). */
  tenantId: TenantId;
  scopeId: ScopeId;
  owner: PrincipalId;
}

export interface CreateInstanceResult {
  tenantId: TenantId;
  scopeId: ScopeId;
  url: string | null;
}

/**
 * Thrown with the step that failed still attached.
 *
 * "It failed" is not actionable for a multi-step create spanning two systems:
 * whether the vertical provisioned before the directory row did is the difference
 * between an invisible orphan and a tenant that looks real and does not work.
 */
export class InstanceStepError extends Error {
  constructor(
    readonly step: InstanceStep,
    readonly cause: Error,
  ) {
    super(`${INSTANCE_STEPS.find((s) => s.key === step)!.label}: ${cause.message}`);
    this.name = 'InstanceStepError';
  }
}

export async function createInstance(
  api: Api,
  input: CreateInstanceInput,
  onStep?: (step: InstanceStep, state: 'doing' | 'done') => void,
): Promise<CreateInstanceResult> {
  const { tenantId, scopeId, owner, slug, name } = input;
  const verticalSlug = input.verticalSlug.trim();
  const hostname = input.hostname?.trim().toLowerCase() ?? '';

  async function step<T>(key: InstanceStep, fn: () => Promise<T>): Promise<T> {
    onStep?.(key, 'doing');
    try {
      const out = await fn();
      onStep?.(key, 'done');
      return out;
    } catch (e) {
      throw new InstanceStepError(key, e as Error);
    }
  }

  await step('tenant', () => api.createTenant({ id: tenantId, slug, name }));
  await step('instance', () =>
    api.provisionInstance(verticalSlug, { tenantId, scopeId, owner, slug, name }),
  );
  await step('scope', () =>
    api.provisionScope({ tenantId, scopeId, slug, name, vertical: verticalSlug }),
  );

  if (!hostname) return { tenantId, scopeId, url: null };

  await step('hostname', () =>
    api.bindHostname({
      hostname,
      tenantId,
      scopeId,
      surface: 'app',
      region: null,
      canonical: true,
    }),
  );
  await step('activate', () => api.setHostnameStatus(hostname, 'active'));

  return { tenantId, scopeId, url: `https://${hostname}` };
}

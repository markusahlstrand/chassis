import type { PrincipalId, ScopeId, TenantId } from '@substrat-run/contracts';
import { PLATFORM_SECRET_HEADER } from '@substrat-run/kernel';
import { ControlPlaneError } from './client.js';

/**
 * The platform's client for calling a VERTICAL (K-31).
 *
 * The mirror of `ControlPlaneClient`, pointing the other way, and the direction
 * matters: that one is a vertical talking up to the platform, this is the platform
 * telling a vertical to do something. K-31 makes this the authoritative direction,
 * because only the vertical can create a usable scope DO — the DO class bundles the
 * modules and lives in the vertical's own deployment.
 *
 * Deliberately tiny. Provisioning is the only thing the platform asks a vertical to
 * do, and every additional verb here would be authority the platform holds over
 * someone else's code.
 */

export interface VerticalClientOptions {
  /**
   * How to reach the vertical. A Worker service binding's `fetch` when deployed —
   * the vertical has no public route (K-26/K-27), so this is the only ingress — or
   * plain `fetch` against a URL locally.
   */
  fetch: typeof fetch;
  /** Base URL. With a service binding the host is ignored, but `Request` needs one. */
  baseUrl?: string;
  /** Shared secret the vertical verifies with `assertPlatformCall`. */
  platformSecret: string;
}

export interface ProvisionInstanceInput {
  tenantId: TenantId;
  scopeId: ScopeId;
  /** The first admin — whoever asked for the instance. */
  owner: PrincipalId;
  slug: string;
  name: string;
}

export interface ProvisionedInstance {
  tenantId: TenantId;
  scopeId: ScopeId;
  owner: PrincipalId;
}

export class VerticalClient {
  constructor(private readonly options: VerticalClientOptions) {}

  /**
   * Ask the vertical to create one instance.
   *
   * Idempotent at the far end, so a retry after a partial failure converges rather
   * than duplicating — which K-31 makes load-bearing, because this is the second
   * phase of a two-phase creation and the reconciliation sweep re-runs exactly it.
   */
  async provisionInstance(input: ProvisionInstanceInput): Promise<ProvisionedInstance> {
    const base = this.options.baseUrl ?? 'https://vertical.invalid';
    const res = await this.options.fetch(`${base}/internal/provision`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [PLATFORM_SECRET_HEADER]: this.options.platformSecret,
      },
      body: JSON.stringify(input),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      // Surfaced rather than swallowed: a 403 here means the secrets do not match,
      // which is a deployment error someone must see, not a transient failure to retry.
      throw new ControlPlaneError(
        res.status,
        body?.error ?? `vertical refused provisioning: ${res.status} ${res.statusText}`,
      );
    }
    return (await res.json()) as ProvisionedInstance;
  }
}

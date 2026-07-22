import { z } from '@substrat-run/contracts';

/**
 * The deploy seam (self-serve-deploy.md). A `substrat push` uploads a *built* worker
 * bundle; this layer forwards it to the platform's runtime (a Workers-for-Platforms
 * dispatch namespace) and records a **pending** version. The push is not a deploy —
 * admission still gates serving.
 *
 * Two rules live here, and they are the reason an untrusted bundle can be accepted at
 * all:
 *
 * 1. **The platform holds the Cloudflare credential, never the builder** (D-34). The
 *    upload itself is `DeployVerticalFn`, injected by the host (the Worker holds the
 *    WfP-scoped token) so this package stays host-agnostic and unit-testable.
 * 2. **The sandbox contract** (self-serve-deploy.md §4): a vertical gets its OWN DO
 *    classes only — never the platform's `CONTROL_PLANE` binding, cross-script reach,
 *    or a service binding to a platform worker. `assertSandboxContract` refuses an
 *    upload that declares more, *before* it reaches the namespace. That structural
 *    refusal — not inspecting minified code — is the primary defence.
 */

/** A binding the uploaded worker declares, as far as the contract check needs it. */
export interface DeclaredBinding {
  type: string;
  name: string;
  class_name?: string;
  script_name?: string;
}

/** A built vertical, ready to upload. `modules` are the bundled ESM parts. */
export interface VerticalBundle {
  entry: string;
  compatibilityDate: string;
  modules: { name: string; content: Uint8Array; contentType: string }[];
  /** DO classes to migrate as SQLite (`new_sqlite_classes`). */
  doClasses: string[];
  bindings: DeclaredBinding[];
}

/**
 * Upload a built bundle to the platform runtime under `deploymentRef`. Injected by the
 * host so the transport package never imports a Cloudflare SDK and tests use a fake.
 */
export type DeployVerticalFn = (deploymentRef: string, bundle: VerticalBundle) => Promise<void>;

const declaredBinding = z.object({
  type: z.string().min(1),
  name: z.string().min(1),
  class_name: z.string().optional(),
  script_name: z.string().optional(),
});

/** The JSON part a `substrat push` sends alongside the module files. */
export const deployManifest = z.object({
  version: z.string().min(1),
  /** Display name for a first-time register; defaults to the slug. */
  name: z.string().min(1).optional(),
  /** Filename of the main module among the uploaded parts. */
  entry: z.string().min(1),
  compatibilityDate: z.string().min(1),
  doClasses: z.array(z.string().min(1)).default([]),
  bindings: z.array(declaredBinding).default([]),
  /** Computed by the builder's toolchain; what the promotion checkpoint compares. */
  digests: z.object({
    manifest: z.string().min(1),
    permission: z.string().min(1),
    migration: z.string().min(1),
  }),
});
export type DeployManifest = z.infer<typeof deployManifest>;

/**
 * The §4 sandbox contract. Throws (mapped to a 4xx by errors.ts via "deploy refused")
 * if the declared bindings would give the vertical reach into platform infrastructure.
 */
export function assertSandboxContract(m: DeployManifest): void {
  const own = new Set(m.doClasses);
  for (const b of m.bindings) {
    if (b.name === 'CONTROL_PLANE') {
      throw new Error(
        `deploy refused: binding 'CONTROL_PLANE' is the platform's directory, not a vertical's`,
      );
    }
    if (b.type === 'service') {
      throw new Error(
        `deploy refused: service binding '${b.name}' — a vertical reaches the platform through the router (K-27), never a binding`,
      );
    }
    if (b.type === 'durable_object_namespace') {
      if (b.script_name) {
        throw new Error(
          `deploy refused: cross-script DO binding '${b.name}' (script '${b.script_name}') — a vertical may bind only its OWN DO classes`,
        );
      }
      if (b.class_name && !own.has(b.class_name)) {
        throw new Error(
          `deploy refused: DO binding '${b.name}' → '${b.class_name}', not one of the vertical's own classes [${m.doClasses.join(', ') || 'none'}]`,
        );
      }
    }
  }
}

/**
 * The dispatch script name a version deploys under, and what the router will dispatch
 * on (orchestration.md §5.3). Keyed on the version's ULID rather than the `@version`
 * label the RFC sketched, because **it is a Cloudflare Worker script name** — no `@`
 * or `.`, only `[a-z0-9_-]`. A lowercased ULID is valid by construction and unique per
 * version; the human-readable label lives on the version record's `version` field.
 */
export function deploymentRefFor(slug: string, versionId: string): string {
  return `${slug}-${versionId.toLowerCase()}`;
}

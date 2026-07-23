import { z } from 'zod';
import { moduleManifest, permissionKey } from '@substrat-run/contracts';
import {
  assertAllowed,
  ulid,
  type ModuleRegistration,
  type OperationContext,
  type OperationHandler,
} from '@substrat-run/kernel';

// ============================================================================
// The Dashboard — the tenant-facing self-service surface, built AS a Substrat
// vertical (the platform, dogfooded). See docs/design/dashboard.md.
//
// This module owns the customer's OWN data + permissions: the list of apps they
// have created (a `dashboard_apps` row per provisioned instance) and the keys
// that authorize managing them. The actual scope provisioning is NOT here —
// `provisionScope` is a ScopeHost action, so it runs in app-level code
// (`createApp` in provision.ts) with the tenant taken from the caller's own
// dashboard scope, never a request argument. This module answers "can they?" and
// records the result; the app layer effects it, narrowed to the caller's tenant.
// ============================================================================

export const DASHBOARD_PERM = {
  /** Create/track an app (a provisioned vertical instance) in this tenant. Held by the owner. */
  provisionApp: permissionKey.parse('dashboard:provision-app'),
  /** Read the account's apps. */
  read: permissionKey.parse('dashboard:read'),
};

export const dashboardManifest = moduleManifest.parse({
  id: '@substrat-run/dashboard',
  version: '0.0.1',
  kernelContract: '^0.0.1',
  permissions: [
    {
      key: 'dashboard:provision-app',
      description:
        'Provision and manage apps (vertical instances) in this tenant — the tenant admin',
    },
    { key: 'dashboard:read', description: 'Read the tenant’s apps' },
  ],
  events: { emits: [], consumes: [] },
  migrations: { journalDir: './migrations', compatibleFrom: '0.0.1' },
  attachmentTargets: [],
  entitlementKey: 'dashboard',
});

export const dashboardMigrations = [
  {
    version: '0001-init',
    sql: `
      -- One row per app (provisioned vertical instance) the tenant owns. The app
      -- itself is a separate SCOPE running that vertical; this is the account's
      -- own record of it, keyed by the app's scope id.
      CREATE TABLE dashboard_apps (
        id            TEXT PRIMARY KEY,
        app_scope_id  TEXT NOT NULL UNIQUE,
        vertical_slug TEXT NOT NULL,
        name          TEXT NOT NULL,
        status        TEXT NOT NULL CHECK (status IN ('provisioning','active','failed')),
        hostname      TEXT,
        created_by    TEXT NOT NULL,
        created_at    TEXT NOT NULL
      );
    `,
  },
  {
    version: '0002-app-deleted',
    sql: `
      -- Soft delete: deleting an app deprovisions its scope but keeps the record
      -- (the account's audit history is retained). A non-null timestamp hides the
      -- row from list-apps; the status enum is left alone so no table rebuild.
      ALTER TABLE dashboard_apps ADD COLUMN deleted_at TEXT;
    `,
  },
];

export interface DashboardAppRow {
  id: string;
  app_scope_id: string;
  vertical_slug: string;
  name: string;
  status: 'provisioning' | 'active' | 'failed';
  hostname: string | null;
  created_by: string;
  created_at: string;
  deleted_at: string | null;
}

// -- operations --------------------------------------------------------------

const provisionAppInput = z.object({
  /** The scope id the app will run under (minted by the caller). */
  appScopeId: z.string().min(1),
  /** Which vertical this app runs — 'meridian', 'callout', … (catalog slug). */
  verticalSlug: z.string().min(1),
  name: z.string().min(1),
});

/**
 * Authorize + record an app before the platform effect. Its FIRST line is the
 * permission check — the "can they?" the whole self-service model rests on. It
 * only writes this tenant's own `dashboard_apps` row (status `provisioning`); the
 * scope itself is provisioned by the app layer afterwards, in this same tenant.
 */
const provisionAppOp: OperationHandler<z.infer<typeof provisionAppInput>, DashboardAppRow> = async (
  ctx: OperationContext,
  raw,
) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.provisionApp));
  const input = provisionAppInput.parse(raw);
  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO dashboard_apps (id, app_scope_id, vertical_slug, name, status, hostname, created_by, created_at)
     VALUES (?, ?, ?, ?, 'provisioning', NULL, ?, ?)`,
    [id, input.appScopeId, input.verticalSlug, input.name, ctx.principal, new Date().toISOString()],
  );
  return ctx.sql.query<DashboardAppRow>('SELECT * FROM dashboard_apps WHERE id = ?', [id])[0]!;
};

const markAppActiveInput = z.object({
  appScopeId: z.string().min(1),
  hostname: z.string().min(1).optional(),
});

/** Flip an app to `active` once the platform provisioned its scope. Same authority as creating it. */
const markAppActiveOp: OperationHandler<z.infer<typeof markAppActiveInput>, DashboardAppRow> = async (
  ctx,
  raw,
) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.provisionApp));
  const input = markAppActiveInput.parse(raw);
  ctx.sql.exec(
    `UPDATE dashboard_apps SET status = 'active', hostname = COALESCE(?, hostname) WHERE app_scope_id = ?`,
    [input.hostname ?? null, input.appScopeId],
  );
  const row = ctx.sql.query<DashboardAppRow>('SELECT * FROM dashboard_apps WHERE app_scope_id = ?', [
    input.appScopeId,
  ])[0];
  if (!row) throw new Error(`no app for scope ${input.appScopeId}`);
  return row;
};

/** The account's apps — a plain read, gated by `dashboard:read`. Deleted apps are hidden. */
const listAppsOp: OperationHandler<Record<string, never>, DashboardAppRow[]> = async (ctx) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.read));
  return ctx.sql.query<DashboardAppRow>(
    'SELECT * FROM dashboard_apps WHERE deleted_at IS NULL ORDER BY created_at DESC',
  );
};

const deleteAppInput = z.object({ appScopeId: z.string().min(1) });

/**
 * Soft-delete an app's record (same authority as creating it). The scope is
 * deprovisioned by the app layer afterwards (deprovisionApp in provision.ts); this
 * only stamps `deleted_at` so the row drops out of `list-apps` while the record —
 * the account's audit history — is retained. Idempotent: a second delete is a no-op.
 */
const deleteAppOp: OperationHandler<z.infer<typeof deleteAppInput>, DashboardAppRow> = async (ctx, raw) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.provisionApp));
  const input = deleteAppInput.parse(raw);
  ctx.sql.exec('UPDATE dashboard_apps SET deleted_at = ? WHERE app_scope_id = ? AND deleted_at IS NULL', [
    new Date().toISOString(),
    input.appScopeId,
  ]);
  const row = ctx.sql.query<DashboardAppRow>('SELECT * FROM dashboard_apps WHERE app_scope_id = ?', [
    input.appScopeId,
  ])[0];
  if (!row) throw new Error(`no app for scope ${input.appScopeId}`);
  return row;
};

export const dashboardModule: ModuleRegistration = {
  manifest: dashboardManifest,
  migrations: dashboardMigrations,
  operations: {
    'dashboard/provision-app': provisionAppOp as OperationHandler<never, unknown>,
    'dashboard/mark-app-active': markAppActiveOp as OperationHandler<never, unknown>,
    'dashboard/list-apps': listAppsOp as OperationHandler<never, unknown>,
    'dashboard/delete-app': deleteAppOp as OperationHandler<never, unknown>,
  },
};

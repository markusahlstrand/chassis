import { z } from 'zod';
import { moduleManifest, permissionKey, type PermissionKey, type OrgId } from '@substrat-run/contracts';
import {
  assertAllowed,
  ulid,
  type ModuleRegistration,
  type OperationContext,
  type OperationHandler,
} from '@substrat-run/kernel';
import { INVITES_PERM, sendInvite, acceptInvite, revokeInvite } from '@substrat-run/engine-invites';

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
  /** Invite/remove members and see the roster — the tenant-admin membership surface. */
  manageMembers: permissionKey.parse('dashboard:manage-members'),
};

/**
 * The team roles a member can hold, each mapped to the permission set it carries.
 * `provision.ts` renders `ROLES` (the RoleDefinition[] the checkpoint reviews) from
 * this same map, so the artifact and the runtime agree by construction. The invite
 * flow enforces the §5.1 bound against these sets — a caller may only invite at a
 * role whose every permission they already hold (membership.md §5.1; the kernel does
 * NOT enforce this, so the dashboard does).
 *
 * `owner` and `admin` are equal in permissions today; the distinction is that the
 * owner is the un-removable first member (and will own billing). `member` runs apps
 * but cannot manage the team; `viewer` is read-only.
 */
export const MEMBER_ROLES: Record<string, PermissionKey[]> = {
  owner: [DASHBOARD_PERM.provisionApp, DASHBOARD_PERM.read, DASHBOARD_PERM.manageMembers, INVITES_PERM.send, INVITES_PERM.read, INVITES_PERM.revoke],
  admin: [DASHBOARD_PERM.provisionApp, DASHBOARD_PERM.read, DASHBOARD_PERM.manageMembers, INVITES_PERM.send, INVITES_PERM.read, INVITES_PERM.revoke],
  member: [DASHBOARD_PERM.provisionApp, DASHBOARD_PERM.read],
  viewer: [DASHBOARD_PERM.read],
};

export type MemberRole = keyof typeof MEMBER_ROLES;

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
    {
      key: 'dashboard:manage-members',
      description: 'Invite and remove team members and see the roster',
    },
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
  {
    version: '0003-members',
    sql: `
      -- The team roster PROJECTION. There is no kernel "who holds a role at this
      -- tenant" query, so the dashboard keeps its own readable roster: one row per
      -- member (active) or outstanding invite (invited). Access itself is the kernel
      -- role assignment at the tenant node; this table is the human-facing view of it
      -- plus the plaintext the invites engine deliberately does not keep (it hashes
      -- identifiers). The admin legitimately sees whom they invited, so storing the
      -- email here is intended — the engine's non-enumerability protects the ACCEPT
      -- path and cross-tenant correlation, not the owner's view of their own team.
      CREATE TABLE dashboard_members (
        id            TEXT PRIMARY KEY,
        -- The kernel principal once accepted; NULL while still 'invited'.
        principal     TEXT UNIQUE,
        email         TEXT NOT NULL,
        role_key      TEXT NOT NULL,
        status        TEXT NOT NULL CHECK (status IN ('active','invited','revoked')),
        -- Links a pending row to its invites-engine invitation (the accept gate).
        invitation_id TEXT UNIQUE,
        invited_by    TEXT NOT NULL,
        invited_at    TEXT NOT NULL,
        joined_at     TEXT
      );
      CREATE INDEX dashboard_members_by_status ON dashboard_members (status);

      -- Per-team settings, one row. Holds the org id every team invitation is keyed
      -- by (the invites engine keys on org). Written once when the team is created.
      CREATE TABLE dashboard_team (
        org_id TEXT NOT NULL
      );
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

const markAppFailedInput = z.object({ appScopeId: z.string().min(1) });

/**
 * Flip an app to `failed` when provisioning didn't complete (the vertical refused, a
 * hostname wouldn't bind, …). Same authority as creating it. Guarded to only move a
 * `provisioning` row, so it never clobbers an app that did come up. Without this a
 * failed create leaves the row silently at `provisioning` — indistinguishable from
 * "still coming up".
 */
const markAppFailedOp: OperationHandler<z.infer<typeof markAppFailedInput>, DashboardAppRow> = async (ctx, raw) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.provisionApp));
  const input = markAppFailedInput.parse(raw);
  ctx.sql.exec("UPDATE dashboard_apps SET status = 'failed' WHERE app_scope_id = ? AND status = 'provisioning'", [
    input.appScopeId,
  ]);
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

// -- team + members ----------------------------------------------------------

export interface DashboardMemberRow {
  id: string;
  /** The kernel principal once accepted; null while still 'invited'. */
  principal: string | null;
  email: string;
  role_key: string;
  status: 'active' | 'invited' | 'revoked';
  invitation_id: string | null;
  invited_by: string;
  invited_at: string;
  joined_at: string | null;
}

const initTeamInput = z.object({
  orgId: z.string().min(1),
  ownerEmail: z.string().min(1),
});

/**
 * Seed a freshly-created team: record its invite-keying org id and the owner as the
 * first (active) member. Invoked once by the worker at team creation, as the owner
 * (who holds every permission). Guarded so a re-run cannot duplicate the singleton.
 */
const initTeamOp: OperationHandler<z.infer<typeof initTeamInput>, void> = async (ctx, raw) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.manageMembers));
  const input = initTeamInput.parse(raw);
  if (ctx.sql.query<{ org_id: string }>('SELECT org_id FROM dashboard_team LIMIT 1')[0]) return;
  const now = new Date().toISOString();
  ctx.sql.exec('INSERT INTO dashboard_team (org_id) VALUES (?)', [input.orgId]);
  ctx.sql.exec(
    `INSERT INTO dashboard_members (id, principal, email, role_key, status, invited_by, invited_at, joined_at)
     VALUES (?, ?, ?, 'owner', 'active', ?, ?, ?)`,
    [ulid(), ctx.principal, input.ownerEmail, ctx.principal, now, now],
  );
};

const inviteMemberInput = z.object({
  email: z.string().trim().min(1),
  roleKey: z.enum(['admin', 'member', 'viewer']),
});

/**
 * Invite someone to the team at a role. Enforces the §5.1 bound HERE (the kernel
 * does not): the caller may invite only at a role whose every permission they
 * already hold — checked with `ctx.check` per permission, so a member cannot mint
 * authority above their own. Composes the invites engine's `sendInvite` (hashed
 * identifier, rate-limited, accept-required) in the same transaction and records a
 * readable pending roster row.
 */
const inviteMemberOp: OperationHandler<z.infer<typeof inviteMemberInput>, { invitationId: string }> = async (ctx, raw) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.manageMembers));
  const input = inviteMemberInput.parse(raw);
  const perms = MEMBER_ROLES[input.roleKey];
  if (!perms) throw new Error(`unknown role '${input.roleKey}'`);
  for (const perm of perms) assertAllowed(await ctx.check(perm));

  const team = ctx.sql.query<{ org_id: string }>('SELECT org_id FROM dashboard_team LIMIT 1')[0];
  if (!team) throw new Error('team not initialised');

  const { id: invitationId } = await sendInvite(ctx, {
    orgId: team.org_id as unknown as OrgId,
    identifier: input.email,
    roleKey: input.roleKey,
  });
  // The engine no-ops a duplicate open invite (returns the same id); mirror that in
  // the projection so re-inviting is idempotent rather than a duplicate roster row.
  if (!ctx.sql.query<{ id: string }>('SELECT id FROM dashboard_members WHERE invitation_id = ?', [invitationId])[0]) {
    ctx.sql.exec(
      `INSERT INTO dashboard_members (id, email, role_key, status, invitation_id, invited_by, invited_at)
       VALUES (?, ?, ?, 'invited', ?, ?, ?)`,
      [ulid(), input.email, input.roleKey, invitationId, ctx.principal, new Date().toISOString()],
    );
  }
  return { invitationId };
};

const acceptInviteInput = z.object({
  invitationId: z.string().min(1),
  identifier: z.string().min(1),
});

/**
 * Accept an invitation, as the recipient principal (minted by the worker; not a
 * member yet, so there is no permission to check — the identifier hash IS the
 * authority, per the invites engine). Composes `acceptInvite` (verifies the hash,
 * transitions state, emits invites.accepted + member.add-requested) and flips the
 * roster row to active in the SAME transaction. The kernel role assignment + identity
 * link are effected by the worker afterwards (they need platform authority / the sub).
 */
const acceptInviteOp: OperationHandler<z.infer<typeof acceptInviteInput>, { roleKey: string }> = async (ctx, raw) => {
  const input = acceptInviteInput.parse(raw);
  const invitation = await acceptInvite(ctx, input); // throws "not acceptable" on any mismatch
  ctx.sql.exec(
    `UPDATE dashboard_members SET principal = ?, status = 'active', joined_at = ? WHERE invitation_id = ?`,
    [ctx.principal, new Date().toISOString(), input.invitationId],
  );
  return { roleKey: invitation.role_key };
};

const revokeInviteInput = z.object({ invitationId: z.string().min(1) });

/** Withdraw a pending invite (composes the engine's revoke) + drop it from the roster. */
const revokeInviteOp: OperationHandler<z.infer<typeof revokeInviteInput>, void> = async (ctx, raw) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.manageMembers));
  const input = revokeInviteInput.parse(raw);
  revokeInvite(ctx, input.invitationId);
  ctx.sql.exec(
    `UPDATE dashboard_members SET status = 'revoked' WHERE invitation_id = ? AND status = 'invited'`,
    [input.invitationId],
  );
};

/** The team roster — active members + outstanding invites, newest first. Gated read. */
const listMembersOp: OperationHandler<Record<string, never>, DashboardMemberRow[]> = async (ctx) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.read));
  return ctx.sql.query<DashboardMemberRow>(
    `SELECT * FROM dashboard_members WHERE status IN ('active','invited') ORDER BY invited_at DESC`,
  );
};

const removeMemberInput = z.object({ memberId: z.string().min(1) });

/**
 * Remove an ACTIVE member from the roster projection (the worker separately revokes
 * their kernel role via `unassignRole` — that is what actually cuts access). The
 * owner cannot be removed. Returns the removed principal + role so the worker knows
 * what to unassign; a no-match (already gone, or the owner) returns null.
 */
const removeMemberOp: OperationHandler<z.infer<typeof removeMemberInput>, { principal: string; roleKey: string } | null> = async (ctx, raw) => {
  assertAllowed(await ctx.check(DASHBOARD_PERM.manageMembers));
  const input = removeMemberInput.parse(raw);
  const row = ctx.sql.query<DashboardMemberRow>(
    `SELECT * FROM dashboard_members WHERE id = ? AND status = 'active' AND role_key != 'owner'`,
    [input.memberId],
  )[0];
  if (!row || !row.principal) return null;
  ctx.sql.exec(`UPDATE dashboard_members SET status = 'revoked' WHERE id = ?`, [input.memberId]);
  return { principal: row.principal, roleKey: row.role_key };
};

export const dashboardModule: ModuleRegistration = {
  manifest: dashboardManifest,
  migrations: dashboardMigrations,
  operations: {
    'dashboard/provision-app': provisionAppOp as OperationHandler<never, unknown>,
    'dashboard/mark-app-active': markAppActiveOp as OperationHandler<never, unknown>,
    'dashboard/mark-app-failed': markAppFailedOp as OperationHandler<never, unknown>,
    'dashboard/list-apps': listAppsOp as OperationHandler<never, unknown>,
    'dashboard/delete-app': deleteAppOp as OperationHandler<never, unknown>,
    'dashboard/init-team': initTeamOp as OperationHandler<never, unknown>,
    'dashboard/invite-member': inviteMemberOp as OperationHandler<never, unknown>,
    'dashboard/accept-invite': acceptInviteOp as OperationHandler<never, unknown>,
    'dashboard/revoke-invite': revokeInviteOp as OperationHandler<never, unknown>,
    'dashboard/list-members': listMembersOp as OperationHandler<never, unknown>,
    'dashboard/remove-member': removeMemberOp as OperationHandler<never, unknown>,
  },
};

import type Database from 'better-sqlite3';
import {
  objectRef,
  type Decision,
  type EntityRef,
  type Node,
  type PermissionKey,
  type PrincipalId,
  type RelationTuple,
  type RoleDefinition,
} from '@chassis/contracts';
import type { PermissionChecker } from '@chassis/kernel';

/**
 * The built-in constrained relationship-tuple evaluator (design doc §4.2,
 * plan D-23). Fixed four-rule algebra — role expansion, tenancy-tree
 * inheritance, declared entity parent edges (depth ≤ 4), membership — no
 * negation, no configurable rewrites. Every allow carries its tuple proof.
 *
 * Tuple placement: scope-level and entity tuples live in the scope database
 * (`_chassis_tuples`); tenant-level assignments/grants and org membership
 * live in the directory (`_chassis_tenant_tuples`). Everything is evaluated
 * inside the caller's serialization domain, so check-after-write consistency
 * is free — the "no zookies" property.
 */

const ENTITY_WALK_DEPTH = 4;

export interface CheckerDeps {
  directory: Database.Database;
  /** Resolve an OPEN scope db; checks only run inside operations, so it is open. */
  scopeDb(scopeId: string): Database.Database | undefined;
  getRole(tenantId: string, key: string): RoleDefinition | undefined;
}

interface TupleRow {
  subject: string;
  relation: string;
  object: string;
  expires_at: string | null;
}

const t = (subject: string, relation: string, object: string): RelationTuple => ({
  subject: objectRef.parse(subject),
  relation,
  object: objectRef.parse(object),
});

export function createTupleChecker(deps: CheckerDeps): PermissionChecker {
  const tenantTuples = (tenantId: string, subject: string, relationPrefix: string): TupleRow[] =>
    deps.directory
      .prepare(
        `SELECT subject, relation, object, expires_at FROM _chassis_tenant_tuples
         WHERE tenant_id = ? AND subject = ? AND relation LIKE ?`,
      )
      .all(tenantId, subject, `${relationPrefix}%`) as TupleRow[];

  const scopeTuples = (
    db: Database.Database,
    subject: string,
    relationPrefix: string,
  ): TupleRow[] =>
    db
      .prepare(
        `SELECT subject, relation, object, expires_at FROM _chassis_tuples
         WHERE subject = ? AND relation LIKE ?`,
      )
      .all(subject, `${relationPrefix}%`) as TupleRow[];

  const live = (row: TupleRow, now: string): boolean =>
    row.expires_at === null || row.expires_at > now;

  return {
    async check(
      principal: PrincipalId,
      permission: PermissionKey,
      node: Node,
      entity?: EntityRef,
    ): Promise<Decision> {
      const now = new Date().toISOString();
      const deny: Decision = { allowed: false, checked: permission, node };
      const scopeDb = node.scopeId ? deps.scopeDb(node.scopeId) : undefined;

      // Rule 4 — membership: the subject set is the principal plus its orgs.
      const subjects: { ref: string; via?: RelationTuple }[] = [
        { ref: `principal:${principal}` },
      ];
      for (const m of tenantTuples(node.tenantId, `principal:${principal}`, 'member')) {
        if (m.relation === 'member' && live(m, now)) {
          subjects.push({ ref: m.object, via: t(m.subject, m.relation, m.object) });
        }
      }

      // Inheritance (rule 2): a scope check also consults tenant-level tuples.
      const nodeObjects: { obj: string; scoped: boolean }[] = node.scopeId
        ? [
            { obj: `scope:${node.scopeId}`, scoped: true },
            { obj: `tenant:${node.tenantId}`, scoped: false },
          ]
        : [{ obj: `tenant:${node.tenantId}`, scoped: false }];

      const tuplesFor = (subject: string, prefix: string, scoped: boolean): TupleRow[] =>
        scoped
          ? scopeDb
            ? scopeTuples(scopeDb, subject, prefix)
            : []
          : tenantTuples(node.tenantId, subject, prefix);

      for (const nodeObj of nodeObjects) {
        for (const subject of subjects) {
          // Rule 1 — role expansion.
          for (const row of tuplesFor(subject.ref, 'role:', nodeObj.scoped)) {
            if (row.object !== nodeObj.obj || !live(row, now)) continue;
            const roleKey = row.relation.slice('role:'.length);
            const role = deps.getRole(node.tenantId, roleKey);
            if (role?.permissions.includes(permission)) {
              return {
                allowed: true,
                proof: [
                  ...(subject.via ? [subject.via] : []),
                  t(row.subject, row.relation, row.object),
                  t(`role:${roleKey}`, `granted:${permission}`, nodeObj.obj),
                ],
              };
            }
          }
          // Direct grants at the node.
          for (const row of tuplesFor(subject.ref, `granted:${permission}`, nodeObj.scoped)) {
            if (row.object === nodeObj.obj && row.relation === `granted:${permission}` && live(row, now)) {
              return {
                allowed: true,
                proof: [
                  ...(subject.via ? [subject.via] : []),
                  t(row.subject, row.relation, row.object),
                ],
              };
            }
          }
        }
      }

      // Rule 3 — entity walk along declared parent edges (entity grants are
      // scope-local by construction).
      if (entity && scopeDb) {
        type Frontier = { ref: string; chain: RelationTuple[] };
        let frontier: Frontier[] = [
          { ref: `${entity.entityType}:${entity.entityId}`, chain: [] },
        ];
        for (let depth = 0; depth <= ENTITY_WALK_DEPTH && frontier.length > 0; depth++) {
          // grant lookup at current frontier objects
          for (const candidate of frontier) {
            for (const subject of subjects) {
              const grant = scopeDb
                .prepare(
                  `SELECT subject, relation, object, expires_at FROM _chassis_tuples
                   WHERE subject = ? AND relation = ? AND object = ?`,
                )
                .get(subject.ref, `granted:${permission}`, candidate.ref) as
                | TupleRow
                | undefined;
              if (grant && live(grant, now)) {
                return {
                  allowed: true,
                  proof: [
                    ...(subject.via ? [subject.via] : []),
                    ...candidate.chain,
                    t(grant.subject, grant.relation, grant.object),
                  ],
                };
              }
            }
          }
          // expand one level of parents
          const next: Frontier[] = [];
          for (const candidate of frontier) {
            const parents = scopeDb
              .prepare(
                `SELECT subject, relation, object, expires_at FROM _chassis_tuples
                 WHERE subject = ? AND relation = 'parent'`,
              )
              .all(candidate.ref) as TupleRow[];
            for (const p of parents) {
              next.push({
                ref: p.object,
                chain: [...candidate.chain, t(p.subject, 'parent', p.object)],
              });
            }
          }
          frontier = next;
        }
      }

      return deny;
    },
  };
}

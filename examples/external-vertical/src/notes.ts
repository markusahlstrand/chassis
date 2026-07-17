/**
 * A tiny custom module — the "write your own" half of a vertical.
 *
 * It follows every module rule the platform enforces mechanically: data access
 * is `ctx.sql` only, the permission check is the operation's first line, inputs
 * are parsed with Zod, and every mutation emits a kernel-stamped event. Nothing
 * here imports a database driver, a node built-in, or another module — it is the
 * same shape an engine ships, just smaller. It runs unchanged on the SQLite
 * adapter (local) and the Cloudflare adapter (deployed).
 */
import { moduleManifest, permissionKey, z } from '@substrat-run/contracts';
import { assertAllowed, ulid, type ModuleRegistration } from '@substrat-run/kernel';

export const NOTES_PERM = {
  write: permissionKey.parse('notes:write'),
  read: permissionKey.parse('notes:read'),
};

const noteInput = z.object({ text: z.string().min(1) });

interface NoteRow {
  id: string;
  text: string;
  created_by: string;
  created_at: string;
}

export const notesModule: ModuleRegistration = {
  manifest: moduleManifest.parse({
    id: '@acme/notes',
    version: '0.0.1',
    kernelContract: '^0.0.1',
    permissions: [
      { key: 'notes:write', description: 'Create notes' },
      { key: 'notes:read', description: 'Read notes' },
    ],
    events: {
      emits: [{ type: 'notes.created', schemaVersion: 1 }],
      consumes: [],
    },
    migrations: { journalDir: './migrations', compatibleFrom: '0.0.1' },
    attachmentTargets: [],
    // The SKU flag that gates loading (D-20): a tenant without this entitlement
    // loads none of these operations.
    entitlementKey: 'notes',
  }),
  migrations: [
    {
      version: '0001-init',
      sql: `CREATE TABLE notes (
        id         TEXT PRIMARY KEY,
        text       TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );`,
    },
  ],
  operations: {
    'notes/create': async (ctx, input) => {
      assertAllowed(await ctx.check(NOTES_PERM.write));
      const { text } = noteInput.parse(input);
      const id = ulid();
      ctx.sql.exec('INSERT INTO notes (id, text, created_by, created_at) VALUES (?, ?, ?, ?)', [
        id,
        text,
        ctx.principal,
        new Date().toISOString(),
      ]);
      // No origin fields: tenant, scope, actor, id and timestamp are stamped by
      // the kernel, so this event physically cannot be mislabelled.
      ctx.emit({
        type: 'notes.created',
        schemaVersion: 1,
        entity: { entityType: 'note', entityId: id },
        piiClass: 'none',
        payload: { noteId: id },
      });
      return { id };
    },
    'notes/list': async (ctx) => {
      assertAllowed(await ctx.check(NOTES_PERM.read));
      return ctx.sql.query<NoteRow>('SELECT id, text, created_by, created_at FROM notes ORDER BY id DESC');
    },
  },
};

import { z } from 'zod';

/**
 * The content-type DSL. In Manyfold a content type is a definition object —
 * fields, their types, and the references that connect types — and that object is
 * the single source the editor form, the model-builder views, the body validator,
 * and (option 2, cms-content.md §4) the generated migration all read from.
 *
 * Milestone A persists bodies as a validated JSON revision (cms-content.md §9); the
 * operations are identical to the typed-table form, so the storage can swap under
 * them later without a single operation changing. `compileTypeToSql` below is the
 * demonstrative other half — the `CREATE TABLE` a real save would stage for review.
 */

export type FieldType =
  | 'text'
  | 'richText'
  | 'slug'
  | 'bool'
  | 'int'
  | 'date'
  | 'enum'
  | 'textArray'
  | 'assetRef'
  | 'assetRefMany'
  | 'ref'
  | 'refMany';

export const FIELD_TYPES = [
  'text', 'richText', 'slug', 'bool', 'int', 'date', 'enum', 'textArray', 'assetRef', 'assetRefMany', 'ref', 'refMany',
] as const;

export interface FieldDef {
  type: FieldType;
  required?: boolean;
  index?: boolean;
  /** enum */
  options?: readonly string[];
  /** ref / refMany — the target content-type key (the "connected" edge) */
  target?: string;
  /** slug — the field it derives from */
  source?: string;
  maxLen?: number;
}

export interface ContentTypeDef {
  key: string;
  version: number;
  title: string;
  /** which field renders as the entry's display title */
  titleField: string;
  slugField?: string;
  fields: Record<string, FieldDef>;
}

export function defineContentType(def: ContentTypeDef): ContentTypeDef {
  if (!def.fields[def.titleField]) {
    throw new Error(`content type ${def.key}: titleField '${def.titleField}' is not a field`);
  }
  return def;
}

// ── The four seed types ─────────────────────────────────────────────────────

export const AUTHOR = defineContentType({
  key: 'author',
  version: 1,
  title: 'Author',
  titleField: 'name',
  fields: {
    name: { type: 'text', required: true },
    bio: { type: 'richText' },
    avatar: { type: 'assetRef' },
  },
});

export const SNIPPET = defineContentType({
  key: 'snippet',
  version: 1,
  title: 'Snippet',
  titleField: 'name',
  fields: {
    name: { type: 'text', required: true },
    kind: { type: 'enum', options: ['banner', 'cta', 'quote'], required: true },
    body: { type: 'richText' },
  },
});

export const PAGE = defineContentType({
  key: 'page',
  version: 1,
  title: 'Page',
  titleField: 'title',
  slugField: 'slug',
  fields: {
    title: { type: 'text', required: true },
    slug: { type: 'slug', source: 'title' },
    body: { type: 'richText' },
    hero: { type: 'assetRef' },
    blocks: { type: 'refMany', target: 'snippet' },
    seoTitle: { type: 'text', maxLen: 60 },
    seoDescription: { type: 'text', maxLen: 160 },
  },
});

export const POST = defineContentType({
  key: 'post',
  version: 1,
  title: 'Post',
  titleField: 'title',
  slugField: 'slug',
  fields: {
    title: { type: 'text', required: true },
    slug: { type: 'slug', source: 'title' },
    body: { type: 'richText' },
    hero: { type: 'assetRef' },
    blocks: { type: 'refMany', target: 'snippet' },
    author: { type: 'ref', target: 'author' },
    publishedAt: { type: 'date', index: true },
    tags: { type: 'textArray' },
    category: { type: 'enum', options: ['news', 'guide', 'release'] },
    seoTitle: { type: 'text', maxLen: 60 },
    seoDescription: { type: 'text', maxLen: 160 },
  },
});

export const CONTENT_TYPES: ContentTypeDef[] = [PAGE, POST, SNIPPET, AUTHOR];
export const CONTENT_TYPE_BY_KEY: ReadonlyMap<string, ContentTypeDef> = new Map(
  CONTENT_TYPES.map((t) => [t.key, t]),
);

// ── Body validation (built from the definition) ─────────────────────────────

function fieldSchema(f: FieldDef): z.ZodTypeAny {
  let base: z.ZodTypeAny;
  switch (f.type) {
    case 'text':
    case 'richText':
    case 'slug':
    case 'date':
    case 'assetRef':
    case 'ref': {
      let s = z.string();
      if (f.maxLen) s = s.max(f.maxLen);
      base = s;
      break;
    }
    case 'bool':
      base = z.boolean();
      break;
    case 'int':
      base = z.number().int();
      break;
    case 'enum':
      base = z.enum((f.options ?? ['']) as [string, ...string[]]);
      break;
    case 'textArray':
    case 'assetRefMany':
    case 'refMany':
      base = z.array(z.string());
      break;
  }
  return f.required ? base : base.optional();
}

/**
 * The Zod schema for a type's body — `.strict()` so an unknown field is rejected at
 * the boundary (parse, don't trust). Optional fields may be omitted; required fields
 * must be present.
 */
export function buildBodySchema(def: ContentTypeDef): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, f] of Object.entries(def.fields)) shape[name] = fieldSchema(f);
  return z.object(shape).strict() as unknown as z.ZodType<Record<string, unknown>>;
}

/** The reference edges of a type — Post→Author, Page→Snippet — used to resolve at delivery. */
export function referenceFields(def: ContentTypeDef): { name: string; target: string; many: boolean }[] {
  const out: { name: string; target: string; many: boolean }[] = [];
  for (const [name, f] of Object.entries(def.fields)) {
    if ((f.type === 'ref' || f.type === 'refMany') && f.target) {
      out.push({ name, target: f.target, many: f.type === 'refMany' });
    }
  }
  return out;
}

// ── The demonstrative compile-to-SQL half (option 2, cms-content.md §4) ──────

const SQL_COLUMN: Partial<Record<FieldType, string>> = {
  text: 'TEXT',
  richText: 'TEXT',
  slug: 'TEXT',
  date: 'TEXT',
  enum: 'TEXT',
  assetRef: 'TEXT',
  ref: 'TEXT',
  bool: 'INTEGER',
  int: 'INTEGER',
};

/**
 * The `CREATE TABLE` a "Save" in the model builder would stage as a reviewable
 * migration (never run live). Scalar fields become columns; array/refMany fields
 * become child join tables. Demonstrative in Milestone A — the migration-preview
 * view renders this; the JSON store is what actually persists.
 */
export function compileTypeToSql(def: ContentTypeDef): string {
  const cols = ['  entry_id TEXT NOT NULL', '  rev_no INTEGER NOT NULL'];
  const children: string[] = [];
  for (const [name, f] of Object.entries(def.fields)) {
    const col = SQL_COLUMN[f.type];
    if (col) {
      cols.push(`  ${name} ${col}${f.required ? ' NOT NULL' : ''}`);
    } else {
      // textArray / assetRefMany / refMany → child join table
      children.push(
        `CREATE TABLE ct_${def.key}_${name} (entry_id TEXT NOT NULL, rev_no INTEGER NOT NULL, ` +
          `position INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY (entry_id, rev_no, position));`,
      );
    }
  }
  cols.push('  PRIMARY KEY (entry_id, rev_no)');
  const table = `CREATE TABLE ct_${def.key}_v${def.version} (\n${cols.join(',\n')}\n);`;
  const indexes = Object.entries(def.fields)
    .filter(([, f]) => f.index)
    .map(([name]) => `CREATE INDEX ct_${def.key}_${name} ON ct_${def.key}_v${def.version} (${name});`);
  return [table, ...indexes, ...children].join('\n');
}

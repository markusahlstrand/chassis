import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { lint, resolvePackages, type Violation } from '../src/index.js';

// ---------------------------------------------------------------------------
// Fixtures: a standalone vertical with engines installed in node_modules, which
// is the shape the monorepo linter could never see. Engine ownership comes from
// the migration SQL in the package's shipped dist — exactly as npm delivers it.
// ---------------------------------------------------------------------------

const roots: string[] = [];

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'boundary-lint-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return root;
}

/** An installed engine: package.json + dist carrying its CREATE TABLEs. */
function engine(name: string, tables: string[]): Record<string, string> {
  const dir = `node_modules/@substrat-run/${name}`;
  return {
    [`${dir}/package.json`]: JSON.stringify({ name: `@substrat-run/${name}`, main: './dist/index.js' }),
    [`${dir}/dist/index.js`]: tables
      .map((t) => `export const m_${t} = { sql: \`CREATE TABLE ${t} (id TEXT PRIMARY KEY);\` };`)
      .join('\n'),
  };
}

const VERTICAL_PKG = JSON.stringify({ name: '@acme/bike-shop', type: 'module' });

function rules(vs: Violation[]): string[] {
  return vs.map((v) => v.rule);
}

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('standalone vertical (engines in node_modules)', () => {
  it('R5 fires on an engine table and stays quiet on the vertical’s own', () => {
    const root = project({
      'package.json': VERTICAL_PKG,
      ...engine('engine-workorder', ['workorder_orders', 'workorder_time_entries']),
      'src/module.ts': `
        export const migrations = [{ version: '0001', sql: \`CREATE TABLE shop_customers (id TEXT);\` }];
        export function own(ctx) { return ctx.sql.query('SELECT * FROM shop_customers'); }
        export function foreign(ctx) { return ctx.sql.query('SELECT * FROM workorder_time_entries'); }
      `,
    });

    const violations = lint(root);

    expect(rules(violations)).toEqual(['R5']);
    expect(violations[0]!.message).toContain('workorder_time_entries');
    expect(violations[0]!.message).toContain('@substrat-run/engine-workorder');
    // The vertical's own table is never a violation.
    expect(violations[0]!.message).not.toContain('shop_customers');
  });

  it('resolves ownership from the published dist, so the map is not empty', () => {
    const root = project({
      'package.json': VERTICAL_PKG,
      ...engine('engine-invoicing', ['invoicing_lines']),
      'src/module.ts': 'export const x = 1;',
    });

    const owners = resolvePackages(root).filter((p) => !p.lint).map((p) => p.name);
    expect(owners).toContain('@substrat-run/engine-invoicing');
  });

  it('a clean vertical passes', () => {
    const root = project({
      'package.json': VERTICAL_PKG,
      ...engine('engine-workorder', ['workorder_orders']),
      'src/module.ts': `
        import { listOrders } from '@substrat-run/engine-workorder';
        export const migrations = [{ version: '0001', sql: \`CREATE TABLE shop_bikes (id TEXT);\` }];
        export function ok(ctx) { return { a: listOrders(ctx), b: ctx.sql.query('SELECT * FROM shop_bikes') }; }
      `,
    });

    expect(lint(root)).toEqual([]);
  });
});

describe('the spine (R4)', () => {
  it('reads of _substrat_* are legal — timelines are projections', () => {
    const root = project({
      'package.json': VERTICAL_PKG,
      ...engine('engine-workorder', ['workorder_orders']),
      'src/module.ts': `
        export function timeline(ctx) { return ctx.sql.query('SELECT type FROM _substrat_outbox'); }
      `,
    });

    expect(lint(root)).toEqual([]);
  });

  it('writes to _substrat_* are R4', () => {
    const root = project({
      'package.json': VERTICAL_PKG,
      ...engine('engine-workorder', ['workorder_orders']),
      'src/module.ts': `
        export function forge(ctx) { ctx.sql.exec("INSERT INTO _substrat_outbox (id) VALUES ('x')"); }
      `,
    });

    expect(rules(lint(root))).toEqual(['R4']);
  });
});

describe('R2 / R3', () => {
  it('flags raw data access, platform escapes, and network', () => {
    const root = project({
      'package.json': VERTICAL_PKG,
      ...engine('engine-workorder', ['workorder_orders']),
      'src/module.ts': `
        import Database from 'better-sqlite3';
        import { readFileSync } from 'node:fs';
        import axios from 'axios';
        export function bad() { void fetch('https://example.com'); return [Database, readFileSync, axios]; }
      `,
    });

    expect(rules(lint(root)).sort()).toEqual(['R2', 'R2', 'R3', 'R3']);
  });
});

describe('harness exemption', () => {
  it('server.ts may touch node and the adapter; module code may not', () => {
    const harnessSrc = `
      import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
      import { readFileSync } from 'node:fs';
      export const host = new SqliteScopeHost({ dir: './data' });
      export const cfg = readFileSync('./cfg.json', 'utf8');
    `;
    const root = project({
      'package.json': VERTICAL_PKG,
      ...engine('engine-workorder', ['workorder_orders']),
      'src/server.ts': harnessSrc,
      'src/module.ts': 'export const x = 1;',
    });

    expect(lint(root)).toEqual([]);

    // The same code under a non-harness name is module code, and is not exempt.
    const root2 = project({
      'package.json': VERTICAL_PKG,
      ...engine('engine-workorder', ['workorder_orders']),
      'src/ops.ts': harnessSrc,
    });
    expect(rules(lint(root2)).sort()).toEqual(['R2', 'R2']);
  });
});

describe('R5 escape hatch (decision 27)', () => {
  it('an explicit allow block suppresses R5, and only within the block', () => {
    const root = project({
      'package.json': VERTICAL_PKG,
      ...engine('engine-workorder', ['workorder_time_entries']),
      'src/module.ts': `
        export function extract(ctx) {
          // boundary-lint-allow R5 — one-time extraction handoff
          const old = ctx.sql.query('SELECT * FROM workorder_time_entries');
          // boundary-lint-end R5
          const sneaky = ctx.sql.query('SELECT * FROM workorder_time_entries');
          return [old, sneaky];
        }
      `,
    });

    const violations = lint(root);
    expect(rules(violations)).toEqual(['R5']);
    // Only the line outside the block is reported (line 1 is the template's
    // leading newline, so `sneaky` lands on 6).
    expect(violations[0]!.line).toBe(6);
  });
});

describe('config', () => {
  it('honours explicit packages and externals', () => {
    const root = project({
      'package.json': VERTICAL_PKG,
      'boundary-lint.config.json': JSON.stringify({
        packages: [{ name: '@acme/thing', src: 'lib' }],
        externals: ['vendor/engine-thing'],
      }),
      'vendor/engine-thing/package.json': JSON.stringify({ name: '@acme/engine-thing' }),
      'vendor/engine-thing/dist/index.js': 'export const m = { sql: `CREATE TABLE thing_rows (id TEXT);` };',
      'lib/module.ts': `export function f(ctx) { return ctx.sql.query('SELECT * FROM thing_rows'); }`,
    });

    const violations = lint(root);
    expect(rules(violations)).toEqual(['R5']);
    expect(violations[0]!.message).toContain('@acme/engine-thing');
  });
});

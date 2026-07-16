#!/usr/bin/env node
/**
 * substrat-boundary-lint [--root <dir>] [--verbose]
 *
 * Exit 0 = the layer rules hold. Exit 1 = violations. Exit 2 = the linter could
 * not do its job (see below).
 */
import { lint, loadConfig, resolvePackages, formatViolations } from './index.js';

const argv = process.argv.slice(2);
const rootArg = argv.indexOf('--root');
const root = (rootArg >= 0 ? argv[rootArg + 1] : undefined) ?? process.cwd();
const verbose = argv.includes('--verbose');

const config = loadConfig(root);
const packages = resolvePackages(root, config);
const linted = packages.filter((p) => p.lint);
const owners = packages.filter((p) => !p.lint);

if (verbose) {
  console.log('boundary-lint: linting');
  for (const p of linted) console.log(`  · ${p.name}  (${p.dir})${p.engine ? '  [engine: R1]' : ''}`);
  console.log('boundary-lint: table ownership from');
  for (const p of owners) console.log(`  · ${p.name}  (${p.dir})`);
  console.log();
}

// A linter that checked nothing must never print a green light. R5 depends on
// knowing which module owns which table; with no module code found, or no
// engines resolvable, "all rules hold" would be a lie an agent then trusts.
// Fail loudly instead — a silent pass is worse than no linter at all.
if (linted.length === 0) {
  console.error(
    'boundary-lint: no module code found.\n\n' +
      `  Looked in: ${root}\n` +
      '  Expected `src/` (a standalone vertical) or `engines/*/src` + `demos/*/src` (the monorepo).\n' +
      '  Point it at your module code with boundary-lint.config.json:\n\n' +
      '    { "packages": [{ "src": "src" }] }\n',
  );
  process.exit(2);
}

if (owners.length === 0 && linted.length === 1) {
  console.error(
    'boundary-lint: no engines resolved — R5 (tables private) would check nothing.\n\n' +
      '  A vertical composes engines; their tables are what R5 protects. With no\n' +
      '  engine packages found, the ownership map holds only your own tables and\n' +
      '  every R5 check trivially passes.\n\n' +
      `  Looked for: ${root}/node_modules/@substrat-run/engine-*\n` +
      '  Install an engine, or declare where they live:\n\n' +
      '    { "externals": ["node_modules/@acme/engine-thing"] }\n',
  );
  process.exit(2);
}

const violations = lint(root, config);

if (violations.length) {
  console.error(`boundary-lint: ${violations.length} violation(s)\n`);
  console.error(formatViolations(violations));
  console.error('');
  process.exit(1);
}

console.log('boundary-lint: all layer rules hold');

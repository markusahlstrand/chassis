#!/usr/bin/env node
/**
 * Repo entry point for the layer rules. The implementation lives in
 * `packages/boundary-lint` and ships to strangers as
 * `@substrat-run/boundary-lint` — this monorepo lints itself with the same code
 * a from-scratch vertical runs, so the rules can never drift between what we
 * enforce on ourselves and what we enforce on the product.
 *
 * Kept as `tools/boundary-lint.mjs` because CI, CLAUDE.md, and
 * `.claude/settings.local.json` all name this path.
 */
import { lint, loadConfig, formatViolations } from '../packages/boundary-lint/dist/index.js';

const root = new URL('..', import.meta.url).pathname;
const violations = lint(root, loadConfig(root));

if (violations.length) {
  console.error(`boundary-lint: ${violations.length} violation(s)\n`);
  console.error(formatViolations(violations));
  console.error('');
  process.exit(1);
}
console.log('boundary-lint: all layer rules hold');

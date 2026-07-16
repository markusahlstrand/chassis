#!/usr/bin/env node
/**
 * `npm create substrat` — placeholder.
 *
 * This reserves the entry point a user will guess. It deliberately does nothing
 * but point at what does exist: publishing a stub that pretends to scaffold
 * would be worse than publishing nothing.
 *
 * Dependency-free and buildless on purpose — a placeholder that can break at
 * install time is a placeholder that damages the name it exists to protect.
 */

const DOCS = 'https://substrat.ahlstrand.es';
const GUIDE = `${DOCS}/guide/getting-started`;
const REPO = 'https://github.com/substrat-run/substrat';

process.stdout.write(
  [
    '',
    '  Substrat — a hosted substrate for vertical business software.',
    '',
    '  The initializer is not released yet. This package reserves',
    '  `npm create substrat` for it.',
    '',
    '  To start a vertical today, follow the guide:',
    `    ${GUIDE}`,
    '',
    '  The packages are published and usable now:',
    '    pnpm add @substrat-run/kernel @substrat-run/contracts @substrat-run/adapter-sqlite zod',
    '',
    `  Docs:  ${DOCS}`,
    `  Repo:  ${REPO}`,
    '',
    '  Substrat is 0.x and interfaces change without notice until the first',
    '  vertical ships.',
    '',
    '',
  ].join('\n'),
);

// The Dashboard has no demo world of its own — provisioning IS its domain. This
// file exists only so the permission checkpoint sees it: `tools/permission-diff.mts`
// reads `MODULES`/`ROLES` from each vertical's `seed.ts` to render PERMISSIONS.md,
// and a vertical it cannot find is silently skipped — CI green over an unreviewed
// permission surface. See demos/callout/src/seed.ts.
export { MODULES, ROLES } from './provision.js';

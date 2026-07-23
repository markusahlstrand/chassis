import { describe, it, expect } from 'vitest';
import { deploymentRefFor } from '../src/deploy.js';

/**
 * The dispatch script name must stay Cloudflare-safe (`[a-z0-9_-]`). A builder-owned
 * vertical's slug is `<tenant>/<name>` (builder-plane.md), so the `/` — and any other
 * stray char — has to flatten to `-`, while a bare platform slug is left as-is.
 */
describe('deploymentRefFor', () => {
  const V = '01KY713CDRSSD1G0N5411NAYXP';

  it('leaves a bare platform slug unchanged (backward-compatible)', () => {
    expect(deploymentRefFor('callout', V)).toBe(`callout-${V.toLowerCase()}`);
  });

  it('flattens a `<tenant>/<name>` slug to a script-safe ref', () => {
    expect(deploymentRefFor('acme/callout', V)).toBe(`acme-callout-${V.toLowerCase()}`);
  });

  it('is script-name-safe for any slug (only [a-z0-9_-] survives)', () => {
    expect(deploymentRefFor('Acme Inc/My.App', V)).toMatch(/^[a-z0-9_-]+$/);
  });
});

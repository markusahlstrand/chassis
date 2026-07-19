import { z } from 'zod';
import { instant, slug } from './ids.js';

/**
 * The vertical + version registry (#31 step 1; D-33's milestone one).
 *
 * Today a scope carries a nullable `vertical` STRING — a label nothing validates and
 * nothing can be pinned to. That is enough to say "this scope runs Callout" and not
 * enough to say *which Callout*, which is what dev/staging/prod and preview
 * deployments are: the same vertical at different versions.
 *
 * The registry makes a version a real record with digests, so promotion can compare
 * two of them, and an admission status, so **push is not live**.
 */

/** Where a vertical came from. `builtin` is one we ship; the others are a customer's. */
export const verticalSource = z.enum(['builtin', 'git', 'cli']);
export type VerticalSource = z.infer<typeof verticalSource>;

export const vertical = z.object({
  slug, // stable, human-readable, and what a scope row denormalizes for display
  name: z.string().min(1),
  source: verticalSource,
  createdAt: instant,
});
export type Vertical = z.infer<typeof vertical>;

export const registerVerticalInput = vertical.pick({ slug: true, name: true, source: true });
export type RegisterVerticalInput = z.infer<typeof registerVerticalInput>;

/**
 * Whether a version may be bound to a scope.
 *
 * `pending` is what a push produces. The admission gates — boundary-lint, the
 * migration diff and the permission diff — decide the rest, and binding a scope is a
 * separate, reviewable step. That separation is the whole point: it is what stops a
 * push being a deploy, and it puts the two human checkpoints where the blast radius
 * is (promotion) rather than where the typing is (merge).
 */
export const admissionStatus = z.enum(['pending', 'admitted', 'rejected']);
export type AdmissionStatus = z.infer<typeof admissionStatus>;

/**
 * One published version of a vertical.
 *
 * The three digests are what make promotion answerable. "Has the permission surface
 * changed between the version in prod and the one I am promoting?" is a string
 * comparison here, where today it is a person remembering to look — and per §4 of the
 * plan, a checkpoint that can be skipped is not a checkpoint.
 */
export const verticalVersion = z.object({
  id: z.string().min(1), // ULID
  verticalSlug: slug,
  version: z.string().min(1), // the builder's label — semver, a git sha, whatever they push
  manifestDigest: z.string().min(1),
  permissionDigest: z.string().min(1),
  migrationDigest: z.string().min(1),
  /** How to reach the deployment that serves it. Null until something is deployed. */
  deploymentRef: z.string().min(1).nullable(),
  admission: admissionStatus,
  /** Why it was rejected, when it was. Null otherwise. */
  admissionNote: z.string().nullable(),
  createdAt: instant,
});
export type VerticalVersion = z.infer<typeof verticalVersion>;

export const publishVersionInput = verticalVersion.pick({
  id: true,
  verticalSlug: true,
  version: true,
  manifestDigest: true,
  permissionDigest: true,
  migrationDigest: true,
  deploymentRef: true,
});
export type PublishVersionInput = z.infer<typeof publishVersionInput>;

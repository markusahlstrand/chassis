/**
 * How the admin log renders a `PlatformActorId`.
 *
 * The decision the design took, and it is the honest one: **show the ULID**. A
 * `PlatformActorId` resolves to no name, email, or avatar — there is no staff
 * registry anywhere in the platform, and the audit log stores the raw ULID
 * because that is genuinely all it knows. Rendering an invented display name
 * would make the log look like a human record when it is a machine trace.
 *
 * An alias is console-side annotation layered on top — NOT platform identity. It
 * cannot be trusted for anything the log is for; the ULID beside it is what the
 * kernel actually stamped. Keep them visually distinct for that reason.
 */

/** Console-owned aliases. Empty until someone decides where staff identity lives (§6). */
const ALIASES: Readonly<Record<string, string>> = {};

export function actorAlias(actor: string): string | undefined {
  return ALIASES[actor];
}

export function ActorCell({ actor }: { actor: string }) {
  const alias = actorAlias(actor);
  const short = `${actor.slice(0, 4)}…${actor.slice(-4)}`;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span
        title={actor}
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 12.5,
          color: alias ? 'var(--text-tertiary)' : 'var(--text-primary)',
        }}
      >
        {short}
      </span>
      {alias ? (
        <span style={{ fontSize: 12.5, color: 'var(--text-primary)' }}>{alias}</span>
      ) : (
        <span style={{ fontSize: 11, color: 'var(--text-placeholder)' }}>unlabelled</span>
      )}
    </span>
  );
}

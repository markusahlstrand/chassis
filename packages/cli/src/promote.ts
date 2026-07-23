/**
 * `substrat promote <slug> --channel dev|staging --version <id>` — a builder self-serves a
 * NON-prod channel (builder-plane.md §4; model B keeps prod a staff decision). The slug is
 * BARE — the control plane forms `<tenantSlug>/<slug>` from the caller's tenant (§5), so a
 * builder never types their own prefix. Only admitted versions promote; a changed digest is
 * refused without acknowledgement (the two checkpoints), surfaced as a 4xx here.
 */
export interface PromoteOptions {
  controlPlaneUrl: string;
  header: Record<string, string>;
  slug: string;
  channel: string;
  versionId: string;
}

export async function promote(opts: PromoteOptions): Promise<{ channel: string; versionId: string }> {
  const base = opts.controlPlaneUrl.replace(/\/$/, '');
  const url = `${base}/verticals/${encodeURIComponent(opts.slug)}/channels/${encodeURIComponent(opts.channel)}/promote`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...opts.header, 'content-type': 'application/json' },
    body: JSON.stringify({ versionId: opts.versionId }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`promote failed (${res.status}): ${body.slice(0, 300)}`);
  return JSON.parse(body) as { channel: string; versionId: string };
}

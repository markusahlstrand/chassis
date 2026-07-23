/**
 * `substrat versions <slug>` — list a vertical's versions and which channels point at
 * them. Read-only builder visibility: the first slice of letting a builder see the
 * verticals they pushed without the staff console. It calls the existing registry
 * endpoints (`/verticals/:slug/versions`, `/channels`); today those are staff-gated, so
 * this works for staff now and for builders once builder-scoped authz lands.
 */
interface Version {
  id: string;
  version: string;
  admission: string;
  deploymentRef?: string;
}
interface Channel {
  channel: string;
  versionId: string;
}

async function getJson<T>(url: string, header: Record<string, string>): Promise<T> {
  const res = await fetch(url, { headers: header });
  if (!res.ok) {
    throw new Error(`${res.status} ${(await res.text().catch(() => res.statusText)).slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

export async function printVersions(controlPlaneUrl: string, header: Record<string, string>, slug: string): Promise<void> {
  const base = controlPlaneUrl.replace(/\/$/, '');
  const versions = await getJson<Version[]>(`${base}/verticals/${encodeURIComponent(slug)}/versions`, header);
  // Channels are best-effort — a vertical with none registered still lists its versions.
  const channels = await getJson<Channel[]>(`${base}/verticals/${encodeURIComponent(slug)}/channels`, header).catch(
    () => [] as Channel[],
  );

  if (versions.length === 0) {
    console.log(`no versions for '${slug}' (or they aren't visible to you).`);
    return;
  }

  const byVersion = new Map<string, string[]>();
  for (const c of channels) {
    const list = byVersion.get(c.versionId) ?? [];
    list.push(c.channel);
    byVersion.set(c.versionId, list);
  }

  // Newest first (the id is a ULID — lexicographic order is chronological).
  const rows = [...versions]
    .sort((a, b) => (a.id < b.id ? 1 : -1))
    .map((v) => [v.version, v.admission, (byVersion.get(v.id) ?? []).join(',') || '—', v.id]);

  const headers = ['VERSION', 'ADMISSION', 'CHANNELS', 'ID'];
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const fmt = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ');
  console.log(fmt(headers));
  for (const r of rows) console.log(fmt(r));
}

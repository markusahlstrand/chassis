// Typed client over the Manyfold dev server. The dev persona rides in `x-principal`
// and the active site in `x-site` (both localStorage-backed); in production these become
// a real session + the routed node. Every op goes through /api/op/<name> — the kernel
// checks permissions inside each operation, so the generic transport is exactly as safe.

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const PRINCIPAL_KEY = 'manyfold.principal';
const SITE_KEY = 'manyfold.site';

export const getPrincipal = (): string => localStorage.getItem(PRINCIPAL_KEY) ?? '';
export const setPrincipal = (id: string): void => localStorage.setItem(PRINCIPAL_KEY, id);
export const getSite = (): string => localStorage.getItem(SITE_KEY) ?? 'cafe';
export const setSite = (slug: string): void => localStorage.setItem(SITE_KEY, slug);

function headers(): Record<string, string> {
  return { 'content-type': 'application/json', 'x-principal': getPrincipal(), 'x-site': getSite() };
}

export async function op<T>(name: string, input: unknown = {}): Promise<T> {
  const res = await fetch(`/api/op/${name}`, { method: 'POST', headers: headers(), body: JSON.stringify(input) });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError((body as { error?: string }).error ?? `${res.status}`, res.status);
  return body;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: headers() });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError((body as { error?: string }).error ?? `${res.status}`, res.status);
  return body;
}

// ── Types mirrored from the vertical (kept minimal, only what the app renders) ──

export type EntryStatus = 'draft' | 'in_review' | 'approved' | 'published' | 'unpublished' | 'archived';

export interface Persona { id: string; name: string; roles: Record<string, string> }
export interface Site { slug: string; name: string }
export interface Me { principal: string; name: string; site: string; role: string | null }
export interface EntryListItem { id: string; type_key: string; status: EntryStatus; slug: string | null; title: string; updated_at: string }
export interface FieldDef { type: string; required?: boolean; index?: boolean; options?: string[]; target?: string; source?: string; maxLen?: number }
export interface ContentTypeDef { key: string; version: number; title: string; titleField: string; slugField?: string; fields: Record<string, FieldDef> }
export interface RevisionMeta { rev_no: number; frozen: number; hash: string | null; author: string; created_at: string }
export interface EntryDetail { entry: { id: string; type_key: string; status: EntryStatus; slug: string | null; draft_rev: number; published_rev: number | null; created_at: string; updated_at: string }; body: Record<string, unknown>; revisions: RevisionMeta[] }
export interface DeliveryItem { type_key: string; slug: string | null; title: string; hash: string }

export const api = {
  personas: () => get<Persona[]>('/api/personas'),
  sites: () => get<Site[]>('/api/sites'),
  me: () => get<Me>('/api/me'),
  listTypes: () => op<{ def: ContentTypeDef; sql: string }[]>('list-types'),
  saveType: (def: { key: string; title: string; titleField: string; slugField?: string; fields: Record<string, FieldDef> }) => op<ContentTypeDef>('save-type', def),
  deleteType: (key: string) => op<{ deleted: string }>('delete-type', { key }),
  listEntries: (input: { typeKey?: string; status?: EntryStatus } = {}) => op<EntryListItem[]>('list-entries', input),
  reviewQueue: () => op<EntryListItem[]>('review-queue'),
  getEntry: (entryId: string) => op<EntryDetail>('get-entry', { entryId }),
  createEntry: (typeKey: string, body: Record<string, unknown>) => op<EntryDetail['entry']>('create-entry', { typeKey, body }),
  saveDraft: (entryId: string, body: Record<string, unknown>) => op<EntryDetail['entry']>('save-draft', { entryId, body }),
  restore: (entryId: string, revNo: number) => op<EntryDetail['entry']>('restore-revision', { entryId, revNo }),
  submit: (entryId: string) => op('submit-for-review', { entryId }),
  approve: (entryId: string) => op('approve', { entryId }),
  reject: (entryId: string, note: string) => op('reject', { entryId, note }),
  publish: (entryId: string) => op('publish', { entryId }),
  unpublish: (entryId: string) => op('unpublish', { entryId }),
  archive: (entryId: string) => op('archive', { entryId }),
  deliver: (typeKey: string, slug: string) => op<{ type: string; slug: string | null; hash: string; publishedAt: string; body: Record<string, unknown> }>('deliver', { typeKey, slug }),
  listDelivery: (input: { typeKey?: string } = {}) => op<DeliveryItem[]>('list-delivery', input),
};

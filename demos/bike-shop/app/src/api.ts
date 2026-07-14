export interface CastMember {
  name: string;
  role: string;
  principal: string;
}

export interface Repair {
  id: string;
  number: number;
  facility: { entityType: string; entityId: string }; // the BIKE, in this vertical
  customer: { entityType: string; entityId: string };
  kind: string;
  title: string;
  description: string | null;
  status: 'planned' | 'in_progress' | 'completed' | 'closed';
  assignedTo: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface Money {
  amount: string;
  currency: string;
}

export interface BillableLine {
  article: string;
  description: string;
  qty: string;
  unit: string;
  unitPrice: Money;
  lineTotal: Money;
}

export interface Bike {
  id: string;
  label: string;
  frame_no: string | null;
}

export interface Customer {
  id: string;
  number: string;
  name: string;
  phone: string | null;
  bikes: Bike[];
}

export interface Price {
  article: string;
  description: string;
  unit: string;
  price_amount: string;
  currency: string;
  min_qty: string | null;
  internal: number;
}

export interface Underlag {
  id: string;
  number: number;
  customer_id: string;
  status: 'open' | 'exported';
  created_at: string;
  total: string;
}

export interface UnderlagLine {
  id: string;
  source_type: string;
  source_id: string;
  article: string;
  description: string;
  qty: string;
  unit: string;
  unit_price_amount: string;
  currency: string;
  line_total_amount: string;
}

export interface TimelineEntry {
  type: string;
  occurred_at: string;
  actor: string;
}

export interface ProtocolItem {
  key: string;
  label: string;
  type: 'check' | 'value' | 'text';
  unit?: string;
}

export interface ProtocolInstance {
  id: string;
  template_key: string;
  template_version: number;
  entity_type: string;
  entity_id: string;
  status: 'open' | 'signed' | 'voided';
  created_by: string;
  created_at: string;
  voided_reason: string | null;
}

export interface ProtocolResponse {
  id: string;
  item_key: string;
  value_json: string;
  note: string | null;
  responded_by: string;
  responded_at: string;
}

export interface ProtocolSignature {
  id: string;
  signed_by: string;
  kind: 'primary' | 'counter';
  method: string;
  content_hash: string;
  signed_at: string;
}

export interface ProtocolSummary {
  instance: ProtocolInstance;
  title: string;
  answered: number;
  total: number;
  signedBy: string | null;
  signedAt: string | null;
  countersignedBy: string | null;
  countersignedAt: string | null;
}

export interface ProtocolDetail {
  instance: ProtocolInstance;
  template: {
    key: string;
    version: number;
    title: string;
    content: { sections: { title: string; items: ProtocolItem[] }[] };
  };
  responses: ProtocolResponse[];
  latest: Record<string, ProtocolResponse>;
  signature: ProtocolSignature | null;
  signatures: ProtocolSignature[];
}

export function currentPrincipal(): string | null {
  return localStorage.getItem('bike-shop-principal');
}

export function setPrincipal(principal: string | null): void {
  if (principal) localStorage.setItem('bike-shop-principal', principal);
  else localStorage.removeItem('bike-shop-principal');
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const principal = currentPrincipal();
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(principal ? { 'x-principal': principal } : {}),
      ...init?.headers,
    },
  });
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `${res.status}`);
  return body;
}

export const api = {
  cast: () => call<Record<string, CastMember>>('/cast'),
  customers: () => call<Customer[]>('/customers'),
  repairs: () => call<Repair[]>('/repairs'),
  repair: (id: string) =>
    call<{ order: Repair; time: { id: string; hours: string; note: string | null }[]; material: { id: string; article: string; qty: string }[] }>(
      `/repairs/${id}`,
    ),
  timeline: (id: string) => call<TimelineEntry[]>(`/repairs/${id}/timeline`),
  createRepair: (input: { bikeId: string; kind: string; title: string; description?: string }) =>
    call<Repair>('/repairs', { method: 'POST', body: JSON.stringify(input) }),
  assign: (id: string, technician: string) =>
    call<Repair>(`/repairs/${id}/assign`, { method: 'POST', body: JSON.stringify({ technician }) }),
  start: (id: string) => call<Repair>(`/repairs/${id}/start`, { method: 'POST', body: '{}' }),
  reportTime: (id: string, hours: string, note?: string) =>
    call(`/repairs/${id}/time`, { method: 'POST', body: JSON.stringify({ hours, note }) }),
  reportMaterial: (id: string, article: string, qty: string) =>
    call(`/repairs/${id}/material`, { method: 'POST', body: JSON.stringify({ article, qty }) }),
  complete: (id: string) =>
    call<{ order: Repair; billable: BillableLine[]; total: Money }>(
      `/repairs/${id}/complete`,
      { method: 'POST', body: '{}' },
    ),
  close: (id: string) => call<Repair>(`/repairs/${id}/close`, { method: 'POST', body: '{}' }),
  portalRepairs: () => call<Repair[]>('/portal/repairs'),
  invoicing: () => call<Underlag[]>('/invoicing'),
  underlag: (id: string) =>
    call<{ underlag: Underlag; lines: UnderlagLine[]; total: string }>(`/invoicing/${id}`),
  exportUnderlag: (id: string) => call<Underlag>(`/invoicing/${id}/export`, { method: 'POST', body: '{}' }),
  prices: () => call<Price[]>('/prices'),
  createCustomer: (input: { number: string; name: string; phone?: string }) =>
    call<Omit<Customer, 'bikes'>>('/customers', { method: 'POST', body: JSON.stringify(input) }),
  registerBike: (customerId: string, input: { label: string; frameNo?: string }) =>
    call<Bike>(`/customers/${customerId}/bikes`, { method: 'POST', body: JSON.stringify(input) }),
  upsertPrice: (input: {
    article: string;
    description: string;
    unit: string;
    priceAmount: string;
    minQty?: string;
    internal?: boolean;
  }) => call<Price>('/prices', { method: 'POST', body: JSON.stringify(input) }),
  repairProtocols: (repairId: string) => call<ProtocolSummary[]>(`/repairs/${repairId}/protocols`),
  startConditionReport: (repairId: string) =>
    call<ProtocolInstance>(`/repairs/${repairId}/condition-report`, { method: 'POST', body: '{}' }),
  protocol: (id: string) => call<ProtocolDetail>(`/protocols/${id}`),
  fillProtocol: (id: string, itemKey: string, value: boolean | string, note?: string) =>
    call<ProtocolResponse>(`/protocols/${id}/responses`, {
      method: 'POST',
      body: JSON.stringify({ itemKey, value, note }),
    }),
  signProtocol: (id: string) =>
    call<{ instance: ProtocolInstance; signature: ProtocolSignature }>(`/protocols/${id}/sign`, {
      method: 'POST',
      body: '{}',
    }),
  countersignProtocol: (id: string) =>
    call<{ instance: ProtocolInstance; signature: ProtocolSignature }>(
      `/protocols/${id}/countersign`,
      { method: 'POST', body: '{}' },
    ),
};

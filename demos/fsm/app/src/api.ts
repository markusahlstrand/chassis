export interface CastMember {
  name: string;
  role: string;
  principal: string;
}

export interface WorkOrder {
  id: string;
  number: number;
  facility: { entityType: string; entityId: string };
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

export interface Facility {
  id: string;
  name: string;
  address: string | null;
  access_note: string | null;
}

export interface Customer {
  id: string;
  number: string;
  name: string;
  org_ref: string | null;
  facilities: Facility[];
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

export function currentPrincipal(): string | null {
  return localStorage.getItem('fsm-principal');
}

export function setPrincipal(principal: string | null): void {
  if (principal) localStorage.setItem('fsm-principal', principal);
  else localStorage.removeItem('fsm-principal');
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
  workorders: () => call<WorkOrder[]>('/workorders'),
  workorder: (id: string) =>
    call<{ order: WorkOrder; time: { id: string; hours: string; note: string | null }[]; material: { id: string; article: string; qty: string }[] }>(
      `/workorders/${id}`,
    ),
  timeline: (id: string) => call<TimelineEntry[]>(`/workorders/${id}/timeline`),
  createOrder: (input: { facilityId: string; kind: string; title: string; description?: string }) =>
    call<WorkOrder>('/workorders', { method: 'POST', body: JSON.stringify(input) }),
  assign: (id: string, technician: string) =>
    call<WorkOrder>(`/workorders/${id}/assign`, { method: 'POST', body: JSON.stringify({ technician }) }),
  start: (id: string) => call<WorkOrder>(`/workorders/${id}/start`, { method: 'POST', body: '{}' }),
  reportTime: (id: string, hours: string, note?: string) =>
    call(`/workorders/${id}/time`, { method: 'POST', body: JSON.stringify({ hours, note }) }),
  reportMaterial: (id: string, article: string, qty: string) =>
    call(`/workorders/${id}/material`, { method: 'POST', body: JSON.stringify({ article, qty }) }),
  complete: (id: string) =>
    call<{ order: WorkOrder; billable: BillableLine[]; total: Money }>(
      `/workorders/${id}/complete`,
      { method: 'POST', body: '{}' },
    ),
  close: (id: string) => call<WorkOrder>(`/workorders/${id}/close`, { method: 'POST', body: '{}' }),
  portalOrders: () => call<WorkOrder[]>('/portal/orders'),
  invoicing: () => call<Underlag[]>('/invoicing'),
  underlag: (id: string) =>
    call<{ underlag: Underlag; lines: UnderlagLine[]; total: string }>(`/invoicing/${id}`),
  exportUnderlag: (id: string) => call<Underlag>(`/invoicing/${id}/export`, { method: 'POST', body: '{}' }),
  prices: () => call<Price[]>('/prices'),
  createCustomer: (input: { number: string; name: string; orgRef?: string }) =>
    call<Omit<Customer, 'facilities'>>('/customers', { method: 'POST', body: JSON.stringify(input) }),
  createFacility: (customerId: string, input: { name: string; address?: string; accessNote?: string }) =>
    call<Facility>(`/customers/${customerId}/facilities`, { method: 'POST', body: JSON.stringify(input) }),
  upsertPrice: (input: {
    article: string;
    description: string;
    unit: string;
    priceAmount: string;
    minQty?: string;
    internal?: boolean;
  }) => call<Price>('/prices', { method: 'POST', body: JSON.stringify(input) }),
};

export interface Money {
  amount: string;
  currency: string;
}

export interface CastMember {
  name: string;
  role: string;
  principal: string;
  customerId?: string;
}

export interface CatalogVariant {
  id: string;
  sku: string;
  grind: string;
  sizeLabel: string;
  price: Money;
  available: number;
}
export interface CatalogProduct {
  id: string;
  slug: string;
  name: string;
  origin: string;
  notes: string;
  roast: number;
  published: number;
  variants: CatalogVariant[];
}

export interface CartLine {
  lineId: string;
  variantId: string;
  sku: string;
  name: string;
  grind: string;
  sizeLabel: string;
  qty: number;
  unitPrice: Money;
  lineTotal: Money;
}
export interface Cart {
  id: string;
  lines: CartLine[];
  subtotal: Money;
}

export interface OrderRow {
  id: string;
  number: number;
  customer_id: string;
  owner: string;
  status: 'placed' | 'fulfilled' | 'closed' | 'cancelled';
  payment_method: string;
  discount_code: string | null;
  subtotal_amount: string;
  discount_amount: string;
  total_amount: string;
  currency: string;
  placed_at: string;
}
export interface OrderLineRow {
  id: string;
  sku: string;
  name: string;
  grind: string;
  size_label: string;
  qty: number;
  unit_price_amount: string;
  line_total_amount: string;
  currency: string;
}

export interface Underlag {
  id: string;
  number: number;
  customer_id: string;
  status: 'open' | 'exported';
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

const KEY = 'shop-principal';
export function currentPrincipal(): string | null {
  return localStorage.getItem(KEY);
}
export function setPrincipal(principal: string | null): void {
  if (principal) localStorage.setItem(KEY, principal);
  else localStorage.removeItem(KEY);
}

/** Thrown so views can distinguish a permission wall (403) from other failures. */
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const principal = currentPrincipal();
  const res = await fetch(`/api${path}`, {
    ...init,
    credentials: 'include', // carry the Better Auth session cookie
    headers: {
      'content-type': 'application/json',
      // Dev-picker header; the server prefers a real session over it.
      ...(principal ? { 'x-principal': principal } : {}),
      ...init?.headers,
    },
  });
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new ApiError(body.error ?? `${res.status}`, res.status);
  return body;
}

/** Better Auth REST endpoints (own error shape) — used by the login screen. */
async function authCall(path: string, payload?: unknown): Promise<void> {
  const res = await fetch(`/api/auth${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new ApiError(body.message ?? body.error ?? `${res.status}`, res.status);
  }
}

export interface Me {
  authenticated: boolean;
  principal?: string;
  display?: string;
  via?: string;
  customerId?: string | null;
}

export const api = {
  cast: () => call<{ cast: Record<string, CastMember>; world: unknown }>('/cast'),

  // auth (Better Auth via the neutral seam)
  me: () => call<Me>('/me'),
  signUp: (email: string, password: string, name: string) =>
    authCall('/sign-up/email', { email, password, name }),
  signIn: (email: string, password: string) => authCall('/sign-in/email', { email, password }),
  signOut: () => authCall('/sign-out'),

  // storefront
  catalog: () => call<CatalogProduct[]>('/catalog'),
  createCart: () => call<{ id: string }>('/carts', { method: 'POST', body: '{}' }),
  cart: (id: string) => call<Cart>(`/carts/${id}`),
  addToCart: (id: string, variantId: string, qty: number, holdSeconds?: number) =>
    call<{ lineId: string; reserved: number; availableAfter: number }>(`/carts/${id}/lines`, {
      method: 'POST',
      body: JSON.stringify({ variantId, qty, ...(holdSeconds !== undefined ? { holdSeconds } : {}) }),
    }),
  removeLine: (id: string, lineId: string) =>
    call<{ released: boolean }>(`/carts/${id}/lines/${lineId}`, { method: 'DELETE' }),
  checkout: (
    id: string,
    input: { customerId: string; paymentMethod?: 'invoice' | 'card'; discountCode?: string },
  ) => call<{ order: OrderRow; lines: OrderLineRow[] }>(`/carts/${id}/checkout`, {
    method: 'POST',
    body: JSON.stringify(input),
  }),

  // portal + admin
  portalOrders: () => call<OrderRow[]>('/portal/orders'),
  orders: () => call<OrderRow[]>('/orders'),
  order: (id: string) => call<{ order: OrderRow; lines: OrderLineRow[] }>(`/orders/${id}`),
  fulfil: (id: string) => call<OrderRow>(`/orders/${id}/fulfil`, { method: 'POST', body: '{}' }),
  close: (id: string) => call<OrderRow>(`/orders/${id}/close`, { method: 'POST', body: '{}' }),

  // reused invoicing engine
  invoicing: () => call<Underlag[]>('/invoicing'),
  underlag: (id: string) => call<{ underlag: Underlag; lines: UnderlagLine[]; total: string }>(`/invoicing/${id}`),
  exportUnderlag: (id: string) => call<Underlag>(`/invoicing/${id}/export`, { method: 'POST', body: '{}' }),
};

export const kr = (amount: string): string =>
  `${Number(amount).toLocaleString('sv-SE', { maximumFractionDigits: 2 })} kr`;

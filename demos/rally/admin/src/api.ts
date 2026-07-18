export interface CastMember {
  name: string;
  role: string;
  principal: string;
}
export interface Money {
  amount: string;
  currency: string;
}

export type ReservationState =
  | 'held'
  | 'confirmed'
  | 'in_service'
  | 'completed'
  | 'expired'
  | 'cancelled'
  | 'no_show';

export interface Reservation {
  id: string;
  resourceId: string;
  startsAt: string;
  endsAt: string;
  state: ReservationState;
  /** What the row means NOW — a lapsed hold reads `expired` even unswept. */
  effectiveState: ReservationState;
  quantity: number;
  expiresAt: string | null;
  fillTarget: number | null;
  note: string | null;
  createdBy: string;
  createdAt: string;
}

export interface Court {
  id: string;
  kind: string;
  name: string;
  capacity: number;
  active: boolean;
}

export interface Member {
  id: string;
  party_ref: string;
  name: string;
  phone: string | null;
  tier: string;
  level: string | null;
}

export interface Hours {
  weekday: number;
  opens_at: string | null;
  closes_at: string | null;
  closed: number;
}
export interface CourtConfig {
  resource_id: string;
  durations: string;
  indoor: number;
}
export interface Tier {
  key: string;
  title: string;
  discount_pct: number;
  monthly_amount: string;
}
export interface PriceRule {
  id: string;
  label: string;
  resource_id: string | null;
  weekday: number | null;
  from_time: string | null;
  to_time: string | null;
  duration: number | null;
  amount: string;
  currency: string;
}
export interface Closure {
  id: string;
  resource_id: string | null;
  on_date: string;
  opens_at: string | null;
  closes_at: string | null;
  reason: string;
}
export interface VenueSnapshot {
  venue: { id: string; name: string; timezone: string; hold_minutes: number };
  hours: Hours[];
  courtHours: (Hours & { resource_id: string })[];
  courts: CourtConfig[];
  tiers: Tier[];
  priceRules: PriceRule[];
  closures: Closure[];
}

export interface SlotFit {
  startsAt: string;
  maxFitMinutes: number;
  fits: number[];
}

/** A failed call that still carries the server's shape — 409 is "just taken". */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
  get isSlotTaken(): boolean {
    return this.code === 'SLOT_UNAVAILABLE';
  }
}

let principal = '';
export const setPrincipal = (p: string): void => {
  principal = p;
};

/** Which club's scope the console is looking at. One API, many scopes. */
let venue = 'solna';
export const setVenue = (v: string): void => {
  venue = v;
};

export interface Venue {
  key: string;
  label: string;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  // /api/cast is the only route that legitimately runs unauthenticated — it is
  // how the picker learns who it may be. Anything else firing without a
  // principal is a mount-ordering bug, and should say so rather than surface as
  // a mystery 403 from the server.
  if (!principal && path !== '/api/cast') {
    throw new ApiError(0, `no principal selected yet — ${path} fired before the picker was ready`);
  }
  const res = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(principal ? { 'x-principal': principal } : {}),
      'x-venue': venue,
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new ApiError(res.status, data?.error ?? res.statusText, data?.code);
  }
  return data as T;
}

const post = <T,>(path: string, body?: unknown): Promise<T> =>
  call<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

export const api = {
  cast: (): Promise<{
    cast: Record<string, CastMember>;
    venues: Venue[];
    members: Record<string, Record<string, string>>;
  }> => call('/api/cast'),
  venue: (): Promise<VenueSnapshot> => call('/api/venue'),
  courts: (): Promise<Court[]> => call('/api/courts'),
  members: (): Promise<Member[]> => call('/api/members'),
  reservations: (from: string, to: string): Promise<Reservation[]> =>
    call(`/api/reservations?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  availability: (resourceId: string, date: string): Promise<SlotFit[]> =>
    call(`/api/availability?resourceId=${resourceId}&date=${date}`),

  book: (input: {
    resourceId: string;
    memberId: string;
    date: string;
    time: string;
    duration: number;
  }): Promise<{ reservation: Reservation; price: Money; ruleLabel: string }> =>
    post('/api/bookings', input),
  confirm: (id: string): Promise<{ reservation: Reservation; price: Money }> =>
    post(`/api/bookings/${id}/confirm`),
  cancel: (id: string, reason?: string): Promise<Reservation> =>
    post(`/api/bookings/${id}/cancel`, { reason }),
  move: (id: string, patch: { resourceId?: string; startsAt?: string }): Promise<Reservation> =>
    post(`/api/bookings/${id}/move`, patch),
  noShow: (id: string): Promise<Reservation> => post(`/api/bookings/${id}/no-show`),
  maintenance: (input: {
    resourceId: string;
    date: string;
    time: string;
    duration: number;
    reason: string;
  }): Promise<Reservation> => post('/api/maintenance', input),

  setHours: (input: {
    weekday: number;
    opensAt?: string;
    closesAt?: string;
    closed?: boolean;
  }): Promise<Hours> => post('/api/hours', input),
  addClosure: (input: { onDate: string; reason: string; resourceId?: string }): Promise<Closure> =>
    post('/api/closures', input),
  addCourt: (input: { name: string; durations?: string }): Promise<Court> =>
    post('/api/courts', input),
  setCourtActive: (id: string, active: boolean): Promise<Court> =>
    post(`/api/courts/${id}/active`, { active }),
  addPriceRule: (input: {
    label: string;
    amount: string;
    fromTime?: string;
    toTime?: string;
    duration?: number;
  }): Promise<PriceRule> => post('/api/price-rules', input),
  addMember: (input: { partyRef: string; name: string; tier?: string }): Promise<Member> =>
    post('/api/members', input),
};

/** ULID-shaped id for a new member's global player ref (Crockford: no I L O U). */
export function newPartyRef(): string {
  const A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let s = '';
  for (let i = 0; i < 26; i += 1) s += A[Math.floor(Math.random() * A.length)];
  return s;
}

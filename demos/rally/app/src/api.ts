export interface CastMember {
  name: string;
  role: string;
  principal: string;
}
export interface Money {
  amount: string;
  currency: string;
}
export interface CourtListing {
  id: string;
  name: string;
  durations: string;
  indoor: boolean;
}
export interface SlotFit {
  startsAt: string;
  maxFitMinutes: number;
  fits: number[];
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
  effectiveState: ReservationState;
  expiresAt: string | null;
  fillTarget: number | null;
  note: string | null;
}
export interface VenueSnapshot {
  venue: { name: string; timezone: string; hold_minutes: number };
}

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
    },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText, data?.code);
  return data as T;
}
const post = <T,>(p: string, b?: unknown): Promise<T> =>
  call<T>(p, { method: 'POST', body: JSON.stringify(b ?? {}) });

export const api = {
  cast: (): Promise<{ cast: Record<string, CastMember>; members: Record<string, string> }> =>
    call('/api/cast'),
  venue: (): Promise<VenueSnapshot> => call('/api/venue'),
  courts: (): Promise<CourtListing[]> => call('/api/browse/courts'),
  availability: (resourceId: string, date: string): Promise<SlotFit[]> =>
    call(`/api/availability?resourceId=${resourceId}&date=${date}`),
  myBookings: (): Promise<Reservation[]> => call('/api/portal/bookings'),
  book: (i: {
    resourceId: string;
    memberId: string;
    date: string;
    time: string;
    duration: number;
  }): Promise<{ reservation: Reservation; price: Money; ruleLabel: string }> =>
    post('/api/bookings', i),
  confirm: (id: string): Promise<{ reservation: Reservation; price: Money }> =>
    post(`/api/bookings/${id}/confirm`),
  cancel: (id: string): Promise<Reservation> => post(`/api/bookings/${id}/cancel`, {}),
};

export function hhmm(instant: string, tz: string): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(instant));
}
export function dayLabel(instant: string, tz: string): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(instant));
}

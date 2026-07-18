import { z } from 'zod';
import {
  dataSubjectId,
  moduleManifest,
  moneyOf,
  permissionKey,
  type EntityRef,
  type Money,
} from '@substrat-run/contracts';
import {
  assertAllowed,
  ulid,
  type ModuleRegistration,
  type OperationContext,
  type OperationHandler,
} from '@substrat-run/kernel';
import {
  availability as engineAvailability,
  confirmReservation,
  holdReservation,
  joinReservation,
  listReservations,
  listResources,
  PERM as BK,
  type Reservation,
} from '@substrat-run/engine-booking';

// ============================================================================
// The RallyPoint vertical (spec/concept.md) — a padel/tennis club running on
// engine-booking. A court IS a resource, a booking IS a reservation, an open
// match IS a held reservation with a fill target.
//
// Everything here is vocabulary, opening hours, pricing and policy. The
// allocation invariant, the state machine and expiry stay in the engine —
// notably, this file contains NO locking and NO overlap arithmetic.
//
// The timezone split (engine-booking.md D-B): the engine takes absolute
// instants and never does calendar arithmetic. All local wall-clock reasoning
// — opening hours, the start grid, DST — lives here.
// ============================================================================

export const RALLY_PERM = {
  /**
   * Browse the club: courts, opening hours, and which slots are FREE.
   *
   * Deliberately distinct from `booking:read`. A player must see what is free in
   * order to book at all, but must never read the club's book — who holds which
   * court. `booking:read` for a player is narrowed to their own member record, so
   * a scope-level check on it would (correctly) deny them, and widening that
   * grant to the scope would hand every player the whole calendar. This key is
   * the capability that actually matches the need: free/busy, no identities.
   */
  browse: permissionKey.parse('rally:browse'),
  manageVenue: permissionKey.parse('rally:manage-venue'),
  managePricing: permissionKey.parse('rally:manage-pricing'),
  manageMembers: permissionKey.parse('rally:manage-members'),
};

export const rallyManifest = moduleManifest.parse({
  id: '@substrat-run/demo-rally',
  version: '0.0.1',
  kernelContract: '^0.0.1',
  permissions: [
    {
      key: 'rally:browse',
      description: 'See courts, opening hours and free slots — free/busy only, never who booked',
    },
    {
      key: 'rally:manage-venue',
      description: 'Set club and court opening hours, closures, and maintenance blocks',
    },
    { key: 'rally:manage-pricing', description: 'Manage price rules and membership tiers' },
    { key: 'rally:manage-members', description: 'Manage club members and their records' },
  ],
  events: { emits: [], consumes: [] },
  migrations: { journalDir: './migrations', compatibleFrom: '0.0.1' },
  attachmentTargets: [{ entityType: 'member', readPermission: 'rally:manage-members' }],
  // The portal walk is reservation → member: a player reaches their own booking
  // through an entity-narrowed grant on their member record. The engine already
  // declares reservation → resource for its own link; a reservation therefore
  // has two declared parents, and the proof walk follows the member edge.
  entityRelations: [{ entityType: 'reservation', parentType: 'member' }],
  entitlementKey: 'rallypoint',
});

export const rallyMigrations = [
  {
    version: '0001-init',
    sql: `
      CREATE TABLE rally_venue (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        timezone     TEXT NOT NULL,
        hold_minutes INTEGER NOT NULL DEFAULT 10
      );
      CREATE TABLE rally_members (
        id         TEXT PRIMARY KEY,
        party_ref  TEXT NOT NULL UNIQUE,
        name       TEXT NOT NULL,
        phone      TEXT,
        tier       TEXT NOT NULL DEFAULT 'drop-in',
        level      TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE rally_tiers (
        key             TEXT PRIMARY KEY,
        title           TEXT NOT NULL,
        discount_pct    INTEGER NOT NULL DEFAULT 0,
        monthly_amount  TEXT NOT NULL DEFAULT '0',
        currency        TEXT NOT NULL DEFAULT 'SEK'
      );
      CREATE TABLE rally_courts (
        resource_id TEXT PRIMARY KEY,
        durations   TEXT NOT NULL DEFAULT '60,90,120',
        indoor      INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE rally_venue_hours (
        weekday   INTEGER PRIMARY KEY,
        opens_at  TEXT,
        closes_at TEXT,
        closed    INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE rally_court_hours (
        resource_id TEXT NOT NULL,
        weekday     INTEGER NOT NULL,
        opens_at    TEXT,
        closes_at   TEXT,
        closed      INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (resource_id, weekday)
      );
      CREATE TABLE rally_closures (
        id          TEXT PRIMARY KEY,
        resource_id TEXT,
        on_date     TEXT NOT NULL,
        opens_at    TEXT,
        closes_at   TEXT,
        reason      TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );
      CREATE TABLE rally_price_rules (
        id          TEXT PRIMARY KEY,
        label       TEXT NOT NULL,
        resource_id TEXT,
        weekday     INTEGER,
        from_time   TEXT,
        to_time     TEXT,
        duration    INTEGER,
        amount      TEXT NOT NULL,
        currency    TEXT NOT NULL DEFAULT 'SEK',
        created_at  TEXT NOT NULL
      );
      CREATE TABLE rally_bookings (
        reservation_id TEXT PRIMARY KEY,
        member_id      TEXT NOT NULL REFERENCES rally_members(id),
        price_amount   TEXT NOT NULL,
        currency       TEXT NOT NULL,
        rule_label     TEXT NOT NULL,
        created_at     TEXT NOT NULL
      );
      CREATE TABLE rally_matches (
        reservation_id TEXT PRIMARY KEY,
        level_min      TEXT NOT NULL,
        level_max      TEXT NOT NULL
      );
    `,
  },
];

// ---------------------------------------------------------------------------
// Local time ↔ instants. The engine refuses to do this; the vertical must.
// ---------------------------------------------------------------------------

/** What wall clock does `ms` show in `timeZone`, expressed as a UTC-epoch value? */
function wallClockInZone(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const p: Record<string, string> = {};
  for (const part of parts) p[part.type] = part.value;
  return Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour) === 24 ? 0 : Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
}

/**
 * `2026-07-20` + `19:00` in `Europe/Stockholm` → an absolute instant.
 *
 * Two passes: the first estimates the offset, the second re-reads it at the
 * candidate instant so a DST boundary resolves correctly. Ambiguous local times
 * (the autumn repeat) settle on the earlier instant, which is the convention
 * spec/concept.md §4.1 committed to.
 */
export function zonedToInstant(date: string, time: string, timeZone: string): string {
  const naive = Date.parse(`${date}T${time.length === 5 ? `${time}:00` : time}Z`);
  if (Number.isNaN(naive)) throw new Error(`invalid local time: ${date} ${time}`);
  let candidate = naive - (wallClockInZone(naive, timeZone) - naive);
  candidate = naive - (wallClockInZone(candidate, timeZone) - candidate);
  return new Date(candidate).toISOString();
}

/** Weekday (0=Sun…6=Sat) of a local calendar date — read at local noon to dodge edges. */
function weekdayOf(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

const addMinutes = (instant: string, minutes: number): string =>
  new Date(Date.parse(instant) + minutes * 60_000).toISOString();

const minutesBetween = (a: string, b: string): number =>
  Math.round((Date.parse(b) - Date.parse(a)) / 60_000);

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export interface VenueRow {
  id: string;
  name: string;
  timezone: string;
  hold_minutes: number;
}
export interface MemberRow {
  id: string;
  party_ref: string;
  name: string;
  phone: string | null;
  tier: string;
  level: string | null;
  created_at: string;
}
export interface TierRow {
  key: string;
  title: string;
  discount_pct: number;
  monthly_amount: string;
  currency: string;
}
export interface HoursRow {
  weekday: number;
  opens_at: string | null;
  closes_at: string | null;
  closed: number;
}
export interface CourtHoursRow extends HoursRow {
  resource_id: string;
}
export interface ClosureRow {
  id: string;
  resource_id: string | null;
  on_date: string;
  opens_at: string | null;
  closes_at: string | null;
  reason: string;
  created_at: string;
}
export interface PriceRuleRow {
  id: string;
  label: string;
  resource_id: string | null;
  weekday: number | null;
  from_time: string | null;
  to_time: string | null;
  duration: number | null;
  amount: string;
  currency: string;
  created_at: string;
}
export interface CourtRow {
  resource_id: string;
  durations: string;
  indoor: number;
}

/** What the slot picker needs: per start, the longest duration that actually fits. */
export interface SlotFit {
  startsAt: string;
  maxFitMinutes: number;
  fits: number[];
}

const memberRef = (id: string): EntityRef => ({ entityType: 'member', entityId: id });
const reservationRef = (id: string): EntityRef => ({ entityType: 'reservation', entityId: id });

function venue(ctx: OperationContext): VenueRow {
  const row = ctx.sql.query<VenueRow>('SELECT * FROM rally_venue WHERE id = ?', ['venue'])[0];
  if (!row) throw new Error('venue not configured — run rally/set-venue first');
  return row;
}

// ---------------------------------------------------------------------------
// The bookable window: club hours ∩ court hours − closures
// ---------------------------------------------------------------------------

/**
 * The effective open window for one court on one local date, as instants.
 *
 * Court hours **narrow, never widen** (spec §4.1): the intersection is taken
 * deliberately rather than letting a court override the club, so the two tables
 * cannot disagree and hand a customer a bookable slot on a shut day.
 */
export function bookableWindow(
  ctx: OperationContext,
  resourceId: string,
  date: string,
): { startsAt: string; endsAt: string } | null {
  const v = venue(ctx);
  const weekday = weekdayOf(date);

  const club = ctx.sql.query<HoursRow>('SELECT * FROM rally_venue_hours WHERE weekday = ?', [
    weekday,
  ])[0];
  if (!club || club.closed === 1 || !club.opens_at || !club.closes_at) return null;

  let opens = club.opens_at;
  let closes = club.closes_at;

  const court = ctx.sql.query<CourtHoursRow>(
    'SELECT * FROM rally_court_hours WHERE resource_id = ? AND weekday = ?',
    [resourceId, weekday],
  )[0];
  if (court) {
    if (court.closed === 1) return null;
    if (court.opens_at && court.opens_at > opens) opens = court.opens_at;
    if (court.closes_at && court.closes_at < closes) closes = court.closes_at;
  }

  // Closures: a whole-day closure kills the window; a partial one trims it.
  const closures = ctx.sql.query<ClosureRow>(
    'SELECT * FROM rally_closures WHERE on_date = ? AND (resource_id IS NULL OR resource_id = ?)',
    [date, resourceId],
  );
  for (const c of closures) {
    if (!c.opens_at || !c.closes_at) return null;
    if (c.opens_at <= opens && c.closes_at >= closes) return null;
    if (c.opens_at <= opens && c.closes_at > opens) opens = c.closes_at;
    else if (c.closes_at >= closes && c.opens_at < closes) closes = c.opens_at;
  }

  if (opens >= closes) return null;
  return {
    startsAt: zonedToInstant(date, opens, v.timezone),
    // A club open past midnight stores closes_at < opens_at, meaning "next day"
    // (spec §4.1). Rolling it forward here is what stops prime time vanishing.
    endsAt:
      closes > opens
        ? zonedToInstant(date, closes, v.timezone)
        : addMinutes(zonedToInstant(date, closes, v.timezone), 24 * 60),
  };
}

// ---------------------------------------------------------------------------
// Pricing — the vertical's moment
// ---------------------------------------------------------------------------

/**
 * Resolve the price for a slot: most specific rule wins
 * (court > duration > time-of-day > weekday > base), then the member's tier
 * discount. Duration is an input, not a multiplier — a 90-minute peak slot is
 * not necessarily 1.5× the 60-minute price (spec §4).
 */
export function resolvePrice(
  ctx: OperationContext,
  input: { resourceId: string; date: string; time: string; duration: number; tier?: string },
): { price: Money; label: string } {
  const weekday = weekdayOf(input.date);
  const rules = ctx.sql.query<PriceRuleRow>('SELECT * FROM rally_price_rules');

  const applicable = rules.filter((r) => {
    if (r.resource_id && r.resource_id !== input.resourceId) return false;
    if (r.weekday !== null && r.weekday !== weekday) return false;
    if (r.duration !== null && r.duration !== input.duration) return false;
    if (r.from_time && input.time < r.from_time) return false;
    if (r.to_time && input.time >= r.to_time) return false;
    return true;
  });
  if (applicable.length === 0) throw new Error(`no price rule matches ${input.date} ${input.time}`);

  const specificity = (r: PriceRuleRow): number =>
    (r.resource_id ? 8 : 0) + (r.duration !== null ? 4 : 0) + (r.from_time ? 2 : 0) + (r.weekday !== null ? 1 : 0);
  const winner = applicable.reduce((best, r) => (specificity(r) > specificity(best) ? r : best));

  let amount = Number(winner.amount);
  let label = winner.label;
  if (input.tier) {
    const tier = ctx.sql.query<TierRow>('SELECT * FROM rally_tiers WHERE key = ?', [input.tier])[0];
    if (tier && tier.discount_pct > 0) {
      amount = Math.round(amount * (1 - tier.discount_pct / 100));
      label = `${winner.label} − ${tier.title} ${tier.discount_pct}%`;
    }
  }
  return { price: moneyOf(String(amount), winner.currency), label };
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

const setVenueOp: OperationHandler<
  { name: string; timezone: string; holdMinutes?: number },
  VenueRow
> = async (ctx, input) => {
  assertAllowed(await ctx.check(RALLY_PERM.manageVenue));
  ctx.sql.exec(
    `INSERT OR REPLACE INTO rally_venue (id, name, timezone, hold_minutes) VALUES ('venue', ?, ?, ?)`,
    [input.name, input.timezone, input.holdMinutes ?? 10],
  );
  return venue(ctx);
};

const setHoursOp: OperationHandler<
  { weekday: number; opensAt?: string; closesAt?: string; closed?: boolean },
  HoursRow
> = async (ctx, input) => {
  assertAllowed(await ctx.check(RALLY_PERM.manageVenue));
  ctx.sql.exec(
    `INSERT OR REPLACE INTO rally_venue_hours (weekday, opens_at, closes_at, closed)
     VALUES (?, ?, ?, ?)`,
    [input.weekday, input.opensAt ?? null, input.closesAt ?? null, input.closed ? 1 : 0],
  );
  return ctx.sql.query<HoursRow>('SELECT * FROM rally_venue_hours WHERE weekday = ?', [
    input.weekday,
  ])[0]!;
};

const setCourtHoursOp: OperationHandler<
  { resourceId: string; weekday: number; opensAt?: string; closesAt?: string; closed?: boolean },
  CourtHoursRow
> = async (ctx, input) => {
  assertAllowed(await ctx.check(RALLY_PERM.manageVenue));
  ctx.sql.exec(
    `INSERT OR REPLACE INTO rally_court_hours (resource_id, weekday, opens_at, closes_at, closed)
     VALUES (?, ?, ?, ?, ?)`,
    [
      input.resourceId,
      input.weekday,
      input.opensAt ?? null,
      input.closesAt ?? null,
      input.closed ? 1 : 0,
    ],
  );
  return ctx.sql.query<CourtHoursRow>(
    'SELECT * FROM rally_court_hours WHERE resource_id = ? AND weekday = ?',
    [input.resourceId, input.weekday],
  )[0]!;
};

const registerCourtOp: OperationHandler<
  { resourceId: string; durations?: string; indoor?: boolean },
  CourtRow
> = async (ctx, input) => {
  assertAllowed(await ctx.check(RALLY_PERM.manageVenue));
  ctx.sql.exec(
    `INSERT OR REPLACE INTO rally_courts (resource_id, durations, indoor) VALUES (?, ?, ?)`,
    [input.resourceId, input.durations ?? '60,90,120', input.indoor === false ? 0 : 1],
  );
  return ctx.sql.query<CourtRow>('SELECT * FROM rally_courts WHERE resource_id = ?', [
    input.resourceId,
  ])[0]!;
};

const addClosureOp: OperationHandler<
  { resourceId?: string; onDate: string; opensAt?: string; closesAt?: string; reason: string },
  ClosureRow
> = async (ctx, input) => {
  assertAllowed(await ctx.check(RALLY_PERM.manageVenue));
  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO rally_closures (id, resource_id, on_date, opens_at, closes_at, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.resourceId ?? null,
      input.onDate,
      input.opensAt ?? null,
      input.closesAt ?? null,
      input.reason,
      new Date().toISOString(),
    ],
  );
  return ctx.sql.query<ClosureRow>('SELECT * FROM rally_closures WHERE id = ?', [id])[0]!;
};

const upsertPriceRuleOp: OperationHandler<
  {
    id?: string;
    label: string;
    resourceId?: string;
    weekday?: number;
    fromTime?: string;
    toTime?: string;
    duration?: number;
    amount: string;
    currency?: string;
  },
  PriceRuleRow
> = async (ctx, input) => {
  assertAllowed(await ctx.check(RALLY_PERM.managePricing));
  const id = input.id ?? ulid();
  ctx.sql.exec(
    `INSERT OR REPLACE INTO rally_price_rules
       (id, label, resource_id, weekday, from_time, to_time, duration, amount, currency, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.label,
      input.resourceId ?? null,
      input.weekday ?? null,
      input.fromTime ?? null,
      input.toTime ?? null,
      input.duration ?? null,
      input.amount,
      input.currency ?? 'SEK',
      new Date().toISOString(),
    ],
  );
  return ctx.sql.query<PriceRuleRow>('SELECT * FROM rally_price_rules WHERE id = ?', [id])[0]!;
};

const upsertTierOp: OperationHandler<
  { key: string; title: string; discountPct?: number; monthlyAmount?: string },
  TierRow
> = async (ctx, input) => {
  assertAllowed(await ctx.check(RALLY_PERM.managePricing));
  ctx.sql.exec(
    `INSERT OR REPLACE INTO rally_tiers (key, title, discount_pct, monthly_amount, currency)
     VALUES (?, ?, ?, ?, 'SEK')`,
    [input.key, input.title, input.discountPct ?? 0, input.monthlyAmount ?? '0'],
  );
  return ctx.sql.query<TierRow>('SELECT * FROM rally_tiers WHERE key = ?', [input.key])[0]!;
};

const createMemberOp: OperationHandler<
  { partyRef: string; name: string; phone?: string; tier?: string; level?: string },
  MemberRow
> = async (ctx, input) => {
  assertAllowed(await ctx.check(RALLY_PERM.manageMembers));
  const id = ulid();
  // Parse at the boundary: a member's party_ref is the global player identity and
  // must be a real data-subject id, or crypto-shredding has nothing to key on.
  const partyRef = dataSubjectId.parse(input.partyRef);
  ctx.sql.exec(
    `INSERT INTO rally_members (id, party_ref, name, phone, tier, level, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      partyRef,
      input.name,
      input.phone ?? null,
      input.tier ?? 'drop-in',
      input.level ?? null,
      new Date().toISOString(),
    ],
  );
  return ctx.sql.query<MemberRow>('SELECT * FROM rally_members WHERE id = ?', [id])[0]!;
};

const listMembersOp: OperationHandler<undefined, MemberRow[]> = async (ctx) => {
  assertAllowed(await ctx.check(RALLY_PERM.manageMembers));
  return ctx.sql.query<MemberRow>('SELECT * FROM rally_members ORDER BY name');
};

export interface CourtListing {
  id: string;
  name: string;
  durations: string;
  indoor: boolean;
}

/**
 * Courts as a player may see them. The engine's own `booking/list-resources`
 * binding requires `booking:read`, which a player deliberately does not hold at
 * scope level — so this reaches the engine through its exported in-scope
 * function and joins the vertical's own side table in memory — never a SELECT
 * against the engine's own tables, which are private to it (decision 28).
 */
const browseCourtsOp: OperationHandler<undefined, CourtListing[]> = async (ctx) => {
  assertAllowed(await ctx.check(RALLY_PERM.browse));
  const config = new Map(
    ctx.sql
      .query<CourtRow>('SELECT * FROM rally_courts')
      .map((c) => [c.resource_id, c] as const),
  );
  return listResources(ctx, 'court')
    .filter((r) => r.active)
    .map((r) => ({
      id: r.id,
      name: r.name,
      durations: config.get(r.id)?.durations ?? '60,90,120',
      indoor: config.get(r.id)?.indoor !== 0,
    }));
};

export interface VenueSnapshot {
  venue: VenueRow;
  hours: HoursRow[];
  courtHours: CourtHoursRow[];
  courts: CourtRow[];
  tiers: TierRow[];
  priceRules: PriceRuleRow[];
  closures: ClosureRow[];
}

/**
 * Everything both surfaces need to render a calendar: the club's shape.
 * Guarded by `booking:read` rather than `rally:manage-venue` — the player app
 * must know when the club opens without being able to change it.
 */
const getVenueOp: OperationHandler<undefined, VenueSnapshot> = async (ctx) => {
  assertAllowed(await ctx.check(RALLY_PERM.browse));
  return {
    venue: venue(ctx),
    hours: ctx.sql.query<HoursRow>('SELECT * FROM rally_venue_hours ORDER BY weekday'),
    courtHours: ctx.sql.query<CourtHoursRow>('SELECT * FROM rally_court_hours'),
    courts: ctx.sql.query<CourtRow>('SELECT * FROM rally_courts'),
    tiers: ctx.sql.query<TierRow>('SELECT * FROM rally_tiers ORDER BY discount_pct'),
    priceRules: ctx.sql.query<PriceRuleRow>('SELECT * FROM rally_price_rules ORDER BY created_at'),
    closures: ctx.sql.query<ClosureRow>('SELECT * FROM rally_closures ORDER BY on_date'),
  };
};

/**
 * THE SLOT PICKER FEED. For every start on the club's 30-minute grid, the
 * longest duration that actually fits — the "fit dots" the design handover
 * hangs its core interaction on.
 *
 * Availability is the engine's (free intervals between reservations); the
 * opening-hours intersection is the vertical's. The engine would happily report
 * 03:00 as free.
 */
const availabilityOp: OperationHandler<
  { resourceId: string; date: string; now?: string },
  SlotFit[]
> = async (ctx, input) => {
  assertAllowed(await ctx.check(RALLY_PERM.browse));
  const window = bookableWindow(ctx, input.resourceId, input.date);
  if (!window) return [];

  const court = ctx.sql.query<CourtRow>('SELECT * FROM rally_courts WHERE resource_id = ?', [
    input.resourceId,
  ])[0];
  const durations = (court?.durations ?? '60,90,120')
    .split(',')
    .map((d) => Number(d.trim()))
    .filter((d) => d > 0)
    .sort((a, b) => a - b);

  const free = engineAvailability(ctx, {
    resourceId: input.resourceId,
    from: window.startsAt,
    to: window.endsAt,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });

  const out: SlotFit[] = [];
  const gridStep = 30;
  const total = minutesBetween(window.startsAt, window.endsAt);
  for (let offset = 0; offset < total; offset += gridStep) {
    const startsAt = addMinutes(window.startsAt, offset);
    const fits = durations.filter((d) => {
      const endsAt = addMinutes(startsAt, d);
      if (endsAt > window.endsAt) return false;
      // The whole [start, end) must sit inside ONE free interval.
      return free.some((f) => f.startsAt <= startsAt && f.endsAt >= endsAt);
    });
    if (fits.length > 0) {
      out.push({ startsAt, maxFitMinutes: fits[fits.length - 1]!, fits });
    }
  }
  return out;
};

const bookInput = z.object({
  resourceId: z.string().min(1),
  memberId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  duration: z.number().int().positive(),
  now: z.string().optional(),
});

/**
 * THE PRICING MOMENT. Validate the slot against the club's own rules (open
 * window, allowed duration), resolve the price from the rule table + the
 * member's tier, then hand the engine an absolute interval and let it arbitrate.
 *
 * If the court is taken, the engine throws `SlotUnavailable` — this vertical
 * never checks for a clash itself, because it cannot do so correctly and the
 * engine already does.
 */
const bookCourtOp: OperationHandler<
  z.infer<typeof bookInput>,
  { reservation: Reservation; price: Money; ruleLabel: string }
> = async (ctx, rawInput) => {
  assertAllowed(await ctx.check(BK.hold));
  const input = bookInput.parse(rawInput);
  const v = venue(ctx);

  const member = ctx.sql.query<MemberRow>('SELECT * FROM rally_members WHERE id = ?', [
    input.memberId,
  ])[0];
  if (!member) throw new Error(`member not found: ${input.memberId}`);

  const window = bookableWindow(ctx, input.resourceId, input.date);
  if (!window) throw new Error(`the club is closed on ${input.date}`);

  const startsAt = zonedToInstant(input.date, input.time, v.timezone);
  const endsAt = addMinutes(startsAt, input.duration);
  if (startsAt < window.startsAt || endsAt > window.endsAt) {
    throw new Error(`${input.time} +${input.duration}min falls outside opening hours`);
  }

  const court = ctx.sql.query<CourtRow>('SELECT * FROM rally_courts WHERE resource_id = ?', [
    input.resourceId,
  ])[0];
  const allowed = (court?.durations ?? '60,90,120').split(',').map((d) => Number(d.trim()));
  if (!allowed.includes(input.duration)) {
    throw new Error(`${input.duration} min is not bookable on this court`);
  }

  const { price, label } = resolvePrice(ctx, {
    resourceId: input.resourceId,
    date: input.date,
    time: input.time,
    duration: input.duration,
    tier: member.tier,
  });

  const now = input.now ?? new Date().toISOString();
  const reservation = holdReservation(ctx, {
    resourceId: input.resourceId,
    startsAt,
    endsAt,
    expiresAt: addMinutes(now, v.hold_minutes),
    now,
  });

  // The vertical's own side table, keyed by the engine's id — never a column
  // added upstream (CLAUDE.md, decision 28).
  ctx.sql.exec(
    `INSERT INTO rally_bookings (reservation_id, member_id, price_amount, currency, rule_label, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [reservation.id, member.id, price.amount, price.currency, label, now],
  );
  ctx.link(reservationRef(reservation.id), memberRef(member.id));

  return { reservation, price, ruleLabel: label };
};

const confirmBookingOp: OperationHandler<
  { reservationId: string; now?: string },
  { reservation: Reservation; price: Money }
> = async (ctx, input) => {
  assertAllowed(await ctx.check(BK.confirm, reservationRef(input.reservationId)));
  const booking = ctx.sql.query<{ price_amount: string; currency: string }>(
    'SELECT price_amount, currency FROM rally_bookings WHERE reservation_id = ?',
    [input.reservationId],
  )[0];
  if (!booking) throw new Error(`no RallyPoint booking for ${input.reservationId}`);
  const reservation = confirmReservation(ctx, {
    reservationId: input.reservationId,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  return { reservation, price: moneyOf(booking.price_amount, booking.currency) };
};

const openMatchInput = bookInput.extend({
  fillTarget: z.number().int().min(2).max(4).default(4),
  levelMin: z.string(),
  levelMax: z.string(),
});

/**
 * An open match is the SAME held reservation, with a fill target — the engine
 * mechanism that also powers the payment hold. The level band is vertical
 * policy the engine never learns.
 */
const createOpenMatchOp: OperationHandler<
  z.infer<typeof openMatchInput>,
  { reservation: Reservation; price: Money; sharePerPlayer: Money }
> = async (ctx, rawInput) => {
  assertAllowed(await ctx.check(BK.hold));
  const input = openMatchInput.parse(rawInput);
  const v = venue(ctx);
  const member = ctx.sql.query<MemberRow>('SELECT * FROM rally_members WHERE id = ?', [
    input.memberId,
  ])[0];
  if (!member) throw new Error(`member not found: ${input.memberId}`);

  const window = bookableWindow(ctx, input.resourceId, input.date);
  if (!window) throw new Error(`the club is closed on ${input.date}`);
  const startsAt = zonedToInstant(input.date, input.time, v.timezone);
  const endsAt = addMinutes(startsAt, input.duration);
  if (startsAt < window.startsAt || endsAt > window.endsAt) {
    throw new Error(`${input.time} +${input.duration}min falls outside opening hours`);
  }

  const { price, label } = resolvePrice(ctx, {
    resourceId: input.resourceId,
    date: input.date,
    time: input.time,
    duration: input.duration,
    tier: member.tier,
  });

  const now = input.now ?? new Date().toISOString();
  const reservation = holdReservation(ctx, {
    resourceId: input.resourceId,
    startsAt,
    endsAt,
    // An open match holds until it fills or the deadline passes — same field.
    expiresAt: startsAt,
    fillTarget: input.fillTarget,
    now,
  });

  ctx.sql.exec(
    `INSERT INTO rally_bookings (reservation_id, member_id, price_amount, currency, rule_label, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [reservation.id, member.id, price.amount, price.currency, label, now],
  );
  ctx.sql.exec(
    `INSERT INTO rally_matches (reservation_id, level_min, level_max) VALUES (?, ?, ?)`,
    [reservation.id, input.levelMin, input.levelMax],
  );
  ctx.link(reservationRef(reservation.id), memberRef(member.id));

  const share = Math.round(Number(price.amount) / input.fillTarget);
  return {
    reservation,
    price,
    sharePerPlayer: moneyOf(String(share), price.currency),
  };
};

/**
 * Joining enforces the LEVEL BAND — pure vertical policy. A player outside the
 * band is refused here; the design's request-and-approve flow (all current
 * players must accept) is the next increment and lives in this layer too, never
 * in the engine.
 */
const joinMatchOp: OperationHandler<
  { reservationId: string; memberId: string; now?: string },
  { reservation: Reservation; share: Money }
> = async (ctx, input) => {
  assertAllowed(await ctx.check(BK.create));
  const member = ctx.sql.query<MemberRow>('SELECT * FROM rally_members WHERE id = ?', [
    input.memberId,
  ])[0];
  if (!member) throw new Error(`member not found: ${input.memberId}`);

  const match = ctx.sql.query<{ level_min: string; level_max: string }>(
    'SELECT * FROM rally_matches WHERE reservation_id = ?',
    [input.reservationId],
  )[0];
  if (!match) throw new Error(`not an open match: ${input.reservationId}`);
  if (!member.level) throw new Error(`${member.name} has no rated level`);
  if (Number(member.level) < Number(match.level_min) || Number(member.level) > Number(match.level_max)) {
    throw new Error(
      `level ${member.level} is outside the band ${match.level_min}–${match.level_max}`,
    );
  }

  const booking = ctx.sql.query<{ price_amount: string; currency: string }>(
    'SELECT price_amount, currency FROM rally_bookings WHERE reservation_id = ?',
    [input.reservationId],
  )[0]!;
  const reservationRow = listReservations(ctx, {}).find((r) => r.id === input.reservationId)!;
  const share = moneyOf(
    String(Math.round(Number(booking.price_amount) / (reservationRow.fillTarget ?? 1))),
    booking.currency,
  );

  const result = joinReservation(ctx, {
    reservationId: input.reservationId,
    partyRef: dataSubjectId.parse(member.party_ref),
    share,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  return { reservation: result.reservation, share };
};

/**
 * Blocking a court for maintenance is an ORDINARY reservation with no
 * participants (spec §4.1) — it rides the same overlap invariant, shows on the
 * calendar, and needs no second mechanism that could disagree with the first.
 */
const blockMaintenanceOp: OperationHandler<
  { resourceId: string; date: string; time: string; duration: number; reason: string; now?: string },
  Reservation
> = async (ctx, input) => {
  assertAllowed(await ctx.check(RALLY_PERM.manageVenue));
  const v = venue(ctx);
  const startsAt = zonedToInstant(input.date, input.time, v.timezone);
  const now = input.now ?? new Date().toISOString();
  const held = holdReservation(ctx, {
    resourceId: input.resourceId,
    startsAt,
    endsAt: addMinutes(startsAt, input.duration),
    expiresAt: addMinutes(now, 1),
    note: `maintenance: ${input.reason}`,
    now,
  });
  return confirmReservation(ctx, { reservationId: held.id, now });
};

/** Portal listing: a proof walk per reservation, never a WHERE clause on the caller. */
const portalBookingsOp: OperationHandler<{ now?: string } | undefined, Reservation[]> = async (
  ctx,
  input,
) => {
  const all = listReservations(ctx, input?.now !== undefined ? { now: input.now } : {});
  const visible: Reservation[] = [];
  for (const r of all) {
    const decision = await ctx.check(BK.read, reservationRef(r.id));
    if (decision.allowed) visible.push(r);
  }
  return visible;
};

const timelineOp: OperationHandler<
  { entityType: string; entityId: string },
  { type: string; occurred_at: string; actor: string }[]
> = async (ctx, input) => {
  const entity: EntityRef = z
    .object({ entityType: z.string().min(1), entityId: z.string().min(1) })
    .parse(input);
  assertAllowed(await ctx.check(BK.read, entity));
  return ctx.sql.query(
    `SELECT type, occurred_at, actor FROM _substrat_outbox
     WHERE entity_type = ? AND entity_id = ? ORDER BY rowid`,
    [entity.entityType, entity.entityId],
  );
};

export const rallyModule: ModuleRegistration = {
  manifest: rallyManifest,
  migrations: rallyMigrations,
  operations: {
    'rally/set-venue': setVenueOp as never,
    'rally/set-hours': setHoursOp as never,
    'rally/set-court-hours': setCourtHoursOp as never,
    'rally/register-court': registerCourtOp as never,
    'rally/add-closure': addClosureOp as never,
    'rally/upsert-price-rule': upsertPriceRuleOp as never,
    'rally/upsert-tier': upsertTierOp as never,
    'rally/create-member': createMemberOp as never,
    'rally/list-members': listMembersOp as never,
    'rally/get-venue': getVenueOp as never,
    'rally/courts': browseCourtsOp as never,
    'rally/availability': availabilityOp as never,
    'rally/book-court': bookCourtOp as never,
    'rally/confirm-booking': confirmBookingOp as never,
    'rally/create-open-match': createOpenMatchOp as never,
    'rally/join-match': joinMatchOp as never,
    'rally/block-maintenance': blockMaintenanceOp as never,
    'rally/portal-bookings': portalBookingsOp as never,
    'rally/timeline': timelineOp as never,
  },
};

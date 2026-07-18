# Operations, functions & permissions

## Operations

Registered bindings, each one a permission check plus a call into the in-scope function
below.

| Operation | Permission | Does |
|---|---|---|
| `booking/create-resource` | `booking:manage-resources` | add a bookable resource |
| `booking/set-resource-active` | `booking:manage-resources` | take one out of service |
| `booking/list-resources` | `booking:read` | list resources |
| `booking/hold` | `booking:hold` | tentative hold; throws `SlotUnavailable` |
| `booking/confirm` | `booking:confirm` *(per reservation)* | held → confirmed, re-checking capacity |
| `booking/expire` | `booking:confirm` | surface a lapsed hold as `expired` |
| `booking/join` | `booking:create` *(per reservation)* | add a participant; auto-confirms at `fillTarget` |
| `booking/leave` | `booking:cancel` *(per reservation)* | soft-leave |
| `booking/cancel` | `booking:cancel` *(per reservation)* | held/confirmed → cancelled |
| `booking/move` | `booking:move` *(per reservation)* | reschedule; throws `SlotUnavailable` |
| `booking/start` · `complete` · `no-show` | `booking:complete` | service transitions |
| `booking/get` · `list` · `availability` | `booking:read` | reads |

Checks marked *(per reservation)* pass an `EntityRef`, so a consumer holding an
entity-narrowed grant reaches their own booking and no one else's.

## In-scope functions

The composable surface. A vertical calls these **inside its own operation and its own
permission check**, in one transaction — this is how you extend the engine without forking
it.

```ts
createResource(ctx, { kind, name, capacity? })            → Resource
holdReservation(ctx, { resourceId, startsAt, endsAt,
                       expiresAt, quantity?, fillTarget? }) → Reservation  // throws SlotUnavailable
confirmReservation(ctx, { reservationId })                → Reservation
expireReservation(ctx, { reservationId })                 → Reservation
joinReservation(ctx, { reservationId, partyRef, share? }) → { participant, reservation }
leaveReservation(ctx, { reservationId, participantId })   → Reservation
moveReservation(ctx, { reservationId, resourceId?,
                       startsAt?, endsAt? })              → Reservation  // throws SlotUnavailable
cancelReservation · startReservation · completeReservation · markNoShow
getReservation(ctx, id)      → { reservation, participants }
listReservations(ctx, { resourceId?, from?, to? }) → Reservation[]
availability(ctx, { resourceId, from, to })        → FreeInterval[]
effectiveStateOf(state, expiresAt, now)            → ReservationState
```

### `move`, not `update`

`moveReservation` changes resource and/or interval, re-runs the allocation check **excluding
itself** (so nudging a booking that overlaps its own old slot is legal), and keeps the
reservation's identity, roster and payments. Passing `startsAt` alone *shifts* it, preserving
duration — what dragging a calendar cell means.

It is explicitly not cancel-then-rebook, which would lose all three. And there is no generic
`updateReservation`: engines model named transitions, participants are an append-only log
rather than a patchable field, and `booking.moved` carrying from/to is worth more to a
consumer than a permanent diff blob.

### `availability` returns intervals, not slots

`FreeInterval[]` — `{ startsAt, endsAt, available }`, merged, with `available` a **number**
because capacity may exceed 1. It reports raw gaps between reservations and knows nothing of
opening hours: left alone it will happily call 03:00 free. Intersecting with the venue's
bookable window is the vertical's job.

This shape is deliberate. With mixed durations there is no canonical slot list — "does 90
fit at 19:00? does 120?" is a question about gaps, and a fixed slot list cannot answer it.

## Permissions

| Key | Grants |
|---|---|
| `booking:create` | add participants to a reservation |
| `booking:read` | resources, reservations, availability |
| `booking:hold` | place a tentative hold |
| `booking:confirm` | confirm a held reservation |
| `booking:cancel` | cancel a reservation, or leave one |
| `booking:move` | reschedule to another slot or resource |
| `booking:complete` | start service, complete, or mark a no-show |
| `booking:manage-resources` | create, edit and deactivate resources |

`booking:move` is separate from `booking:cancel` on purpose: staff who may reschedule a
customer are not necessarily staff who may cancel and refund one.

## Entitlement

`entitlementKey: 'booking'`. Default-deny — grant it to a tenant before its operations
resolve.

# Meridian — Employee view design brief

Status: draft v0.1 · Last updated: 2026-07-18 · Hand-off doc for design.

The employee's self-service surface — everything a person does for themselves: check their
vacation balance, request time off, log hours, submit an expense, and finish onboarding.
Managers and HR use the desktop dashboard ([dashboard.md](./dashboard.md)); **this surface is
where the other 95% of people live, and they live on a phone.**

## Non-negotiable: mobile-first, not mobile-tolerant

Design the **phone** first and let it scale up — not a desktop screen that reflows. Every
decision below assumes a person standing in a hallway with one thumb free:

- **One column. Thumb-reachable primary actions** — the main CTA sits in the bottom third,
  not the top. Tap targets ≥ 44px.
- **Bottom tab bar** as the primary nav: **Home · Time off · Timesheet · Expenses · Me**.
- **Minimal typing.** Pickers, sensible defaults (today's date, most-recent projects first),
  steppers for hours, a calendar for date ranges. Typing is a last resort.
- **Camera-first capture.** Submitting an expense *starts* with the camera; receipts are
  photos, not file uploads.
- **Capture is offline-tolerant.** Time entries, expense photos, and requests are
  append-only, event-shaped writes (per master plan §6 mobile capture) — queue them offline
  and replay on reconnect. Show a quiet "queued — will sync" state; never block on network.
- **Native-feeling touch**: bottom sheets for actions, pull-to-refresh, swipe where it earns
  its keep. Installable-PWA feel (add to home screen), not a website in a frame.
- On tablet/desktop the same components relax into two columns — but the phone is the design
  target, and if a trade-off is forced, the phone wins.

## Home ("Me")

Top-to-bottom, single column:

1. **Greeting + quiet context** — name, and which entity (Sweden / Spain) they belong to,
   understated. Scope is *ambient* here — an employee has exactly one; no switcher.
2. **Vacation balance — the hero card.** Remaining days, big and unmissable, with a ring or
   stacked bar. Shows the breakdown that matters for their country: **saved days** and any
   **expiring soon** (SE), or statutory remaining (ES). One glance answers "can I book a
   week off?"
3. **Primary CTA — "Request time off."** Full-width, thumb-zone, always reachable.
4. **Upcoming** — my next approved/pending time off, compact.
5. **This week's timesheet** — a running weekly total (reassurance for ES *registro de
   jornada*) and a one-tap **Log time** for today.
6. **Expenses** — a **Submit** (camera) button and the status of my recent few.
7. **Onboarding** — only for new hires: checklist progress with the next task to complete/sign.
8. **My requests** — pending items and their state (approved / waiting / rejected), so people
   stop asking "did my leave go through?"

## The four flows (each optimized for one-handed phone use)

- **Request time off** — pick type (vacation / VAB / sick / parental — the *local* leave-type
  vocabulary for their scope), choose dates on a calendar, see the **balance impact live**
  before submitting, one tap to send. Confirmation, then back home.
- **Log time** — date defaults to today; hours via stepper; **project picker with recent
  projects first**; optional note. Append-only — a fix is a new entry, never an edit. Weekly
  total updates immediately. Built for fast repeat entry (log yesterday too in two taps).
- **Submit expense** — **camera opens first**; snap the receipt, then amount, category, and
  optional project; submit. The photo is the point; the form is three fields.
- **Finish onboarding** — tap a task, complete or **e-sign inline** (bottom sheet), progress
  ring advances.

## Cross-cutting

- **Localization**: sv / es / en, employee-facing throughout; leave types and holidays use
  the *scope's* local vocabulary.
- **Notifications**: push/email when a request is approved or an expense is reimbursed —
  the loop that keeps people out of the app until they need it.
- **Privacy by construction**: an employee sees only their own records. There is no colleague
  list, no salary, no other-scope data — the entity-narrowed grant, felt as a UI that simply
  has nothing of anyone else's in it.
- **States**: friendly empties ("Nothing pending — you're all set"), skeleton loaders,
  explicit offline/queued badges, and recoverable errors (a failed sync retries, never loses
  the entry).
- **Accessibility & theme**: large text support, WCAG contrast, screen-reader labels on every
  control, non-color-only encodings for leave types, light/dark.

## Visual language

The same Meridian system as the dashboard — calm, Nordic, generous whitespace, one accent
color, a colorblind-safe leave-type palette identical in light and dark — re-expressed for
touch and small screens: larger type, rounded cards, bottom sheets, and the balance number as
the undisputed hero of the home screen.

## Anti-patterns to avoid

- Dense tables or multi-column grids crammed onto a phone.
- Tiny tap targets, top-anchored primary actions, or hiding the balance below the fold.
- Forcing typing where a picker, stepper, or camera would do.
- A desktop dashboard shrunk down — this is a distinct, touch-native surface.
- Blocking on the network for a capture action; losing a queued entry on a flaky connection.

## One-paragraph version (for a quick prompt)

> A mobile-first employee self-service app for a multi-country HR product — design the phone
> first. Bottom tab bar (Home, Time off, Timesheet, Expenses, Me). The Home screen leads with
> a big vacation-balance hero card (remaining days as a ring, with saved-days-expiring for
> Sweden), a full-width thumb-reachable "Request time off" button, this week's timesheet total
> with one-tap log, an expenses submit-by-camera button, onboarding progress for new hires,
> and the status of my pending requests. Four flows, all one-handed and low-typing: request
> time off (pick type + dates, see live balance impact), log time (today prefilled, hours
> stepper, recent-projects picker, append-only), submit expense (camera opens first, three
> fields), and e-sign onboarding tasks inline. Capture works offline and syncs later with a
> quiet "queued" state. An employee only ever sees their own data — no colleagues, no
> salaries. Calm Nordic visual language, one accent color, colorblind-safe leave-type palette,
> light/dark, large touch targets, localized sv/es/en.

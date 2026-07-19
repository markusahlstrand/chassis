# FSM demo — view specifications

Status: draft v0.2 · Last updated: 2026-07-14

> Companion to [testrun.md](testrun.md) (operations these views call)
> and kernel-design §7.4 (composition model). Each view is guided by the incumbent's
> screenshots ([feature survey](../../../docs/research/fsm-vendor-feature-survey.md)) — **kept
> where the pattern earned its place, improved where the survey exposed weakness**.
> Views marked v0 are in the demo; v1/v2 are specified so the pattern kit is designed
> against the full set, not just the demo slice.
>
> Format per view: route/surface · permission · pattern-kit composition · data
> (operations) · layout · **improvements over the incumbent**.

## 0. Pattern-kit vocabulary used below

`FilteredList` (saved filters + live counts + column settings) · `DetailLayout`
(master-data left panel + tabbed main + related tables) · `RelatedTable` ·
`StatusFlow` (visual state machine with guarded transitions) · `EntityCard` /
`EntityLink` (the §7.4 entity-view registry) · `Timeline` (event-spine projection) ·
`CaptureForm` (mobile one-thumb form) · `MoneyText` / `QtyDelta` · `VisibilityBadge` ·
`ProofPopover` ("why can I see/do this").

Cross-cutting improvements applied to *every* view, then not repeated:

- **Activity timeline everywhere.** The incumbent has history scattered per module; we
  project the event spine per `EntityRef` — every entity gets the same `Timeline` tab
  for free. This is the audit moat made visible.
- **Live updates.** Scope-DO WebSockets make lists/details update without refresh
  (dispatch, portal status). The incumbent has nothing comparable.
- **⌘K command palette**: global, permission-filtered actions + entity search. Cheap
  with shadcn; replaces their per-list-only search.
- **Proof-based UI**: buttons/nav render from `check()` decisions; long-press/hover
  `ProofPopover` shows the tuple chain. "View as user" is a shell toggle (§7.8).
- **i18n keys day one** (sv/en for the demo); dark mode via theme tokens.

## 1. Office shell (desktop, `@substrat-run/shell`)

### 1.1 Work order list — `/workorders` · `workorder:read` · **v0**

- `FilteredList` over `workorder/list`. Columns: number, title, customer
  (`EntityLink`), facility, kind (colored dot), assigned (avatar), status
  (`StatusFlow` chip), created, ⚙ column settings.
- Saved filters as **first-class, shareable, URL-addressable** views with live counts
  ("Mina aktiva · 12") — survey shows counts but private/implicit filters.
- Row hover → peek panel (title, latest timeline entries) instead of forcing
  navigation.
- **Improvements:** their map is a separate mode; we add a split **list+map toggle**
  where the visible (filtered) rows are the pins — one mental model, not two views.
  Bulk actions (assign N orders) behind multi-select, permission-checked per row.

### 1.2 Work order detail — `/workorders/:id` · `workorder:read` · **v0**

- `DetailLayout`. Left panel: customer + facility (`EntityCard`s — facility card
  surfaces the standing `access_note` with `VisibilityBadge internal`), assigned
  technician, dates, kind, PO/märkning.
- Main tabs: **Översikt** (description, utfört arbete, internal notes — three text
  areas with snippet support, internal one visibly badged) · **Rader** (lines grid:
  filters Alla/Tid/Material; `QtyDelta` renders corrections as "8 (+2)" chips with an
  audit popover backed by the append-only entries — the survey's best micro-pattern,
  kept and made explainable) · **Timeline** (new).
- `RelatedTable`: invoice basis lines referencing this order (via entity-view
  registry — invoicing UI renders them, zero imports).
- **`StatusFlow` header** replaces their status dropdown: the state machine drawn as
  steps, guarded transitions greyed with the *reason* ("Complete requires
  in_progress"; later: "protocol 3/8 incomplete" — open question 11's UI). This is the
  single biggest improvement: the incumbent shows status as a value; we show it as a
  governed machine.
- **Self-inspection card** (v0, engine-protocol.md milestone A): protocols on the order
  with fill progress ("3/8 punkter"), status pill (Öppen/Signerad/Makulerad), template
  picker to start one, and an expandable fill sheet — checkboxes save on toggle,
  measurements/text per-item with unit labels; corrections show an entry-count badge
  whose tooltip is the append-only history. Signing freezes the sheet read-only and
  prints signer/method/`content_hash`. A warn banner states the completion guard
  ("Obligatoriskt för slutförande: self-inspection-electrical") on `montage` orders — the block
  itself is the operation's, not the UI's.
- **Improvement:** completion is a **priced review sheet** (modal): reported lines →
  priced billable lines side-by-side (min-qty adjustments and dropped internal lines
  shown explicitly with strikethrough + reason) before confirming — the survey's
  pricing is invisible magic; ours shows its work at the moment it matters.

### 1.3 Customer & facility detail — `/customers/:id` · `customer:manage`/read · **v0**

- `DetailLayout`: customer master data + portal org status (linked/not, invite
  action); `RelatedTable`s: facilities (with access notes badged), open orders,
  underlag, timeline.
- **Improvement:** "shared register" honesty — a `VisibilityBadge` on every field
  shows what the portal customer sees; toggling *is* editing visibility. The incumbent
  claims a shared register; we make the sharing inspectable.

### 1.4 Invoice basis review — `/invoicing` + `/invoicing/:id` · `invoicing:read` · **v0**

- List: `FilteredList` (status open/exported, customer, total `MoneyText`).
- Detail: lines with **provenance drill-down** — each line's source renders via the
  entity-view registry as a workorder `EntityCard` (star topology on screen); export
  action with `StatusFlow` (open → exported, immutability stated on the button).
- **Improvement:** a **completeness banner**: "3 completed orders for this customer are
  not yet on any underlag" — computed from events; the survey's month-end diff pain,
  pre-empted in the UI.

### 1.5 Price list — `/settings/prices` · `customer:manage` · **v0 (simple)**

- Editable table (article, description, unit, price `MoneyText`, min-qty, internal
  flag).
- **Improvement kept from the incumbent** (their best idea): the **"test article
  price" simulator** — inline widget: pick article + qty → shows the priced result and
  *which rule produced it* (our version explains via the same show-your-work sheet as
  1.2). v1 grows toward prisbild-per-customer with cascade rules.

### 1.6 Dispatch board — `/planning` · `workorder:assign` · **v1**

- Resources (people *and* equipment) × timeline; **job-queue sidebar** (kept — their
  strongest scheduling idea) with drag-to-assign; absence bars; category colors.
- **Improvements:** queue rows show *why* unplanned (unassigned vs waiting-on-parts);
  drop targets validate against role/absence and refuse with reason; live via
  WebSockets (two dispatchers see each other's moves — the incumbent is single-planner
  by design).

### 1.7 Worked-time matrix — `/time` · office role · **v2**

Employees × days with worked/deviation cells and payroll-basis filter (kept); cells
open the underlying append-only entries (auditability their matrix lacks).

### 1.8 Security views — `/settings/access` · admin · **v0 (small), our differentiator**

- Role/assignment/grant list per node; **"View as"** launcher (any principal, any
  scope) — the §7.8 demo prop; **permission diff** review screen for definition
  changes (who gains what, where — rendered from tuples). The incumbent has nothing
  here; this is Substrat showing its kernel.

## 2. Field mobile (separate lightweight shell, same headless hooks)

### 2.1 My jobs — `/m` · `workorder:read` · **v0**

- Card list: today first, then queue; status + kind color; **Acceptera** button on
  offered jobs (kept from survey); pull-to-refresh + live updates.
- **Improvement:** facility access info (door code, warnings) surfaced **on the card
  before travel** — in the incumbent it's buried in the order detail.

### 2.2 Job capture — `/m/orders/:id` · `workorder:report` · **v0**

- `CaptureForm` stack, one-thumb: big status action (Start → Report → Complete
  hand-off to office in v0), time entry (hour stepper + note), material picker
  (price-list search), photo attach (→ documents engine later; v0 stub), utfört arbete
  text with voice-input hint.
- **Improvements:** every capture is an **event-shaped append** — visible "saved ✓ 14:02"
  receipts per entry (trust in patchy connectivity, and the future offline queue's UI
  is already right); no editable history on mobile at all (append-only made tangible),
  corrections are new entries.

### 2.3 Checklist filling — **v2** (mobile; the office fill/sign slice shipped v0 in 1.2)

Per-point assessment (X/1/2/A/– kept — it's the industry's language), note + photo per
point, progress counter, **"Skapa aktivitet"** kept (their best mobile idea: spawn a
follow-up from a checkpoint), on-glass signature; gating status shown as progress
toward the blocked transition (ties to 1.2's StatusFlow).

## 3. Customer portal (per-tenant brandable, consumer-grade)

### 3.1 Portal home — `/p` · entity-narrowed `workorder:read` · **v0**

- "Your service orders" list (status in plain language, not internal vocabulary:
  *Planned / In progress / Done*), facility filter if >1.
- **Felanmälan form** (v1): description + photo + facility → creates a `planned` order
  via a portal-scoped operation; confirmation with tracking link.
- **Improvements:** live status (they poll/none); plain-language status mapping is
  configuration, not code; everything shown passes the visibility filter — internal
  notes/lines are *structurally* absent from the payload (checked in the operation,
  not hidden in CSS — testable in §8 of the test-run spec).

### 3.2 Portal order detail — `/p/orders/:id` · **v0**

Work description, performed work, status timeline (customer-visible events only),
technician first-name, documents marked `customer`. **Improvement:** "what happens
next" strip derived from the state machine — the machine is already there; the
incumbent shows a bare status string.

## 4. What the demo build actually needs (v0 cut)

Office: 1.1, 1.2, 1.3, 1.4, 1.5-simple, 1.8-small. Mobile: 2.1, 2.2. Portal: 3.1
(list only), 3.2. Everything renders from the test-run spec's operations — **no new
kernel surface**; the views consume `invoke`, decisions, and the outbox-fed timeline.

## 5. Deferred with intent

Dispatch board (1.6, needs scheduling), time matrix (1.7, needs balances), checklist
mobile (2.3, needs protocol engine), felanmälan intake (3.1's form — needs portal
write path + spam control), map integration (needs geo columns + tile provider
decision), quantity-correction entry UI (engine v2 append-deltas first).

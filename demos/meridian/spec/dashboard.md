# Meridian — Dashboard design brief

Status: draft v0.1 · Last updated: 2026-07-18 · Hand-off doc for design.

The landing screen after sign-in. One calm, glanceable operating picture of the workforce
for the signed-in role, with the two or three things that role *owes the org* surfaced
first. Not an analytics wall — a place you act from, then leave.

## Audience & role-awareness

Three variants sharing one layout system and component set. The role decides the data and
what's hero, never the visual language.

- **HR admin / People Ops** — the whole company, both countries, salary included. Richest.
- **Manager** — their team only. No salaries, no other scope.
- **Employee** — self-service, re-centered on "me".

A **scope switcher** (All · Sweden · Spain) and a **date range** (defaults to current month)
sit in the top bar and re-filter everything below. Switching scope is the demo's "one
company, two countries" beat — the numbers and the leave-type vocabulary change because the
*scope* changed, not the screen.

## Layout — HR admin (the default, design this first)

Top bar: Meridian wordmark · company name · **scope switcher** · date range · search · avatar menu.

**Row 1 — KPI tiles** (5–6, equal weight, scannable in one pass):
- **Headcount** — total, with a tiny SE/ES split bar.
- **Off today** — count + a few mini avatars of who.
- **Pending approvals** — leave + expenses, badge count (this is a call to action).
- **Absence rate** — % this period, with a small trend arrow vs last.
- **Utilization** — logged project hours ÷ capacity, as a compact gauge.
- **Days at risk** — saved vacation days expiring this year (the SE saved-days beat).

**Row 2 — the heart of the screen** (asymmetric split):
- **Left, wide — "Who's off"**: a two-week team timeline. Rows = people (or teams),
  columns = days, colored chips per leave type, a clear *today* marker. Scope-filtered.
  This is the single most-looked-at object; give it the most room.
- **Right, narrow — Approvals queue**: actionable list of pending leave + expense requests.
  Each row: avatar, name, type, dates or amount, inline **Approve / Reject**. Empty state
  is a *win*, not a blank: "All caught up."

**Row 3 — trends** (even split, small multiples):
- **Absence trend** — absence days per month, 6-month window, area or bar.
- **Time by project** — horizontal bars, logged hours per project this period; utilization %
  as the summary number.

**Row 4 — "Attention"** strip of compact cards, each a count + a "review" link:
- **Registro de jornada gaps** — ES employees missing time entries this week (compliance).
- **Onboarding in progress** — checklists not yet signed.
- **Dates approaching** — probation ends, contract renewals.
- **Saved days expiring** — the ones behind the Row-1 tile.

## The other two roles (same components, retargeted)

- **Manager**: identical layout, team-scoped data — their who's-off, their approvals, their
  team's utilization and registro gaps. Salary and other scopes simply absent.
- **Employee**: re-centered on "me" — **my vacation balance** (with saved-days breakdown as a
  ring or stacked bar), my upcoming time off, a prominent **Request time off** button, **my
  timesheet this week** (log hours to a project inline), my expenses status, my onboarding
  checklist progress. The employee surface is **mobile-first** and specified in full in its
  own hand-off doc — [employee-view.md](./employee-view.md).

## Interactions

- Scope switcher and date range drive every tile and chart.
- Any KPI tile is clickable → drills to its underlying list.
- Approvals act inline with optimistic update; a "who's off" chip opens the request.
- Everything degrades to a friendly empty state; nothing shows a raw zero without context.

## Visual language

Calm, spacious, European/Nordic clarity. Generous whitespace, one accent color, a restrained
**categorical palette for leave types** that is colorblind-safe and identical in light and
dark. Data-dense but airy — the numbers are the heroes, the chrome recedes. Rounded cards,
hairline borders, no heavy shadows. Charts are minimal: no gridline clutter, direct labels
over legends where possible, no pie charts for time. Fully responsive (tiles reflow, the
timeline scrolls horizontally inside its own container), theme-aware light/dark, and
accessible (contrast, keyboard, and never color as the only signal — pair every leave-type
color with a label or glyph).

## Anti-patterns to avoid

- A wall of equal-weight widgets. Establish hierarchy: **approvals + who's-off are the
  heart**; everything else supports them.
- Vanity metrics. Every number on the screen should imply an action or answer a real
  question a person walked in with.
- Cramming all three roles into one busy screen — retarget the data, keep the calm.
- Color-only encodings, pie charts, and dense tables where a chart or a count would do.

## One-paragraph version (for a quick prompt)

> A calm, role-aware HR dashboard for a small multi-country software company. Top bar with a
> Sweden/Spain scope switcher and a month range that filter everything. A row of ~6 KPI tiles
> (headcount with SE/ES split, off-today, pending approvals, absence rate, utilization, saved
> vacation days expiring). Below, an asymmetric split: a wide two-week "who's off" team
> timeline with colored leave-type chips, beside a narrow, inline-actionable approvals queue.
> Then two small charts — absence trend and hours-by-project — and a strip of "attention"
> cards (missing time entries for Spanish staff, onboarding in progress, upcoming contract
> dates). Nordic-clean: airy, one accent color, a colorblind-safe leave-type palette
> consistent across light and dark, minimal charts, numbers as heroes. Managers see the same
> layout scoped to their team (no salaries); employees see a "me" version with their vacation
> balance, a request-time-off button, and this week's timesheet.

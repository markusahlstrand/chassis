# Handoff: RallyPoint — Player App (mobile) & Manager Console (desktop)

## Overview
RallyPoint is a padel/tennis court-booking platform with two surfaces:

1. **Player app** (mobile-first web): find clubs, book courts (60/90/120 min), create/join open matches, split payment, manage bookings. `RallyPoint Player.dc.html`
2. **Manager console** (desktop, 1440px+): staff-facing ops tool — a resource calendar (courts × time) plus CRUD for courts, pricing rules, hours, members, reports, staff roles. `RallyPoint Console.dc.html`

## About the Design Files
The files in this bundle are **design references created in HTML** — static high-fidelity mockups showing intended look and behavior, **not production code**. The task is to **recreate these designs in the target codebase's environment** (React, Vue, native, etc.) using its established patterns and libraries — or, if no codebase exists yet, choose an appropriate framework and implement there. The `.dc.html` files open directly in a browser; `ios-frame.jsx` / `browser-window.jsx` are presentation chrome (device bezels) only — ignore them for implementation.

## Fidelity
**High-fidelity.** Colors, type, spacing, radii, and copy are final intent. Recreate pixel-perfectly, substituting your design-system primitives where equivalent. Screens are laid out on a canvas with badge ids (1a, 1b, …) referenced throughout this document.

## Design Tokens (both surfaces)

### Color
| Token | Value | Use |
|---|---|---|
| ink | `#14171A` | primary text, primary buttons, selected states |
| body text | `#3B423D` | secondary text |
| muted | `#66706A` / `#8A938C` | captions, meta |
| disabled | `#B3BAB0` | struck/unavailable |
| app bg | `#F4F4F0` (mobile) / `#F4F4F0` (console content) | page background |
| surface | `#FFFFFF` | cards, cells |
| surface alt | `#F7F8F3`, `#F0F1EA`, `#FBFBF8` | insets, chips, table headers |
| border | `#E2E3DC` (cards), `#F0F1EA` (dividers), `#D8DAD2` (strong) | |
| **accent lime** | `#D7F34F` | THE brand accent. Always paired with ink text/border. Selection, highlights, primary "sporty" CTAs. Never sole carrier of state. |
| lime deep | `#9DBB2A` / `#B3CB3E` | open-match bars, heatmap |
| success green | `#256B3E` (text/border), `#EDF6D2` (bg) | confirmed, "in band", links |
| **urgency amber** | `#C2510F` (fg), `#FDF6EE`/`#FBEFE6` (bg) | hold countdowns, now-line, peak, "above band". Reserved — nothing else uses it. |
| warning gold | `#C99A2E` / `#8A6A1B` on `#FBF4E6` | pending approval, rule overlaps, price-boundary chip |
| danger red | `#A33328` (fg), `#F9ECEA` (bg) | debt block, double-booking rejection, leave/cancel |
| Dark theme (console 1b) | bg `#16191B`, panel `#1B1F22`, cell `#22282A`, line `#23282B`, text `#E8EAE1`, muted `#8A938C`/`#6C7679`, confirmed bar `#4E9B68` | |

### Typography
- **Archivo** (Google Fonts) — everything. Display/headers: 800, tight tracking (−0.01/−0.02em); wordmark 800 *italic* "RALLYPOINT" preceded by a lime parallelogram (12–14px square, `skewX(-12deg)`, 1.5px ink border).
- **IBM Plex Mono** 500/600 — every time, price, countdown, distance, level number, kbd hint. Transactional data always reads as data.
- Mobile scale: screen title 22/800, card title 16.5/700, body 12.5–13, meta 11–12, mono chips 11.5–14. Console is denser: table body 12–12.5, cell text 10.5–11, mono meta 8.5–10.
- Minimum tap target on mobile: 44px.

### Shape & elevation
- Radius: 16px club cards, 13–15px mobile cards/CTAs, 10–12px inputs/chips, 7px calendar cells, 99px pills/avatars.
- Borders over shadows. Shadows only for: floating map card `0 10px 30px rgba(20,23,26,.14)`, sheets `0 -12px 40px rgba(0,0,0,.3)`, popovers `0 10px 30px rgba(20,23,26,.3)`.
- Selected state = `border: 2px solid #14171A` + lime fill. Disabled = dashed `#D8DAD2` border + `#F7F8F3` fill + reason text.
- Image placeholders: `repeating-linear-gradient(45deg,#E6E9DE 0 10px,#EEF0E8 10px 20px)` + mono caption — replace with real photos/map tiles.

### Locale
SEK ("340 kr", space thousands separator), 24-hour time ("19:00–20:30"), metric ("0.8 km"), Monday-first weeks. Skill scale: 0–7 numeric (Playtomic-style), one decimal ("3.4"), bands as ranges ("2.5–4.0").

---

## Player App (`RallyPoint Player.dc.html`)
Viewport 402×874 (iPhone). Root layout: `flex column`; scrollable content; bottom nav (4 tabs: Discover, Matches, Bookings, Profile — 22px stroked icons, active = ink + 700 label, inactive `#8A938C`). Sheets are bottom modals: white, `border-radius 24px 24px 0 0`, grabber bar, scrim `rgba(20,23,26,.45)`.

### Screens
- **1a Discover (list)** — wordmark + location switcher; search field + Map toggle (ink block, lime label); filter pill row (active = ink bg/white text); club cards: photo (first card only), name 16.5/700, meta line, "next free" chips (first chip lime, rest `#F0F1EA`), "from 220 kr" mono right-aligned. Full club = single muted chip "full until 21:00".
- **1b Discover (map)** — full-bleed map placeholder; price pins (ink pill = bookable, lime+ink border = cheapest/highlighted, white muted = full); bottom card carousel with page dots; List toggle.
- **1c Club detail** — hero photo + back FAB; name/address/hours; amenity chips; 4-day selector (today = ink block); **per-court availability strips**: 14–23 track, booked = `#C9CEC2` blocks on `#EFF1EA`, mono hour ruler beneath; sticky CTA "Pick a time →" (lime arrow).
- **1d Slot picker A (recommended)** — start-first. Date scroller; start-time grid (4 cols). **Every free chip carries fit dots**: 3 dots = 120 fits, 2 = 90, 1 = 60 (filled `#14171A`, unfilled `#D8DAD2`); legend "▪ 60 ▪▪ 90 ▪▪▪ 120 fits". Booked chips: struck mono + "booked". Selected chip: lime + 2px ink border. Below, duration selector for the chosen start: available = outlined w/ price, selected = lime + SELECTED tag, **unavailable = dashed + reason ("20:30 is booked")** + helper line naming the nearest starts where it does fit. CTA shows resolved range + price. *This is the core interaction: no tap may dead-end.*
- **1e Slot picker B** — duration-first segmented control (60/90/120, active = ink bg + lime mono text); grid pre-filtered ("Showing the 9 start times where 90 min fits today"), grouped Afternoon/Evening with peak label; footer hint for switching duration without losing the date.
- **1f Slot picker C** — vertical day timeline for one court: booked blocks `#E4E6DC`, free gaps expand to show every `start · duration` combination chip that fits; gap-close reason ("No 120 after 18:00 — the gap closes at 20:00").
- **1g Confirm & pay** — hold banner (white card, 1.5px amber border): "Court held for you" + mono countdown 22px + progress bar; booking summary card (DATE/TIME/TOTAL inset cells); **split block**: 4-segment bar (YOU = lime, others `#E8EAE1`), copy "Pay 340 kr now — each joiner's 85 kr is refunded to you automatically"; cancellation terms row (clock icon, "Free cancellation until Fri 19:00 (24 h before)…"); Apple Pay primary + "or pay by card".
- **1h Open matches** — header + lime "+ Create"; filter pills; match cards (variant A row, see 1i). Level fit is decided up front: `YOUR LEVEL ✓` badge (green on `#EDF6D2`) vs `ABOVE BAND` (amber on `#FBEFE6`); footer per card: band range + "Join →" or "Request a spot →".
- **1i Match card variants** — A row (default), B dark poster (ink card, 30px lime mono time hero, "Join · 85 kr" lime button), C compact (time block | divider | club + mono meta | Join) for feeds/history.
- **1j Match detail** — ink hero card (lime "Today 19:00", share price right); **level band gauge**: 0–7 track, lime band segment, ink "you" dot, badge "YOU'RE IN · 3.4"; players list "2 of 4" with 4-segment momentum meter, rows = avatar + name + status ("Host · paid", "played with you ×3") + mono level chip; empty rows dashed avatar "Free spot" + "Share link"; **cancellation window explainer** (two bullets: "Now: free to leave… / Once full: locked within 24 h — your share is charged") shown BEFORE the CTA; CTA lime "Join match · pay 85 kr".
- **1k My bookings** — HELD card first (amber border, "HELD · PAY IN 8:47" tag, Complete payment); UPCOMING confirmed cards with explicit cancel affordances ("Leave · free until full", "Cancel · free until Tue 07:00" in red text); PAST compact rows at 75% opacity with score + Rebook.
- **1l Profile** — ink header: avatar (lime ring), name, lime level tile "3.4 LEVEL"; stat tiles (matches/win rate/90-day trend) on `rgba(255,255,255,.07)`; "People you play with" avatar row + Invite; Groups rows (icon tile, next session meta); recent result row.
- **1m Join via link (logged-out)** — ink page, wordmark, inviter line ("Marta K. invited you"), white match card (mono "Sat 19:00" 26px, spots badge, avatars, band, "Your share 85 kr"); bottom sheet: "Grab a spot in 30 seconds", Apple/Google/email sign-in, escape hatch "Just looking? Browse the club →". Payment only after sign-in.
- **1n Slot just taken** — sheet over dimmed picker: amber clock icon, "18:30 just got booked", 3 ranked alternatives (closest = lime highlighted; same court/time-shift, same time/next court, nearby club) each with price; CTA "Book 19:00 instead"; "Back to all times". Never a dead error.
- **1o Hold expiring/expired** — <1 min: banner flips to solid amber, white countdown. Expired sheet: grey "0:00", "Your hold expired", copy confirms **no charge** and slot may still be free; CTA "Hold … again" (lime) + "See other times".
- **1p Level-band request flow** — outside band: amber card, band gauge with "you" dot outside (amber), copy "all 3 current players must approve", CTA "Request a spot". PENDING state: gold PENDING tag, per-player approval chips (✓ green dot / waiting hollow), "Nothing charged until everyone approves", Withdraw. DECLINED state: neutral (not red), "This one didn't work out", no charge + no rating impact, redirect CTA "3 matches at your level tonight →".
- **1q Blocked by debt** — red-bordered card atop bookings: plain statement, fee provenance card (date, court, 160 kr) + Dispute link, CTA "Pay 160 kr & unblock"; rest of screen at 45% opacity. Firm, no shame language.
- **1r Empty states** — no clubs in radius (widen search / suggest club), no open matches (Create CTA, lime), no connections ("everyone you play with lands here automatically" + Invite).
- **1s Component sheet** — canonical specs for slot chip (free/fits≤90/selected/booked/just-taken), duration selector, participant row (host/pending/empty), countdown (calm/urgent/expired), price-split block.

---

## Manager Console (`RallyPoint Console.dc.html`)
1440px primary, degrade to 1024 (sidebar collapses to icon rail as in 1b). Light default (1a) + dark treatment (1b). Shell: 182px white sidebar (logo + MGR tag, nav with lime left-bar active state, club/user footer) + topbar (date pager ‹ Today ›, view switcher Day/Week/Court, customer search ⌘K, "+ New booking" N).

### Keyboard-first
`N` new booking · `⌘K` find customer · `T` today · `G` jump to date · `⏎` commit drawer · `esc` closes drawer **without losing input**. Hints rendered as mono kbd chips throughout.

### The calendar (1a — recommended)
Resource grid: courts as columns (header cards: name, type, allowed durations/hours), time as rows (07–22, 48px/hour, hairline `#F0F1EA` per hour). Peak window 17–21 = faint amber tint band + dashed boundaries + vertical "PEAK 17–21" gutter label. **Now**: 2px amber rule with mono time bubble; everything above it washed with `rgba(244,244,240,.35)` + cells at 55% opacity with grey-green left bar. Drag-to-create: dashed ink ghost with lime wash + mono time tag. Click-to-inspect: ink popover (name, price/payment, mono meta, Move / Cancel / No-show actions).

**Cell states (all border+fill+icon+label — never colour alone):**
| State | Spec |
|---|---|
| Confirmed paid | white, `1px #D8DAD2`, **3px left bar `#256B3E`**, "Name ✓", mono meta |
| Confirmed unpaid | same + `PAY ON SITE` grey chip + "320 kr due" |
| Held | `#FDF6EE`, **1.5px dashed `#C2510F`**, "⏱ HELD" + live mono countdown, "releases automatically" |
| Open match | `#FAFCEF`, 3px left bar `#9DBB2A`, "◐ Open match 2/4" + 4-segment fill meter + "may collapse" |
| Maintenance | 45° grey stripes, 3px left bar `#66706A`, "▨ Maintenance", "internal · not billable" |
| Outside hours | −45° light hatch on column with "opens 09:00"/"closes 21:00" |
| Inactive court | whole column hatched + card "⊘ Inactive · Resurfacing · back 28 Jul" |
| Past | 55% opacity, muted left bar |
| Just taken (rejection) | `#F9ECEA`, 1.5px `#A33328`, "✕ just taken" |
| Price boundary | confirmed cell + gold chip "290 kr = off 120 + peak 170" |

Legend row pinned under the grid repeats all states with swatches. Dark variant (1b): same encodings on dark tokens, 30-min rows (40px/30min), icon rail.

### Other screens
- **1c Booking drawer** — 424px right panel over scrimmed calendar; created without leaving the calendar. Customer typeahead (member tier chip inline), court/start selects, duration segmented **with disabled reason** ("120 — 21:00 booked"), price card showing the resolved rule ("PE-2 peak", "340 kr − member 10% = 306 kr") + Override link, payment method (Pay on site / Send pay link / Mark paid), footer "Create booking ⏎" + "Hold 10 min". **Double-booking rejection**: red banner at top — "Court 2 · 19:00 was just taken · 20 s ago · online. Everything you typed is kept." + two one-tap alternative chips (first lime). Calendar behind shows the lost cell red and the alternative highlighted.
- **1d Courts** — table (court, type, allowed durations, hours override, active state) + detail panel: duration toggles (note: removing one hides it from the player app per-court), hours override, price rules touching the court, "Block for maintenance…" and "Deactivate" (red outline).
- **1e Pricing rules** — precedence statement ("most specific wins: court > duration > time > day > base"), ordered drag-to-reprioritise table ending in BASE row; **overlap warning row** (gold wash + inline explanation "PE-3 overlaps PE-2 … PE-3 wins (narrower day + duration)"); right rail: ink "try a slot" resolver showing stacked rules → "Player pays 400 kr", and peak-window editor with day-track visual.
- **1f Club settings** — weekly hours rows (Mon-first, "copy to all"), closures/holidays list with typed severity tags (CLOSED ALL DAY red / BLOCKED 08–18 gold / REDUCED HOURS grey); note: exceptions grey the calendar automatically and conflicting bookings are flagged.
- **1g Members** — three tier cards (Drop-in 0 kr, Member 199 kr −10% most common, Club+ 449 kr −20%) + member table with tier and bookings/mo.
- **1h Reports** — KPI tiles (occupancy, revenue, cancellations, off-peak gap hours in amber); occupancy heatmap hour×weekday (lime ramp `#EFF1EA→#7E9A15`, % in every cell) with actionable footnote; revenue-by-week bars (current week lime).
- **1i Staff & roles** — staff table + section×role permission matrix (edit green / view grey / none faint).
- **1j Quiet-day calendar** — sparse grid stays honest; floating suggestion card ("Quiet Tuesday — 61 open court-hours" + Create off-peak rule / Host open match).
- **1k Component sheet** — canonical cell states, rule row + overlap, court card, occupancy spark.

## Interactions & Behavior
- **Hold lifecycle**: booking creates a ~10-min hold; countdown visible player-side (1g/1k) and staff-side (calendar cell). <1 min flips banner to solid amber. Expiry releases slot, charges nothing, offers instant re-hold (1o).
- **Race handling**: optimistic tap → server reject → alternatives sheet (player 1n) / inline banner preserving all typed input (console 1c). Never lose input; never a bare error.
- **Duration availability**: chips must be computed against real gaps (fit dots in 1d; pre-filter in 1e). Selecting an unavailable duration is impossible — it is rendered disabled with the reason.
- **Open match fill**: n/4 momentum meter everywhere (player card, detail, console cell). Out-of-band users request; all current players approve; pending/declined states per 1p.
- **Cancellation window**: free while unfilled; locked within 24 h once full. Stated before commit (1j), on the pay screen (1g), and on every cancel button label (1k).
- Transitions: sheets slide up 250–300ms ease-out; keep motion minimal elsewhere. Countdown ticks 1s.

## State Management (minimum viable)
- Slot picker: `selectedDate`, `selectedStart`, `selectedDuration`, `availability: {start → maxFitMinutes}` (from gaps), derived price.
- Hold: `holdExpiresAt` (server-authoritative), tick locally, states `active | urgent(<60s) | expired`.
- Match: `players[]`, `capacity`, `band {min,max}`, `myLevel`, `myStatus: none | requested(approvals[]) | joined | declined`.
- Bookings list: `held | confirmed | past`, per-item `cancellableUntil`, `lockReason`.
- Account: `blockedByDebt {amount, source}` gates all booking CTAs.
- Console calendar: `date`, `view`, `cells[]` typed by the state table above, `nowLine`, drawer form state (persist across rejection), rule set ordered by specificity.

## Accessibility
WCAG AA. State never by colour alone (every state pairs icon/label/border-style). Ink on lime ≈ 13:1; amber `#C2510F` and green `#256B3E` on white ≥ 4.5:1 at text sizes used. 44px minimum touch targets on mobile. High-contrast light theme is the outdoor default.

## Assets
No binary assets. Striped blocks are placeholders for club photos and map tiles (swap for real imagery/map SDK). Icons are simple inline SVG strokes (pin, ball, calendar, person, clock, share, chevrons) — substitute your icon library at 22px/1.8–2px stroke. Fonts: Google Fonts Archivo + IBM Plex Mono. Logo: "RALLYPOINT" Archivo 800 italic + lime skewed square — placeholder wordmark, replace when brand exists.

## Files
- `RallyPoint Player.dc.html` — all mobile screens & component sheet (badges 1a–1s)
- `RallyPoint Console.dc.html` — all console screens & component sheet (badges 1a–1k)
- `ios-frame.jsx`, `browser-window.jsx` — presentation chrome only, not part of the design

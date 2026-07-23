---
'@substrat-run/ui': minor
---

**`Dialog` gains `confirmDisabled` — the confirm button can be gated (type-to-confirm).**

The shared `Dialog`'s confirm button was always clickable. A destructive dialog that guards on typed input (e.g. "type the app name to confirm") could only make the click a no-op by passing `onConfirm={undefined}`, which left the button *looking* enabled while doing nothing.

- New `confirmDisabled?: boolean` prop disables the confirm button.
- The button is now also disabled when there is no `onConfirm` handler at all, so a gated dialog reads correctly whichever pattern a caller uses.

The dashboard's "Delete app" dialog uses it: the button stays disabled until the typed name matches.

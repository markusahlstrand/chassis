# Design tokens — vendored, not authored

These four files come from the design handoff (`Substrat Design System.zip`,
`handoff/tokens/`) and are the source of truth for color, type, spacing and
elevation across the docs site. **Values are copied verbatim. Do not re-derive,
round, or "improve" one** — if a color looks wrong, that is a conversation with
design, not an edit here. Taking a new bundle should be close to a straight copy.

Two deliberate deviations, both mechanical:

1. **Dark selector.** The handoff scopes dark mode to `[data-theme="dark"]`;
   VitePress toggles `html.dark`. Both selectors are listed, so the design's own
   static refs and the live site stay in sync. Additive only — no value changed.
2. **`fonts.css` is not vendored.** It `@import`ed Geist from the Google Fonts
   CDN. Geist is SIL OFL, so `../index.ts` imports self-hosted `@fontsource`
   files instead. The `--font-sans` / `--font-mono` tokens in `typography.css`
   are untouched and still name Geist.

`typography.css` also drops the handoff's element-level `body` / `a` / `code`
rules; VitePress styles those from its own variables, which `../styles/vitepress.css`
maps back onto these tokens. Nothing is lost, and two stylesheets don't fight
over `body`.

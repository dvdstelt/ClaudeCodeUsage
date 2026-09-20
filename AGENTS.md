# Claude Code Usage Monitor (GNOME Shell extension)

A GNOME Shell panel indicator that shows your Claude subscription tier and live
usage limits (5-hour and 7-day windows). It reuses the OAuth token that Claude
Code already stores on disk, so there is usually no separate login. Each profile
can also sign in on its own, from a PKCE flow in its row in prefs, for accounts
that never use the CLI.

## Layout

The shipped extension lives in `src/`; everything else (this file, the README,
the LICENSE, `build.sh`, `tools/`) is repo tooling that stays out of the bundle.

- `src/extension.js` — panel indicator + dropdown UI (ESM, GNOME Shell 45+
  style). `ProfileView` holds everything specific to one Claude Code profile
  (its `UsageClient`, panel block, and popup section); `ClaudeUsageIndicator`
  owns one `ProfileView` per configured profile, plus the shared panel icon,
  poll timer, and countdown. The panel shows a Claude icon once, then one
  block per profile: `[profile divider] [chip] [tier icon] [tier label]
  [lead divider]`, then `PanelGroup`s, each `[window divider] gauges…
  [reset countdown]`. There is one `PanelGauge` (tag, ring/bar, percentage)
  per usage window selected by `panel-windows`, keyed by window like the
  popup meters so gauges are reused across polls and move between groups.
  Its ring and bar sit in a `Clutter.BinLayout` stack, so the one percentage
  label can go on top of the gauge shown instead of after it
  (`_syncPctPlace()`, from the `panel-pct.position` UI value; it reparents
  the label on a change only, never on a tick, and the layout signature is
  not involved). `panel-pct.sign` drops the "%" (`_syncPctText()`), and over
  the bar the label takes no warn/crit state, since those text colors are
  unreadable on a fill of the same color.
  Each element is independently toggleable via GSettings (the toggles apply
  to every gauge of every profile uniformly). With several gauges in one
  block each carries a short window tag ("5h", "7d", model name).
  - Groups: `groupPanelWindows()` (usageModel.js) puts the weekly and
    per-model windows whose resets are within 5 minutes (or unknown) in one
    group, whose `resetsAt` is the first known reset. The window divider
    sits between groups only, and the countdown is the group's, shown once.
  - Dividers: `PanelDivider` draws both settings. `panel-divider` (window
    divider) goes before every group but the first; `panel-lead-divider`
    goes between a block's leading elements (chip, tier icon/label, and for
    the first block the shared Claude icon) and its gauges, and before every
    profile block but the first (`ProfileView.applyVisibility()`). Blank
    shows nothing, exactly `|` draws a 1px line, other text is a label.
  - `renderPanel()` runs after every poll, preference change and countdown
    tick. It re-lays-out (`_layoutPanel`) only when the layout signature
    (window keys per group, tags, divider text) changed, then re-applies
    values (`_updatePanel`). While `lastResult === 'error'` every gauge
    reads `!`, so set `lastResult` before calling it. The tick
    (`_scheduleCountdown`, 30s, or 1s under 90s to a reset) fetches nothing;
    popup meters are only re-applied while the menu is open.
  - Tier icons are `src/icons/tier-<name>-symbolic.svg` (the `-symbolic`
    suffix makes the shell recolor them; every path becomes the foreground
    color, and the second tone is `opacity`, so use fills only, no strokes
    or masks). That foreground color is `.cu-panel-tier-icon`'s `color` in
    the stylesheet, by default the Claude icon's orange (`#D97757`) and
    changeable under "Top-Bar UI"; the fill in the files themselves is
    never shown. `TIER_ICONS` + `tierIconName()` in usageModel.js map a tier
    label to a name: `max-20x`, then the base `max`, else null, which hides
    the icon. Add a name to `TIER_ICONS` when adding its file (a test checks
    each listed name has one). Original artwork is in `assets/tier-icons/`;
    the shipped files are `svgo`-optimised copies.
  - Style: every panel widget has an `applyStyle(style)` next to its
    `applyVisibility()`. `ClaudeUsageIndicator._applyStyle()` resolves the
    `ui-style` setting with `uiStyle()` (uiStyle.js) on a change and hands it
    down; each actor then gets `style.inline(<its class>, <level state>)` as
    its inline style via `applyInline()`, which is null (stylesheet.css alone
    applies) when nothing it uses was changed. A widget made later (a gauge
    or group from `_layoutPanel`) gets the `ProfileView`'s kept style. The
    ring paints itself and the bar sizes its own fill, so those read
    `style.value()` / `style.rgba()` instead; there are no size or color
    constants left in extension.js (the ring's colors and track are the
    shared `usage.*` values). The popup is covered the same way: `Meter`,
    the popup half of `ProfileView.applyStyle()` (`_setLineState()` keeps the
    extra-usage / error line's state class and inline style together), and
    the popup shell in `ClaudeUsageIndicator._applyStyle()`. An inline
    background beats the stylesheet's `:hover`, so while the button's
    background is changed `_styleUsageButton()` sets a derived hover shade
    (`hoverShade`) on `notify::hover`. A per-model window's tag carries
    `cu-panel-wtag-model` on top of `cu-panel-wtag` (`PanelGauge.setTag`), and
    gets the inline style of both. `PanelGroup._syncResetText()` writes the
    countdown as Pango markup (`boldNumbersMarkup`) while the
    `panel-reset.bold-numbers` value is on, as plain text otherwise.
- `src/prefs.js` — Adwaita preferences (element toggles, the "Panel reflects"
  window switches, refresh interval, the "Claude profiles" list), bound to
  GSettings, on the "General" tab, plus one tab per entry of `UI_PAGES`
  ("Shared UI", "Top-Bar UI", "Popup UI") built by `lib/uiStylePage.js` (the top-bar one
  is also where the two divider texts are edited). Each profile row
  carries its own PKCE sign-in (`_addSignInRows`): a status line that reads
  "Using Claude Code", "Connected", or "Not connected", plus Connect, a field
  for the pasted code, and Disconnect.
- `src/schemas/` — GSettings schema (`org.gnome.shell.extensions.claude-usage`).
  Keys: `show-icon`/`show-percentage`/`show-tier` (label)/`show-tier-icon`/`show-reset` (bool),
  `panel-gauge` (`ring`|`bar`|`none`),
  `panel-windows` (`as`, any of `five-hour`|`seven-day`|`scoped`|`max`|`worst`;
  one panel gauge per matched window, merged and shown in role order),
  `panel-window` (deprecated single-valued predecessor, read once by
  `migratePanelWindows()` to seed `panel-windows`), `panel-divider` (window
  divider: string drawn between gauge groups; default `' '`) and
  `panel-lead-divider` (lead divider: after the leading elements and between
  profiles; default `'|'`) — for both, a blank/whitespace value shows
  nothing and exactly `|` draws a 1px line,
  `poll-seconds` (30-600),
  `panel-position` (`left`|`center`|`right`) + `panel-index` (0-20, where the
  indicator sits in that box; applied live by re-registering it in `_place()`),
  `toggle-menu` (`as`, keyboard shortcut that opens the popup; empty = unbound,
  registered with `Main.wm.addKeybinding` like the shell's own panel menus),
  `profiles` (JSON string, array of `{id, label, configDir}`),
  `profile-tokens` (JSON string, profile id -> in-app tokens),
  `show-profile-chip` (bool),
  `ui-style` (JSON string, id -> value for each "Shared UI" / "Top-Bar UI" / "Popup UI"
  value changed from its default; see `lib/uiStyle.js`),
  `profiles-initialized` (bool, set once auto-detection has seeded `profiles`
  so a deliberately-emptied list isn't re-seeded), and the in-app sign-in
  tokens `access-token`/`refresh-token` (string) + `expires-at` (int64 ms).
  Recompile after edits: `glib-compile-schemas src/schemas/`.
- `src/lib/usageClient.js` — pure GI module: resolves a token for a given
  `configDir` (that profile's on-disk credentials first, the extension's own
  GSettings tokens second), calls the usage and profile endpoints, refreshes the
  token when near expiry, and writes it back to whichever store it came from.
  Takes a `profileId` and resolves that profile's own in-app token from
  `tokenStore.js` when the on-disk credentials are missing or dead; a profile
  that has never signed in resolves to a `SignedOutError`, which the panel shows
  as a muted "Signed out" state. `allowSharedToken` now only decides which
  single profile may claim a pre-per-profile sign-in during migration. Exports
  `claudeCodeCredentialsAvailable(configDir)`, `defaultConfigDir()`
  (`~/.claude`), and `discoverConfigDirs()` (finds `~/.claude` and sibling
  `~/.claude-*` directories that already hold credentials). Soup is pinned
  inline via `gi://Soup?version=3.0` (some systems still ship the 2.4
  typelib).
- `src/lib/profiles.js` — the profile list: `loadProfiles`/`saveProfiles`
  (JSON in the `profiles` GSettings key) and `ensureProfiles` (seeds the list
  from `discoverConfigDirs()` once, gated by `profiles-initialized`). Kept
  shell-import-free like `usageClient.js` so prefs and plain `gjs` can use it
  too.
- `src/lib/tokenStore.js` — per-profile in-app OAuth tokens, kept as a JSON
  object in the `profile-tokens` GSettings key keyed by profile id. Each
  profile signs in to its own Claude account; `migrateLegacyToken()` moves a
  pre-per-profile single sign-in onto the one profile entitled to it. No
  imports at all, so it is unit-testable under plain `node`
  (`tools/test-tokenStore.mjs`).
- `src/lib/uiStyle.js` — the UI settings: a table (`UI_STYLE_GROUPS`) of
  every style value preferences can change, each group on exactly one of
  the `UI_PAGES` tabs (`page`: `shared`, `topbar` or `popup`), each value with an id
  (`panel-tier.font-size`, `usage-text.warn`), a type (`px`, `pt`,
  `color`, `choice`, `bool`), its default, and its targets (style class,
  optional state class, `ok`/`warn`/`crit` or `dim`, and CSS properties;
  none for a value the extension paints or acts on itself: the ring's, the
  `bold-numbers` switch, the percentage's `position` and `sign`). One value can have several targets, and that is
  the rule rather than the exception: values meant to be the same thing are
  one setting (the shared "Usage colors" for the ring, the bar gauge, the
  popup meters and their text; one spacing for the panel's boxes; one
  divider color for a line's `background-color` and a text's `color`; one
  line and spacing for every popup separator; one size and color for the
  popup's secondary text), so their defaults have to stay equal in the
  stylesheet, where they are declared once with a grouped selector. A value
  with `inherits` (made with `follow()`) has no default or stylesheet rule of its
  own: it follows the named value until overridden (`defaultValue()`, which
  walks a chain), and must be listed after it, so that its declaration comes
  later in an inline style and wins. That is how "Shared UI" works: its
  "Common values" (`muted.color`, `line.color`, `bar.border-radius`,
  `pct.font-weight`) target every class concerned and hold the default, and
  each element's own value on the other two tabs (`panel-tier.color`,
  `secondary.color`, `separator.color`, …) follows one of them, so the shared
  groups come first in the table. The model tag follows the window tag the
  same way, within one tab. An unchanged follower writes nothing, so the
  value it follows must have the same state targets (a test checks it). A
  `def: null` without `inherits` means "the panel's own" and is for the
  percentage's color and font size only. A group may also list `settings`, plain string
  GSettings keys (`panel-lead-divider`, `panel-divider`) that the page
  edits, resets and counts too (`textSettingChanged`). "Reset all" is per
  tab: `changedCount(settings, page)` and `resetPage(settings, page)`.
  stylesheet.css remains the source of the
  defaults and a test checks the table agrees with it, so change both
  together. Only values that differ from their default are stored
  (`loadOverrides`/`setOverride` over the `ui-style` JSON
  key; unknown ids and invalid values are dropped, which also keeps anything
  unsafe out of an inline style). `uiStyle(overrides)` resolves them:
  `inline(cls, state)`, `value(id)`, `rgba(id)`, `overridden(id)`. To make
  another value editable, add it to the table (and to stylesheet.css) and
  make sure its class gets an `applyInline()` in extension.js; tests check
  both. Left out on purpose: hover colors, `font-feature-settings`,
  `text-align`, and one-off margins. No imports, so it
  runs under plain `node` (`tools/test-uiStyle.mjs`).
- `src/lib/uiStylePage.js` — the "Shared UI" / "Top-Bar UI" / "Popup UI" preferences tabs
  built from that table (`buildUiStylePage(settings, window, pageId)`): one
  row per value (`[reset] [control]`, the reset button only
  while the value is changed; spin button, color button, dropdown or switch
  by type; an entry for a group's `settings`) and that tab's "Reset all"
  button with an `Adw.AlertDialog` confirmation. A row whose value follows
  one on another tab says so in its subtitle, shows the followed value until
  it has its own, and names it in its reset tooltip (`followed()`). Imports Gtk, so it is for prefs.js only:
  never import it from extension.js. No shell imports, so
  `tools/test-uiStylePage.js` drives the real page under plain `gjs`.
- `src/lib/oauth.js` — shared OAuth/API constants (client id, endpoints,
  scopes, headers) and text codecs, imported by both `usageClient.js` and
  `prefs.js` so the values are defined once. No shell imports.
- `src/lib/usageModel.js` — pure data-shaping: turns the usage payload into the
  ordered list of windows the popup renders (`normalizeWindows`, preferring the
  self-describing `limits[]` array and falling back to the legacy flat keys),
  the extra-usage money block (`normalizeSpend`), and the panel's window
  selection (`selectPanelWindows` over the `panel-windows` selectors,
  `windowTag` for the short panel tags, `migratePanelWindows` for the
  `panel-window` upgrade). No GI or shell imports, so it is unit-testable
  under plain `node` (see `tools/test-usageModel.mjs`).
- `src/stylesheet.css` — `cu-*` classes for the indicator and popup, and the
  defaults of every UI setting. Values shared between classes are declared
  once with a grouped selector (the first block, the panel's spacing, the
  popup's secondary text and separator lines); keep it that way, since one
  setting drives all of them. Only classes that extension.js uses.
- `src/icons/` — panel icon (`claude-spark.svg`), popup logo
  (`octopus.png`), and the recolorable tier icons
  (`tier-<name>-symbolic.svg`, one per name in `TIER_ICONS`). `assets/` holds
  repo-only originals that stay out of the bundle (`assets/tier-icons/`).
- `build.sh` — runs `gnome-extensions pack src` into `dist/`, including `lib`,
  `icons`, and the schema; excludes dev files. Output is the uploadable
  `dist/<uuid>.shell-extension.zip`. Accepts an optional `-major`/`-minor`/
  `-patch` flag that bumps `version-name` (semver) in `metadata.json` and
  increments the integer `version` before packing.
- `tools/poll.js` — standalone validator that hits the live API and prints the
  normalised windows + spend, run from the repo root: `gjs -m tools/poll.js`
  (defaults to `~/.claude`) or `gjs -m tools/poll.js ~/.claude-work` to check a
  specific profile.
- `tools/test-usageModel.mjs` — pure-`node` unit tests for `usageModel.js`
  (no network, no GI): `node tools/test-usageModel.mjs`.
- `tools/test-uiStyle.mjs` — the same for `uiStyle.js`, including the check
  that its defaults match `src/stylesheet.css`: `node tools/test-uiStyle.mjs`.
- `tools/test-uiStylePage.js` — builds all three UI tabs against
  in-memory settings and drives its controls (needs a display and a compiled
  schema; shows no window): `gjs -m tools/test-uiStylePage.js`.

## Data sources

- Tier: `~/.claude/.credentials.json` (`claudeAiOauth.subscriptionType` /
  `rateLimitTier`), confirmed via `GET https://api.anthropic.com/api/oauth/profile`.
- Limits: `GET https://api.anthropic.com/api/oauth/usage`. The current shape is
  a self-describing `limits[]` array — each entry has `kind`
  (`session`/`weekly_all`/`weekly_scoped`), `group` (`session`/`weekly`),
  `percent`, `severity` (`normal`/`warning`/`critical`), `resets_at`,
  `is_active`, and an optional `scope.model.display_name` naming a per-model
  window (e.g. Fable). Money now comes as a structured `spend` object
  (`used`/`limit` as `{amount_minor, currency, exponent}` + `percent` +
  `severity`). The older flat keys (`five_hour`, `seven_day`,
  `seven_day_<model>` with `utilization` %, plus `extra_usage`) are still parsed
  as a fallback in `usageModel.js`. Required headers:
  `Authorization: Bearer <token>`, `anthropic-beta: oauth-2025-04-20`,
  `anthropic-version: 2023-06-01`.
- Refresh: `POST https://platform.claude.com/v1/oauth/token` with
  `grant_type=refresh_token` and the public Claude Code `client_id`.

These are undocumented internal endpoints and may change without notice.

## Conventions

- All file I/O must stay cheap and non-blocking; never parse large transcripts on
  the shell main loop (it janks the compositor). Network calls use libsoup async,
  and file reads/writes use the `_async` GIO variants — the review tooling
  rejects synchronous `load_contents()` / `replace_contents()` in shell code.
- Keep `src/lib/usageClient.js` and `src/lib/usageModel.js` free of
  `resource:///org/gnome/shell` imports so they stay runnable under plain `gjs`
  (both are also imported by `prefs.js` or the tools).

### Teardown rules

extensions.gnome.org runs a static analysis (Shexli) on every upload, and it
checks these mechanically. Getting them wrong fails review, so:

- **Connect signals with `connectObject(..., this)`, never a bare `connect()`**,
  and drop them with a single `disconnectObject(this)` during teardown. A raw
  `connect()` stored on a `this.*` field with no matching disconnect is flagged
  (EGO-L-003). Disconnect *before* destroying the actors, so nothing fires
  mid-teardown.
- **Destroy every object you create, explicitly.** Call `.destroy()` on each
  child widget (leaf-first, then the container) rather than relying on the
  parent to cascade — the analyser matches each `this._x = new St.…` against a
  corresponding `this._x.destroy()` and cannot infer cascading (EGO-L-002).
- **Null the references afterwards** (`this._x = null`), and null the indicator
  in `disable()` (EGO-L-005). Prefer this over a `this._destroyed` flag; guard
  late async callbacks with a `Gio.Cancellable` that teardown cancels.

Helper classes that own widgets (`Meter`, `PanelBar`) therefore each expose a
`destroy()` that follows all three rules; call it from the indicator's
`destroy()`.

## Install (development)

Symlink `src/` (not the repo root) into the extensions folder:

```sh
ln -s "$PWD/src" ~/.local/share/gnome-shell/extensions/claude-usage@dvdstelt.github.io
glib-compile-schemas "$PWD/src/schemas/"
gnome-extensions enable claude-usage@dvdstelt.github.io
```

On Wayland a new extension only loads after logging out and back in.

## Release

`./build.sh` packs `src/` into `dist/<uuid>.shell-extension.zip` for upload to
extensions.gnome.org. The bundle contains only runtime files.

# Claude Code Usage Monitor (GNOME Shell extension)

A GNOME Shell panel indicator that shows your Claude subscription tier and live
usage limits (5-hour and 7-day windows). It reuses the OAuth token that Claude
Code already stores on disk, so there is usually no separate login. When Claude
Code is not signed in, prefs offers an in-app PKCE sign-in as a fallback; that
sign-in group is hidden whenever Claude Code credentials are present.

## Layout

The shipped extension lives in `src/`; everything else (this file, the README,
the LICENSE, `build.sh`, `tools/`) is repo tooling that stays out of the bundle.

- `src/extension.js` — panel indicator + dropdown UI (ESM, GNOME Shell 45+
  style). The panel shows a Claude icon, a Cairo-drawn usage ring, a percentage,
  an optional time-until-reset countdown, and a tier label; each is
  independently toggleable via GSettings.
- `src/prefs.js` — Adwaita preferences (element toggles, panel window, refresh
  interval), bound to GSettings. Also hosts the fallback PKCE sign-in flow,
  shown only when `claudeCodeCredentialsAvailable()` is false.
- `src/schemas/` — GSettings schema (`org.gnome.shell.extensions.claude-usage`).
  Keys: `show-icon`/`show-percentage`/`show-tier`/`show-reset` (bool),
  `panel-gauge` (`ring`|`bar`|`none`),
  `panel-window` (`five-hour`|`seven-day`|`max`|`worst`), `poll-seconds` (30-600),
  and the in-app sign-in tokens `access-token`/`refresh-token` (string) +
  `expires-at` (int64 ms). Recompile after edits:
  `glib-compile-schemas src/schemas/`.
- `src/lib/usageClient.js` — pure GI module: resolves a token (Claude Code's
  on-disk credentials first, the extension's own GSettings tokens second),
  calls the usage and profile endpoints, refreshes the token when near expiry,
  and writes it back to whichever store it came from. Exports
  `claudeCodeCredentialsAvailable()` for prefs. Soup is pinned inline via
  `gi://Soup?version=3.0` (some systems still ship the 2.4 typelib).
- `src/lib/oauth.js` — shared OAuth/API constants (client id, endpoints,
  scopes, headers) and text codecs, imported by both `usageClient.js` and
  `prefs.js` so the values are defined once. No shell imports.
- `src/lib/usageModel.js` — pure data-shaping: turns the usage payload into the
  ordered list of windows the popup renders (`normalizeWindows`, preferring the
  self-describing `limits[]` array and falling back to the legacy flat keys) and
  the extra-usage money block (`normalizeSpend`). No GI or shell imports, so it
  is unit-testable under plain `node` (see `tools/test-usageModel.mjs`).
- `src/stylesheet.css` — `cu-*` classes for the indicator and popup.
- `src/icons/` — panel icon (`claude-spark.svg`) and popup logo
  (`octopus.png`).
- `build.sh` — runs `gnome-extensions pack src` into `dist/`, including `lib`,
  `icons`, and the schema; excludes dev files. Output is the uploadable
  `dist/<uuid>.shell-extension.zip`. Accepts an optional `-major`/`-minor`/
  `-patch` flag that bumps `version-name` (semver) in `metadata.json` and
  increments the integer `version` before packing.
- `tools/poll.js` — standalone validator that hits the live API and prints the
  normalised windows + spend, run from the repo root: `gjs -m tools/poll.js`.
- `tools/test-usageModel.mjs` — pure-`node` unit tests for `usageModel.js`
  (no network, no GI): `node tools/test-usageModel.mjs`.

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

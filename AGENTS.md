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
  and a tier label; each is independently toggleable via GSettings.
- `src/prefs.js` — Adwaita preferences (element toggles, panel window, refresh
  interval), bound to GSettings. Also hosts the fallback PKCE sign-in flow,
  shown only when `claudeCodeCredentialsAvailable()` is false.
- `src/schemas/` — GSettings schema (`org.gnome.shell.extensions.claude-usage`).
  Keys: `show-icon`/`show-percentage`/`show-tier` (bool),
  `panel-gauge` (`ring`|`bar`|`none`),
  `panel-window` (`five-hour`|`seven-day`|`max`), `poll-seconds` (30-600),
  and the in-app sign-in tokens `access-token`/`refresh-token` (string) +
  `expires-at` (int64 ms). Recompile after edits:
  `glib-compile-schemas src/schemas/`.
- `src/lib/usageClient.js` — pure GI module: resolves a token (Claude Code's
  on-disk credentials first, the extension's own GSettings tokens second),
  calls the usage and profile endpoints, refreshes the token when near expiry,
  and writes it back to whichever store it came from. Exports
  `claudeCodeCredentialsAvailable()` for prefs.
- `src/lib/versions.js` — pins `Soup` to 3.0; must be imported before
  `gi://Soup` (ESM evaluates imported modules in source order, so the version is
  set before the typelib loads).
- `src/stylesheet.css` — `cu-*` classes for the indicator and popup.
- `src/icons/` — panel and popup SVGs.
- `build.sh` — runs `gnome-extensions pack src` into `dist/`, including `lib`,
  `icons`, and the schema; excludes dev files. Output is the uploadable
  `dist/<uuid>.shell-extension.zip`.
- `tools/poll.js` — standalone validator, run from the repo root:
  `gjs -m tools/poll.js`.

## Data sources

- Tier: `~/.claude/.credentials.json` (`claudeAiOauth.subscriptionType` /
  `rateLimitTier`), confirmed via `GET https://api.anthropic.com/api/oauth/profile`.
- Limits: `GET https://api.anthropic.com/api/oauth/usage` returns `five_hour`,
  `seven_day`, `seven_day_sonnet` (each `utilization` % + `resets_at`) and
  `extra_usage`. Required headers: `Authorization: Bearer <token>`,
  `anthropic-beta: oauth-2025-04-20`, `anthropic-version: 2023-06-01`.
- Refresh: `POST https://platform.claude.com/v1/oauth/token` with
  `grant_type=refresh_token` and the public Claude Code `client_id`.

These are undocumented internal endpoints and may change without notice.

## Conventions

- All file I/O must stay cheap and non-blocking; never parse large transcripts on
  the shell main loop (it janks the compositor). Network calls use libsoup async.
- Keep `src/lib/usageClient.js` free of `resource:///org/gnome/shell` imports so
  it stays runnable under plain `gjs` (it is also imported by `prefs.js`).

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

# Claude Code Usage Monitor

A GNOME Shell panel indicator that shows your Claude subscription tier and live
usage limits right in the top bar, so you can see how much of your 5-hour and
7-day windows you have left without opening a browser.

It reuses the OAuth token that Claude Code already stores on disk, so for most
people there is nothing to log in to. If you do not use Claude Code (or its
saved sign-in has expired), the extension can sign in on its own from the
preferences window.

> [!NOTE]
> **What changed?** See the [changelog](CHANGELOG.md) for the notable changes in each release.

## Features

- **Panel indicator** with a Claude icon, a usage gauge (a circular ring or a horizontal bar, your choice, or none), a percentage, an optional time-until-reset countdown, and a subscription tier label. Each element can be toggled independently.
- **Multiple profiles.** If you run more than one Claude Code account on this machine (via `CLAUDE_CONFIG_DIR`, e.g. `~/.claude` and `~/.claude-work`), the extension shows every configured profile side by side in the panel and the dropdown, and refreshes them all together. Profiles are auto-detected on first run; add, rename, repoint, or remove them from the "Claude profiles" group in preferences.
- **Dropdown** with per-window meters: the 5-hour window, the 7-day window, and any per-model 7-day windows the API reports (for example Opus and Sonnet), discovered automatically.
- **Rate projection.** Meters, the ring, and the panel percentage are colored by your projected end-of-window usage at the current burn rate, so a fast burn turns amber or red before you actually hit the limit. When a window is on track to run out early, the caption spells it out (for example `burning fast — out in ~1h20m at this rate`); a window that is merely rising shows `on track for ~N% by reset`.
- **Live countdown.** The "resets in" captions tick down between polls, counting in seconds once a window is less than a minute from resetting.
- **Theme aware.** The ring track follows your panel text color, so it stays legible on both light and dark themes.
- **Configurable** refresh interval and choice of which window the panel reflects (5-hour, 7-day, or whichever is most constrained).

## Requirements

- GNOME Shell 46, 47, 48, 49, or 50 (Ubuntu 24.04 LTS and newer).
- Either:
  - **Claude Code** signed in (the extension reads
    `~/.claude/.credentials.json`, or another profile directory you configure
    in preferences), or
  - an in-app sign-in via the preferences window (see Authentication below).

## Install

### From the extensions website

Install it from [extensions.gnome.org](https://extensions.gnome.org/extension/10086/claude-code-usage-monitor/) (the schema is compiled for you on install).

### From source (development)

The extension source lives in `src/`. Symlink that directory into the GNOME extensions folder:

```sh
git clone https://github.com/dvdstelt/ClaudeCodeUsage.git
ln -s "$PWD/ClaudeCodeUsage/src" \
  ~/.local/share/gnome-shell/extensions/claude-usage@dvdstelt.github.io
glib-compile-schemas "$PWD/ClaudeCodeUsage/src/schemas/"
gnome-extensions enable claude-usage@dvdstelt.github.io
```

On Wayland a newly installed extension only loads after you log out and back in.
On X11 you can reload the shell with `Alt+F2`, then `r`, then Enter.

### Building a release

To produce the bundle you upload to extensions.gnome.org:

```sh
./build.sh
```

This writes `dist/claude-usage@dvdstelt.github.io.shell-extension.zip`,
containing only the runtime files (no README, license, tools, or mockups).
Upload it at <https://extensions.gnome.org/upload/>.

To bump the version while building, pass one of `-major`, `-minor`, or
`-patch`:

```sh
./build.sh -patch   # 1.1.1 -> 1.1.2
./build.sh -minor   # 1.1.1 -> 1.2.0
./build.sh -major   # 1.1.1 -> 2.0.0
```

A bump rewrites `version-name` in `src/metadata.json` and also increments the integer `version` field, which extensions.gnome.org requires to increase on every upload.

## Configuration

Open the preferences from the dropdown (the gear button) or with:

```sh
gnome-extensions prefs claude-usage@dvdstelt.github.io
```

- **Panel elements** - show or hide the icon, percentage, time until reset, and tier, and choose the usage gauge (circle, bar, or none).
- **Panel reflects** - which window the ring, percentage, and time-until-reset countdown track: the 5-hour window, the 7-day window, or whichever is most constrained.
- **Refresh interval** - how often to poll for updated usage (30 to 600 seconds; default 300).

## Authentication

The extension never asks for your password. It uses an OAuth token in one of two ways:

1. **Claude Code (preferred).** If `~/.claude/.credentials.json` contains a valid token, the extension uses it directly. When the token is close to expiry it is refreshed automatically with the stored refresh token and written back to the same file, so it stays valid whether or not Claude Code itself is running. Because the credentials are shared, you stay signed in to both. If those credentials have fully expired (for example you only use Claude Desktop and never sign in to the Claude Code CLI), the extension falls back to the in-app sign-in below.
2. **In-app sign-in (fallback).** Every profile has its own **Connect** button in its row under "Claude profiles", so each profile can sign in to its own Claude account without the CLI. It runs a standard PKCE OAuth flow: Connect opens your browser, you authorize, and paste the resulting code back into the preferences window. Tokens are stored per profile in GSettings and refreshed automatically before they expire. A profile that is already signed in through Claude Code says so and needs nothing here.

## How it works

`lib/usageClient.js` resolves a valid access token (Claude Code's on-disk credentials first, the extension's own tokens second), then calls Anthropic's OAuth usage and profile endpoints. It is a plain GI module with no GNOME Shell imports, so it can be run and tested on its own:

```sh
gjs -m tools/poll.js
```

The endpoints used are undocumented, internal Anthropic OAuth endpoints and may change without notice.

## Development

The repository is laid out as:

- `src/` - everything that ships in the extension bundle:
  - `extension.js` - panel indicator and dropdown UI.
  - `prefs.js` - Adwaita preferences, including the fallback sign-in flow.
  - `stylesheet.css` - panel and popup styling.
  - `lib/usageClient.js` - token resolution, refresh, and the usage/profile
    calls, parameterized by config directory so each profile gets its own
    client.
  - `lib/profiles.js` - the profile list (label + config directory), stored as
    JSON in GSettings; auto-detects `~/.claude` and sibling `~/.claude-*`
    directories on first run.
  - `lib/tokenStore.js` - per-profile in-app OAuth tokens, stored as JSON in
    GSettings and keyed by profile id.
  - `lib/oauth.js` - shared OAuth/API constants and text codecs used by both
    the usage client and prefs.
  - `schemas/` - GSettings schema. Recompile after edits with
    `glib-compile-schemas src/schemas/`.
  - `icons/` - panel and popup icons.
- `build.sh` - packages `src/` into an uploadable bundle in `dist/`.
- `tools/poll.js` - standalone validator for the usage client; run from the
  repository root with `gjs -m tools/poll.js`.

See `AGENTS.md` for the data sources and conventions in more detail.

## Contributors

Built by [@dvdstelt](https://github.com/dvdstelt), with thanks to everyone who has contributed:

- [@amalakhovsky](https://github.com/amalakhovsky) - rendering every usage window dynamically from the API's `limits[]` array (per-model windows such as Fable, the "worst active limit" panel option, structured spend), and fixing the popup bars to fill completely at 100%.
- [@ClemDNL](https://github.com/ClemDNL) - the optional time-until-reset countdown in the panel.

Pull requests are welcome. See `AGENTS.md` for the layout and conventions, and the [changelog](CHANGELOG.md) for what has landed so far.

## License

Released under the GNU General Public License, version 2 or later (GPL-2.0-or-later). See `LICENSE` for the full text.

## Disclaimer

This is an unofficial, community project. It is not affiliated with or endorsed by Anthropic. It relies on internal endpoints that may change at any time.

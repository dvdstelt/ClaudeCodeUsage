# Claude Code Usage Monitor

A GNOME Shell panel indicator that shows your Claude subscription tier and live
usage limits right in the top bar, so you can see how much of your 5-hour and
7-day windows you have left without opening a browser.

It reuses the OAuth token that Claude Code already stores on disk, so for most
people there is nothing to log in to. If you do not use Claude Code (or its
saved sign-in has expired), the extension can sign in on its own from the
preferences window.

> **What changed?** See the [changelog](CHANGELOG.md) for the notable changes in
> each release.

## Features

- **Panel indicator** with a Claude icon, a usage gauge (a circular ring or a
  horizontal bar, your choice, or none), a percentage, an optional time-until-
  reset countdown, and a subscription tier label. Each element can be toggled
  independently.
- **Dropdown** with per-window meters: the 5-hour window, the 7-day window, and
  any per-model 7-day windows the API reports (for example Opus and Sonnet),
  discovered automatically.
- **Rate projection.** Meters, the ring, and the panel percentage are colored by
  your projected end-of-window usage at the current burn rate, so a fast burn
  turns amber or red before you actually hit the limit. When a window is on
  track to run out early, the caption spells it out (for example
  `burning fast — out in ~1h20m at this rate`); a window that is merely rising
  shows `on track for ~N% by reset`.
- **Live countdown.** The "resets in" captions tick down between polls, counting
  in seconds once a window is less than a minute from resetting.
- **Theme aware.** The ring track follows your panel text color, so it stays
  legible on both light and dark themes.
- **Configurable** refresh interval and choice of which window the panel
  reflects (5-hour, 7-day, or whichever is most constrained).

## Requirements

- GNOME Shell 48, 49, or 50.
- Either:
  - **Claude Code** signed in (the extension reads
    `~/.claude/.credentials.json`), or
  - an in-app sign-in via the preferences window (see Authentication below).

## Install

### From the extensions website

Install it from
[extensions.gnome.org](https://extensions.gnome.org/) (the schema is compiled
for you on install).

### From source (development)

The extension source lives in `src/`. Symlink that directory into the GNOME
extensions folder:

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

A bump rewrites `version-name` in `src/metadata.json` and also increments the
integer `version` field, which extensions.gnome.org requires to increase on
every upload.

## Configuration

Open the preferences from the dropdown (the gear button) or with:

```sh
gnome-extensions prefs claude-usage@dvdstelt.github.io
```

- **Panel elements** - show or hide the icon, percentage, time until reset, and
  tier, and choose the usage gauge (circle, bar, or none).
- **Panel reflects** - which window the ring, percentage, and time-until-reset
  countdown track: the 5-hour window, the 7-day window, or whichever is most
  constrained.
- **Refresh interval** - how often to poll for updated usage (30 to 600
  seconds; default 300).

## Authentication

The extension never asks for your password. It uses an OAuth token in one of two
ways:

1. **Claude Code (preferred).** If `~/.claude/.credentials.json` contains a
   valid token, the extension uses it directly. When the token is close to
   expiry it is refreshed automatically with the stored refresh token and
   written back to the same file, so it stays valid whether or not Claude Code
   itself is running. Because the credentials are shared, you stay signed in to
   both. If those credentials have fully expired (for example you only use
   Claude Desktop and never sign in to the Claude Code CLI), the extension
   falls back to the in-app sign-in below.

2. **In-app sign-in (fallback).** When Claude Code has no valid token, the
   preferences window shows an **Account** group with a Connect button. It runs
   a standard PKCE OAuth flow: Connect opens your browser, you authorize, and
   paste the resulting code back into the preferences window. The tokens are
   stored in GSettings and refreshed automatically before they expire. This
   group is hidden whenever Claude Code has a valid token, since there is
   nothing to do in that case; it reappears once that token expires.

## How it works

`lib/usageClient.js` resolves a valid access token (Claude Code's on-disk
credentials first, the extension's own tokens second), then calls Anthropic's
OAuth usage and profile endpoints. It is a plain GI module with no GNOME Shell
imports, so it can be run and tested on its own:

```sh
gjs -m tools/poll.js
```

The endpoints used are undocumented, internal Anthropic OAuth endpoints and may
change without notice.

## Development

The repository is laid out as:

- `src/` - everything that ships in the extension bundle:
  - `extension.js` - panel indicator and dropdown UI.
  - `prefs.js` - Adwaita preferences, including the fallback sign-in flow.
  - `stylesheet.css` - panel and popup styling.
  - `lib/usageClient.js` - token resolution, refresh, and the usage/profile
    calls.
  - `lib/oauth.js` - shared OAuth/API constants and text codecs used by both
    the usage client and prefs.
  - `schemas/` - GSettings schema. Recompile after edits with
    `glib-compile-schemas src/schemas/`.
  - `icons/` - panel and popup icons.
- `build.sh` - packages `src/` into an uploadable bundle in `dist/`.
- `tools/poll.js` - standalone validator for the usage client; run from the
  repository root with `gjs -m tools/poll.js`.

See `AGENTS.md` for the data sources and conventions in more detail.

## License

Released under the GNU General Public License, version 2 or later
(GPL-2.0-or-later). See `LICENSE` for the full text.

## Disclaimer

This is an unofficial, community project. It is not affiliated with or endorsed
by Anthropic. It relies on internal endpoints that may change at any time.

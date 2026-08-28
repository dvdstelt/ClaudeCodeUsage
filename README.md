# Claude Code Usage Monitor

<img width="260" alt="image" align="right" src="https://github.com/user-attachments/assets/190b87b7-58cb-45f7-8782-788ca027d1b8" />

A GNOME Shell panel indicator that shows your Claude subscription tier and live
usage limits right in the top bar, so you can see how much of your 5-hour and
7-day windows you have left without opening a browser.

It reuses the OAuth token that Claude Code already stores on disk, so for most
people there is nothing to log in to. If you do not use Claude Code (or its
saved sign-in has expired), the extension can sign in on its own from the
preferences window.

> [!NOTE]
> **What changed?** See the [changelog](CHANGELOG.md) for the notable changes in each release.

See [install](#install) instructions

<br /><br />

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
- A **Claude Pro or Max subscription**. The extension reports the usage limits
  that come with a Claude Code subscription, so a free account has nothing to
  show and cannot be connected - authorization is refused before any token is
  issued, whether you sign in from the extension or from the CLI.
- Then either:
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

## Configuration

Open the preferences from the dropdown (the gear button) or with:

```sh
gnome-extensions prefs claude-usage@dvdstelt.github.io
```

- **Panel elements** - show or hide the icon, percentage, time until reset, and tier, and choose the usage gauge (circle, bar, or none).
- **Panel reflects** - which window the ring, percentage, and time-until-reset countdown track: the 5-hour window, the 7-day window, or whichever is most constrained.
- **Panel position** - which section of the top bar the indicator sits in (left, center, or right), and where it sits among the other items there. Changes apply immediately.
- **Shortcut to open the popup** - an optional keyboard shortcut that opens the usage dropdown, the way `Super+S` opens GNOME's quick settings. Not set by default; click the row to record one, or the clear button to remove it.
- **Refresh interval** - how often to poll for updated usage (30 to 600 seconds; default 300).

## Authentication

The extension **never asks for your password**. It uses an OAuth token in one of two ways. Both require a Claude Pro or Max subscription: a free account is refused at Anthropic's authorization page, since it has no Claude Code usage limits to report.

1. **Claude Code (preferred).** If `~/.claude/.credentials.json` contains a valid token, the extension uses it directly. When the token is close to expiry it is refreshed automatically with the stored refresh token and written back to the same file, so it stays valid whether or not Claude Code itself is running. Because the credentials are shared, you stay signed in to both. If those credentials have fully expired (for example you only use Claude Desktop and never sign in to the Claude Code CLI), the extension falls back to the in-app sign-in below.
2. **In-app sign-in (fallback).** Every profile has its own **Connect** button in its row under "Claude profiles", so each profile can sign in to its own Claude account without the CLI. It runs a standard PKCE OAuth flow: Connect opens your browser, you authorize, and paste the resulting code back into the preferences window. Tokens are stored per profile in GSettings and refreshed automatically before they expire. A profile that is already signed in through Claude Code says so and needs nothing here.

## Development

See `AGENTS.md` for the data sources and conventions in detail.

## Contributors

Built by [@dvdstelt](https://github.com/dvdstelt), with thanks to everyone who has contributed:

- [@amalakhovsky](https://github.com/amalakhovsky) - rendering every usage window dynamically from the API's `limits[]` array (per-model windows such as Fable, the "worst active limit" panel option, structured spend), and fixing the popup bars to fill completely at 100%.
- [@ClemDNL](https://github.com/ClemDNL) - the optional time-until-reset countdown in the panel.
- [@rafi0x](https://github.com/rafi0x) - multiple profiles

Pull requests are welcome. See `AGENTS.md` for the layout and conventions, and the [changelog](CHANGELOG.md) for what has landed so far.

## License

Released under the GNU General Public License, version 2 or later (GPL-2.0-or-later). See `LICENSE` for the full text.

## Disclaimer

This is an unofficial, community project. It is not affiliated with or endorsed by Anthropic. It relies on internal endpoints that may change at any time.

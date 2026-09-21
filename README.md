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

- **Panel indicator** with a Claude icon, a usage gauge (a circular ring or a horizontal bar, your choice, or none), a percentage, an optional time-until-reset countdown, and the subscription tier as a label and/or an icon. Each element can be toggled independently.
- **Multiple profiles.** If you run more than one Claude Code account on this machine (via `CLAUDE_CONFIG_DIR`, e.g. `~/.claude` and `~/.claude-work`), the extension shows every configured profile side by side in the panel and the dropdown, and refreshes them all together. Profiles are auto-detected on first run; add, rename, repoint, or remove them from the "Claude profiles" group in preferences.
- **Dropdown** with per-window meters: the 5-hour window, the 7-day window, and any per-model 7-day windows the API reports (for example Opus and Sonnet), discovered automatically.
- **Rate projection.** Meters, the ring, and the panel percentage are colored by your projected end-of-window usage at the current burn rate, so a fast burn turns amber or red before you actually hit the limit. When a window is on track to run out early, the caption spells it out (for example `burning fast — out in ~1h20m at this rate`); a window that is merely rising shows `on track for ~N% by reset`.
- **Live countdown.** The "resets in" captions tick down between polls, counting in seconds once a window is less than a minute from resetting.
- **Themeable.** The gauge track is a neutral grey that reads on both light and dark themes, and every color, size, spacing and font in the panel and the popup can be changed from the UI preference tabs.
- **Configurable** refresh interval and choice of which windows the panel shows: any mix of the 5-hour window, the 7-day window, per-model windows such as Fable, whichever is most constrained, or the worst active limit, side by side.

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
cd ClaudeCodeUsage
ln -s "$PWD/src" \
  ~/.local/share/gnome-shell/extensions/claude-usage@dvdstelt.github.io
git config core.hooksPath tools/git-hooks
./tools/compile-schemas.sh
gnome-extensions enable claude-usage@dvdstelt.github.io
```

The `core.hooksPath` line keeps the compiled GSettings schema in step with
whatever branch you have checked out. The extensions folder symlinks `src/`, so
the code follows a branch switch instantly, but the compiled schema is a
gitignored build artifact - without the hooks, checking out a branch that adds a
setting leaves the extension failing to start with `GSettings key … not found in
schema`. Run `./tools/compile-schemas.sh` any time to fix that by hand.

On Wayland a newly installed extension only loads after you log out and back in.
On X11 you can reload the shell with `Alt+F2`, then `r`, then Enter.

## Configuration

Open the preferences from the dropdown (the gear button) or with:

```sh
gnome-extensions prefs claude-usage@dvdstelt.github.io
```

- **Panel elements** - show or hide the Claude icon, percentage, time until reset, subscription tier label, and subscription tier icon (Max 5x / 20x use the Max icon; a tier without artwork shows none), and choose the usage gauge (circle, bar, or none).
- **Panel reflects** - which windows get a gauge (ring or bar, percentage, time-until-reset countdown) in the panel. Switch on any combination of the 5-hour window, the 7-day window, the per-model 7-day windows (e.g. Fable), whichever window is most constrained, and the worst active limit. With more than one switched on the gauges sit side by side, each with a short tag (5h, 7d, or the model name), separated by the window divider. The 7-day windows reset together, so they are shown as one group: no divider between them and a single time-until-reset after the last one. With none of them switched on the panel falls back to the 5-hour window; to show no gauge at all, set the gauge to "None" and turn off the usage percentage under **Panel elements**.
- **Panel position** - which section of the top bar the indicator sits in (left, center, or right), and where it sits among the other items there. Changes apply immediately.
- **Shortcut to open the popup** - an optional keyboard shortcut that opens the usage dropdown, the way `Super+S` opens GNOME's quick settings. Not set by default; click the row to record one, or the clear button to remove it.
- **Refresh interval** - how often to poll for updated usage (30 to 600 seconds; default 300).

The settings above are on the **General** tab. Three more tabs hold the look of the extension: **Shared UI** for what the top bar and the popup have in common, **Top-Bar UI** for the indicator in the top bar, and **Popup UI** for the popup that opens from it. Between them they cover the sizes, spacing, padding, font sizes and weights, corner radii and colors in use, and each value is on exactly one tab. Changes apply immediately. A value you changed gets a reset button next to it, and once anything on a tab is changed a **Reset all** button at the top of that tab puts its values back to their defaults, after asking for confirmation.

**Shared UI** holds two groups:

- **Usage colors** - normal / warning / critical, their text colors, and the track, for the top bar's gauges and the popup's meters alike.
- **Common values** - the *muted text color* (the tier label, the tags and the countdown in the top bar, the secondary text in the popup), the *divider and separator color*, the *bar corner radius* (the bar gauge and the popup's meters) and the *percentage font weight*. Each of these is a base: every element still has its own value on the Top-Bar UI or Popup UI tab, which follows the shared one until you change it there, and follows it again when you reset it.

Within a tab the same holds: one line width and spacing covers every separator line in the popup, and one size covers all of its secondary text. A few of the top-bar groups are worth knowing:

- **Usage percentage** - *Position* puts the percentage next to the gauge (the default) or on top of it: inside the circle, or over the bar. It only fits on the gauge with a smaller *font size* (by default the panel's own) or a larger gauge, and inside the circle it reads best with *Show the % sign* switched off. Over the bar it stays in its normal color, since the warning and critical text colors are hard to read on a fill of the same color.

- **Model tag** - the model name (for example `Fable`) before a per-model gauge can have its own font size, weight and color. Each one follows the window tag (`5h`, `7d`) until you change it.
- **Time until reset** - *Bold numbers* shows `1h19m` with the `1` and the `19` in bold and the `h` and the `m` regular.
- **Dividers** - the *lead divider* sits between the leading elements (Claude icon, profile tag, subscription tier) and the gauges, and between profiles; the *window divider* sits between usage windows. For either one, a single `|` draws a thin vertical line (the lead divider's default), any other text (for example `·`) is shown as typed, and blank shows nothing. One color applies to both kinds; a line also has a width and a height, and text a font size.

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

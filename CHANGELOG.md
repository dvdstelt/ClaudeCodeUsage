# Changelog

All notable changes to Claude Code Usage Monitor are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

## 1.4.1 - 2026-08-26

### Added
- A "Buy me a coffee" button in the preferences footer, next to Report a bug
  and Request a feature, and a ko-fi link on the extension's page alongside the
  existing PayPal one.

## 1.4.0 - 2026-08-26

Thanks to @rafi0x for the multiple-profile support.

### Added
- Support for multiple Claude Code profiles (separate `CLAUDE_CONFIG_DIR`
  accounts, e.g. `~/.claude` and `~/.claude-work`). All configured profiles are
  shown side by side in the panel and the dropdown, and refresh together with
  a single "Refresh all" action. Profiles are auto-detected on first run and
  can be renamed, repointed, added, or removed from a new "Claude profiles"
  group in preferences.
- A profile whose config directory has no Claude Code login is now shown as
  signed out, instead of silently displaying another account's usage.
- Each profile can sign in to its own Claude account, from its own row in
  preferences, so a second account no longer needs the Claude Code CLI. Tokens
  are kept per profile, and an existing single sign-in is carried over on
  upgrade rather than being lost.
- The indicator can be placed in any section of the top bar - left, center, or
  right - and positioned among the other items there, without needing a
  separate panel-organiser extension (#1).
- An optional keyboard shortcut opens the usage popup, the way `Super+S` opens
  GNOME's quick settings. Not set by default (#13).
- A "Profile tag" toggle hides the short two-letter tag shown before each
  profile's gauge, for anyone who would rather keep the panel narrow.

### Changed
- GNOME Shell 46 and 47 are now supported (previously 48-50 only), covering
  Ubuntu 24.04 LTS.
- The account name now appears in each profile's subtitle (for example
  "Dennis · Claude Code · active"), so it stays visible now that the popup
  header shows the profile's own label.
- The subscription pill follows the plan the API reports rather than a fixed
  list, so team and enterprise seats are labelled correctly.
- Each profile has its own header in the popup - its own logo and the name you
  gave it - instead of one static heading above the list. With a single profile
  the popup reads the way it did before profiles existed.
- The "Updated" time sits once at the bottom of the popup instead of being
  repeated in every profile section, since all profiles refresh together.
- "Remove this profile" is only offered when another profile would remain, so
  the last one cannot be deleted by accident.

## 1.3.0 - 2026-08-21

Thanks to @amalakhovsky, who contributed everything in this release: the
dynamic `limits[]` rework and the 100% bar fill.

### Added
- Per-model usage windows. Anthropic's usage endpoint now reports its windows in
  a self-describing `limits[]` array that includes model-scoped limits (e.g. a
  weekly Fable window). The popup renders one meter per reported window
  dynamically, so any current or future model the API breaks out shows up
  automatically instead of being silently dropped.
- A "Worst active limit" option for *Panel reflects*, so the top-bar gauge can
  surface whichever limit is most severe right now — a maxed-out per-model
  window reaches the panel even when the 5-hour and 7-day totals are calm.

### Changed
- Gauge colors are now floored at the severity the API reports for each window:
  the existing burn-consequence coloring still applies, but a window the API
  flags as warning/critical never reads calmer than that.
- The extra-usage line now uses the structured `spend` object (authoritative
  amount, limit, percentage, and severity) when present, falling back to the
  older `extra_usage` field — and scales it by the API's own decimal places
  instead of assuming cents. It tints amber/red with the spend severity.

### Fixed
- The popup usage bars now fill completely at 100%. The fill was sized from a
  fixed pixel constant while the track stretches to the popup's width, so a
  maxed-out window stopped a few pixels short of the end; the fill is now sized
  as a fraction of the track's actual width and always reaches the end.

## 1.1.2 - 2026-07-10

### Changed
- Gauge colors now reflect the *consequence* of a fast burn, not just the
  projected percentage. A window only turns red when you're out of headroom now
  or would be locked out for a meaningful stretch; a burn that only just runs
  out right before the reset stays amber. The caption matches (e.g. "on pace to
  run out just before reset" instead of "burning fast").
- Long dropdown captions (and the extra-usage / error lines) now wrap onto a
  second line instead of running off the edge of the popup.

## 1.1.1 - 2026-06-25

### Changed
- The preferences sign-in section now appears whenever the on-disk Claude Code
  token is expired, instead of staying hidden behind stale credentials.

## 1.1.0 - 2026-06-24

### Added

- Fallback to the in-app (browser) sign-in when Claude Code's stored
  credentials are unusable — so the extension works for people who only use
  Claude Desktop and never sign in to the Claude Code CLI.

### Fixed

- A failed token refresh (e.g. an expired refresh token) now shows a clear
  "session expired, sign in again" message instead of a cryptic "HTTP 400".

## 1.0.3 - 2026-06-22

### Added
- Optional time-until-reset countdown in the panel, next to the gauge and
  percentage (Panel elements ▸ Time until reset; off by default). It follows
  the same window as "Panel reflects" and ticks down live between polls.
  Thanks to @ClemDNL.

## 1.0.2 - 2026-06-08

### Added
- A PayPal donation link on the extension's page.

### Changed
- The rate-projection warning now explains itself: instead of a bare
  "proj N%", a window burning fast enough to run out early reads
  "burning fast — out in ~Xh Ym at this rate", and a slower-rising window
  reads "on track for ~N% by reset".

## 1.0.1 - 2026-06-08

### Changed
- Internal maintenance for extensions.gnome.org review compliance: switched to
  asynchronous credential file access, explicit teardown of panel widgets, and
  proper signal cleanup. No user-facing changes.

## 1.0.0 - 2026-06-04

### Added
- Initial release.
- Panel indicator with a Claude icon, a usage gauge (circular ring, horizontal
  bar, or none), a usage percentage, and a subscription tier label — each
  toggleable independently.
- Dropdown with per-window meters: the 5-hour window, the 7-day window, and any
  per-model 7-day windows the API reports (e.g. Opus, Sonnet), discovered
  automatically.
- Rate projection: meters, the ring, and the panel percentage are colored by
  projected end-of-window usage at the current burn rate.
- Live countdown: the "resets in" captions tick down between polls.
- Theme-aware ring that follows the panel text color on light and dark themes.
- Configurable refresh interval and choice of which window the panel reflects
  (5-hour, 7-day, or whichever is most constrained).
- Reuses Claude Code's existing OAuth token (refreshing it when near expiry), or
  an in-app PKCE browser sign-in from preferences when Claude Code is not
  present.
- Supports GNOME Shell 48, 49, and 50.

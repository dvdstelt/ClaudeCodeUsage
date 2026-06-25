# Changelog

All notable changes to Claude Code Usage Monitor are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

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

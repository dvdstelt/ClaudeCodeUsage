import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import Cairo from 'cairo';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {UsageClient, UsageError, SignedOutError, defaultConfigDir} from './lib/usageClient.js';
import {loadProfiles, ensureProfiles} from './lib/profiles.js';
import {normalizeWindows, normalizeSpend} from './lib/usageModel.js';

const USAGE_SETTINGS_URL = 'https://claude.ai/settings/usage';

// Severity levels, least to most severe.
const LEVEL_RANK = {ok: 0, warn: 1, crit: 2};

// Severity from a raw utilization %: how full the bucket is right now.
function utilLevel(util) {
    if (util >= 90)
        return 'crit';
    if (util >= 75)
        return 'warn';
    return 'ok';
}

// The more severe of two levels.
function maxLevel(a, b) {
    return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
}

// Style-class suffix for a level (cu-ok / cu-warn / cu-crit).
function levelClass(level) {
    return `cu-${level}`;
}

// RGB triple for a level, for Cairo painting.
function levelRgb(level) {
    if (level === 'crit')
        return [0.88, 0.11, 0.14]; // #e01b24
    if (level === 'warn')
        return [1.0, 0.47, 0.0];   // #ff7800
    return [0.2, 0.82, 0.48];      // #33d17a
}

const RING_SIZE = 18;
const RING_WIDTH = 3;
const PANEL_BAR_WIDTH = 34;

// StThemeNode colors are Cogl.Color. Across GNOME Shell versions the
// components come back either as 0-255 bytes or as 0-1 floats depending on
// the GJS build, so detect the scale instead of assuming one. Returns an
// [r, g, b] float triple.
function colorRgb(c) {
    const scale = Math.max(c.red, c.green, c.blue) > 1 ? 255 : 1;
    return [c.red / scale, c.green / scale, c.blue / scale];
}

// Collapse refreshes that land closer together than this. Opening the popup
// triggers a refresh, and so does the poll timer; without a floor the two can
// fire back-to-back and the second request is rate-limited (429) by the API.
const MIN_REFRESH_MS = 60 * 1000;

// Projected end-of-window utilization at the current consumption rate. Returns
// the larger of actual and projected, falling back to actual when the window
// has barely started (too little signal) or reports no reset time.
function projectedUtil(util, resetsAtIso, totalSeconds) {
    const target = Date.parse(resetsAtIso ?? '');
    if (Number.isNaN(target) || !totalSeconds)
        return util;
    const remaining = (target - Date.now()) / 1000;
    if (remaining <= 0)
        return util;
    const elapsed = totalSeconds - remaining;
    if (elapsed <= 0 || elapsed / totalSeconds < 0.05)
        return util;
    return Math.max(util, (util * totalSeconds) / elapsed);
}

// Seconds from now until utilization would hit 100% at the average rate so far
// this window, but only when that exhaustion lands before the window resets
// (i.e. the current pace really does overrun the limit). Returns null
// otherwise, using the same early-window guard as projectedUtil so we don't
// extrapolate from noise.
function exhaustSeconds(util, resetsAtIso, totalSeconds) {
    const target = Date.parse(resetsAtIso ?? '');
    if (Number.isNaN(target) || !totalSeconds || util <= 0)
        return null;
    const remaining = (target - Date.now()) / 1000;
    if (remaining <= 0)
        return null;
    const elapsed = totalSeconds - remaining;
    if (elapsed <= 0 || elapsed / totalSeconds < 0.05)
        return null;
    const toExhaust = (elapsed * (100 - util)) / util;
    return toExhaust > 0 && toExhaust < remaining ? toExhaust : null;
}

// Human-friendly duration trimmed to the two largest units: "30s", "45m",
// "4h 21m", "2d 5h". sep sets what goes between the two units, e.g. '' for the
// compact panel form ("4h21m").
function humanDuration(seconds, sep = ' ') {
    const s = Math.max(0, Math.floor(seconds));
    if (s < 60)
        return `${s}s`;
    const mins = Math.round(s / 60);
    if (mins < 60)
        return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24)
        return `${hrs}h${sep}${mins % 60}m`;
    const days = Math.floor(hrs / 24);
    return `${days}d${sep}${hrs % 24}h`;
}

// Being locked out for at least this fraction of the window makes a fast burn
// "critical" (red). A shorter lockout (running out just before the reset) only
// warrants a warning (amber).
const LOCKOUT_CRIT_FRAC = 0.10;

// How long you'd be stuck at the limit before the window resets, in seconds, at
// the current burn rate, or null when the pace doesn't run out before reset.
function lockoutSeconds(util, resetsAtIso, totalSeconds) {
    const exhaust = exhaustSeconds(util, resetsAtIso, totalSeconds);
    if (exhaust === null)
        return null;
    const remaining = (Date.parse(resetsAtIso) - Date.now()) / 1000;
    return Math.max(0, remaining - exhaust);
}

// Severity for a usage window, based on the *consequence* of the current burn
// rather than the raw projected percentage. Red is reserved for "out of
// headroom now, or locked out for a meaningful stretch"; a burn that only just
// overruns right before the reset stays amber.
function windowLevel(util, resetsAtIso, totalSeconds) {
    // Floor: how full the bucket is right now, independent of timing.
    let level = utilLevel(util);

    const lockout = lockoutSeconds(util, resetsAtIso, totalSeconds);
    if (lockout !== null) {
        // Projected to run out before the reset: escalate by how long you'd be
        // locked out, as a fraction of the whole window.
        const projLevel = lockout >= totalSeconds * LOCKOUT_CRIT_FRAC ? 'crit' : 'warn';
        level = maxLevel(level, projLevel);
    } else {
        // Won't run out before the reset: a rising window can warn, but never
        // go critical from projection alone.
        if (projectedUtil(util, resetsAtIso, totalSeconds) >= 75)
            level = maxLevel(level, 'warn');
    }
    return level;
}

// Caption note explaining the projection, tied to the same lockout threshold as
// windowLevel so an amber gauge never reads "burning fast".
function projectionNote(util, resetsAtIso, totalSeconds) {
    const lockout = lockoutSeconds(util, resetsAtIso, totalSeconds);
    if (lockout !== null) {
        if (lockout >= totalSeconds * LOCKOUT_CRIT_FRAC) {
            const exhaust = exhaustSeconds(util, resetsAtIso, totalSeconds);
            return `burning fast — out in ~${humanDuration(exhaust)} at this rate`;
        }
        return 'on pace to run out just before reset';
    }
    const proj = projectedUtil(util, resetsAtIso, totalSeconds);
    if (proj >= 75 && Math.round(proj) > Math.round(util))
        return `on track for ~${Math.round(proj)}% by reset`;
    return '';
}

// Plan label for the pill: the API's raw token (`subscriptionType` from disk or
// `organization_type` from the profile), prefix-stripped and cased — nothing
// mapped by name, so new plans show through. "CLAUDE" only if the API said
// nothing. A multiplier in the rate-limit tier ("…_20x") is appended.
function tierLabel(plan, rateLimitTier) {
    const base = String(plan ?? '')
        .replace(/^claude[_-]/i, '')
        .replace(/[_-]+/g, ' ')
        .trim()
        .toUpperCase() || 'CLAUDE';
    const m = /(\d+)x/.exec(rateLimitTier ?? '');
    return m ? `${base} ${m[1]}x` : base;
}

// Short (1-2 letter) chip for a profile label, so the panel can distinguish
// multiple profiles without much width: "TechZu" -> "TE", "My Team" -> "MT".
function profileChip(label) {
    const words = (label ?? '').trim().split(/\s+/).filter(Boolean);
    if (words.length >= 2)
        return (words[0][0] + words[1][0]).toUpperCase();
    return (label ?? '').slice(0, 2).toUpperCase() || '?';
}

function relativeReset(iso) {
    const target = Date.parse(iso);
    if (Number.isNaN(target))
        return '';
    const diff = target - Date.now();
    if (diff <= 0)
        return 'resetting…';
    if (diff < 60000)
        return `resets in ${Math.floor(diff / 1000)}s`;
    const mins = Math.round(diff / 60000);
    if (mins < 60)
        return `resets in ${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24)
        return `resets in ${hrs}h ${mins % 60}m`;
    const days = Math.floor(hrs / 24);
    return `resets in ${days}d ${hrs % 24}h`;
}

// Compact "time until reset" for the panel: magnitude only, no "resets in"
// prefix, no separator between units ("4h21m"). Empty when the timestamp is
// missing or unparseable so the label collapses instead of showing junk.
function compactReset(iso) {
    const target = Date.parse(iso);
    if (Number.isNaN(target))
        return '';
    const diff = target - Date.now();
    if (diff <= 0)
        return 'now';
    return humanDuration(diff / 1000, '');
}

// Let a fixed-width popup label wrap onto extra lines instead of running off
// the edge. Pango only wraps when the text actually exceeds the width, so short
// text stays on one line. Returns the label for chaining.
function wrapLabel(label) {
    label.x_expand = true;
    label.clutter_text.line_wrap = true;
    label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return label;
}

// A labelled progress meter: title + percentage row, bar, and reset caption.
class Meter {
    constructor(name) {
        this.root = new St.BoxLayout({vertical: true, style_class: 'cu-meter'});

        const row = new St.BoxLayout({style_class: 'cu-meter-row'});
        this._name = new St.Label({text: name, style_class: 'cu-meter-name', x_expand: true});
        this._pct = new St.Label({text: '—', style_class: 'cu-meter-pct'});
        row.add_child(this._name);
        row.add_child(this._pct);

        this._track = new St.BoxLayout({style_class: 'cu-track', x_expand: true});
        this._fill = new St.Widget({style_class: 'cu-fill cu-ok'});
        this._track.add_child(this._fill);
        // The fill is sized as a fraction of the track's *actual* allocated
        // width, recomputed whenever the track is (re)laid out. Sizing off a
        // fixed pixel constant left a 100% bar short of the end whenever the
        // popup stretched the track wider than that constant (issue #3).
        this._fraction = 0;
        // connectObject ties the handler to this meter, so destroy() can drop
        // it with a single disconnectObject(this).
        this._track.connectObject('notify::width', () => this._resizeFill(), this);

        this._caption = wrapLabel(new St.Label({text: '', style_class: 'cu-caption'}));

        this.root.add_child(row);
        this.root.add_child(this._track);
        this.root.add_child(this._caption);
    }

    // The bar width tracks actual utilization; level (defaults to the util's
    // own level) drives the color, so projection can tint without resizing.
    setValue(util, caption, level = utilLevel(util)) {
        this._pct.text = `${Math.round(util)}%`;
        this._fraction = Math.max(0, Math.min(100, util)) / 100;
        this._resizeFill();
        this._fill.style_class = `cu-fill ${levelClass(level)}`;
        this._caption.text = caption ?? '';
        this._caption.visible = !!caption;
    }

    // Size the fill to the current fraction of the track's real width, so a
    // 100% window always reaches the end no matter how wide the popup lays the
    // track out. Called on every value change and on every track re-allocation
    // (the first allocation lands after construction, when width is still 0).
    _resizeFill() {
        const w = this._track?.get_width() ?? 0;
        this._fill.set_width(Math.round(this._fraction * w));
    }

    // Update the meter's title in place (a reused meter can change label, e.g.
    // if the API renames a scoped window).
    setName(name) {
        this._name.text = name;
    }

    setMuted() {
        this._pct.text = '—';
        this._fraction = 0;
        this._fill.set_width(0);
        this._caption.visible = false;
    }

    // Destroys the meter's actor tree and releases the owned references.
    // Each child is destroyed explicitly (leaf-first) so the destruction is
    // unambiguous to both the runtime and static review tooling.
    destroy() {
        // Drop the track's notify::width handler before tearing the actors
        // down, so nothing can fire mid-destruction.
        this._track?.disconnectObject(this);
        this._name?.destroy();
        this._pct?.destroy();
        this._fill?.destroy();
        this._caption?.destroy();
        this._track?.destroy();
        this.root?.destroy();
        this._name = null;
        this._pct = null;
        this._fill = null;
        this._caption = null;
        this._track = null;
        this.root = null;
    }
}

// A compact circular usage gauge for the panel, drawn with Cairo.
const Ring = GObject.registerClass(
class Ring extends St.DrawingArea {
    _init() {
        super._init({
            style_class: 'cu-ring',
            width: RING_SIZE,
            height: RING_SIZE,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._util = null;
        this._color = null;
    }

    setValue(util, level = utilLevel(util)) {
        this._util = Math.max(0, Math.min(100, util));
        this._color = levelRgb(level);
        this.queue_repaint();
    }

    setUnknown() {
        this._util = null;
        this._color = null;
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const cx = w / 2;
        const cy = h / 2;
        const radius = Math.min(w, h) / 2 - RING_WIDTH / 2;
        const start = -Math.PI / 2;

        cr.setLineWidth(RING_WIDTH);
        cr.setLineCap(Cairo.LineCap.ROUND);

        // Track tint follows the panel's text color, so it stays visible on
        // both light and dark themes.
        const [fr, fg, fb] = colorRgb(this.get_theme_node().get_foreground_color());
        cr.setSourceRGBA(fr, fg, fb, 0.22);
        cr.arc(cx, cy, radius, 0, 2 * Math.PI);
        cr.stroke();

        if (this._util !== null && this._util > 0) {
            const [r, g, b] = this._color ?? levelRgb(utilLevel(this._util));
            cr.setSourceRGBA(r, g, b, 1);
            cr.arc(cx, cy, radius, start, start + (this._util / 100) * 2 * Math.PI);
            cr.stroke();
        }

        cr.$dispose();
    }
});

// A compact horizontal usage bar for the panel: the same data as the ring, but
// drawn as a small track + fill. Mirrors the Ring API (setValue/setUnknown).
class PanelBar {
    constructor() {
        this.root = new St.BoxLayout({
            style_class: 'cu-panel-bar',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._fill = new St.Widget({style_class: 'cu-panel-bar-fill'});
        this.root.add_child(this._fill);
    }

    setValue(util, level = utilLevel(util)) {
        const clamped = Math.max(0, Math.min(100, util));
        this._fill.set_width(Math.round((clamped / 100) * PANEL_BAR_WIDTH));
        this._fill.style_class = `cu-panel-bar-fill ${levelClass(level)}`;
    }

    setUnknown() {
        this._fill.set_width(0);
        this._fill.style_class = 'cu-panel-bar-fill';
    }

    // Destroys the bar's actor tree and releases the owned references.
    destroy() {
        this._fill?.destroy();
        this.root?.destroy();
        this._fill = null;
        this.root = null;
    }
}

// Everything specific to one Claude Code profile (one config directory / one
// account): its own token client, panel block, and popup section. Multiple
// instances are orchestrated by ClaudeUsageIndicator, which shares a single
// panel icon, poll timer, and countdown across all of them.
class ProfileView {
    constructor(profile, settings, panelBox, sectionsBox, showChip, isFirst, allowSharedToken) {
        this.profile = profile;
        this._settings = settings;
        this._client = new UsageClient({configDir: profile.configDir, settings, allowSharedToken});
        this._lastUsage = null;
        // Normalised windows from the last render, cached for the panel
        // selector and the between-poll countdown.
        this._windows = [];
        this._meterBindings = [];
        // key (from the usage model) -> Meter, so meters are reused across
        // polls and torn down only when the API stops reporting that window.
        this._meters = new Map();

        // ---- panel block ----
        this._panelBlock = new St.BoxLayout({style_class: 'cu-panel-block'});
        this._panelSep = null;
        if (!isFirst) {
            this._panelSep = new St.Widget({style_class: 'cu-panel-sep', y_align: Clutter.ActorAlign.CENTER});
            panelBox.add_child(this._panelSep);
        }
        if (showChip) {
            this._chip = new St.Label({
                text: profileChip(profile.label),
                style_class: 'cu-panel-chip',
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._panelBlock.add_child(this._chip);
        }
        this._ring = new Ring();
        this._panelBar = new PanelBar();
        this._panelPct = new St.Label({text: '…', style_class: 'cu-panel-pct', y_align: Clutter.ActorAlign.CENTER});
        this._panelReset = new St.Label({text: '', style_class: 'cu-panel-reset', y_align: Clutter.ActorAlign.CENTER});
        this._panelTier = new St.Label({text: '', style_class: 'cu-panel-tier', y_align: Clutter.ActorAlign.CENTER});
        this._panelBlock.add_child(this._ring);
        this._panelBlock.add_child(this._panelBar.root);
        this._panelBlock.add_child(this._panelPct);
        this._panelBlock.add_child(this._panelReset);
        this._panelBlock.add_child(this._panelTier);
        panelBox.add_child(this._panelBlock);

        // ---- popup section ----
        this._section = new St.BoxLayout({
            vertical: true,
            style_class: isFirst ? 'cu-profile-section' : 'cu-profile-section cu-profile-section-divider',
        });

        const header = new St.BoxLayout({style_class: 'cu-profile-header'});
        const who = new St.BoxLayout({vertical: true, x_expand: true});
        this._label = new St.Label({text: profile.label, style_class: 'cu-title'});
        this._subtitle = new St.Label({text: '', style_class: 'cu-subtitle'});
        who.add_child(this._label);
        who.add_child(this._subtitle);
        this._pill = new St.Label({text: '', style_class: 'cu-pill', y_align: Clutter.ActorAlign.CENTER});
        // An empty pill still paints as a coloured dot; only show it with a tier.
        this._pill.visible = false;
        header.add_child(who);
        header.add_child(this._pill);
        this._section.add_child(header);

        // Limits — one meter per window the API reports (5-hour, 7-day, and
        // any per-model windows like Fable), built dynamically on render.
        this._metersBox = new St.BoxLayout({vertical: true});
        this._section.add_child(this._metersBox);

        this._extra = wrapLabel(new St.Label({text: '', style_class: 'cu-extra'}));
        this._section.add_child(this._extra);

        this._error = wrapLabel(new St.Label({text: '', style_class: 'cu-error'}));
        this._error.visible = false;
        this._section.add_child(this._error);

        this._updated = new St.Label({text: 'Loading…', style_class: 'cu-updated'});
        this._section.add_child(this._updated);

        sectionsBox.add_child(this._section);
    }

    applyVisibility() {
        const gauge = this._settings.get_string('panel-gauge');
        this._ring.visible = gauge === 'ring';
        this._panelBar.root.visible = gauge === 'bar';
        this._panelPct.visible = this._settings.get_boolean('show-percentage');
        this._panelTier.visible = this._settings.get_boolean('show-tier');
        this._panelReset.visible = this._settings.get_boolean('show-reset');
    }

    async applyTierFromDisk(cancellable) {
        try {
            const {subscriptionType, rateLimitTier} = await this._client.tierFromDisk();
            if (cancellable.is_cancelled())
                return;
            // No credentials on disk: leave the tier blank rather than flash a
            // generic "CLAUDE"; the refresh fills in the real state shortly.
            if (!subscriptionType && !rateLimitTier)
                return;
            const label = tierLabel(subscriptionType, rateLimitTier);
            this._pill.text = label;
            this._pill.visible = true;
            this._panelTier.text = label.split(' ')[0];
        } catch {
            // Not signed in yet; the refresh will surface a clearer message.
        }
    }

    // Fetches usage + profile for this account only; never rejects (errors are
    // reported through renderError). Caller drives concurrency across profiles.
    async refresh(cancellable) {
        const [usageRes, profileRes] = await Promise.allSettled([
            this._client.fetchUsage(cancellable),
            this._client.fetchProfile(cancellable),
        ]);
        if (cancellable.is_cancelled())
            return;
        if (usageRes.status === 'rejected') {
            this._renderError(usageRes.reason);
            return;
        }
        if (profileRes.status === 'rejected')
            logError(profileRes.reason, `claude-usage: profile fetch failed for "${this.profile.label}" (non-fatal)`);
        this._render(usageRes.value, profileRes.status === 'fulfilled' ? profileRes.value : null);
    }

    _render(usage, profile) {
        this._error.visible = false;
        this._lastUsage = usage;

        if (profile?.account) {
            const sub = profile.application?.name ?? 'Claude';
            const status = profile.organization?.subscription_status === 'active' ? `${sub} · active` : sub;
            // The section title is the profile's own label, so fold the account
            // identity into the subtitle instead of dropping it — otherwise a
            // single-profile user loses the display name the header used to
            // show, and it stays useful for telling profiles apart.
            const who = profile.account.display_name || profile.account.full_name || '';
            this._subtitle.text = who ? `${who} · ${status}` : status;
            // Org plan is authoritative and always present; the has_claude_*
            // booleans are only a fallback (both false for team/enterprise seats).
            const plan = profile.organization?.organization_type
                ?? (profile.account.has_claude_max ? 'max'
                    : profile.account.has_claude_pro ? 'pro' : null);
            this._pill.text = tierLabel(plan, profile.organization?.rate_limit_tier);
            this._pill.visible = true;
            this._panelTier.text = this._pill.text.split(' ')[0];
        }

        // Build the meter list from the normalised windows. The model prefers
        // the API's self-describing limits[] array (which now carries per-model
        // windows like Fable) and falls back to the legacy flat keys.
        this._windows = normalizeWindows(usage);
        this._meterBindings = [];
        const seen = new Set();
        for (const w of this._windows) {
            seen.add(w.key);
            let meter = this._meters.get(w.key);
            if (!meter) {
                meter = new Meter(w.label);
                this._metersBox.add_child(meter.root);
                this._meters.set(w.key, meter);
            } else {
                meter.setName(w.label);
            }
            this._bindWindow(meter, w);
        }
        // Keep the on-screen order matching the window order.
        this._windows.forEach((w, i) => {
            this._metersBox.set_child_at_index(this._meters.get(w.key).root, i);
        });
        // Drop meters for windows the API stopped reporting.
        for (const [key, meter] of this._meters) {
            if (!seen.has(key)) {
                meter.destroy();
                this._meters.delete(key);
            }
        }

        this._renderSpend(usage);

        this.renderPanel();

        const now = GLib.DateTime.new_now_local();
        this._updated.text = `Updated ${now.format('%H:%M:%S')}`;
    }

    // Renders the "extra usage" line from the normalised spend block (the new
    // structured `spend` object, or the legacy `extra_usage` fallback), colour-
    // ing it by the API's severity.
    _renderSpend(usage) {
        const spend = normalizeSpend(usage);
        if (!spend) {
            this._extra.visible = false;
            this._extra.style_class = 'cu-extra';
            return;
        }
        const parts = [spend.used, spend.limit].filter(Boolean);
        let text = `Extra usage: ${parts.join(' / ')}`;
        if (spend.percent !== null)
            text += ` (${spend.percent}%)`;
        this._extra.text = text;
        this._extra.style_class = `cu-extra ${levelClass(spend.level)}`;
        this._extra.visible = true;
    }

    // Pairs a meter with its normalised window so the live countdown can
    // re-render the caption between polls without another network round-trip.
    _bindWindow(meter, w) {
        this._meterBindings.push({meter, w});
        this._applyWindow(meter, w);
    }

    // Soonest reset among this profile's on-screen windows, in seconds, or null.
    soonestResetSeconds() {
        let soonest = null;
        for (const {w} of this._meterBindings) {
            if (!w?.resetsAt)
                continue;
            const t = Date.parse(w.resetsAt);
            if (Number.isNaN(t))
                continue;
            const rem = (t - Date.now()) / 1000;
            if (rem > 0 && (soonest === null || rem < soonest))
                soonest = rem;
        }
        return soonest;
    }

    // Re-apply meters and panel from the last fetched usage (captions only move).
    refreshCountdowns() {
        if (!this._lastUsage)
            return;
        for (const {meter, w} of this._meterBindings)
            this._applyWindow(meter, w);
        this.renderPanel();
    }

    // Renders a meter from a normalised usage window. The color reflects the
    // consequence of the current burn (see windowLevel): red only when you're
    // out of headroom now or would be locked out for a meaningful stretch;
    // amber for a near-reset overrun or a rising trend. It is floored at the
    // API's own severity, so a window the API flags as warning/critical never
    // reads calmer than the API says. The caption explains it in words.
    _applyWindow(meter, w) {
        if (!w || !Number.isFinite(w.utilization)) {
            meter.setMuted();
            return;
        }
        const util = w.utilization;
        const level = maxLevel(windowLevel(util, w.resetsAt, w.totalSeconds), w.apiLevel);
        let caption = w.resetsAt ? relativeReset(w.resetsAt)
            : (util > 0 ? '' : 'not used yet');

        const note = projectionNote(util, w.resetsAt, w.totalSeconds);
        if (note)
            caption = caption ? `${caption} · ${note}` : note;

        meter.setValue(util, caption, level);
    }

    // Final level for a normalised window: the computed burn consequence,
    // floored at the API's severity.
    _windowLevel(w) {
        return maxLevel(windowLevel(w.utilization, w.resetsAt, w.totalSeconds), w.apiLevel);
    }

    // The worst window to surface in the panel: the highest severity among the
    // active limits (or all of them if none are marked active), breaking ties by
    // utilization. This is how a 100% scoped window (e.g. Fable) reaches the bar
    // even when the session and weekly totals are calm.
    _worstWindow(windows) {
        const active = windows.filter(w => w.isActive);
        const pool = active.length ? active : windows;
        const score = w => LEVEL_RANK[this._windowLevel(w)] * 1000 + (Number(w.utilization) || 0);
        return pool.reduce((best, w) => (score(w) > score(best) ? w : best));
    }

    // Which normalised usage window the panel reflects, per the panel-window
    // preference.
    _panelWindow() {
        const windows = this._windows;
        if (!windows || !windows.length)
            return null;
        switch (this._settings.get_string('panel-window')) {
        case 'seven-day':
            return windows.find(w => w.role === 'weekly') ?? windows[0];
        case 'worst':
            return this._worstWindow(windows);
        case 'max':
            return windows.reduce((best, w) =>
                (Number(w.utilization) || 0) > (Number(best.utilization) || 0) ? w : best);
        case 'five-hour':
        default:
            return windows.find(w => w.role === 'session') ?? windows[0];
        }
    }

    renderPanel() {
        const sel = this._panelWindow();
        if (!sel || !Number.isFinite(sel.utilization)) {
            this._panelPct.text = '—';
            this._panelPct.style_class = 'cu-panel-pct';
            this._ring.setUnknown();
            this._panelBar.setUnknown();
            this._panelReset.text = '';
            return;
        }
        const util = sel.utilization;
        const level = this._windowLevel(sel);
        this._panelPct.text = `${Math.round(util)}%`;
        this._panelPct.style_class = `cu-panel-pct ${levelClass(level)}`;
        this._panelReset.text = sel.resetsAt ? compactReset(sel.resetsAt) : '';
        this._ring.setValue(util, level);
        this._panelBar.setValue(util, level);
    }

    _renderError(e) {
        // A cancelled request means the extension is being torn down (or
        // profiles are being rebuilt); nothing to show.
        if (e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            return;
        // This profile has no login of its own: a state, not a failure.
        if (e instanceof SignedOutError) {
            this._renderSignedOut(e);
            return;
        }
        // A 429 is transient (we polled a touch too soon). If we already have
        // usage on screen, keep showing it instead of flashing an error.
        if (e instanceof UsageError && e.status === 429 && this._lastUsage) {
            logError(e, `claude-usage: rate limited for "${this.profile.label}", keeping last data`);
            return;
        }
        this._panelPct.text = '!';
        this._panelPct.style_class = 'cu-panel-pct cu-warn';
        this._ring.setUnknown();
        this._panelBar.setUnknown();
        this._panelReset.text = '';
        let msg;
        if (e instanceof UsageError && e.status === 401)
            msg = 'Session expired. Sign in via Claude Code or Settings.';
        else if (e instanceof UsageError && e.status === 429)
            msg = 'Rate limited by Claude; will retry shortly.';
        else
            msg = e.message || 'Could not reach Claude';
        this._error.text = msg;
        this._error.style_class = 'cu-error';
        this._error.visible = true;
        this._updated.text = 'Update failed';
        logError(e, `claude-usage: refresh failed for "${this.profile.label}"`);
    }

    // Clear any stale usage and show a muted "signed out" line. The account
    // just needs signing in (via Claude Code, or the in-app sign-in).
    _renderSignedOut(e) {
        for (const meter of this._meters.values())
            meter.destroy();
        this._meters.clear();
        this._meterBindings = [];
        this._windows = [];
        this._lastUsage = null;

        this._subtitle.text = 'Signed out';
        this._pill.text = '';
        this._pill.visible = false;
        this._panelTier.text = '';
        this._extra.visible = false;

        this._panelPct.text = '—';
        this._panelPct.style_class = 'cu-panel-pct';
        this._ring.setUnknown();
        this._panelBar.setUnknown();
        this._panelReset.text = '';

        this._error.text = e.message;
        this._error.style_class = 'cu-error cu-dim';
        this._error.visible = true;
        // Nothing to timestamp; the subtitle and note already say "signed out".
        this._updated.text = '';
    }

    // Destroys every widget this view owns, leaf-first, then releases the
    // references. The children would go with their containers anyway, but the
    // store's review tooling matches each `this._x = new St.…` against a
    // corresponding `this._x.destroy()` and cannot infer cascading, so each one
    // is destroyed explicitly.
    destroy() {
        for (const meter of this._meters.values())
            meter.destroy();
        this._meters.clear();

        // Panel block contents, then the block itself.
        this._ring?.destroy();
        this._panelBar?.destroy();
        this._chip?.destroy();
        this._panelPct?.destroy();
        this._panelReset?.destroy();
        this._panelTier?.destroy();
        this._panelSep?.destroy();
        this._panelBlock?.destroy();

        // Popup section contents, then the section itself.
        this._label?.destroy();
        this._subtitle?.destroy();
        this._pill?.destroy();
        this._updated?.destroy();
        this._metersBox?.destroy();
        this._section?.destroy();

        this._ring = null;
        this._panelBar = null;
        this._chip = null;
        this._panelPct = null;
        this._panelReset = null;
        this._panelTier = null;
        this._panelSep = null;
        this._panelBlock = null;
        this._label = null;
        this._subtitle = null;
        this._pill = null;
        this._updated = null;
        this._metersBox = null;
        this._section = null;
        this._meterBindings = [];
        this._windows = [];
        this._lastUsage = null;
        this._client = null;
    }
}

const ClaudeUsageIndicator = GObject.registerClass(
class ClaudeUsageIndicator extends PanelMenu.Button {
    _init(path, settings, openPreferences) {
        super._init(0.5, 'Claude Code Usage Monitor');

        this._path = path;
        this._settings = settings;
        this._openPreferences = openPreferences;
        this._busy = false;
        this._cancellable = new Gio.Cancellable();
        this._lastFetchMs = 0;
        this._profileViews = [];
        this._countdownTimer = null;
        this._timer = null;

        // ---- panel button ----
        this._panelBox = new St.BoxLayout({style_class: 'cu-panel'});
        this._panelIcon = new St.Icon({
            gicon: Gio.icon_new_for_string(`${path}/icons/claude-spark.svg`),
            style_class: 'cu-panel-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._panelBox.add_child(this._panelIcon);
        // Profile blocks are appended after the icon by _rebuildProfiles().
        this.add_child(this._panelBox);

        this._buildMenuShell();

        // connectObject ties these handlers to `this`, so a single
        // disconnectObject(this) in destroy() (and the automatic cleanup when
        // this actor is destroyed) tears them all down.
        this.menu.connectObject('open-state-changed', (_m, open) => {
            if (open)
                this._refresh();
        }, this);

        // Live-apply preference changes without needing a shell reload.
        this._settings.connectObject(
            'changed::show-icon', () => this._applyVisibility(),
            'changed::panel-gauge', () => this._applyVisibility(),
            'changed::show-percentage', () => this._applyVisibility(),
            'changed::show-tier', () => this._applyVisibility(),
            'changed::show-reset', () => this._applyVisibility(),
            'changed::panel-window', () => this._renderAllPanels(),
            'changed::poll-seconds', () => this._startTimer(),
            // Signing in (or out) from prefs changes the token source; refetch.
            'changed::access-token', () => this._refresh(true),
            // Profiles were added/removed/renamed/repointed in prefs.
            'changed::profiles', () => this._rebuildFromSettings(),
            this);

        this._applyVisibility();
        this._initProfiles();
    }

    // One-time async setup: seeds the profile list (auto-detection) if it's
    // empty, then builds the views. Later profile edits go through
    // _rebuildFromSettings() instead, which is synchronous and cheap.
    async _initProfiles() {
        const cancellable = this._cancellable;
        const profiles = await ensureProfiles(this._settings);
        if (cancellable.is_cancelled())
            return;
        this._buildProfileViews(profiles);
    }

    _rebuildFromSettings() {
        this._buildProfileViews(loadProfiles(this._settings));
    }

    _buildProfileViews(profiles) {
        this._destroyProfileViews();
        const showChip = profiles.length > 1;
        // Only the profile the single in-app token can belong to may fall back
        // to it: the sole profile, or the one owning the default ~/.claude dir.
        const defaultDir = Gio.File.new_for_path(defaultConfigDir());
        this._profileViews = profiles.map((profile, i) => {
            const ownsDefaultDir = Gio.File.new_for_path(profile.configDir).equal(defaultDir);
            const allowSharedToken = profiles.length === 1 || ownsDefaultDir;
            return new ProfileView(profile, this._settings, this._panelBox,
                this._sectionsBox, showChip, i === 0, allowSharedToken);
        });
        this._applyVisibility();
        for (const view of this._profileViews)
            view.applyTierFromDisk(this._cancellable);
        this._refresh(true);
        this._startTimer();
    }

    _destroyProfileViews() {
        if (this._countdownTimer) {
            GLib.source_remove(this._countdownTimer);
            this._countdownTimer = null;
        }
        for (const view of this._profileViews)
            view.destroy();
        this._profileViews = [];
    }

    _buildMenuShell() {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const root = new St.BoxLayout({vertical: true, style_class: 'cu-popup'});
        item.add_child(root);
        this.menu.addMenuItem(item);

        // header (static branding; per-profile identity lives in each section)
        const header = new St.BoxLayout({style_class: 'cu-header'});
        const logo = new St.Icon({
            gicon: Gio.icon_new_for_string(`${this._path}/icons/octopus.png`),
            style_class: 'cu-logo',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const who = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        who.add_child(new St.Label({text: 'Claude', style_class: 'cu-title'}));
        who.add_child(new St.Label({text: 'usage', style_class: 'cu-subtitle'}));
        header.add_child(logo);
        header.add_child(who);
        root.add_child(header);

        // One section per profile, rebuilt whenever the profile list changes.
        this._sectionsBox = new St.BoxLayout({vertical: true});
        root.add_child(this._sectionsBox);

        // actions
        const actions = new St.BoxLayout({style_class: 'cu-actions'});
        const openUsage = new St.Button({label: 'Usage page', style_class: 'cu-btn cu-btn-pri', x_expand: true});
        openUsage.connect('clicked', () => {
            this.menu.close();
            Gio.AppInfo.launch_default_for_uri(USAGE_SETTINGS_URL, null);
        });
        actions.add_child(openUsage);
        root.add_child(actions);

        // footer
        const footer = new St.BoxLayout({style_class: 'cu-footer'});
        const settingsBtn = new St.Button({label: '⚙ Settings', style_class: 'cu-refresh', x_expand: true});
        settingsBtn.connect('clicked', () => {
            this.menu.close();
            this._openPreferences?.();
        });
        const refreshLabel = this._profileViews?.length > 1 ? '↻ Refresh all' : '↻ Refresh';
        this._refreshBtn = new St.Button({label: refreshLabel, style_class: 'cu-refresh', x_expand: true});
        // connectObject so destroy() can drop this with disconnectObject(this);
        // a bare connect() on a this._* field is flagged by the store's review
        // tooling as a signal that is never disconnected.
        this._refreshBtn.connectObject('clicked', () => this._refresh(true), this);
        footer.add_child(settingsBtn);
        footer.add_child(this._refreshBtn);
        root.add_child(footer);
    }

    _startTimer() {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = null;
        }
        const seconds = this._settings.get_int('poll-seconds');
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _applyVisibility() {
        this._panelIcon.visible = this._settings.get_boolean('show-icon');
        for (const view of this._profileViews)
            view.applyVisibility();
        if (this._refreshBtn)
            this._refreshBtn.label = this._profileViews.length > 1 ? '↻ Refresh all' : '↻ Refresh';
    }

    _renderAllPanels() {
        for (const view of this._profileViews)
            view.renderPanel();
    }

    // force bypasses the min-gap throttle (used for explicit user actions like
    // signing in or editing profiles); opening the popup and the poll timer go
    // through the throttle. All profiles are fetched concurrently, which is
    // both faster and simpler than the user refreshing each one by hand.
    _refresh(force = false) {
        if (this._busy || this._profileViews.length === 0)
            return;
        if (!force && Date.now() - this._lastFetchMs < MIN_REFRESH_MS)
            return;
        this._busy = true;
        this._lastFetchMs = Date.now();

        const cancellable = this._cancellable;
        Promise.allSettled(this._profileViews.map(view => view.refresh(cancellable)))
            .finally(() => {
                this._busy = false;
                if (!cancellable.is_cancelled())
                    this._scheduleCountdown();
            });
    }

    // Soonest reset across every window of every profile, in seconds, or null.
    _soonestResetSeconds() {
        let soonest = null;
        for (const view of this._profileViews) {
            const rem = view.soonestResetSeconds();
            if (rem !== null && (soonest === null || rem < soonest))
                soonest = rem;
        }
        return soonest;
    }

    // Tick the "resets in …" captions between polls: every second once a reset
    // is under 90s away (so the seconds display is live), every 30s otherwise.
    _scheduleCountdown() {
        if (this._countdownTimer) {
            GLib.source_remove(this._countdownTimer);
            this._countdownTimer = null;
        }
        const soonest = this._soonestResetSeconds();
        if (soonest === null)
            return;
        const interval = soonest < 90 ? 1 : 30;
        this._countdownTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this._countdownTimer = null;
            for (const view of this._profileViews)
                view.refreshCountdowns();
            this._scheduleCountdown();
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        // Abort any in-flight fetch so its callback drops out (it checks the
        // cancellable) instead of touching torn-down actors.
        this._cancellable?.cancel();
        this._cancellable = null;
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = null;
        }
        if (this._countdownTimer) {
            GLib.source_remove(this._countdownTimer);
            this._countdownTimer = null;
        }
        this.menu.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._settings = null;

        this._refreshBtn?.disconnectObject(this);
        this._refreshBtn?.destroy();
        this._refreshBtn = null;
        this._panelIcon?.destroy();
        this._panelIcon = null;

        this._destroyProfileViews();

        // Destroyed after the profile views, which live inside these boxes.
        this._panelBox?.destroy();
        this._panelBox = null;
        this._sectionsBox?.destroy();
        this._sectionsBox = null;

        super.destroy();
    }
});

export default class ClaudeUsageExtension extends Extension {
    enable() {
        this._indicator = new ClaudeUsageIndicator(this.path, this.getSettings(), () => this.openPreferences());
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}

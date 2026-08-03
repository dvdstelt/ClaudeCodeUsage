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

import {UsageClient, UsageError} from './lib/usageClient.js';
import {loadProfiles, ensureProfiles} from './lib/profiles.js';

const TRACK_WIDTH = 300;
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

const FIVE_HOUR_SECONDS = 5 * 3600;
const SEVEN_DAY_SECONDS = 7 * 24 * 3600;

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

function tierLabel(subscriptionType, rateLimitTier) {
    const base = subscriptionType === 'max' ? 'MAX'
        : subscriptionType === 'pro' ? 'PRO'
        : (subscriptionType ?? '').toUpperCase() || 'CLAUDE';
    const m = /(\d+)x/.exec(rateLimitTier ?? '');
    return m ? `${base} ${m[1]}x` : base;
}

// Friendly name for a per-model usage window key suffix (seven_day_<name>).
function modelLabel(name) {
    const known = {opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', oauth_apps: 'OAuth Apps'};
    return known[name] ??
        name.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
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

        this._track = new St.BoxLayout({style_class: 'cu-track'});
        this._fill = new St.Widget({style_class: 'cu-fill cu-ok'});
        this._track.add_child(this._fill);

        this._caption = wrapLabel(new St.Label({text: '', style_class: 'cu-caption'}));

        this.root.add_child(row);
        this.root.add_child(this._track);
        this.root.add_child(this._caption);
    }

    // The bar width tracks actual utilization; level (defaults to the util's
    // own level) drives the color, so projection can tint without resizing.
    setValue(util, caption, level = utilLevel(util)) {
        this._pct.text = `${Math.round(util)}%`;
        this._fill.set_width(Math.round((Math.max(0, Math.min(100, util)) / 100) * TRACK_WIDTH));
        this._fill.style_class = `cu-fill ${levelClass(level)}`;
        this._caption.text = caption ?? '';
        this._caption.visible = !!caption;
    }

    setMuted() {
        this._pct.text = '—';
        this._fill.set_width(0);
        this._caption.visible = false;
    }

    // Destroys the meter's actor tree and releases the owned references.
    // Each child is destroyed explicitly (leaf-first) so the destruction is
    // unambiguous to both the runtime and static review tooling.
    destroy() {
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
    constructor(profile, settings, panelBox, sectionsBox, showChip, isFirst) {
        this.profile = profile;
        this._settings = settings;
        this._client = new UsageClient({configDir: profile.configDir, settings});
        this._lastUsage = null;
        this._meterBindings = [];
        this._perModelMeters = new Map();

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
        header.add_child(who);
        header.add_child(this._pill);
        this._section.add_child(header);

        this._fiveHour = new Meter('5-hour window');
        this._sevenDay = new Meter('7-day window');
        this._section.add_child(this._fiveHour.root);
        this._section.add_child(this._sevenDay.root);
        // Per-model 7-day meters are added here on demand.
        this._perModelBox = new St.BoxLayout({vertical: true});
        this._section.add_child(this._perModelBox);

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
            const label = tierLabel(subscriptionType, rateLimitTier);
            this._pill.text = label;
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
            this._subtitle.text = profile.organization?.subscription_status === 'active' ? `${sub} · active` : sub;
            this._pill.text = tierLabel(
                profile.account.has_claude_max ? 'max' : profile.account.has_claude_pro ? 'pro' : '',
                profile.organization?.rate_limit_tier);
            this._panelTier.text = this._pill.text.split(' ')[0];
        }

        // Reset the binding list each render so the countdown re-applies from
        // exactly the windows now on screen (per-model meters come and go).
        this._meterBindings = [];
        this._bindWindow(this._fiveHour, usage.five_hour, FIVE_HOUR_SECONDS);
        this._bindWindow(this._sevenDay, usage.seven_day, SEVEN_DAY_SECONDS);

        // Per-model 7-day windows arrive as seven_day_<name>; render one meter
        // per non-null entry and drop any that the API stops reporting.
        const seen = new Set();
        for (const key of Object.keys(usage)) {
            const m = /^seven_day_(.+)$/.exec(key);
            const win = usage[key];
            if (!m || !win)
                continue;
            seen.add(key);
            let meter = this._perModelMeters.get(key);
            if (!meter) {
                meter = new Meter(`7-day ${modelLabel(m[1])}`);
                this._perModelBox.add_child(meter.root);
                this._perModelMeters.set(key, meter);
            }
            this._bindWindow(meter, win, SEVEN_DAY_SECONDS);
        }
        for (const [key, meter] of this._perModelMeters) {
            if (!seen.has(key)) {
                meter.destroy();
                this._perModelMeters.delete(key);
            }
        }

        const xu = usage.extra_usage;
        if (xu && xu.is_enabled) {
            const cur = xu.currency || '';
            const money = v => Number.isFinite(v) ? `${cur} ${(v / 100).toFixed(2)}`.trim() : null;
            const used = money(Number(xu.used_credits));
            const limit = money(Number(xu.monthly_limit));
            const parts = [used ?? `${cur} 0.00`.trim()];
            if (limit && Number(xu.monthly_limit) > 0)
                parts.push(limit);
            this._extra.visible = true;
            this._extra.text = `Extra usage: ${parts.join(' / ')}`;
        } else {
            this._extra.visible = false;
        }

        this.renderPanel();

        const now = GLib.DateTime.new_now_local();
        this._updated.text = `Updated ${now.format('%H:%M:%S')}`;
    }

    // Pairs a meter with its window so the live countdown can re-render the
    // caption between polls without another network round-trip.
    _bindWindow(meter, win, total) {
        this._meterBindings.push({meter, win, total});
        this._applyWindow(meter, win, total);
    }

    // Soonest reset among this profile's on-screen windows, in seconds, or null.
    soonestResetSeconds() {
        let soonest = null;
        for (const {win} of this._meterBindings) {
            if (!win?.resets_at)
                continue;
            const t = Date.parse(win.resets_at);
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
        for (const {meter, win, total} of this._meterBindings)
            this._applyWindow(meter, win, total);
        this.renderPanel();
    }

    // Renders a meter from a usage window. The color reflects the consequence
    // of the current burn (see windowLevel): red only when you're out of
    // headroom now or would be locked out for a meaningful stretch; amber for a
    // near-reset overrun or a rising trend. The caption explains it in words.
    _applyWindow(meter, win, totalSeconds) {
        if (!win) {
            meter.setMuted();
            return;
        }
        const util = win.utilization;
        const level = windowLevel(util, win.resets_at, totalSeconds);
        let caption = win.resets_at ? relativeReset(win.resets_at)
            : (util > 0 ? '' : 'not used yet');

        const note = projectionNote(util, win.resets_at, totalSeconds);
        if (note)
            caption = caption ? `${caption} · ${note}` : note;

        meter.setValue(util, caption, level);
    }

    // Which usage window the panel reflects, per the panel-window preference.
    _panelWindow() {
        const u = this._lastUsage;
        if (!u)
            return null;
        switch (this._settings.get_string('panel-window')) {
        case 'seven-day':
            return {win: u.seven_day, total: SEVEN_DAY_SECONDS};
        case 'max': {
            const fu = u.five_hour?.utilization ?? -1;
            const su = u.seven_day?.utilization ?? -1;
            return su > fu
                ? {win: u.seven_day, total: SEVEN_DAY_SECONDS}
                : {win: u.five_hour, total: FIVE_HOUR_SECONDS};
        }
        case 'five-hour':
        default:
            return {win: u.five_hour, total: FIVE_HOUR_SECONDS};
        }
    }

    renderPanel() {
        const sel = this._panelWindow();
        if (!sel || !sel.win) {
            this._panelPct.text = '—';
            this._panelPct.style_class = 'cu-panel-pct';
            this._ring.setUnknown();
            this._panelBar.setUnknown();
            this._panelReset.text = '';
            return;
        }
        const util = sel.win.utilization;
        const level = windowLevel(util, sel.win.resets_at, sel.total);
        this._panelPct.text = `${Math.round(util)}%`;
        this._panelPct.style_class = `cu-panel-pct ${levelClass(level)}`;
        this._panelReset.text = sel.win.resets_at ? compactReset(sel.win.resets_at) : '';
        this._ring.setValue(util, level);
        this._panelBar.setValue(util, level);
    }

    _renderError(e) {
        // A cancelled request means the extension is being torn down (or
        // profiles are being rebuilt); nothing to show.
        if (e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            return;
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
        this._error.visible = true;
        this._updated.text = 'Update failed';
        logError(e, `claude-usage: refresh failed for "${this.profile.label}"`);
    }

    destroy() {
        this._fiveHour?.destroy();
        this._sevenDay?.destroy();
        for (const meter of this._perModelMeters.values())
            meter.destroy();
        this._perModelMeters.clear();
        this._panelBar?.destroy();
        this._chip?.destroy();
        this._panelSep?.destroy();
        this._panelBlock?.destroy();
        this._section?.destroy();
        this._fiveHour = null;
        this._sevenDay = null;
        this._panelBar = null;
        this._ring = null;
        this._panelReset = null;
        this._panelSep = null;
        this._panelBlock = null;
        this._section = null;
        this._meterBindings = [];
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
        this._profileViews = profiles.map((profile, i) =>
            new ProfileView(profile, this._settings, this._panelBox, this._sectionsBox, showChip, i === 0));
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
        this._refreshBtn.connect('clicked', () => this._refresh(true));
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

        this._destroyProfileViews();

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

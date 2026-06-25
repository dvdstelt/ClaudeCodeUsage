import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Cairo from 'cairo';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {UsageClient, UsageError} from './lib/usageClient.js';

const TRACK_WIDTH = 300;
const USAGE_SETTINGS_URL = 'https://claude.ai/settings/usage';

// Threshold -> style class suffix for bar/number coloring.
function severity(util) {
    if (util >= 90)
        return 'cu-crit';
    if (util >= 75)
        return 'cu-warn';
    return 'cu-ok';
}

// Same thresholds as severity(), but as RGB triples for Cairo painting.
function severityRgb(util) {
    if (util >= 90)
        return [0.88, 0.11, 0.14]; // #e01b24
    if (util >= 75)
        return [1.0, 0.47, 0.0];   // #ff7800
    return [0.2, 0.82, 0.48];      // #33d17a
}

const RING_SIZE = 18;
const RING_WIDTH = 3;
const PANEL_BAR_WIDTH = 34;

// StThemeNode colors are Cogl.Color. Across GNOME 48-50 the components come
// back either as 0-255 bytes or as 0-1 floats depending on the GJS build, so
// detect the scale instead of assuming one. Returns an [r, g, b] float triple.
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

        this._caption = new St.Label({text: '', style_class: 'cu-caption'});

        this.root.add_child(row);
        this.root.add_child(this._track);
        this.root.add_child(this._caption);
    }

    // The bar width tracks actual utilization; colorUtil (defaults to util)
    // drives the severity color, so projection can tint without resizing.
    setValue(util, caption, colorUtil = util) {
        this._pct.text = `${Math.round(util)}%`;
        this._fill.set_width(Math.round((Math.max(0, Math.min(100, util)) / 100) * TRACK_WIDTH));
        this._fill.style_class = `cu-fill ${severity(colorUtil)}`;
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

    setValue(util, colorUtil = util) {
        this._util = Math.max(0, Math.min(100, util));
        this._color = severityRgb(colorUtil);
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
            const [r, g, b] = this._color ?? severityRgb(this._util);
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

    setValue(util, colorUtil = util) {
        const clamped = Math.max(0, Math.min(100, util));
        this._fill.set_width(Math.round((clamped / 100) * PANEL_BAR_WIDTH));
        this._fill.style_class = `cu-panel-bar-fill ${severity(colorUtil)}`;
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

const ClaudeUsageIndicator = GObject.registerClass(
class ClaudeUsageIndicator extends PanelMenu.Button {
    _init(path, settings, openPreferences) {
        super._init(0.5, 'Claude Code Usage Monitor');

        this._path = path;
        this._settings = settings;
        this._openPreferences = openPreferences;
        this._client = new UsageClient(settings);
        this._busy = false;
        this._cancellable = new Gio.Cancellable();
        this._lastUsage = null;
        this._lastFetchMs = 0;
        this._perModelMeters = new Map();
        this._meterBindings = [];
        this._countdownTimer = null;

        // ---- panel button ----
        const box = new St.BoxLayout({style_class: 'cu-panel'});
        this._panelIcon = new St.Icon({
            gicon: Gio.icon_new_for_string(`${path}/icons/claude-spark.svg`),
            style_class: 'cu-panel-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._ring = new Ring();
        this._panelBar = new PanelBar();
        this._panelPct = new St.Label({text: '…', style_class: 'cu-panel-pct', y_align: Clutter.ActorAlign.CENTER});
        this._panelReset = new St.Label({text: '', style_class: 'cu-panel-reset', y_align: Clutter.ActorAlign.CENTER});
        this._panelTier = new St.Label({text: '', style_class: 'cu-panel-tier', y_align: Clutter.ActorAlign.CENTER});
        box.add_child(this._panelIcon);
        box.add_child(this._ring);
        box.add_child(this._panelBar.root);
        box.add_child(this._panelPct);
        box.add_child(this._panelReset);
        box.add_child(this._panelTier);
        this.add_child(box);

        this._buildMenu();

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
            'changed::panel-window', () => this._renderPanel(),
            'changed::poll-seconds', () => this._startTimer(),
            // Signing in (or out) from prefs changes the token source; refetch.
            'changed::access-token', () => this._refresh(true),
            this);

        this._applyVisibility();

        // Tier is on disk, so show it immediately without waiting for the network.
        this._applyTierFromDisk();
        this._refresh();
        this._startTimer();
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
        const gauge = this._settings.get_string('panel-gauge');
        this._ring.visible = gauge === 'ring';
        this._panelBar.root.visible = gauge === 'bar';
        this._panelPct.visible = this._settings.get_boolean('show-percentage');
        this._panelTier.visible = this._settings.get_boolean('show-tier');
        this._panelReset.visible = this._settings.get_boolean('show-reset');
    }

    _buildMenu() {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const root = new St.BoxLayout({vertical: true, style_class: 'cu-popup'});
        item.add_child(root);
        this.menu.addMenuItem(item);

        // header
        const header = new St.BoxLayout({style_class: 'cu-header'});
        const logo = new St.Icon({
            gicon: Gio.icon_new_for_string(`${this._path}/icons/octopus.png`),
            style_class: 'cu-logo',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const who = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._title = new St.Label({text: 'Claude', style_class: 'cu-title'});
        this._subtitle = new St.Label({text: 'usage', style_class: 'cu-subtitle'});
        who.add_child(this._title);
        who.add_child(this._subtitle);
        this._pill = new St.Label({text: '', style_class: 'cu-pill', y_align: Clutter.ActorAlign.CENTER});
        header.add_child(logo);
        header.add_child(who);
        header.add_child(this._pill);
        root.add_child(header);

        // limits section
        this._sectionLabel(root, 'Usage limits');
        this._fiveHour = new Meter('5-hour window');
        this._sevenDay = new Meter('7-day window');
        root.add_child(this._fiveHour.root);
        root.add_child(this._sevenDay.root);
        // Per-model 7-day meters are added here on demand.
        this._perModelBox = new St.BoxLayout({vertical: true});
        root.add_child(this._perModelBox);

        this._extra = new St.Label({text: '', style_class: 'cu-extra'});
        root.add_child(this._extra);

        this._error = new St.Label({text: '', style_class: 'cu-error'});
        this._error.visible = false;
        root.add_child(this._error);

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
        this._updated = new St.Label({text: 'Loading…', style_class: 'cu-updated', x_expand: true});
        const settings = new St.Button({label: '⚙ Settings', style_class: 'cu-refresh'});
        settings.connect('clicked', () => {
            this.menu.close();
            this._openPreferences?.();
        });
        const refresh = new St.Button({label: '↻ Refresh', style_class: 'cu-refresh'});
        refresh.connect('clicked', () => this._refresh(true));
        footer.add_child(this._updated);
        footer.add_child(settings);
        footer.add_child(refresh);
        root.add_child(footer);
    }

    _sectionLabel(parent, text) {
        parent.add_child(new St.Label({text: text.toUpperCase(), style_class: 'cu-section'}));
    }

    async _applyTierFromDisk() {
        const cancellable = this._cancellable;
        try {
            const {subscriptionType, rateLimitTier} = await this._client.tierFromDisk();
            if (cancellable.is_cancelled())
                return;
            const label = tierLabel(subscriptionType, rateLimitTier);
            this._pill.text = label;
            this._panelTier.text = label.split(' ')[0];
        } catch (e) {
            // Not signed in yet; the refresh will surface a clearer message.
        }
    }

    // force bypasses the min-gap throttle (used for explicit user actions like
    // signing in); opening the popup and the poll timer go through the throttle.
    _refresh(force = false) {
        if (this._busy)
            return;
        if (!force && Date.now() - this._lastFetchMs < MIN_REFRESH_MS)
            return;
        this._busy = true;
        this._lastFetchMs = Date.now();

        // Capture the cancellable: after teardown it is cancelled (and the
        // instance reference nulled), which is how we know to drop a late
        // callback instead of touching destroyed actors.
        const cancellable = this._cancellable;

        // Usage is required; the profile is cosmetic (name and tier pill), so a
        // profile failure must not blank out otherwise-good usage data. Run
        // both in parallel and only surface an error when usage itself fails.
        Promise.allSettled([
            this._client.fetchUsage(cancellable),
            this._client.fetchProfile(cancellable),
        ]).then(([usageRes, profileRes]) => {
            if (cancellable.is_cancelled())
                return;
            if (usageRes.status === 'rejected') {
                this._renderError(usageRes.reason);
                return;
            }
            if (profileRes.status === 'rejected')
                logError(profileRes.reason, 'claude-usage: profile fetch failed (non-fatal)');
            this._render(usageRes.value,
                profileRes.status === 'fulfilled' ? profileRes.value : null);
        }).finally(() => {
            this._busy = false;
        });
    }

    _render(usage, profile) {
        this._error.visible = false;
        this._lastUsage = usage;

        if (profile?.account) {
            this._title.text = profile.account.display_name || profile.account.full_name || 'Claude';
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
            // NOTE: the units of used_credits and monthly_limit are not
            // confirmed against a live extra_usage payload. We scale both the
            // same way (treating them as minor units, e.g. cents) so the two
            // numbers are at least consistent; the previous code scaled only
            // monthly_limit, which could not be right for both. Verify against
            // real data and adjust the divisor if needed.
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

        this._renderPanel();
        this._scheduleCountdown();

        const now = GLib.DateTime.new_now_local();
        this._updated.text = `Updated ${now.format('%H:%M:%S')}`;
    }

    // Pairs a meter with its window so the live countdown can re-render the
    // caption between polls without another network round-trip.
    _bindWindow(meter, win, total) {
        this._meterBindings.push({meter, win, total});
        this._applyWindow(meter, win, total);
    }

    // Soonest reset across all on-screen windows, in seconds, or null if none.
    _soonestResetSeconds() {
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
            this._refreshCountdowns();
            this._scheduleCountdown();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Re-apply meters and panel from the last fetched usage (captions only move).
    _refreshCountdowns() {
        if (!this._lastUsage)
            return;
        for (const {meter, win, total} of this._meterBindings)
            this._applyWindow(meter, win, total);
        this._renderPanel();
    }

    // Renders a meter from a usage window, coloring by projected utilization.
    // When the current pace would exhaust the window before it resets, the
    // caption spells out the burn instead of showing a bare "proj N%": it says
    // how long you have left at this rate. A slower-but-still-rising window
    // gets a gentler "on track for N%" note.
    _applyWindow(meter, win, totalSeconds) {
        if (!win) {
            meter.setMuted();
            return;
        }
        const util = win.utilization;
        const proj = projectedUtil(util, win.resets_at, totalSeconds);
        let caption = win.resets_at ? relativeReset(win.resets_at)
            : (util > 0 ? '' : 'not used yet');

        const exhaust = exhaustSeconds(util, win.resets_at, totalSeconds);
        let note = '';
        if (exhaust !== null)
            note = `burning fast — out in ~${humanDuration(exhaust)} at this rate`;
        else if (severity(proj) !== 'cu-ok' && Math.round(proj) > Math.round(util))
            note = `on track for ~${Math.round(proj)}% by reset`;
        if (note)
            caption = caption ? `${caption} · ${note}` : note;

        meter.setValue(util, caption, proj);
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

    _renderPanel() {
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
        const proj = projectedUtil(util, sel.win.resets_at, sel.total);
        this._panelPct.text = `${Math.round(util)}%`;
        this._panelPct.style_class = `cu-panel-pct ${severity(proj)}`;
        this._panelReset.text = sel.win.resets_at ? compactReset(sel.win.resets_at) : '';
        this._ring.setValue(util, proj);
        this._panelBar.setValue(util, proj);
    }

    _renderError(e) {
        // A cancelled request means the extension is being torn down; nothing
        // to show. (Callers already drop cancelled results, so this is belt
        // and braces.)
        if (e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            return;
        // A 429 is transient (we polled a touch too soon). If we already have
        // usage on screen, keep showing it instead of flashing an error.
        if (e instanceof UsageError && e.status === 429 && this._lastUsage) {
            logError(e, 'claude-usage: rate limited, keeping last data');
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
        logError(e, 'claude-usage: refresh failed');
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

        // Tear down the gauge/meter helpers and release their references; the
        // actors themselves also go with super.destroy(), but releasing here
        // keeps ownership explicit.
        this._fiveHour?.destroy();
        this._sevenDay?.destroy();
        for (const meter of this._perModelMeters.values())
            meter.destroy();
        this._perModelMeters.clear();
        this._panelBar?.destroy();
        this._fiveHour = null;
        this._sevenDay = null;
        this._panelBar = null;
        this._ring = null;
        this._panelReset = null;
        this._meterBindings = [];
        this._lastUsage = null;
        this._client = null;

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

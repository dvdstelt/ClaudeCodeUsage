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

// StThemeNode colors are Cogl.Color. Across GNOME 48-50 the components come
// back either as 0-255 bytes or as 0-1 floats depending on the GJS build, so
// detect the scale instead of assuming one. Returns an [r, g, b] float triple.
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

function tierLabel(subscriptionType, rateLimitTier) {
    const base = subscriptionType === 'max' ? 'MAX'
        : subscriptionType === 'pro' ? 'PRO'
        : (subscriptionType ?? '').toUpperCase() || 'CLAUDE';
    const m = /(\d+)x/.exec(rateLimitTier ?? '');
    return m ? `${base} ${m[1]}x` : base;
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
        // key (from the usage model) -> Meter, so meters are reused across polls
        // and torn down only when the API stops reporting that window.
        this._meters = new Map();
        // Normalised windows from the last render, cached for the panel selector
        // and the between-poll countdown.
        this._windows = [];
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

        // limits section — one meter per window the API reports (5-hour, 7-day,
        // and any per-model windows like Fable), built dynamically on render.
        this._sectionLabel(root, 'Usage limits');
        this._metersBox = new St.BoxLayout({vertical: true});
        root.add_child(this._metersBox);

        this._extra = wrapLabel(new St.Label({text: '', style_class: 'cu-extra'}));
        root.add_child(this._extra);

        this._error = wrapLabel(new St.Label({text: '', style_class: 'cu-error'}));
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

        this._renderPanel();
        this._scheduleCountdown();

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

    // Soonest reset across all on-screen windows, in seconds, or null if none.
    _soonestResetSeconds() {
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
        for (const {meter, w} of this._meterBindings)
            this._applyWindow(meter, w);
        this._renderPanel();
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

    _renderPanel() {
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
        for (const meter of this._meters.values())
            meter.destroy();
        this._meters.clear();
        this._panelBar?.destroy();
        this._panelBar = null;
        this._ring = null;
        this._panelReset = null;
        this._meterBindings = [];
        this._windows = [];
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

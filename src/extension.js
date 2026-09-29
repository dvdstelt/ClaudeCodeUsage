import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Cairo from 'cairo';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {UsageClient, UsageError, SignedOutError, defaultConfigDir} from './lib/usageClient.js';
import {loadProfiles, ensureProfiles} from './lib/profiles.js';
import {
    normalizeWindows, normalizeSpend, selectPanelWindows, groupPanelWindows, windowTag, tierIconName,
    migratePanelWindows,
} from './lib/usageModel.js';
import {uiStyle, loadOverrides, boldNumbersMarkup, hoverShade, formatColor} from './lib/uiStyle.js';

const USAGE_SETTINGS_URL = 'https://claude.ai/settings/usage';

// Severity levels, least to most severe.
const LEVEL_RANK = {ok: 0, warn: 1, crit: 2};

// Gauge-map key for the single '…'/'—' gauge shown while a profile has no
// windows to display (before the first fetch, or when signed out).
const PLACEHOLDER_GAUGE = '';

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

// The style with nothing changed under "Top-Bar UI" and "Popup UI" in
// preferences (lib/uiStyle.js). A widget starts from it, until its owner hands
// it the current style through applyStyle().
const DEFAULT_STYLE = uiStyle();

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
        this._level = 'ok';
        this._style = DEFAULT_STYLE;
    }

    applyStyle(style) {
        this._style = style;
        applyInline(this.root, style, 'meter');
        applyInline(this._name, style, 'meter-name');
        applyInline(this._pct, style, 'meter-pct');
        applyInline(this._track, style, 'track');
        applyInline(this._fill, style, 'fill', this._level);
        applyInline(this._caption, style, 'caption');
    }

    // The bar width tracks actual utilization; level (defaults to the util's
    // own level) drives the color, so projection can tint without resizing.
    setValue(util, caption, level = utilLevel(util)) {
        this._pct.text = `${Math.round(util)}%`;
        this._fraction = Math.max(0, Math.min(100, util)) / 100;
        this._resizeFill();
        this._level = level;
        this._fill.style_class = `cu-fill ${levelClass(level)}`;
        applyInline(this._fill, this._style, 'fill', level);
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
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._util = null;
        this._level = null;
        this.applyStyle(DEFAULT_STYLE);
    }

    // The ring paints itself, so it reads its size, line width and colors
    // from the UI settings rather than from a stylesheet.
    applyStyle(style) {
        const size = style.value('ring.size');
        this.set_size(size, size);
        this._stroke = style.value('ring.stroke');
        this._track = style.rgba('usage.track');
        this._colors = {ok: style.rgba('usage.ok'), warn: style.rgba('usage.warn'), crit: style.rgba('usage.crit')};
        this.queue_repaint();
    }

    // Both setters are called on every countdown tick with values that rarely
    // change, so an unchanged value queues no repaint.
    setValue(util, level = utilLevel(util)) {
        const clamped = Math.max(0, Math.min(100, util));
        if (clamped === this._util && level === this._level)
            return;
        this._util = clamped;
        this._level = level;
        this.queue_repaint();
    }

    setUnknown() {
        if (this._util === null && this._level === null)
            return;
        this._util = null;
        this._level = null;
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const cx = w / 2;
        const cy = h / 2;
        // Size and line width are both settings; a line wider than the ring
        // leaves no radius to draw.
        const radius = Math.max(0, Math.min(w, h) / 2 - this._stroke / 2);
        const start = -Math.PI / 2;

        cr.setLineWidth(this._stroke);
        cr.setLineCap(Cairo.LineCap.ROUND);

        cr.setSourceRGBA(...this._track);
        cr.arc(cx, cy, radius, 0, 2 * Math.PI);
        cr.stroke();

        if (this._util !== null && this._util > 0) {
            cr.setSourceRGBA(...this._colors[this._level ?? utilLevel(this._util)]);
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
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._fill = new St.Widget({style_class: 'cu-panel-bar-fill'});
        this.root.add_child(this._fill);
        this._util = null;
        this._level = null;
        this._style = DEFAULT_STYLE;
    }

    setValue(util, level = utilLevel(util)) {
        const clamped = Math.max(0, Math.min(100, util));
        if (clamped === this._util && level === this._level)
            return;
        this._util = clamped;
        this._level = level;
        this._syncFill();
    }

    setUnknown() {
        if (this._util === null && this._level === null)
            return;
        this._util = null;
        this._level = null;
        this._syncFill();
    }

    applyStyle(style) {
        this._style = style;
        applyInline(this.root, style, 'panel-bar');
        this._syncFill();
    }

    // The fill's width (a share of the bar's, which is a UI setting), its
    // level class, and the inline style that goes with that level.
    _syncFill() {
        const width = this._style.value('panel-bar.width');
        this._fill.set_width(Math.round(((this._util ?? 0) / 100) * width));
        this._fill.style_class = this._level ? `cu-panel-bar-fill ${levelClass(this._level)}` : 'cu-panel-bar-fill';
        applyInline(this._fill, this._style, 'panel-bar-fill', this._level);
    }

    // Destroys the bar's actor tree and releases the owned references.
    destroy() {
        this._fill?.destroy();
        this.root?.destroy();
        this._fill = null;
        this.root = null;
    }
}

// Assigns an actor property only when it changes. The panel's values are
// re-applied on every countdown tick and rarely differ, so this keeps an idle
// tick from touching the actors at all.
function setIfChanged(actor, prop, value) {
    if (actor[prop] !== value)
        actor[prop] = value;
}

// Gives an actor the UI settings' values of its style class (`cls`, without
// the "cu-" prefix; an array for several) as its inline style, which beats
// stylesheet.css. With nothing changed the style is null, so the stylesheet
// alone applies. `state` is the actor's level class, if it carries one.
function applyInline(actor, style, cls, state = null) {
    setIfChanged(actor, 'style', style.inline(cls, state));
}

// A divider in the panel, from one of the two divider settings: the lead
// divider (panel-lead-divider: after the Claude icon / tier, and between
// profiles) or the window divider (panel-divider: between groups of gauges).
// Blank or whitespace-only text shows nothing, so the box spacing alone makes
// the gap; exactly "|" draws a crisp 1px line rather than the font's glyph;
// any other text is shown as typed. Owns its actors like PanelBar.
class PanelDivider {
    constructor(styleClass = '') {
        this._rootClasses = styleClass ? [styleClass.replace(/^cu-/, '')] : [];
        this.root = new St.BoxLayout({style_class: `cu-panel-divider ${styleClass}`.trim()});
        this._line = new St.Widget({style_class: 'cu-panel-divider-line', y_align: Clutter.ActorAlign.CENTER});
        this._label = new St.Label({text: '', style_class: 'cu-panel-divider-text', y_align: Clutter.ActorAlign.CENTER});
        this.root.add_child(this._line);
        this.root.add_child(this._label);
        this.root.visible = false;
    }

    // `wanted` is whether the caller has anything for it to divide.
    set(text, wanted) {
        const t = String(text ?? '').trim();
        this._line.visible = t === '|';
        this._label.visible = t !== '|';
        this._label.text = t;
        this.root.visible = !!wanted && t !== '';
    }

    applyStyle(style) {
        applyInline(this.root, style, this._rootClasses);
        applyInline(this._line, style, 'panel-divider-line');
        applyInline(this._label, style, 'panel-divider-text');
    }

    destroy() {
        this._line?.destroy();
        this._label?.destroy();
        this.root?.destroy();
        this._line = null;
        this._label = null;
        this.root = null;
    }
}

// One usage window's gauge in the panel: an optional short tag ("5h", "7d",
// "Fable") so several windows can share a profile's block, then the ring or
// bar and the percentage. The ring and the bar sit in a stack, so that the
// percentage can be drawn on top of the one shown instead of next to it (the
// "Usage percentage" position under "Top-Bar UI"). A ProfileView keeps one per
// window the panel-windows setting selects, and places each in a PanelGroup
// (which carries the divider and the reset countdown). Mirrors Meter/PanelBar:
// owns its actors and tears them down explicitly.
class PanelGauge {
    constructor() {
        this.root = new St.BoxLayout({style_class: 'cu-panel-gauge'});
        this._tag = new St.Label({text: '', style_class: 'cu-panel-wtag', y_align: Clutter.ActorAlign.CENTER});
        this._tag.visible = false;
        this._stack = new St.Widget({layout_manager: new Clutter.BinLayout(), y_align: Clutter.ActorAlign.CENTER});
        this._ring = new Ring();
        this._bar = new PanelBar();
        this._pct = new St.Label({
            text: '…',
            style_class: 'cu-panel-pct',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._stack.add_child(this._ring);
        this._stack.add_child(this._bar.root);
        this.root.add_child(this._tag);
        this.root.add_child(this._stack);
        this.root.add_child(this._pct);
        this._util = null;
        this._level = null;
        this._gauge = 'ring';
        this._over = false;
        this._tagClasses = ['panel-wtag'];
        this._style = DEFAULT_STYLE;
    }

    // The tag only earns its width when more than one gauge is on screen, so
    // the caller says whether to show it. A model name ("Fable") is a tag
    // with a class of its own on top, so it can be styled apart from the
    // "5h" / "7d" tags.
    setTag(text, visible, model = false) {
        this._tag.text = text ?? '';
        this._tag.visible = !!visible && this._tag.text !== '';
        this._tagClasses = model ? ['panel-wtag', 'panel-wtag-model'] : ['panel-wtag'];
        setIfChanged(this._tag, 'style_class', this._tagClasses.map(cls => `cu-${cls}`).join(' '));
        applyInline(this._tag, this._style, this._tagClasses);
    }

    setValue(util, level) {
        this._util = util;
        this._syncPctText();
        this._setLevel(level);
        this._ring.setValue(util, level);
        this._bar.setValue(util, level);
    }

    setUnknown() {
        this._util = null;
        setIfChanged(this._pct, 'text', '—');
        this._setLevel(null);
        this._ring.setUnknown();
        this._bar.setUnknown();
    }

    // A failed refresh: '!' in the warning color, until the next good fetch.
    // Re-applied on every tick while the error lasts, so it sets the text once
    // rather than going through setUnknown's '—' first.
    setError() {
        this._util = null;
        setIfChanged(this._pct, 'text', '!');
        this._setLevel('warn');
        this._ring.setUnknown();
        this._bar.setUnknown();
    }

    // The percentage as text, with or without its sign (a UI setting: without,
    // it fits inside the ring). Only while there is a value: '—', '!' and the
    // placeholder's '…' stay as they are.
    _syncPctText() {
        if (this._util === null)
            return;
        const sign = this._style.value('panel-pct.sign') ? '%' : '';
        setIfChanged(this._pct, 'text', `${Math.round(this._util)}${sign}`);
    }

    // The percentage's level class, and the inline style that goes with it.
    // On top of the bar it takes none for a value: the warning and critical
    // text colors are made to be read on the panel, not on a fill of nearly
    // the same color, and there the fill says it. The '!' of a failed refresh
    // (no value) keeps its warning color: the bar is empty under it.
    _setLevel(level) {
        this._level = level;
        const shown = this._over && this._gauge === 'bar' && this._util !== null ? null : level;
        setIfChanged(this._pct, 'style_class', shown ? `cu-panel-pct ${levelClass(shown)}` : 'cu-panel-pct');
        applyInline(this._pct, this._style, 'panel-pct', shown);
    }

    // Where the percentage goes: on top of the ring or bar (the stack's last
    // child, centred over it), or after it in the row. With no gauge to draw
    // it on, it stays in the row. Called for every preference change, so it
    // only moves the label when the answer differs.
    _syncPctPlace() {
        const over = this._gauge !== 'none' && this._style.value('panel-pct.position') === 'over';
        if (over === this._over)
            return;
        this._over = over;
        this._pct.get_parent()?.remove_child(this._pct);
        (over ? this._stack : this.root).add_child(this._pct);
    }

    applyStyle(style) {
        this._style = style;
        applyInline(this.root, style, 'panel-gauge');
        applyInline(this._tag, style, this._tagClasses);
        this._ring.applyStyle(style);
        this._bar.applyStyle(style);
        this._syncPctPlace();
        this._syncPctText();
        this._setLevel(this._level);
    }

    applyVisibility(settings) {
        this._gauge = settings.get_string('panel-gauge');
        this._ring.visible = this._gauge === 'ring';
        this._bar.root.visible = this._gauge === 'bar';
        this._stack.visible = this._gauge !== 'none';
        this._pct.visible = settings.get_boolean('show-percentage');
        this._syncPctPlace();
        this._setLevel(this._level);
    }

    destroy() {
        this._tag?.destroy();
        this._ring?.destroy();
        this._bar?.destroy();
        this._pct?.destroy();
        this._stack?.destroy();
        this.root?.destroy();
        this._tag = null;
        this._ring = null;
        this._bar = null;
        this._pct = null;
        this._stack = null;
        this.root = null;
    }
}

// A run of panel gauges that reset together (see groupPanelWindows): the
// window divider, the gauges, then one reset countdown for all of them. Most
// groups hold a single gauge; the 7-day window and the per-model 7-day windows
// share one. The gauges belong to the ProfileView (they outlive a regrouping),
// so the group only parents them and hands them back before it is destroyed.
class PanelGroup {
    constructor() {
        this.root = new St.BoxLayout({style_class: 'cu-panel-group'});
        this._divider = new PanelDivider();
        this._reset = new St.Label({text: '', style_class: 'cu-panel-reset', y_align: Clutter.ActorAlign.CENTER});
        this._reset.visible = false;
        this.root.add_child(this._divider.root);
        this.root.add_child(this._reset);
        this._gauges = [];
        this._resetsAt = null;
        this._showReset = false;
        this._boldNumbers = false;
        // What the countdown label was last given (see _syncResetText).
        this._shown = null;
    }

    // Parents exactly these gauges, in order, between the divider and the
    // countdown. A gauge is only reparented when it sits somewhere else.
    setGauges(gauges) {
        for (const gauge of this._gauges) {
            if (!gauges.includes(gauge) && gauge.root?.get_parent() === this.root)
                this.root.remove_child(gauge.root);
        }
        gauges.forEach((gauge, i) => {
            const parent = gauge.root.get_parent();
            if (parent !== this.root) {
                parent?.remove_child(gauge.root);
                this.root.add_child(gauge.root);
            }
            this.root.set_child_at_index(gauge.root, i + 1);
        });
        this._gauges = [...gauges];
    }

    setDivider(text, wanted) {
        this._divider.set(text, wanted);
    }

    // The group's reset time (null: no countdown). The text is recomputed on
    // every call, which is how the countdown ticks between polls.
    setReset(iso) {
        this._resetsAt = iso ?? null;
        this._syncResetText();
        this._syncReset();
    }

    // The countdown, with its numbers in bold and its units regular when that
    // UI setting is on. Markup and plain text go in through different calls
    // (setting the text also switches markup off again), so what was last
    // given is remembered here rather than read back from the label.
    _syncResetText() {
        const text = this._resetsAt ? compactReset(this._resetsAt) : '';
        const shown = `${this._boldNumbers}|${text}`;
        if (shown === this._shown)
            return;
        this._shown = shown;
        if (this._boldNumbers)
            this._reset.clutter_text.set_markup(boldNumbersMarkup(text));
        else
            this._reset.text = text;
    }

    applyVisibility(settings) {
        this._showReset = settings.get_boolean('show-reset');
        this._syncReset();
    }

    applyStyle(style) {
        applyInline(this.root, style, 'panel-group');
        applyInline(this._reset, style, 'panel-reset');
        this._divider.applyStyle(style);
        this._boldNumbers = style.value('panel-reset.bold-numbers');
        this._syncResetText();
    }

    // An empty countdown still takes its box spacing, so hide it.
    _syncReset() {
        setIfChanged(this._reset, 'visible', this._showReset && this._reset.text !== '');
    }

    destroy() {
        this.setGauges([]);
        this._divider?.destroy();
        this._reset?.destroy();
        this.root?.destroy();
        this._divider = null;
        this._reset = null;
        this.root = null;
        this._gauges = [];
    }
}

// Everything specific to one Claude Code profile (one config directory / one
// account): its own token client, panel block, and popup section. Multiple
// instances are orchestrated by ClaudeUsageIndicator, which shares a single
// panel icon, poll timer, and countdown across all of them.
class ProfileView {
    constructor(profile, settings, panelBox, sectionsBox, showChip, isFirst, allowSharedToken, path) {
        this.profile = profile;
        this._settings = settings;
        this._client = new UsageClient({configDir: profile.configDir, settings, allowSharedToken, profileId: profile.id});
        this._lastUsage = null;
        // Outcome of this profile's last refresh ('ok' | 'error' | 'signed-out'),
        // read by the indicator for the shared "Updated …" line.
        this.lastResult = null;
        // Normalised windows from the last render, cached for the panel
        // selector and the between-poll countdown.
        this._windows = [];
        this._meterBindings = [];
        // key (from the usage model) -> Meter, so meters are reused across
        // polls and torn down only when the API stops reporting that window.
        this._meters = new Map();

        // ---- panel block ----
        // [profile divider] [chip] [tier icon] [tier label] [lead divider]
        // [groups of gauges]. Both dividers here draw the lead-divider text:
        // one between this profile and the previous one, one between this
        // block's leading elements and its gauges.
        this._panelBlock = new St.BoxLayout({style_class: 'cu-panel-block'});
        this._profileDivider = null;
        if (!isFirst) {
            this._profileDivider = new PanelDivider('cu-panel-divider-profile');
            panelBox.add_child(this._profileDivider.root);
        }
        if (showChip) {
            this._chip = new St.Label({
                text: profileChip(profile.label),
                style_class: 'cu-panel-chip',
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._panelBlock.add_child(this._chip);
        }
        // The tier icon has no image until the tier is known, and stays
        // without one for a tier that has no artwork (see tierIconName).
        this._path = path;
        this._isFirst = isFirst;
        this._tierIcon = new St.Icon({
            style_class: 'cu-panel-icon cu-panel-tier-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._tierIcon.visible = false;
        this._panelTier = new St.Label({text: '', style_class: 'cu-panel-tier', y_align: Clutter.ActorAlign.CENTER});
        this._panelTier.visible = false;
        this._leadDivider = new PanelDivider();
        // One PanelGauge per window the panel-windows setting selects, keyed
        // by window key (like the popup meters) so gauges survive across
        // polls, placed in PanelGroups (windows that reset together). Until
        // the first fetch a single placeholder gauge shows '…'.
        this._gaugesBox = new St.BoxLayout({style_class: 'cu-panel-gauges'});
        this._gauges = new Map();
        this._groups = [];
        // Signature of everything the current layout was built from, so an
        // unchanged panel is not laid out again (see renderPanel).
        this._layoutSig = null;
        // The UI settings' style, for the gauges, groups and meters made later; the
        // indicator hands over the current one right after construction.
        this._style = DEFAULT_STYLE;
        this._panelBlock.add_child(this._tierIcon);
        this._panelBlock.add_child(this._panelTier);
        this._panelBlock.add_child(this._leadDivider.root);
        this._panelBlock.add_child(this._gaugesBox);
        panelBox.add_child(this._panelBlock);
        this.renderPanel();

        // ---- popup section ----
        this._section = new St.BoxLayout({
            vertical: true,
            style_class: isFirst ? 'cu-profile-section' : 'cu-profile-section cu-profile-section-divider',
        });

        // Each profile carries its own logo and name, so the popup reads as a
        // list of accounts rather than one branded header over anonymous rows.
        this._header = new St.BoxLayout({style_class: 'cu-profile-header'});
        this._logo = new St.Icon({
            gicon: Gio.icon_new_for_string(`${path}/icons/octopus.png`),
            style_class: 'cu-logo',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._header.add_child(this._logo);
        const who = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._label = new St.Label({text: profile.label, style_class: 'cu-title'});
        this._subtitle = new St.Label({text: '', style_class: 'cu-subtitle'});
        who.add_child(this._label);
        who.add_child(this._subtitle);
        this._pill = new St.Label({text: '', style_class: 'cu-pill', y_align: Clutter.ActorAlign.CENTER});
        // An empty pill still paints as a colored dot; only show it with a tier.
        this._pill.visible = false;
        this._header.add_child(who);
        this._header.add_child(this._pill);
        this._section.add_child(this._header);

        // Limits — one meter per window the API reports (5-hour, 7-day, and
        // any per-model windows like Fable), built dynamically on render.
        this._metersBox = new St.BoxLayout({vertical: true});
        this._section.add_child(this._metersBox);

        this._extra = wrapLabel(new St.Label({text: '', style_class: 'cu-extra'}));
        this._section.add_child(this._extra);

        this._error = wrapLabel(new St.Label({text: '', style_class: 'cu-error'}));
        this._error.visible = false;
        this._section.add_child(this._error);
        // The state class each of the two lines carries (a spend level, "dim"
        // for a signed-out note), which its inline style depends on.
        this._extraState = null;
        this._errorState = null;

        sectionsBox.add_child(this._section);
    }

    applyVisibility() {
        const s = this._settings;
        for (const gauge of this._gauges.values())
            gauge.applyVisibility(s);
        for (const group of this._groups)
            group.applyVisibility(s);
        // Both follow their widget: no tier yet (or signed out) means no
        // label text, and a tier without artwork means no icon image.
        this._panelTier.visible = s.get_boolean('show-tier') && this._panelTier.text !== '';
        this._tierIcon.visible = s.get_boolean('show-tier-icon') && this._tierIcon.gicon !== null;
        // The chip is only built with more than one profile, and is then
        // toggleable — some people would rather not spend the panel width.
        if (this._chip)
            this._chip.visible = s.get_boolean('show-profile-chip');

        // The lead divider: before every profile but the first, and between
        // this block's leading elements and its gauges when it has any. The
        // Claude icon is shared and sits in front of the first block, so it
        // counts as a leading element of that block only.
        const lead = s.get_string('panel-lead-divider');
        const leading = !!this._chip?.visible || this._tierIcon.visible || this._panelTier.visible
            || (this._isFirst && s.get_boolean('show-icon'));
        this._leadDivider.set(lead, leading);
        this._profileDivider?.set(lead, true);
    }

    // Applies the UI settings to the panel block and the popup section, and
    // keeps them for the gauges, groups and meters that are created later.
    applyStyle(style) {
        this._style = style;
        applyInline(this._section, style, this._isFirst ? [] : 'profile-section-divider');
        applyInline(this._header, style, 'profile-header');
        applyInline(this._logo, style, 'logo');
        applyInline(this._label, style, 'title');
        applyInline(this._subtitle, style, 'subtitle');
        applyInline(this._pill, style, 'pill');
        for (const meter of this._meters.values())
            meter.applyStyle(style);
        this._setLineState(this._extra, 'extra', this._extraState);
        this._setLineState(this._error, 'error', this._errorState);
        applyInline(this._panelBlock, style, 'panel-block');
        if (this._chip)
            applyInline(this._chip, style, 'panel-chip');
        applyInline(this._tierIcon, style, ['panel-icon', 'panel-tier-icon']);
        applyInline(this._panelTier, style, 'panel-tier');
        applyInline(this._gaugesBox, style, 'panel-gauges');
        this._profileDivider?.applyStyle(style);
        this._leadDivider.applyStyle(style);
        for (const gauge of this._gauges.values())
            gauge.applyStyle(style);
        for (const group of this._groups)
            group.applyStyle(style);
    }

    // The state class of the extra-usage or error line (null: none), with the
    // inline style that goes with it.
    _setLineState(label, cls, state) {
        if (cls === 'extra')
            this._extraState = state;
        else
            this._errorState = state;
        label.style_class = state ? `cu-${cls} cu-${state}` : `cu-${cls}`;
        applyInline(label, this._style, cls, state);
    }

    // Records the account's plan in the popup pill, the panel label, and the
    // panel icon. Called on every poll, so it only acts on a change.
    _setTier(plan, rateLimitTier) {
        const label = tierLabel(plan, rateLimitTier);
        if (label === this._pill.text)
            return;
        this._pill.text = label;
        this._pill.visible = true;
        this._panelTier.text = label.split(' ')[0];
        const icon = tierIconName(label);
        this._tierIcon.gicon = icon
            ? Gio.icon_new_for_string(`${this._path}/icons/tier-${icon}-symbolic.svg`)
            : null;
        this.applyVisibility();
    }

    _clearTier() {
        this._pill.text = '';
        this._pill.visible = false;
        this._panelTier.text = '';
        this._tierIcon.gicon = null;
        this.applyVisibility();
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
            this._setTier(subscriptionType, rateLimitTier);
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
            this._setTier(plan, profile.organization?.rate_limit_tier);
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
                meter.applyStyle(this._style);
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

        // Before renderPanel: it keeps the '!' for as long as this says 'error'.
        this.lastResult = 'ok';
        this.renderPanel();
    }

    // Renders the "extra usage" line from the normalised spend block (the new
    // structured `spend` object, or the legacy `extra_usage` fallback), color-
    // ing it by the API's severity.
    _renderSpend(usage) {
        const spend = normalizeSpend(usage);
        if (!spend) {
            this._extra.visible = false;
            this._setLineState(this._extra, 'extra', null);
            return;
        }
        const parts = [spend.used, spend.limit].filter(Boolean);
        let text = `Extra usage: ${parts.join(' / ')}`;
        if (spend.percent !== null)
            text += ` (${spend.percent}%)`;
        this._extra.text = text;
        this._setLineState(this._extra, 'extra', spend.level);
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

    // Re-applies the last fetched usage so the time-derived parts move between
    // polls: the reset countdowns and the burn-rate colors. Nothing is
    // fetched. The popup's meters only need it while the menu is open (the
    // indicator also calls this the moment it opens).
    refreshCountdowns(menuOpen) {
        if (!this._lastUsage)
            return;
        if (menuOpen) {
            for (const {meter, w} of this._meterBindings)
                this._applyWindow(meter, w);
        }
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

    // Which normalised usage windows the panel shows, per the panel-windows
    // preference (any mix of 5-hour / 7-day / per-model / max / worst, merged
    // and kept in role order). The 'worst' selector ranks by the computed
    // severity, then utilization, over the active limits — that is how a 100%
    // scoped window (e.g. Fable) reaches the panel even when the session and
    // weekly totals are calm.
    _panelWindows() {
        return selectPanelWindows(this._windows, this._settings.get_strv('panel-windows'),
            w => LEVEL_RANK[this._windowLevel(w)] * 1000 + (Number(w.utilization) || 0));
    }

    // The gauge for a window key, created (with the current visibility
    // toggles applied) on first use. A PanelGroup parents it.
    _gauge(key) {
        let gauge = this._gauges.get(key);
        if (!gauge) {
            gauge = new PanelGauge();
            gauge.applyVisibility(this._settings);
            gauge.applyStyle(this._style);
            this._gauges.set(key, gauge);
        }
        return gauge;
    }

    // Syncs the panel with the selected windows. Runs after every poll, on
    // preference changes, and on the countdown tick (the 'worst' selector
    // depends on the burn rate, so the selection can move between polls).
    // The layout — which gauges exist, how they group, dividers, tags — is
    // only redone when its signature changes, so an unchanged panel costs a
    // string compare; the values are then re-applied, which is cheap.
    renderPanel() {
        const sel = this._panelWindows();
        // With nothing to show (no data yet, or signed out) one group holds a
        // single placeholder gauge.
        const groups = sel.length ? groupPanelWindows(sel) : [{windows: [], resetsAt: null}];
        const divider = this._settings.get_string('panel-divider');
        // Tags only when several windows share the block.
        const tagged = sel.length > 1;
        const sig = JSON.stringify([divider, tagged, groups.map(g => g.windows.map(w => [w.key, windowTag(w)]))]);
        if (sig !== this._layoutSig) {
            this._layoutPanel(groups, divider, tagged);
            this._layoutSig = sig;
        }
        this._updatePanel(groups);
    }

    // One PanelGroup per group and one PanelGauge per window, both reused:
    // gauges are keyed by window and move between groups as the grouping
    // changes, and are torn down when their window leaves the selection. The
    // window divider goes before every group but the first.
    _layoutPanel(groups, divider, tagged) {
        const keysOf = g => (g.windows.length ? g.windows.map(w => w.key) : [PLACEHOLDER_GAUGE]);
        const wanted = new Set(groups.flatMap(keysOf));
        for (const [key, gauge] of this._gauges) {
            if (!wanted.has(key)) {
                gauge.destroy();
                this._gauges.delete(key);
            }
        }
        while (this._groups.length > groups.length)
            this._groups.pop().destroy();
        while (this._groups.length < groups.length) {
            const group = new PanelGroup();
            group.applyVisibility(this._settings);
            group.applyStyle(this._style);
            this._gaugesBox.add_child(group.root);
            this._groups.push(group);
        }
        groups.forEach((g, i) => {
            this._groups[i].setGauges(keysOf(g).map(key => this._gauge(key)));
            this._groups[i].setDivider(divider, i > 0);
            for (const w of g.windows)
                this._gauges.get(w.key).setTag(windowTag(w), tagged, w.role === 'scoped');
        });
    }

    // Values, colors and countdowns for the laid-out groups. After a failed
    // refresh every gauge reads '!', and keeps reading it through countdown
    // ticks and preference changes, until a fetch succeeds again.
    _updatePanel(groups) {
        const failed = this.lastResult === 'error';
        groups.forEach((g, i) => {
            this._groups[i].setReset(failed ? null : g.resetsAt);
            if (!g.windows.length) {
                // The placeholder keeps its '…' until the first result is in.
                const gauge = this._gauges.get(PLACEHOLDER_GAUGE);
                if (failed)
                    gauge.setError();
                else if (this.lastResult !== null)
                    gauge.setUnknown();
                return;
            }
            for (const w of g.windows) {
                const gauge = this._gauges.get(w.key);
                if (failed)
                    gauge.setError();
                else if (Number.isFinite(w.utilization))
                    gauge.setValue(w.utilization, this._windowLevel(w));
                else
                    gauge.setUnknown();
            }
        });
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
        this.lastResult = 'error';
        this.renderPanel();
        let msg;
        if (e instanceof UsageError && e.status === 401)
            msg = 'Session expired. Sign in via Claude Code or Settings.';
        else if (e instanceof UsageError && e.status === 403)
            // The API refuses to serve usage for this account: typically no
            // active subscription, even though auth itself succeeded (so the
            // profile fetch above can still show a stale plan/tier). Prefer
            // the API's own wording since it may name the actual cause.
            msg = e.apiMessage() || 'No active Claude subscription for this account.';
        else if (e instanceof UsageError && e.status === 429)
            msg = 'Rate limited by Claude; will retry shortly.';
        else
            msg = e.message || 'Could not reach Claude';
        this._error.text = msg;
        this._setLineState(this._error, 'error', null);
        this._error.visible = true;
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
        this._clearTier();
        this._extra.visible = false;

        // Not a failure: the subtitle and note already say "signed out".
        this.lastResult = 'signed-out';
        // Windows are cleared above, so this collapses to the placeholder.
        this.renderPanel();

        this._error.text = e.message;
        this._setLineState(this._error, 'error', 'dim');
        this._error.visible = true;
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
        for (const gauge of this._gauges.values())
            gauge.destroy();
        this._gauges.clear();
        for (const group of this._groups)
            group.destroy();
        this._groups = [];
        this._gaugesBox?.destroy();
        this._chip?.destroy();
        this._tierIcon?.destroy();
        this._panelTier?.destroy();
        this._leadDivider?.destroy();
        this._profileDivider?.destroy();
        this._panelBlock?.destroy();

        // Popup section contents, then the section itself.
        this._logo?.destroy();
        this._label?.destroy();
        this._subtitle?.destroy();
        this._pill?.destroy();
        this._header?.destroy();
        this._metersBox?.destroy();
        this._section?.destroy();

        this._gaugesBox = null;
        this._chip = null;
        this._tierIcon = null;
        this._panelTier = null;
        this._leadDivider = null;
        this._profileDivider = null;
        this._panelBlock = null;
        this._logo = null;
        this._label = null;
        this._subtitle = null;
        this._pill = null;
        this._header = null;
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
        // Carry a pre-1.5 single "panel reflects" choice into panel-windows.
        migratePanelWindows(settings);
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
            if (!open)
                return;
            // The popup's captions are not ticked while it is closed, and the
            // refresh below may be throttled, so bring them up to date first.
            for (const view of this._profileViews)
                view.refreshCountdowns(true);
            this._refresh();
        }, this);

        // Live-apply preference changes without needing a shell reload.
        this._settings.connectObject(
            'changed::show-icon', () => this._applyVisibility(),
            'changed::panel-gauge', () => this._applyVisibility(),
            'changed::show-percentage', () => this._applyVisibility(),
            'changed::show-tier', () => this._applyVisibility(),
            'changed::show-tier-icon', () => this._applyVisibility(),
            'changed::panel-lead-divider', () => this._applyVisibility(),
            'changed::show-reset', () => this._applyVisibility(),
            'changed::show-profile-chip', () => this._applyVisibility(),
            'changed::panel-windows', () => this._renderAllPanels(),
            'changed::panel-divider', () => this._renderAllPanels(),
            'changed::ui-style', () => this._applyStyle(),
            'changed::poll-seconds', () => this._startTimer(),
            // Signing in (or out) from prefs changes the token source; refetch.
            'changed::access-token', () => this._refresh(true),
            // Profiles were added/removed/renamed/repointed in prefs.
            'changed::profiles', () => this._rebuildFromSettings(),
            this);

        this._applyVisibility();
        this._applyStyle();
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
                this._sectionsBox, showChip, i === 0, allowSharedToken, this._path);
        });
        this._applyVisibility();
        this._applyStyle();
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
        this._popupRoot = new St.BoxLayout({vertical: true, style_class: 'cu-popup'});
        const root = this._popupRoot;
        item.add_child(root);
        this.menu.addMenuItem(item);

        // No global header: each profile section carries its own logo and name,
        // so a single-profile popup looks the way it always did.
        // One section per profile, rebuilt whenever the profile list changes.
        this._sectionsBox = new St.BoxLayout({vertical: true});
        root.add_child(this._sectionsBox);

        // actions
        this._actions = new St.BoxLayout({style_class: 'cu-actions'});
        this._usageBtn = new St.Button({label: 'Usage page', style_class: 'cu-btn', x_expand: true});
        this._usageBtn.connectObject(
            'clicked', () => {
                this.menu.close();
                Gio.AppInfo.launch_default_for_uri(USAGE_SETTINGS_URL, null);
            },
            // Its hover shade may be set inline (see _styleUsageButton).
            'notify::hover', () => this._styleUsageButton(),
            this);
        this._actions.add_child(this._usageBtn);
        root.add_child(this._actions);

        // footer
        this._footer = new St.BoxLayout({style_class: 'cu-footer'});
        const footer = this._footer;
        // One timestamp for the whole popup: every profile refreshes in the
        // same cycle, so a per-profile time would just repeat itself.
        this._updated = new St.Label({text: 'Loading…', style_class: 'cu-updated', x_expand: true});
        footer.add_child(this._updated);
        this._settingsBtn = new St.Button({label: '⚙ Settings', style_class: 'cu-refresh', x_expand: true});
        this._settingsBtn.connectObject('clicked', () => {
            this.menu.close();
            this._openPreferences?.();
        }, this);
        const refreshLabel = this._profileViews?.length > 1 ? '↻ Refresh all' : '↻ Refresh';
        this._refreshBtn = new St.Button({label: refreshLabel, style_class: 'cu-refresh', x_expand: true});
        // connectObject so destroy() can drop this with disconnectObject(this);
        // a bare connect() on a this._* field is flagged by the store's review
        // tooling as a signal that is never disconnected.
        this._refreshBtn.connectObject('clicked', () => this._refresh(true), this);
        footer.add_child(this._settingsBtn);
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

    // One shared timestamp for the whole popup. Every profile refreshes in the
    // same cycle, so this reports the cycle: the time when at least one profile
    // updated, "Update failed" when every profile that could have fetched
    // failed, and nothing at all when they are simply all signed out.
    _renderUpdatedAt() {
        if (!this._updated)
            return;
        const results = this._profileViews.map(v => v.lastResult);
        if (results.includes('ok')) {
            const now = GLib.DateTime.new_now_local();
            this._updated.text = `Updated ${now.format('%H:%M:%S')}`;
        } else if (results.includes('error')) {
            this._updated.text = 'Update failed';
        } else {
            this._updated.text = '';
        }
    }

    _applyVisibility() {
        this._panelIcon.visible = this._settings.get_boolean('show-icon');
        for (const view of this._profileViews)
            view.applyVisibility();
        if (this._refreshBtn)
            this._refreshBtn.label = this._profileViews.length > 1 ? '↻ Refresh all' : '↻ Refresh';
    }

    // Applies the UI settings (the ui-style key: the style values changed from
    // their defaults) to the shared actors of the panel and the popup, and to
    // every profile.
    _applyStyle() {
        const style = uiStyle(loadOverrides(this._settings));
        this._uiStyle = style;
        applyInline(this._panelBox, style, 'panel');
        applyInline(this._panelIcon, style, 'panel-icon');
        applyInline(this._popupRoot, style, 'popup');
        applyInline(this._actions, style, 'actions');
        applyInline(this._footer, style, 'footer');
        applyInline(this._updated, style, 'updated');
        applyInline(this._settingsBtn, style, 'refresh');
        applyInline(this._refreshBtn, style, 'refresh');
        this._styleUsageButton();
        for (const view of this._profileViews)
            view.applyStyle(style);
    }

    // The button's inline style. An inline background beats the stylesheet's
    // :hover rule, so while a changed background is in place the shade under
    // the pointer is worked out from it and set here too.
    _styleUsageButton() {
        const style = this._uiStyle;
        let css = style.inline('btn');
        if (this._usageBtn.hover && style.overridden('btn.background-color'))
            css += ` background-color: ${formatColor(hoverShade(style.rgba('btn.background-color')))};`;
        setIfChanged(this._usageBtn, 'style', css);
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
                if (cancellable.is_cancelled())
                    return;
                this._renderUpdatedAt();
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
    // Nothing is fetched here; the views re-apply their last data.
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
                view.refreshCountdowns(this.menu.isOpen);
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

        this._updated?.destroy();
        this._updated = null;
        this._refreshBtn?.disconnectObject(this);
        this._refreshBtn?.destroy();
        this._refreshBtn = null;
        this._settingsBtn?.disconnectObject(this);
        this._settingsBtn?.destroy();
        this._settingsBtn = null;
        this._usageBtn?.disconnectObject(this);
        this._usageBtn?.destroy();
        this._usageBtn = null;
        this._panelIcon?.destroy();
        this._panelIcon = null;

        this._destroyProfileViews();

        // Destroyed after the profile views, which live inside these boxes.
        this._panelBox?.destroy();
        this._panelBox = null;
        this._sectionsBox?.destroy();
        this._sectionsBox = null;
        this._actions?.destroy();
        this._actions = null;
        this._footer?.destroy();
        this._footer = null;
        this._popupRoot?.destroy();
        this._popupRoot = null;
        this._uiStyle = null;

        super.destroy();
    }
});

export default class ClaudeUsageExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new ClaudeUsageIndicator(
            this.path, this._settings, () => this.openPreferences());
        // Watch both placement keys so a move applies immediately, with no
        // reload and no logging out.
        this._settings.connectObject(
            'changed::panel-position', () => this._place(),
            'changed::panel-index', () => this._place(),
            this);
        this._place();

        // Optional shortcut that opens the popup, the same as clicking the
        // indicator — the shell binds its own panel menus this way (Super+S
        // for quick settings). Unbound by default, so nothing is taken from
        // the user until they choose a combination. Meta follows the GSettings
        // key itself, so changing the shortcut needs no extra plumbing.
        Main.wm.addKeybinding(
            'toggle-menu',
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            // POPUP matters: while the dropdown is open the shell is in popup
            // mode, and a binding without it goes silent — so the shortcut
            // could open the menu but never close it again.
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
            () => this._indicator?.menu.toggle());
    }

    // Puts the indicator in the configured panel box. addToStatusArea refuses a
    // role that is already registered, so the registration is cleared first;
    // the indicator itself is reused, so moving it costs no refetch and leaves
    // the poll timer and current readings alone.
    _place() {
        if (Main.panel.statusArea[this.uuid])
            Main.panel.statusArea[this.uuid] = null;
        Main.panel.addToStatusArea(
            this.uuid, this._indicator,
            this._settings.get_int('panel-index'),
            this._settings.get_string('panel-position'));
    }

    disable() {
        Main.wm.removeKeybinding('toggle-menu');
        this._settings?.disconnectObject(this);
        this._settings = null;
        this._indicator?.destroy();
        this._indicator = null;
    }
}

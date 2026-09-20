// The "UI settings": every style value of the panel (top bar) and of the
// popup that can be changed from preferences, on the "Shared UI" (what the two
// have in common), "Top-Bar UI" and "Popup UI" tabs. Each value is on exactly
// one of them. stylesheet.css stays the source of the defaults;
// this table names each editable value, repeats its default (a test checks the
// two agree), and says which style class and CSS properties it drives. Only
// the values that differ from their default are stored, as a JSON object in
// the `ui-style` GSettings key: {"panel-tier-icon.color": "#ff0000"}.
//
// The extension applies them as inline styles (uiStyle().inline), which beat
// the stylesheet, and reads the few values it paints, measures or acts on
// itself (the ring, the bar's width, a switch) with uiStyle().value / .rgba.
//
// A group can also list `settings`: plain string GSettings keys of their own
// (the two divider texts) that the same preferences page edits, resets and
// counts as changed.
//
// No imports at all, like tokenStore.js, so it is unit-testable under plain
// `node` (tools/test-uiStyle.mjs) and shared by extension.js and prefs.js.

export const UI_STYLE_KEY = 'ui-style';

const WEIGHTS = [['normal', 'Normal'], ['bold', 'Bold']];

// Value builders. A target is {cls, state, css}: the style class without its
// "cu-" prefix, an optional level state ("warn" -> .cu-warn on the same
// actor), and the CSS properties that receive the value. A value with no
// target at all is painted by the extension itself (the ring).
const target = (cls, css, state = null) => ({cls, state, css: [css].flat()});
const px = (id, title, def, targets, extra = {}) =>
    ({id, title, type: 'px', def, min: 0, max: 64, targets: [targets].flat(), ...extra});
const pt = (id, title, def, targets, extra = {}) =>
    ({id, title, type: 'pt', def, min: 4, max: 32, targets: [targets].flat(), ...extra});
const color = (id, title, def, targets, extra = {}) =>
    ({id, title, type: 'color', def, targets: [targets].flat(), ...extra});
// One of `options` ([value, label] pairs). With no target it is a choice the
// extension acts on itself.
const choice = (id, title, def, options, targets = [], extra = {}) =>
    ({id, title, type: 'choice', def, options, targets: [targets].flat(), ...extra});
const weight = (id, title, def, targets, extra = {}) => choice(id, title, def, WEIGHTS, targets, extra);
// A switch the extension acts on itself, so it has no target.
const bool = (id, title, def, extra = {}) => ({id, title, type: 'bool', def, targets: [], ...extra});

// A value that follows another one (`inherits`) until it is changed itself,
// so it has no default and no stylesheet rule of its own. The value it follows
// has to come first in the table, so that this one is written later in the
// inline style and wins. The values on the "Shared UI" tab are followed by one
// value per element on the other two tabs.
const follow = (base, prop) => ({...prop, def: null, inherits: base});

// The font size, color and (where the stylesheet sets one) weight of a label
// class.
const text = (cls, size, def, bold = null) => [
    pt(`${cls}.font-size`, 'Font size', size, target(cls, 'font-size')),
    ...bold ? [weight(`${cls}.font-weight`, 'Font weight', bold, target(cls, 'font-weight'))] : [],
    color(`${cls}.color`, 'Color', def, target(cls, 'color')),
];

// The same for a quiet label, whose color follows the shared muted text color.
const mutedText = (cls, size, bold = null) =>
    text(cls, size, null, bold).map(p => (p.id === `${cls}.color` ? follow('muted.color', p) : p));

// The same values for a class that refines another one: an actor carries both
// classes, and each value follows `base`'s.
const refine = (cls, base) => text(base, null, null, 'bold').map(p => {
    const name = p.id.slice(base.length + 1);
    return follow(p.id, {...p, id: `${cls}.${name}`, targets: [target(cls, name)]});
});

const GREY = 'rgba(128, 128, 128, 1.0)';

// The preferences tabs, in order. A group says which one it is on (`page`).
export const UI_PAGES = [
    {
        id: 'shared',
        title: 'Shared UI',
        icon: 'preferences-desktop-appearance-symbolic',
        description: 'The colors and values that the top bar and the popup have in common.',
    },
    {
        id: 'topbar',
        title: 'Top-Bar UI',
        icon: 'focus-top-bar-symbolic',
        description: 'Sizes, spacing and colors of the indicator in the top bar. The usage colors, and the ' +
            'other values it shares with the popup, are on the "Shared UI" tab.',
    },
    {
        id: 'popup',
        title: 'Popup UI',
        icon: 'view-list-symbolic',
        description: 'Sizes, spacing and colors of the popup that opens from the indicator. The usage colors, ' +
            'and the other values it shares with the top bar, are on the "Shared UI" tab.',
    },
];
const SHARED = 'shared';
const TOPBAR = 'topbar';
const POPUP = 'popup';

// The targets of one value for every popup separator line: the line under a
// profile's header is that box's bottom border (`header`: the property there),
// the ones over the next profile, the actions and the footer are top borders
// (`rest`).
const separators = (header, rest) => [
    target('profile-header', header),
    ...['profile-section-divider', 'actions', 'footer'].map(cls => target(cls, rest)),
];

// Groups are how preferences lays the values out; ids are what is stored.
export const UI_STYLE_GROUPS = [
    // ---- shared by the top bar and the popup: first, since values on the
    // other two tabs follow these ----
    {
        title: 'Usage colors',
        page: SHARED,
        description: 'The gauges in the top bar and the meters in the popup.',
        props: [
            ...[['ok', 'Normal', '#33d17a'], ['warn', 'Warning', '#ff7800'], ['crit', 'Critical', '#e01b24']]
                .map(([level, title, def]) => color(`usage.${level}`, title, def, [
                    target('panel-bar-fill', 'background-color', level),
                    target('fill', 'background-color', level),
                ])),
            color('usage-text.warn', 'Warning text', '#ffa348',
                [target('panel-pct', 'color', 'warn'), target('extra', 'color', 'warn')],
                {subtitle: 'The percentage in the top bar (and the "!" after a failed refresh) and the extra-usage line in the popup.'}),
            color('usage-text.crit', 'Critical text', '#ff6b6b',
                [target('panel-pct', 'color', 'crit'), target('extra', 'color', 'crit')]),
            color('usage.track', 'Track', 'rgba(128, 128, 128, 0.3)',
                [target('panel-bar', 'background-color'), target('track', 'background-color')],
                {subtitle: 'The unfilled part of a gauge or a meter.'}),
        ],
    },
    {
        title: 'Common values',
        page: SHARED,
        description: 'Each of these has a value of its own per element on the other two tabs, which follows ' +
            'the one here until it is changed there.',
        props: [
            color('muted.color', 'Muted text color', GREY, [
                ...['panel-tier', 'panel-chip', 'panel-wtag', 'panel-reset', 'subtitle', 'caption', 'extra', 'updated']
                    .map(cls => target(cls, 'color')),
                target('error', 'color', 'dim'),
            ], {subtitle: 'The tier label, the tags and the countdown in the top bar, and the secondary text in the popup.'}),
            color('line.color', 'Divider and separator color', 'rgba(128, 128, 128, 0.5)', [
                target('panel-divider-line', 'background-color'),
                target('panel-divider-text', 'color'),
                ...separators('border-bottom-color', 'border-top-color'),
            ], {subtitle: 'The dividers in the top bar and the separator lines in the popup.'}),
            px('bar.border-radius', 'Bar corner radius', 99,
                ['panel-bar', 'panel-bar-fill', 'track', 'fill'].map(cls => target(cls, 'border-radius')),
                {subtitle: 'The bar gauge in the top bar and the meters in the popup.', max: 99}),
            weight('pct.font-weight', 'Percentage font weight', 'bold',
                [target('panel-pct', 'font-weight'), target('meter-pct', 'font-weight')],
                {subtitle: 'The percentage in the top bar and the one of each meter in the popup.'}),
        ],
    },

    // ---- the top bar ----
    {
        title: 'Indicator',
        page: TOPBAR,
        description: 'The whole top-bar button.',
        props: [
            px('panel.spacing', 'Space between elements', 5,
                ['panel', 'panel-block', 'panel-gauge'].map(cls => target(cls, 'spacing')),
                {subtitle: 'The icon and the profiles, a profile\'s elements, and a gauge\'s tag, ring or bar, and percentage.'}),
            px('panel-gauges.spacing', 'Space between gauges', 8,
                ['panel-gauges', 'panel-group'].map(cls => target(cls, 'spacing'))),
            px('panel.padding-h', 'Padding, left and right', 4, target('panel', ['padding-left', 'padding-right'])),
        ],
    },
    {
        title: 'Icons',
        page: TOPBAR,
        props: [
            px('panel-icon.icon-size', 'Icon size', 16, target('panel-icon', 'icon-size'),
                {subtitle: 'The Claude icon and the subscription tier icon.', min: 8}),
            color('panel-tier-icon.color', 'Subscription tier icon color', '#D97757', target('panel-tier-icon', 'color')),
        ],
    },
    {
        title: 'Subscription tier label',
        page: TOPBAR,
        props: mutedText('panel-tier', 9, 'bold'),
    },
    {
        title: 'Profile tag',
        page: TOPBAR,
        props: [
            ...mutedText('panel-chip', 8, 'bold'),
            color('panel-chip.background-color', 'Background', 'rgba(128, 128, 128, 0.18)', target('panel-chip', 'background-color')),
            px('panel-chip.padding-v', 'Padding, top and bottom', 1, target('panel-chip', ['padding-top', 'padding-bottom'])),
            px('panel-chip.padding-h', 'Padding, left and right', 4, target('panel-chip', ['padding-left', 'padding-right'])),
            px('panel-chip.border-radius', 'Corner radius', 4, target('panel-chip', 'border-radius'), {max: 99}),
        ],
    },
    {
        title: 'Window tag',
        page: TOPBAR,
        description: 'The "5h" / "7d" / model name before each gauge, when several are shown.',
        props: mutedText('panel-wtag', 8, 'bold'),
    },
    {
        title: 'Model tag',
        page: TOPBAR,
        description: 'The model name (e.g. "Fable") before a per-model gauge. Each value follows the window tag\'s until it is changed here.',
        props: refine('panel-wtag-model', 'panel-wtag'),
    },
    {
        title: 'Circle gauge',
        page: TOPBAR,
        props: [
            px('ring.size', 'Size', 18, target('ring', ['width', 'height']), {min: 8}),
            px('ring.stroke', 'Line width', 3, [], {min: 1, max: 16}),
        ],
    },
    {
        title: 'Bar gauge',
        page: TOPBAR,
        props: [
            px('panel-bar.width', 'Width', 34, target('panel-bar', 'width'), {min: 8, max: 200}),
            px('panel-bar.height', 'Height', 10,
                [target('panel-bar', 'height'), target('panel-bar-fill', 'height')], {min: 2, max: 32}),
            follow('bar.border-radius', px('panel-bar.border-radius', 'Corner radius', null,
                [target('panel-bar', 'border-radius'), target('panel-bar-fill', 'border-radius')], {max: 99})),
        ],
    },
    {
        title: 'Usage percentage',
        page: TOPBAR,
        props: [
            choice('panel-pct.position', 'Position', 'beside',
                [['beside', 'Next to the gauge'], ['over', 'On the gauge']], [],
                {subtitle: 'On the gauge, it takes a smaller font or a larger gauge to fit, and reads better without the % sign.'}),
            bool('panel-pct.sign', 'Show the % sign', true),
            pt('panel-pct.font-size', 'Font size', null, target('panel-pct', 'font-size'),
                {subtitle: 'Default: the panel\'s font size.'}),
            follow('pct.font-weight', weight('panel-pct.font-weight', 'Font weight', null, target('panel-pct', 'font-weight'))),
            color('panel-pct.color', 'Color', null, target('panel-pct', 'color'),
                {subtitle: 'Default: the panel\'s text color. Its warning and critical colors are the "Usage colors".'}),
        ],
    },
    {
        title: 'Time until reset',
        page: TOPBAR,
        props: [
            ...mutedText('panel-reset', 9),
            bool('panel-reset.bold-numbers', 'Bold numbers', false,
                {subtitle: 'Shows "1h19m" with the 1 and the 19 in bold, and the h and the m regular.'}),
        ],
    },
    {
        title: 'Dividers',
        page: TOPBAR,
        description: 'A single | draws a thin vertical line, any other text is shown as typed, and blank shows ' +
            'no divider. The color applies to both kinds; a line has a width and a height, text has a font size.',
        settings: [
            {key: 'panel-lead-divider', title: 'Lead divider (after the icon and tier, and between profiles)'},
            {key: 'panel-divider', title: 'Window divider (between usage windows)'},
        ],
        props: [
            follow('line.color', color('panel-divider.color', 'Color', null,
                [target('panel-divider-line', 'background-color'), target('panel-divider-text', 'color')])),
            px('panel-divider-line.width', 'Line width', 1, target('panel-divider-line', 'width'),
                {subtitle: 'For a | divider.', min: 1, max: 16}),
            px('panel-divider-line.height', 'Line height', 14, target('panel-divider-line', 'height'),
                {subtitle: 'For a | divider.', min: 1}),
            pt('panel-divider-text.font-size', 'Text font size', 9, target('panel-divider-text', 'font-size'),
                {subtitle: 'For any other divider text.'}),
            px('panel-divider-profile.margin-h', 'Margin around the divider between profiles', 6,
                target('panel-divider-profile', ['margin-left', 'margin-right'])),
        ],
    },

    // ---- the popup ----
    {
        title: 'Popup',
        page: POPUP,
        props: [
            px('popup.width', 'Width', 320, target('popup', 'width'), {min: 300, max: 640}),
        ],
    },
    {
        title: 'Profile header',
        page: POPUP,
        description: 'The logo, the profile\'s name and the account line at the top of each profile.',
        props: [
            px('logo.icon-size', 'Logo size', 36, target('logo', 'icon-size'), {min: 16, max: 96}),
            px('profile-header.spacing', 'Space between the logo, the name and the plan', 11, target('profile-header', 'spacing')),
            pt('title.font-size', 'Name font size', 12, target('title', 'font-size')),
            weight('title.font-weight', 'Name font weight', 'bold', target('title', 'font-weight')),
        ],
    },
    {
        title: 'Subscription pill',
        page: POPUP,
        props: [
            ...text('pill', 9, '#ffd9a8', 'bold'),
            color('pill.background-color', 'Background', 'rgba(230, 97, 0, 0.18)', target('pill', 'background-color')),
            color('pill.border-color', 'Border color', 'rgba(230, 97, 0, 0.4)', target('pill', 'border-color')),
            px('pill.padding-v', 'Padding, top and bottom', 3, target('pill', ['padding-top', 'padding-bottom'])),
            px('pill.padding-h', 'Padding, left and right', 9, target('pill', ['padding-left', 'padding-right'])),
            px('pill.border-radius', 'Corner radius', 999, target('pill', 'border-radius'), {max: 999}),
        ],
    },
    {
        title: 'Separator lines',
        page: POPUP,
        description: 'The lines under a profile\'s header, between profiles, and over the button and the footer.',
        props: [
            px('separator.width', 'Line width', 1, separators('border-bottom-width', 'border-top-width'), {max: 8}),
            follow('line.color', color('separator.color', 'Line color', null,
                separators('border-bottom-color', 'border-top-color'))),
            px('separator.space-above', 'Space above a line', 10, separators('padding-bottom', 'margin-top')),
            px('separator.space-below', 'Space below a line', 10, separators('margin-bottom', 'padding-top')),
        ],
    },
    {
        title: 'Meters',
        page: POPUP,
        props: [
            px('meter.spacing', 'Space between a meter\'s title, bar and caption', 5, target('meter', 'spacing')),
            px('meter.margin-bottom', 'Space below each meter', 11, target('meter', 'margin-bottom')),
            pt('meter-name.font-size', 'Title font size', 11, target('meter-name', 'font-size')),
            follow('pct.font-weight',
                weight('meter-pct.font-weight', 'Percentage font weight', null, target('meter-pct', 'font-weight'))),
            px('track.height', 'Bar height', 7, [target('track', 'height'), target('fill', 'height')], {min: 2, max: 32}),
            follow('bar.border-radius', px('track.border-radius', 'Bar corner radius', null,
                [target('track', 'border-radius'), target('fill', 'border-radius')], {max: 99})),
        ],
    },
    {
        title: 'Text',
        page: POPUP,
        props: [
            pt('secondary.font-size', 'Secondary text font size', 9,
                ['subtitle', 'caption', 'extra', 'error', 'updated'].map(cls => target(cls, 'font-size')),
                {subtitle: 'The account line, the meter captions, extra usage, errors and "Updated".'}),
            follow('muted.color', color('secondary.color', 'Secondary text color', null, [
                ...['subtitle', 'caption', 'extra', 'updated'].map(cls => target(cls, 'color')),
                target('error', 'color', 'dim'),
            ], {subtitle: 'The same lines, and the note of a signed-out profile.'})),
            color('error.color', 'Error color', '#ff9c8a', target('error', 'color')),
        ],
    },
    {
        title: 'Button',
        page: POPUP,
        description: 'The "Usage page" button.',
        props: [
            pt('btn.font-size', 'Font size', 10, target('btn', 'font-size')),
            weight('btn.font-weight', 'Font weight', 'bold', target('btn', 'font-weight')),
            color('btn.color', 'Text color', '#ffffff', target('btn', 'color')),
            color('btn.background-color', 'Background', '#3584e4', target('btn', 'background-color'),
                {subtitle: 'The shade it takes under the pointer is worked out from this.'}),
            px('btn.padding-v', 'Padding, top and bottom', 8, target('btn', ['padding-top', 'padding-bottom'])),
            px('btn.padding-h', 'Padding, left and right', 10, target('btn', ['padding-left', 'padding-right'])),
            px('btn.border-radius', 'Corner radius', 9, target('btn', 'border-radius'), {max: 99}),
        ],
    },
    {
        title: 'Footer',
        page: POPUP,
        description: '"Updated" (a secondary text, above), and the Settings and Refresh links.',
        props: [
            px('footer.spacing', 'Space between its elements', 8, target('footer', 'spacing')),
            ...text('refresh', 9, '#62a0ea', 'bold').map(p => ({...p, title: `Link ${p.title.toLowerCase()}`})),
        ],
    },
];

export const UI_STYLE_PROPS = UI_STYLE_GROUPS.flatMap(g => g.props);
export const UI_TEXT_SETTINGS = UI_STYLE_GROUPS.flatMap(g => g.settings ?? []);

// The groups of one preferences tab, in order.
export function pageGroups(page) {
    return UI_STYLE_GROUPS.filter(g => g.page === page);
}

// The group (and through it the tab) a value is in.
export function propGroup(id) {
    return UI_STYLE_GROUPS.find(g => g.props.some(p => p.id === id));
}

const BY_ID = new Map(UI_STYLE_PROPS.map(p => [p.id, p]));

// What a value is while it is not overridden itself: its default, or for one
// that `inherits`, whatever the value it follows currently is. That one may
// follow another in turn (the model tag's color follows the window tag's,
// which follows the shared muted text color).
export function defaultValue(prop, overrides = {}) {
    if (!prop.inherits)
        return prop.def;
    const base = BY_ID.get(prop.inherits);
    return base.id in overrides ? overrides[base.id] : defaultValue(base, overrides);
}

// Pango markup for a compact duration with its numbers bold and the rest
// regular: in "1h19m" the 1 and the 19 are bold, the h and the m are not. Both
// weights are spelled out, because the label's own weight (the stock panel's
// is bold) would otherwise carry over to the units.
export function boldNumbersMarkup(text) {
    const escaped = String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    if (!escaped)
        return '';
    return `<span weight="normal">${escaped.replace(/\d+/g, '<span weight="bold">$&</span>')}</span>`;
}

// [r, g, b, a] as 0-1 floats from "#rgb", "#rrggbb", "#rrggbbaa", "rgb(…)" or
// "rgba(…)"; null for anything else. Doubles as the check that a stored color
// is safe to put in an inline style.
export function parseColor(value) {
    const s = String(value ?? '').trim();
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s)?.[1];
    if (hex) {
        const full = hex.length === 3 ? [...hex].map(c => c + c).join('') : hex;
        const at = i => parseInt(full.slice(i, i + 2), 16) / 255;
        return [at(0), at(2), at(4), full.length === 8 ? at(6) : 1];
    }
    const fn = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(\d*\.?\d+)\s*)?\)$/i.exec(s);
    if (!fn)
        return null;
    const [r, g, b] = [fn[1], fn[2], fn[3]].map(Number);
    const a = fn[4] === undefined ? 1 : Number(fn[4]);
    if (r > 255 || g > 255 || b > 255 || a > 1)
        return null;
    return [r / 255, g / 255, b / 255, a];
}

// The canonical text of a color: "#rrggbb" when opaque, else "rgba(…)".
export function formatColor([r, g, b, a = 1]) {
    const byte = v => Math.round(Math.max(0, Math.min(1, v)) * 255);
    if (a >= 1)
        return `#${[r, g, b].map(v => byte(v).toString(16).padStart(2, '0')).join('')}`;
    return `rgba(${byte(r)}, ${byte(g)}, ${byte(b)}, ${Math.round(Math.max(0, a) * 100) / 100})`;
}

// A stored value as this prop's type, or undefined when it is not usable
// (wrong type, out of range, not a color), in which case the default applies.
export function sanitizeValue(prop, raw) {
    switch (prop?.type) {
    case 'px':
    case 'pt': {
        const n = typeof raw === 'number' ? raw : NaN;
        if (!Number.isFinite(n) || n < prop.min || n > prop.max)
            return undefined;
        return prop.type === 'px' ? Math.round(n) : Math.round(n * 2) / 2;
    }
    case 'color':
        return typeof raw === 'string' && parseColor(raw) ? raw.trim() : undefined;
    case 'choice':
        return prop.options.some(([value]) => value === raw) ? raw : undefined;
    case 'bool':
        return typeof raw === 'boolean' ? raw : undefined;
    default:
        return undefined;
    }
}

// Whether two values of this prop are the same setting ("#FFF" and "#ffffff").
function sameValue(prop, a, b) {
    if (prop.type === 'color' && a !== null && b !== null)
        return formatColor(parseColor(a)) === formatColor(parseColor(b));
    return a === b;
}

function cssValue(prop, value) {
    return prop.type === 'px' || prop.type === 'pt' ? `${value}${prop.type}` : String(value);
}

// The usable overrides among a parsed `ui-style` object: known ids, valid
// values, and nothing that merely restates a default.
export function cleanOverrides(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return out;
    for (const [id, value] of Object.entries(raw)) {
        const prop = BY_ID.get(id);
        const clean = sanitizeValue(prop, value);
        if (clean !== undefined && !sameValue(prop, clean, prop.def))
            out[id] = clean;
    }
    return out;
}

export function loadOverrides(settings) {
    try {
        return cleanOverrides(JSON.parse(settings.get_string(UI_STYLE_KEY)));
    } catch {
        return {};
    }
}

// Stores one value, or drops it with `undefined` (reset) or when it equals the
// default, so "changed from the default" is exactly "has an entry".
export function setOverride(settings, id, value) {
    const overrides = loadOverrides(settings);
    delete overrides[id];
    const next = cleanOverrides({...overrides, [id]: value});
    const text = JSON.stringify(next);
    if (text !== settings.get_string(UI_STYLE_KEY))
        settings.set_string(UI_STYLE_KEY, text);
}

// Whether one of the UI_TEXT_SETTINGS differs from its schema default. The
// extension trims these texts, so blank is blank however it is spelled.
export function textSettingChanged(settings, key) {
    return settings.get_string(key).trim() !== settings.get_default_value(key).unpack().trim();
}

// How many values on one preferences tab differ from their defaults, and the
// reset of all of them ("Reset all" is per tab, and each value is on one tab).
export function changedCount(settings, page) {
    const overrides = loadOverrides(settings);
    const groups = pageGroups(page);
    return groups.flatMap(g => g.props).filter(p => p.id in overrides).length +
        groups.flatMap(g => g.settings ?? []).filter(({key}) => textSettingChanged(settings, key)).length;
}

export function resetPage(settings, page) {
    const overrides = loadOverrides(settings);
    const groups = pageGroups(page);
    for (const {id} of groups.flatMap(g => g.props))
        delete overrides[id];
    const text = JSON.stringify(overrides);
    if (text !== settings.get_string(UI_STYLE_KEY))
        settings.set_string(UI_STYLE_KEY, text);
    for (const {key} of groups.flatMap(g => g.settings ?? []))
        settings.reset(key);
}

// The shade a button takes under the pointer, from its background: a little
// lighter and a little more opaque, like the stylesheet's own :hover rule. An
// inline background beats that rule, so the extension sets this one itself
// while a changed background is in place.
export function hoverShade([r, g, b, a = 1]) {
    const lift = v => v + (1 - v) * 0.12;
    return [lift(r), lift(g), lift(b), Math.min(1, a + 0.12)];
}

// The resolved style for a set of overrides.
//   value(id)  the effective value (the override, else the default; one whose
//              default is the panel's own, the percentage's color and font
//              size, is null until it is overridden)
//   rgba(id)   the same for a color, as [r, g, b, a] floats, or null
//   inline(cls, state)
//              the inline style for an actor of style class cu-<cls> (or of
//              several, given an array) in a state (a level, or "dim"), or
//              null when nothing it uses is overridden, so stylesheet.css
//              alone applies
//   overridden(id)
//              whether that value is changed from its default
export function uiStyle(rawOverrides = {}) {
    const overrides = cleanOverrides(rawOverrides);
    const value = id => {
        if (id in overrides)
            return overrides[id];
        const prop = BY_ID.get(id);
        return prop ? defaultValue(prop, overrides) ?? null : null;
    };
    const overridden = (cls, css) => UI_STYLE_PROPS.some(p => p.id in overrides &&
        p.targets.some(t => t.cls === cls && t.state === null && t.css.includes(css)));

    const build = (classes, state) => {
        const decls = [];
        const emit = (prop, t) => {
            for (const css of t.css)
                decls.push(`${css}: ${cssValue(prop, value(prop.id))};`);
        };
        // Base values first, then the state's, so the state wins like it does
        // in the stylesheet. An inline base value would otherwise beat the
        // stylesheet's state rule, so a state value is also written out when
        // only the base value it replaces was changed.
        for (const prop of UI_STYLE_PROPS) {
            for (const t of prop.targets) {
                if (classes.includes(t.cls) && t.state === null && prop.id in overrides)
                    emit(prop, t);
            }
        }
        for (const prop of UI_STYLE_PROPS) {
            // A value that follows another writes nothing until it is changed
            // itself: the one it follows has the same state targets (a test
            // checks that), and writes them.
            if (prop.inherits && !(prop.id in overrides))
                continue;
            for (const t of prop.targets) {
                if (!classes.includes(t.cls) || t.state === null || t.state !== state)
                    continue;
                if (prop.id in overrides || t.css.some(css => overridden(t.cls, css)))
                    emit(prop, t);
            }
        }
        return decls.length ? decls.join(' ') : null;
    };

    // Asked for on every countdown tick, so each answer is built once.
    const cache = new Map();
    const inline = (cls, state = null) => {
        const classes = [cls].flat();
        const key = `${classes.join(' ')}|${state}`;
        if (!cache.has(key))
            cache.set(key, build(classes, state));
        return cache.get(key);
    };

    return {
        value,
        rgba: id => (value(id) === null ? null : parseColor(value(id))),
        inline,
        overridden: id => id in overrides,
        changed: Object.keys(overrides).length > 0,
    };
}

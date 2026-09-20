#!/usr/bin/env node
// Unit tests for the pure UI-settings table. Runs under plain node (no GI):
//   node tools/test-uiStyle.mjs
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
    UI_PAGES, UI_STYLE_GROUPS, UI_STYLE_PROPS, UI_STYLE_KEY, UI_TEXT_SETTINGS, pageGroups, propGroup,
    parseColor, formatColor, hoverShade, sanitizeValue, cleanOverrides, defaultValue, boldNumbersMarkup,
    loadOverrides, setOverride, textSettingChanged, changedCount, resetPage, uiStyle,
} from '../src/lib/uiStyle.js';

let passed = 0;
const test = (name, fn) => {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
};

// A stand-in for Gio.Settings: the ui-style string (as `text`) and the two
// divider texts, with the schema's defaults.
const DEFAULTS = {[UI_STYLE_KEY]: '{}', 'panel-lead-divider': '|', 'panel-divider': ' '};
const fakeSettings = (text = '{}', others = {}) => ({
    values: {...DEFAULTS, ...others, [UI_STYLE_KEY]: text},
    writes: 0,
    get text() {
        return this.values[UI_STYLE_KEY];
    },
    get_string(key) {
        assert.ok(key in DEFAULTS, key);
        return this.values[key];
    },
    set_string(key, value) {
        assert.ok(key in DEFAULTS, key);
        this.values[key] = value;
        this.writes++;
    },
    get_default_value(key) {
        assert.ok(key in DEFAULTS, key);
        return {unpack: () => DEFAULTS[key]};
    },
    reset(key) {
        assert.ok(key in DEFAULTS, key);
        this.values[key] = DEFAULTS[key];
    },
});

const prop = id => UI_STYLE_PROPS.find(p => p.id === id);

// --- the table itself ---
test('ids are unique and every prop is well-formed', () => {
    const ids = UI_STYLE_PROPS.map(p => p.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const p of UI_STYLE_PROPS) {
        assert.ok(p.title, p.id);
        assert.ok(['px', 'pt', 'color', 'choice', 'bool'].includes(p.type), p.id);
        assert.ok(Array.isArray(p.targets), p.id);
        // A default is itself a valid value. null: the value comes from
        // somewhere else, the panel's own text color or font size, or the
        // value it `inherits`.
        if (p.def !== null)
            assert.equal(sanitizeValue(p, p.def), p.def, p.id);
        else
            assert.ok(p.type === 'color' || p.type === 'pt' || p.inherits, p.id);
        if (p.inherits) {
            // It follows a value of the same type, listed before it, so that
            // its own declaration comes later in an inline style and wins.
            const ids = UI_STYLE_PROPS.map(x => x.id);
            assert.ok(ids.indexOf(p.inherits) >= 0 && ids.indexOf(p.inherits) < ids.indexOf(p.id), p.id);
            assert.equal(prop(p.inherits).type, p.type, p.id);
            assert.equal(p.def, null, p.id);
            // Unchanged, it writes no state declaration of its own, so the
            // value it follows has to have the same state targets.
            for (const t of p.targets.filter(x => x.state !== null)) {
                assert.ok(prop(p.inherits).targets.some(b => b.cls === t.cls && b.state === t.state &&
                    t.css.every(css => b.css.includes(css))), `${p.id}: ${t.cls}.${t.state}`);
            }
        }
    }
    for (const {key, title} of UI_TEXT_SETTINGS)
        assert.ok(key && title, key);
    const pages = UI_PAGES.map(page => page.id);
    for (const g of UI_STYLE_GROUPS) {
        assert.ok(g.title && g.props.length, g.title);
        assert.ok(pages.includes(g.page), g.title);
    }
    for (const page of UI_PAGES)
        assert.ok(page.title && page.icon && pageGroups(page.id).length, page.id);
});

// A value only does something if the extension hands its class to
// applyInline(): by its name there ('panel-tier'), or for the one that comes
// in as a constructor argument, by its full class name ('cu-…').
test('every targeted style class is one extension.js styles', () => {
    const js = readFileSync(new URL('../src/extension.js', import.meta.url), 'utf8');
    const classes = new Set(UI_STYLE_PROPS.flatMap(p => p.targets.map(t => t.cls)));
    assert.ok(classes.size > 30, `${classes.size} classes`);
    for (const cls of classes)
        assert.ok(js.includes(`'${cls}'`) || js.includes(`'cu-${cls}'`), `${cls} is never styled`);
});

// stylesheet.css holds the defaults; the table repeats them so preferences can
// show them and tell a changed value from an unchanged one. Keep them equal.
test('every default matches stylesheet.css', () => {
    const css = readFileSync(new URL('../src/stylesheet.css', import.meta.url), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = new Map();
    for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const decls = {};
        for (const decl of body.split(';')) {
            const at = decl.indexOf(':');
            if (at < 0)
                continue;
            const name = decl.slice(0, at).trim();
            const value = decl.slice(at + 1).trim();
            const border = /^border(-top|-right|-bottom|-left)?$/.exec(name);
            if (border) {
                // "1px solid <color>" -> the width and the color of that side.
                const [, width, color] = /^(\S+)\s+\w+\s+(.+)$/.exec(value);
                Object.assign(decls, {[`${name}-width`]: width, [`${name}-color`]: color});
            } else if (name === 'padding' || name === 'margin') {
                // Expand the 1-4 value shorthand to its four sides.
                const v = value.split(/\s+/);
                const [top, right = top, bottom = top, left = right] = v;
                Object.assign(decls, {
                    [`${name}-top`]: top, [`${name}-right`]: right,
                    [`${name}-bottom`]: bottom, [`${name}-left`]: left,
                });
            } else {
                decls[name] = value;
            }
        }
        for (const selector of selectors.split(','))
            rules.set(selector.trim(), {...rules.get(selector.trim()), ...decls});
    }
    const same = (p, a, b) => (p.type === 'color'
        ? formatColor(parseColor(a)) === formatColor(parseColor(b))
        : parseFloat(a) === parseFloat(b) || a === b);

    const selectorOf = t => `.cu-${t.cls}${t.state ? `.cu-${t.state}` : ''}`;
    // Whether a value with a default of its own declares this: then the
    // declaration is that one's, and a value that follows it adds none.
    const declared = (selector, name) => UI_STYLE_PROPS.some(q => q.def !== null &&
        q.targets.some(u => selectorOf(u) === selector && u.css.includes(name)));

    let checked = 0;
    for (const p of UI_STYLE_PROPS) {
        for (const t of p.targets) {
            const selector = selectorOf(t);
            for (const name of t.css) {
                const actual = rules.get(selector)?.[name];
                if (p.def === null) {
                    if (!declared(selector, name))
                        assert.equal(actual, undefined, `${selector} ${name} should be inherited`);
                    continue;
                }
                assert.ok(actual !== undefined, `${selector} has no ${name}`);
                const expected = p.type === 'px' || p.type === 'pt' ? `${p.def}${p.type}` : p.def;
                assert.ok(same(p, actual, expected), `${selector} ${name}: ${actual} != ${expected}`);
                checked++;
            }
        }
    }
    assert.ok(checked > 90, `only ${checked} declarations checked`);
});

// --- colors ---
test('parseColor: hex, rgb(), rgba(); rejects the rest', () => {
    assert.deepEqual(parseColor('#fff'), [1, 1, 1, 1]);
    assert.deepEqual(parseColor('#FF0000'), [1, 0, 0, 1]);
    assert.deepEqual(parseColor('#00000080'), [0, 0, 0, 128 / 255]);
    assert.deepEqual(parseColor('rgb(255, 0, 0)'), [1, 0, 0, 1]);
    assert.deepEqual(parseColor('rgba(0,0,0,0.5)'), [0, 0, 0, 0.5]);
    assert.deepEqual(parseColor(' rgba(128, 128, 128, 1.0) '), [128 / 255, 128 / 255, 128 / 255, 1]);
    for (const bad of ['', 'red', '#12', '#ggg', 'rgb(300,0,0)', 'rgba(0,0,0,2)', '#fff; width: 9px', null, 7])
        assert.equal(parseColor(bad), null, String(bad));
});

test('formatColor: #rrggbb when opaque, rgba() otherwise, and round-trips', () => {
    assert.equal(formatColor([1, 0, 0, 1]), '#ff0000');
    assert.equal(formatColor([1, 0, 0]), '#ff0000');
    assert.equal(formatColor([0.5, 0.5, 0.5, 0.35]), 'rgba(128, 128, 128, 0.35)');
    for (const text of ['#d97757', 'rgba(128, 128, 128, 0.18)'])
        assert.equal(formatColor(parseColor(text)), text);
});

// --- validation ---
test('sanitizeValue: type, range, rounding', () => {
    const spacing = prop('panel.spacing');
    assert.equal(sanitizeValue(spacing, 7), 7);
    assert.equal(sanitizeValue(spacing, 7.4), 7);
    assert.equal(sanitizeValue(spacing, -1), undefined);
    assert.equal(sanitizeValue(spacing, 999), undefined);
    assert.equal(sanitizeValue(spacing, '7'), undefined);
    assert.equal(sanitizeValue(prop('panel-tier.font-size'), 9.3), 9.5);
    assert.equal(sanitizeValue(prop('panel-tier.font-weight'), 'normal'), 'normal');
    assert.equal(sanitizeValue(prop('panel-tier.font-weight'), 'heavy'), undefined);
    assert.equal(sanitizeValue(prop('panel-tier.color'), '#abc'), '#abc');
    assert.equal(sanitizeValue(prop('panel-tier.color'), 'red; margin: 0'), undefined);
    assert.equal(sanitizeValue(prop('panel-reset.bold-numbers'), true), true);
    assert.equal(sanitizeValue(prop('panel-reset.bold-numbers'), 'yes'), undefined);
    assert.equal(sanitizeValue(undefined, 1), undefined);
});

test('cleanOverrides drops unknown ids, bad values and restated defaults', () => {
    assert.deepEqual(cleanOverrides({
        'panel.spacing': 9,
        'panel.padding-h': 4,                  // the default
        'panel-tier-icon.color': '#d97757',    // the default, other case
        'panel-tier.color': '#ABCDEF',
        'panel-pct.color': '#ffffff',          // inherited by default: kept
        'nope.nothing': 1,
        'ring.stroke': 'thick',
        'ring.ok': '#00ff00',                  // an id from before the colors were shared
    }), {'panel.spacing': 9, 'panel-tier.color': '#ABCDEF', 'panel-pct.color': '#ffffff'});
    for (const junk of [null, [], 'x', 3])
        assert.deepEqual(cleanOverrides(junk), {});
});

// --- storage ---
test('setOverride stores, replaces, and removes a value set back to its default', () => {
    const s = fakeSettings();
    setOverride(s, 'panel.spacing', 9);
    assert.deepEqual(JSON.parse(s.text), {'panel.spacing': 9});
    setOverride(s, 'usage.ok', '#00ff00');
    setOverride(s, 'panel.spacing', 11);
    assert.deepEqual(loadOverrides(s), {'panel.spacing': 11, 'usage.ok': '#00ff00'});
    setOverride(s, 'panel.spacing', 5);
    assert.deepEqual(loadOverrides(s), {'usage.ok': '#00ff00'});
    setOverride(s, 'usage.ok', undefined);
    assert.equal(s.text, '{}');
});

test('setOverride does not write when nothing changes; loadOverrides survives junk', () => {
    const s = fakeSettings();
    setOverride(s, 'panel.spacing', 5);
    setOverride(s, 'panel.spacing', undefined);
    assert.equal(s.writes, 0);
    assert.deepEqual(loadOverrides(fakeSettings('not json')), {});
    assert.deepEqual(loadOverrides(fakeSettings('[1]')), {});
});

test('"Reset all" is per tab, and each value is on one tab', () => {
    const all = {'panel.spacing': 9, 'popup.width': 400, 'usage.ok': '#00ff00', 'muted.color': '#777777'};
    const s = fakeSettings(JSON.stringify(all), {'panel-divider': '┊'});
    assert.equal(changedCount(s, 'shared'), 2);   // usage color, muted text color
    assert.equal(changedCount(s, 'topbar'), 2);   // spacing, divider text
    assert.equal(changedCount(s, 'popup'), 1);    // width
    resetPage(s, 'popup');
    assert.deepEqual(loadOverrides(s), {'panel.spacing': 9, 'usage.ok': '#00ff00', 'muted.color': '#777777'});
    assert.equal(s.get_string('panel-divider'), '┊');
    assert.equal(changedCount(s, 'popup'), 0);
    resetPage(s, 'shared');
    assert.deepEqual(loadOverrides(s), {'panel.spacing': 9});
    assert.equal(s.get_string('panel-divider'), '┊');
    resetPage(s, 'topbar');
    assert.deepEqual(loadOverrides(s), {});
    assert.equal(s.get_string('panel-divider'), ' ');
    assert.equal(uiStyle(loadOverrides(s)).changed, false);
    const writes = s.writes;
    resetPage(s, 'topbar');
    assert.equal(s.writes, writes, 'nothing to reset, nothing written');
});

test('the tabs: what each holds', () => {
    const rows = page => pageGroups(page).reduce((n, g) => n + g.props.length + (g.settings?.length ?? 0), 0);
    assert.deepEqual(UI_PAGES.map(page => page.title), ['Shared UI', 'Top-Bar UI', 'Popup UI']);
    assert.deepEqual(pageGroups('shared').map(g => g.title), ['Usage colors', 'Common values']);
    // Every group is on one tab, and the shared ones come first in the table.
    assert.equal(UI_PAGES.reduce((n, page) => n + pageGroups(page.id).length, 0), UI_STYLE_GROUPS.length);
    assert.deepEqual(UI_STYLE_GROUPS.slice(0, 2), pageGroups('shared'));
    assert.equal(rows('shared'), 10);
    assert.ok(rows('topbar') < 50 && rows('popup') < 50, `${rows('topbar')} / ${rows('popup')} rows`);
    assert.deepEqual(UI_TEXT_SETTINGS.map(t => t.key), ['panel-lead-divider', 'panel-divider']);
});

// --- the resolved style ---
test('uiStyle: nothing changed means no inline style anywhere', () => {
    const style = uiStyle();
    assert.equal(style.changed, false);
    const classes = new Set(UI_STYLE_PROPS.flatMap(p => p.targets.map(t => t.cls)));
    for (const cls of classes) {
        for (const state of [null, 'ok', 'warn', 'crit', 'dim'])
            assert.equal(style.inline(cls, state), null, `${cls} ${state}`);
    }
    assert.equal(style.value('ring.stroke'), 3);
    assert.equal(style.value('panel-pct.color'), null);
    assert.equal(style.rgba('panel-pct.color'), null);
    assert.deepEqual(style.rgba('usage.crit'), parseColor('#e01b24'));
    assert.equal(style.overridden('usage.crit'), false);
    assert.equal(uiStyle({'usage.crit': '#ff0000'}).overridden('usage.crit'), true);
});

test('uiStyle.inline writes each CSS property of a changed value, with units', () => {
    const style = uiStyle({'panel.padding-h': 9, 'panel.spacing': 2, 'panel-tier.font-size': 10.5});
    assert.equal(style.inline('panel'), 'spacing: 2px; padding-left: 9px; padding-right: 9px;');
    assert.equal(style.inline('panel-block'), 'spacing: 2px;');
    assert.equal(style.inline('panel-gauge'), 'spacing: 2px;');
    assert.equal(style.inline('panel-gauges'), null);
    assert.equal(style.inline('panel-tier'), 'font-size: 10.5pt;');
    assert.equal(style.inline('panel-chip'), null);
    assert.equal(style.changed, true);
});

test('uiStyle.inline: one value can drive several classes, and several classes one actor', () => {
    const style = uiStyle({'panel-bar.height': 6, 'panel-icon.icon-size': 20, 'panel-tier-icon.color': '#00ff00'});
    assert.equal(style.inline('panel-bar'), 'height: 6px;');
    assert.equal(style.inline('panel-bar-fill', 'ok'), 'height: 6px;');
    assert.equal(style.inline('panel-icon'), 'icon-size: 20px;');
    assert.equal(style.inline(['panel-icon', 'panel-tier-icon']), 'icon-size: 20px; color: #00ff00;');
    assert.equal(style.inline([]), null);
});

test('uiStyle.inline: a level state beats a changed base value, as in the stylesheet', () => {
    // Only the base color is changed: the warning color must still win, so
    // its (default) value is written after it.
    const base = uiStyle({'panel-pct.color': '#ffffff'});
    assert.equal(base.inline('panel-pct'), 'color: #ffffff;');
    assert.equal(base.inline('panel-pct', 'ok'), 'color: #ffffff;');
    assert.equal(base.inline('panel-pct', 'warn'), 'color: #ffffff; color: #ffa348;');
    // Only a state color is changed: nothing for the other states.
    const crit = uiStyle({'usage-text.crit': '#ff00ff'});
    assert.equal(crit.inline('panel-pct', 'crit'), 'color: #ff00ff;');
    assert.equal(crit.inline('panel-pct', 'warn'), null);
    assert.equal(crit.inline('panel-pct'), null);
    // The popup's error line: muted to the secondary color while signed out.
    const error = uiStyle({'error.color': '#ff0000'});
    assert.equal(error.inline('error'), 'color: #ff0000;');
    assert.equal(error.inline('error', 'dim'), 'color: #ff0000; color: rgba(128, 128, 128, 1.0);');
});

test('shared values reach the top bar, the popup and the ring alike', () => {
    const style = uiStyle({'usage.warn': '#123456', 'usage-text.crit': '#ff00ff', 'usage.track': '#222222'});
    assert.equal(style.inline('panel-bar-fill', 'warn'), 'background-color: #123456;');
    assert.equal(style.inline('fill', 'warn'), 'background-color: #123456;');
    assert.equal(style.inline('fill', 'ok'), null);
    assert.deepEqual(style.rgba('usage.warn'), parseColor('#123456'));
    assert.equal(style.inline('panel-pct', 'crit'), 'color: #ff00ff;');
    assert.equal(style.inline('extra', 'crit'), 'color: #ff00ff;');
    assert.equal(style.inline('panel-bar'), 'background-color: #222222;');
    assert.equal(style.inline('track'), 'background-color: #222222;');
});

test('one separator value styles every line in the popup', () => {
    const style = uiStyle({'separator.color': '#ff0000', 'separator.width': 2, 'separator.space-above': 4});
    assert.equal(style.inline('profile-header'),
        'border-bottom-width: 2px; border-bottom-color: #ff0000; padding-bottom: 4px;');
    for (const cls of ['profile-section-divider', 'actions', 'footer'])
        assert.equal(style.inline(cls), 'border-top-width: 2px; border-top-color: #ff0000; margin-top: 4px;');
    const text = uiStyle({'secondary.color': '#00ff00', 'secondary.font-size': 10});
    for (const cls of ['subtitle', 'caption', 'updated'])
        assert.equal(text.inline(cls), 'font-size: 10pt; color: #00ff00;');
    // The extra-usage line keeps its warning color over the secondary one.
    assert.equal(text.inline('extra', 'warn'), 'font-size: 10pt; color: #00ff00; color: #ffa348;');
    assert.equal(text.inline('error'), 'font-size: 10pt;');
    assert.equal(text.inline('error', 'dim'), 'font-size: 10pt; color: #00ff00;');
});

test('hoverShade: lighter and more opaque, like the stylesheet\'s :hover', () => {
    const shade = hoverShade(parseColor('#3584e4'));
    assert.ok(shade.slice(0, 3).every((v, i) => v > parseColor('#3584e4')[i]));
    assert.equal(shade[3], 1);
    assert.equal(formatColor(hoverShade(parseColor('#ffffff'))), '#ffffff');
    assert.ok(Math.abs(hoverShade([0.5, 0.5, 0.5, 0.18])[3] - 0.30) < 1e-9);
});

test('the divider color is one value for both kinds of divider', () => {
    const style = uiStyle({'panel-divider.color': '#ff0000'});
    assert.equal(style.inline('panel-divider-line'), 'background-color: #ff0000;');
    assert.equal(style.inline('panel-divider-text'), 'color: #ff0000;');
});

test('the values of the two tabs follow the shared ones until they are changed', () => {
    const followers = {
        'muted.color': ['panel-tier.color', 'panel-chip.color', 'panel-wtag.color', 'panel-reset.color', 'secondary.color'],
        'line.color': ['panel-divider.color', 'separator.color'],
        'bar.border-radius': ['panel-bar.border-radius', 'track.border-radius'],
        'pct.font-weight': ['panel-pct.font-weight', 'meter-pct.font-weight'],
    };
    for (const [base, ids] of Object.entries(followers)) {
        assert.equal(propGroup(base).page, 'shared');
        assert.deepEqual(UI_STYLE_PROPS.filter(p => p.inherits === base).map(p => p.id), ids);
        for (const id of ids) {
            assert.notEqual(propGroup(id).page, 'shared', id);
            assert.equal(uiStyle().value(id), prop(base).def, id);
        }
    }

    // The shared value alone reaches every class, and the values that follow
    // it read as it does: the model tag's through the window tag's.
    const shared = uiStyle({'muted.color': '#777777'});
    for (const cls of ['panel-tier', 'panel-chip', 'panel-wtag', 'panel-reset', 'subtitle', 'caption', 'updated'])
        assert.equal(shared.inline(cls), 'color: #777777;');
    assert.equal(shared.inline('error'), null);
    assert.equal(shared.inline('error', 'dim'), 'color: #777777;');
    assert.equal(shared.value('panel-tier.color'), '#777777');
    assert.equal(shared.value('panel-wtag-model.color'), '#777777');
    assert.equal(uiStyle({'muted.color': '#777777', 'panel-wtag.color': '#111111'}).value('panel-wtag-model.color'), '#111111');

    // A value of its own is written after the shared one, so it wins, there only.
    const own = uiStyle({'muted.color': '#777777', 'panel-tier.color': '#ff0000'});
    assert.equal(own.inline('panel-tier'), 'color: #777777; color: #ff0000;');
    assert.equal(own.inline('panel-chip'), 'color: #777777;');
    assert.equal(own.value('panel-tier.color'), '#ff0000');

    const line = uiStyle({'line.color': '#00ff00', 'separator.color': '#0000ff'});
    assert.equal(line.inline('panel-divider-line'), 'background-color: #00ff00;');
    assert.equal(line.inline('panel-divider-text'), 'color: #00ff00;');
    assert.equal(line.inline('footer'), 'border-top-color: #00ff00; border-top-color: #0000ff;');
    assert.equal(line.inline('profile-header'), 'border-bottom-color: #00ff00; border-bottom-color: #0000ff;');

    const bars = uiStyle({'bar.border-radius': 2, 'pct.font-weight': 'normal', 'meter-pct.font-weight': 'bold'});
    for (const cls of ['panel-bar', 'track'])
        assert.equal(bars.inline(cls), 'border-radius: 2px;');
    assert.equal(bars.inline('fill', 'ok'), 'border-radius: 2px;');
    assert.equal(bars.value('track.border-radius'), 2);
    assert.equal(bars.inline('panel-pct'), 'font-weight: normal;');
    assert.equal(bars.inline('meter-pct'), 'font-weight: normal; font-weight: bold;');
});

test('the percentage: next to the gauge or on it, its sign, a font size of its own', () => {
    const style = uiStyle();
    assert.equal(style.value('panel-pct.position'), 'beside');
    assert.equal(style.value('panel-pct.sign'), true);
    assert.equal(style.value('panel-pct.font-size'), null);   // the panel's
    const over = uiStyle({'panel-pct.position': 'over', 'panel-pct.sign': false, 'panel-pct.font-size': 6.5});
    assert.equal(over.value('panel-pct.position'), 'over');
    assert.equal(over.value('panel-pct.sign'), false);
    assert.equal(over.inline('panel-pct'), 'font-size: 6.5pt;');
    assert.equal(over.inline('panel-pct', 'warn'), 'font-size: 6.5pt;');
    assert.equal(uiStyle({'panel-pct.position': 'under'}).value('panel-pct.position'), 'beside');
    // No size is "the default" here: the stock panel's 11pt is a value too.
    assert.deepEqual(cleanOverrides({'panel-pct.font-size': 11, 'panel-pct.sign': true}), {'panel-pct.font-size': 11});
});

test('the model tag follows the window tag until it has a value of its own', () => {
    const size = prop('panel-wtag-model.font-size');
    assert.equal(defaultValue(size), 8);
    assert.equal(defaultValue(size, {'panel-wtag.font-size': 10}), 10);
    assert.equal(defaultValue(prop('panel.spacing'), {'panel.spacing': 9}), 5);

    const model = ['panel-wtag', 'panel-wtag-model'];
    const follows = uiStyle({'panel-wtag.font-size': 10, 'panel-wtag.color': '#ffa348'});
    assert.equal(follows.inline(model), follows.inline('panel-wtag'));
    assert.equal(follows.value('panel-wtag-model.font-size'), 10);
    assert.equal(follows.value('panel-wtag-model.font-weight'), 'bold');

    // Its own value is written after the window tag's, so it wins; one equal
    // to the window tag's default is still its own, and is kept.
    const own = uiStyle({'panel-wtag.font-size': 10, 'panel-wtag.color': '#ffa348',
        'panel-wtag-model.color': '#00ff00', 'panel-wtag-model.font-size': 8});
    assert.equal(own.inline('panel-wtag'), 'font-size: 10pt; color: #ffa348;');
    assert.equal(own.inline(model), 'font-size: 10pt; color: #ffa348; font-size: 8pt; color: #00ff00;');
    assert.equal(own.value('panel-wtag-model.font-size'), 8);
});

test('boldNumbersMarkup: numbers bold, units regular, text escaped', () => {
    const b = n => `<span weight="bold">${n}</span>`;
    assert.equal(boldNumbersMarkup('1h19m'), `<span weight="normal">${b(1)}h${b(19)}m</span>`);
    assert.equal(boldNumbersMarkup('45s'), `<span weight="normal">${b(45)}s</span>`);
    assert.equal(boldNumbersMarkup('now'), '<span weight="normal">now</span>');
    assert.equal(boldNumbersMarkup('<1m & co'), `<span weight="normal">&lt;${b(1)}m &amp; co</span>`);
    assert.equal(boldNumbersMarkup(''), '');
    assert.equal(uiStyle().value('panel-reset.bold-numbers'), false);
    assert.equal(uiStyle({'panel-reset.bold-numbers': true}).value('panel-reset.bold-numbers'), true);
});

test('the divider texts count as changed, and reset, with everything else', () => {
    const s = fakeSettings('{"panel.spacing": 9}', {'panel-divider': '┊'});
    assert.equal(textSettingChanged(s, 'panel-divider'), true);
    assert.equal(textSettingChanged(s, 'panel-lead-divider'), false);
    assert.equal(changedCount(s, 'topbar'), 2);
    assert.equal(changedCount(s, 'popup'), 0);
    // Blank is blank: the default is a space, the extension trims it.
    assert.equal(textSettingChanged(fakeSettings('{}', {'panel-divider': ''}), 'panel-divider'), false);
    assert.equal(textSettingChanged(fakeSettings('{}', {'panel-lead-divider': ' | '}), 'panel-lead-divider'), false);
    resetPage(s, 'topbar');
    assert.equal(changedCount(s, 'topbar'), 0);
    assert.equal(s.get_string('panel-divider'), ' ');
    assert.equal(s.text, '{}');
});

test('uiStyle ignores invalid overrides', () => {
    const style = uiStyle({'panel.spacing': 'wide', 'usage.ok': 'green', 'ring.size': 22});
    assert.equal(style.inline('panel'), null);
    assert.deepEqual(style.rgba('usage.ok'), parseColor('#33d17a'));
    assert.equal(style.value('ring.size'), 22);
});

console.log(`\n${passed} tests passed`);

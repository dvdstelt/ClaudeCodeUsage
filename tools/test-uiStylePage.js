// Smoke test for the "Shared UI", "Top-Bar UI" and "Popup UI" preferences
// pages: builds the real GTK pages against in-memory settings (nothing is written to dconf, no
// window is shown) and drives their controls. Needs a display; run from the repo root
// after `glib-compile-schemas src/schemas/`:
//   gjs -m tools/test-uiStylePage.js
import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {buildUiStylePage} from '../src/lib/uiStylePage.js';
import {UI_STYLE_KEY, pageGroups} from '../src/lib/uiStyle.js';

Adw.init();

let passed = 0;
const assert = (ok, message) => {
    if (!ok)
        throw new Error(`assertion failed: ${message}`);
};
const test = (name, fn) => {
    fn();
    passed++;
    print(`  ok  ${name}`);
};
// Let queued `changed` emissions run.
const settle = () => {
    const context = GLib.MainContext.default();
    while (context.iteration(false))
        ;
};

const schemaDir = GLib.build_filenamev([GLib.get_current_dir(), 'src', 'schemas']);
const source = Gio.SettingsSchemaSource.new_from_directory(schemaDir, Gio.SettingsSchemaSource.get_default(), false);
const settings = new Gio.Settings({
    settings_schema: source.lookup('org.gnome.shell.extensions.claude-usage', false),
    backend: Gio.memory_settings_backend_new(),
});
const stored = () => JSON.parse(settings.get_string(UI_STYLE_KEY));
const rgba = text => {
    const c = new Gdk.RGBA();
    c.parse(text);
    return c;
};

const {page, rows, textRows, resetAll, buildResetAllDialog} = buildUiStylePage(settings, null, 'topbar');
const popup = buildUiStylePage(settings, null, 'popup');
const shared = buildUiStylePage(settings, null, 'shared');

test('one row per value of the tab, all at their defaults', () => {
    assert(page instanceof Adw.PreferencesPage && page.title === 'Top-Bar UI', 'top-bar page');
    assert(popup.page.title === 'Popup UI', 'popup page');
    assert(shared.page.title === 'Shared UI', 'shared page');
    for (const [id, built] of [['topbar', rows], ['popup', popup.rows], ['shared', shared.rows]]) {
        const props = pageGroups(id).flatMap(g => g.props);
        assert(built.size === props.length, `${id}: ${built.size} rows`);
    }
    assert(!rows.has('popup.width') && !popup.rows.has('panel.spacing'), 'each tab has its own values');
    assert(popup.textRows.size === 0 && shared.textRows.size === 0, 'the divider texts are on the top-bar tab only');
    assert(popup.rows.get('popup.width').control.value === 320, 'popup width shows 320');
    for (const {reset} of rows.values())
        assert(!reset.visible, 'no reset button at the default');
    assert(!resetAll.visible, 'no "Reset all" at the defaults');
    assert(rows.get('panel.spacing').control.value === 5, 'spacing shows 5');
    assert(rows.get('panel-tier-icon.color').control.rgba.equal(rgba('#D97757')), 'tier icon is orange');
    assert(rows.get('panel-tier.font-weight').control.selected === 1, 'tier label is bold');
    assert(settings.get_string(UI_STYLE_KEY) === '{}', 'building the page writes nothing');
});

test('changing a control stores the value and shows its reset button', () => {
    rows.get('panel.spacing').control.set_value(9);
    rows.get('panel-tier-icon.color').control.rgba = rgba('#00ff00');
    rows.get('panel-tier.font-weight').control.set_selected(0);
    rows.get('panel-tier.font-size').control.set_value(10.5);
    settle();
    const s = stored();
    assert(s['panel.spacing'] === 9, 'spacing stored');
    assert(s['panel-tier-icon.color'] === '#00ff00', `color stored: ${s['panel-tier-icon.color']}`);
    assert(s['panel-tier.font-weight'] === 'normal', 'weight stored');
    assert(s['panel-tier.font-size'] === 10.5, 'font size stored');
    assert(Object.keys(s).length === 4, 'nothing else stored');
    assert(rows.get('panel.spacing').reset.visible, 'reset shown for spacing');
    assert(!rows.get('panel.padding-h').reset.visible, 'not for an untouched row');
    assert(resetAll.visible, '"Reset all" shown');
});

test('a row\'s reset button restores the default and hides itself', () => {
    const {control, reset} = rows.get('panel.spacing');
    reset.emit('clicked');
    settle();
    assert(!('panel.spacing' in stored()), 'override removed');
    assert(control.value === 5, 'control back at 5');
    assert(!reset.visible, 'reset hidden');
    assert(resetAll.visible, 'others are still changed');
});

test('setting a value back to its default by hand counts as unchanged', () => {
    const {control, reset} = rows.get('panel-tier.font-weight');
    control.set_selected(1);
    settle();
    assert(!('panel-tier.font-weight' in stored()), 'override removed');
    assert(!reset.visible, 'reset hidden');
});

test('an external change (dconf, another window) reaches the rows', () => {
    settings.set_string(UI_STYLE_KEY, JSON.stringify({'ring.size': 24, 'panel-pct.color': '#ff0000'}));
    settle();
    assert(rows.get('ring.size').control.value === 24, 'ring size shown');
    assert(rows.get('ring.size').reset.visible, 'ring size reset shown');
    assert(rows.get('panel-pct.color').control.rgba.equal(rgba('#ff0000')), 'inherited color shown once set');
    assert(!rows.get('panel-tier-icon.color').reset.visible, 'dropped override reset hidden');
    assert(rows.get('panel-tier-icon.color').control.rgba.equal(rgba('#D97757')), 'and back to orange');
    assert(Object.keys(stored()).length === 2, 'showing values wrote nothing back');
});

test('a switch stores true, and back to off counts as unchanged', () => {
    const {control, reset} = rows.get('panel-reset.bold-numbers');
    assert(control instanceof Gtk.Switch && !control.active, 'off by default');
    control.set_active(true);
    settle();
    assert(stored()['panel-reset.bold-numbers'] === true, 'stored');
    assert(reset.visible, 'reset shown');
    control.set_active(false);
    settle();
    assert(!('panel-reset.bold-numbers' in stored()), 'override removed');
    assert(!reset.visible, 'reset hidden');
});

test('the percentage: a position, a switch for its sign, and the panel\'s font size until one is set', () => {
    const position = rows.get('panel-pct.position');
    const sign = rows.get('panel-pct.sign');
    const size = rows.get('panel-pct.font-size');
    assert(position.control instanceof Gtk.DropDown && position.control.selected === 0, 'next to the gauge by default');
    assert(sign.control instanceof Gtk.Switch && sign.control.active, 'the sign is on by default');
    assert(size.control.value === 11 && !size.reset.visible, 'shows the stock 11pt while it is the panel\'s');
    assert(size.reset.tooltip_text.includes('the panel\'s font size'), size.reset.tooltip_text);
    position.control.set_selected(1);
    sign.control.set_active(false);
    size.control.set_value(6.5);
    settle();
    const s = stored();
    assert(s['panel-pct.position'] === 'over', 'position stored');
    assert(s['panel-pct.sign'] === false, 'sign stored');
    assert(s['panel-pct.font-size'] === 6.5, 'font size stored');
    for (const {reset} of [position, sign, size]) {
        assert(reset.visible, 'reset shown');
        reset.emit('clicked');
    }
    settle();
    assert(!Object.keys(stored()).some(id => id.startsWith('panel-pct.') && id !== 'panel-pct.color'), 'overrides removed');
    assert(position.control.selected === 0 && sign.control.active && size.control.value === 11, 'controls back');
});

test('a model tag value shows the window tag\'s until it has its own', () => {
    const model = rows.get('panel-wtag-model.font-size');
    assert(model.control.value === 8, 'shows the window tag default');
    rows.get('panel-wtag.font-size').control.set_value(10);
    settle();
    assert(model.control.value === 10, 'follows the window tag');
    assert(!model.reset.visible && !('panel-wtag-model.font-size' in stored()), 'without a value of its own');
    model.control.set_value(8);
    settle();
    assert(stored()['panel-wtag-model.font-size'] === 8, 'its own value is kept, even the default size');
    assert(model.reset.visible, 'reset shown');
    model.reset.emit('clicked');
    settle();
    assert(model.control.value === 10, 'reset: follows the window tag again');
    rows.get('panel-wtag.font-size').reset.emit('clicked');
    settle();
});

test('the divider texts are edited, reset and counted here', () => {
    assert(textRows.size === 2, 'two divider text rows');
    const {control, reset} = textRows.get('panel-divider');
    assert(textRows.get('panel-lead-divider').control.text === '|', 'lead divider shown');
    assert(!reset.visible, 'no reset at the default');
    const before = resetAll.visible;
    control.text = '┊';
    settle();
    assert(settings.get_string('panel-divider') === '┊', 'typing writes the setting');
    assert(reset.visible, 'reset shown');
    assert(resetAll.visible, '"Reset all" shown for a divider text alone or not');
    reset.emit('clicked');
    settle();
    assert(settings.get_string('panel-divider') === ' ' && !reset.visible, 'reset to blank');
    assert(resetAll.visible === before, '"Reset all" back to what it was');
    control.text = '┊';
    settle();
});

test('a shared value is on the "Shared UI" tab only, and the rows that follow it show it', () => {
    const muted = shared.rows.get('muted.color');
    assert(muted && !rows.has('muted.color') && !popup.rows.has('muted.color'), 'on the shared tab only');
    assert(shared.rows.has('usage.warn') && !rows.has('usage.warn') && !popup.rows.has('usage.warn'), 'the usage colors too');
    const tier = rows.get('panel-tier.color');
    const secondary = popup.rows.get('secondary.color');
    const grey = rgba('rgba(128, 128, 128, 1.0)');
    assert(tier.control.rgba.equal(grey) && secondary.control.rgba.equal(grey), 'both show the shared default');
    assert(tier.row.subtitle.includes('"Muted text color" on the "Shared UI" tab'), `says what it follows: ${tier.row.subtitle}`);
    assert(tier.reset.tooltip_text.includes('on the "Shared UI" tab'), tier.reset.tooltip_text);
    assert(rows.get('panel-wtag-model.color').reset.tooltip_text.includes('under "Window tag"'), 'within a tab: the group');
    assert(rows.get('panel-wtag-model.color').row.subtitle === '', 'and no note, the group says it');

    const popupBefore = popup.resetAll.visible;
    muted.control.rgba = rgba('#123456');
    settle();
    assert(stored()['muted.color'] === '#123456', 'stored once');
    assert(tier.control.rgba.equal(rgba('#123456')) && secondary.control.rgba.equal(rgba('#123456')), 'followed on both tabs');
    assert(rows.get('panel-wtag-model.color').control.rgba.equal(rgba('#123456')), 'and through the window tag');
    assert(!tier.reset.visible && !secondary.reset.visible, 'without values of their own');
    assert(shared.resetAll.visible && popup.resetAll.visible === popupBefore, 'it counts on the shared tab only');

    tier.control.rgba = rgba('#ff0000');
    settle();
    assert(stored()['panel-tier.color'] === '#ff0000' && tier.reset.visible, 'a value of its own');
    assert(secondary.control.rgba.equal(rgba('#123456')), 'the others still follow');
    tier.reset.emit('clicked');
    settle();
    assert(tier.control.rgba.equal(rgba('#123456')) && !tier.reset.visible, 'reset: follows the shared value again');

    const dialog = shared.buildResetAllDialog();
    assert(dialog.heading.includes('Shared UI') && dialog.body.includes('one value'), `${dialog.heading} ${dialog.body}`);
    dialog.emit('response', 'reset');
    settle();
    assert(!('muted.color' in stored()) && !shared.resetAll.visible, 'shared tab back at its defaults');
    assert(tier.control.rgba.equal(grey) && secondary.control.rgba.equal(grey), 'and so are the rows that follow');
});

test('"Reset all" only resets its own tab', () => {
    popup.rows.get('popup.width').control.set_value(400);
    popup.rows.get('separator.color').control.rgba = rgba('#ff0000');
    settle();
    const before = Object.keys(stored()).length;
    const dialog = popup.buildResetAllDialog();
    assert(dialog.heading.includes('Popup UI'), `heading names the tab: ${dialog.heading}`);
    assert(dialog.body.includes('2'), `body counts this tab's changes: ${dialog.body}`);
    dialog.emit('response', 'reset');
    settle();
    assert(Object.keys(stored()).length === before - 2, 'the top-bar values are still there');
    assert(!('popup.width' in stored()) && popup.rows.get('popup.width').control.value === 320, 'popup width back at 320');
    assert(!popup.resetAll.visible && resetAll.visible, 'only the popup tab is back at its defaults');
    assert(settings.get_string('panel-divider') === '┊', 'the divider text is not the popup tab\'s to reset');
});

test('"Reset all": cancel keeps everything, confirm clears everything', () => {
    let dialog = buildResetAllDialog();
    assert(dialog instanceof Adw.AlertDialog, 'an alert dialog');
    assert(dialog.body.includes('3'), `body counts the changes: ${dialog.body}`);
    assert(dialog.default_response === 'cancel' && dialog.close_response === 'cancel', 'cancel is the safe default');
    dialog.emit('response', 'cancel');
    settle();
    assert(Object.keys(stored()).length === 2, 'cancel changes nothing');

    dialog = buildResetAllDialog();
    dialog.emit('response', 'reset');
    settle();
    assert(settings.get_string(UI_STYLE_KEY) === '{}', 'confirm clears the key');
    assert(settings.get_string('panel-divider') === ' ', 'and the divider text');
    assert(!textRows.get('panel-divider').reset.visible, 'divider reset hidden');
    for (const [id, {reset}] of rows)
        assert(!reset.visible, `${id} reset hidden`);
    assert(!resetAll.visible, '"Reset all" hidden again');
    assert(rows.get('ring.size').control.value === 18, 'ring size back at 18');
});

print(`\n${passed} tests passed`);

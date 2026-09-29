// The "Shared UI", "Top-Bar UI" and "Popup UI" preferences pages: one row per
// value that lib/uiStyle.js puts on that page, each with a reset button while it differs
// from its default, plus a "Reset all" button (with a confirmation, and for
// that page only) while anything on it does. The rows write
// the `ui-style` key as they change, which the extension applies live. A
// group's `settings` (the divider texts, GSettings keys of their own) get the
// same treatment.
//
// Preferences only: this imports Gtk, which must never be loaded into the
// shell process, so never import it from extension.js. It has no shell
// imports either, so it also runs under plain gjs (tools/test-uiStylePage.js).

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';

import {
    UI_PAGES, UI_STYLE_PROPS, UI_STYLE_KEY, pageGroups, propGroup, loadOverrides, setOverride, formatColor,
    defaultValue, textSettingChanged, changedCount, resetPage,
} from './uiStyle.js';

// What a control shows for a value whose default is "whatever the panel's own
// is" (the percentage's color and font size): the stock panel's white, 11pt.
const INHERITED_COLOR = '#ffffff';
const INHERITED_SIZE = 11;

// The value that `prop` follows, the group that one is in, and the title of
// its tab when that is another tab than `prop`'s own (null within one tab).
function followed(prop) {
    const base = UI_STYLE_PROPS.find(p => p.id === prop.inherits);
    const group = propGroup(base.id);
    const tab = group.page === propGroup(prop.id).page ? null : UI_PAGES.find(p => p.id === group.page).title;
    return {base, group, tab};
}

function defaultText(prop) {
    if (prop.inherits) {
        const {base, group, tab} = followed(prop);
        return `follows "${base.title}" ${tab ? `on the "${tab}" tab` : `under "${group.title}"`}`;
    }
    if (prop.type === 'bool')
        return prop.def ? 'on' : 'off';
    if (prop.def === null)
        return prop.type === 'color' ? 'the panel\'s text color' : 'the panel\'s font size';
    if (prop.type === 'choice')
        return prop.options.find(([value]) => value === prop.def)[1].toLowerCase();
    return prop.type === 'color' ? prop.def : `${prop.def}${prop.type}`;
}

// The control for one value: {widgets, show(value)}. `changed(value)` is
// called with the new value when the user changes it (never from show()).
function buildControl(prop, changed) {
    if (prop.type === 'px' || prop.type === 'pt') {
        const fine = prop.type === 'pt';
        const spin = new Gtk.SpinButton({
            adjustment: new Gtk.Adjustment({
                lower: prop.min,
                upper: prop.max,
                step_increment: fine ? 0.5 : 1,
                page_increment: fine ? 2 : 4,
            }),
            digits: fine ? 1 : 0,
            numeric: true,
            width_chars: 4,
            valign: Gtk.Align.CENTER,
        });
        spin.connect('value-changed', () => changed(spin.value));
        const unit = new Gtk.Label({label: prop.type, css_classes: ['dim-label']});
        return {control: spin, widgets: [spin, unit], show: value => spin.set_value(value ?? INHERITED_SIZE)};
    }
    if (prop.type === 'color') {
        const button = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({title: prop.title, with_alpha: true}),
            valign: Gtk.Align.CENTER,
        });
        button.connect('notify::rgba', () => {
            const c = button.rgba;
            changed(formatColor([c.red, c.green, c.blue, c.alpha]));
        });
        const show = value => {
            const rgba = new Gdk.RGBA();
            rgba.parse(value ?? INHERITED_COLOR);
            button.rgba = rgba;
        };
        return {control: button, widgets: [button], show};
    }
    if (prop.type === 'bool') {
        const toggle = new Gtk.Switch({valign: Gtk.Align.CENTER});
        toggle.connect('notify::active', () => changed(toggle.active));
        return {control: toggle, widgets: [toggle], show: value => toggle.set_active(value)};
    }
    const values = prop.options.map(([value]) => value);
    const dropdown = Gtk.DropDown.new_from_strings(prop.options.map(([, label]) => label));
    dropdown.valign = Gtk.Align.CENTER;
    dropdown.connect('notify::selected', () => changed(values[dropdown.selected]));
    return {control: dropdown, widgets: [dropdown], show: value => dropdown.set_selected(Math.max(0, values.indexOf(value)))};
}

// A value that follows one on another tab says so under its title (within one
// tab, the group's description does).
function subtitleText(prop) {
    const {base, tab} = prop.inherits ? followed(prop) : {};
    const note = tab ? `Follows "${base.title}" on the "${tab}" tab until it is changed here.` : '';
    return [prop.subtitle, note].filter(Boolean).join(' ');
}

// One row: title, [reset] [control]. The reset button sits before the
// control, so the control does not move under the pointer when it appears.
function buildRow(prop, settings, guard) {
    const row = new Adw.ActionRow({title: prop.title, subtitle: subtitleText(prop)});
    const reset = new Gtk.Button({
        icon_name: 'edit-undo-symbolic',
        tooltip_text: `Reset to the default (${defaultText(prop)})`,
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
        visible: false,
    });
    reset.connect('clicked', () => setOverride(settings, prop.id, undefined));
    row.add_suffix(reset);

    const {control, widgets, show} = buildControl(prop, value => {
        if (!guard.syncing)
            setOverride(settings, prop.id, value);
    });
    for (const widget of widgets)
        row.add_suffix(widget);
    row.activatable_widget = control;

    const sync = overrides => {
        show(prop.id in overrides ? overrides[prop.id] : defaultValue(prop, overrides));
        reset.visible = prop.id in overrides;
    };
    return {row, control, reset, sync};
}

// The row for a plain string setting of its own (a divider text): an entry
// bound to the key, applied keystroke by keystroke, with the same reset button.
function buildTextSettingRow({key, title}, settings) {
    const row = new Adw.EntryRow({title});
    settings.bind(key, row, 'text', Gio.SettingsBindFlags.DEFAULT);
    const shown = text => (text.trim() ? `"${text.trim()}"` : 'blank');
    const reset = new Gtk.Button({
        icon_name: 'edit-undo-symbolic',
        tooltip_text: `Reset to the default (${shown(settings.get_default_value(key).unpack())})`,
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
        visible: false,
    });
    reset.connect('clicked', () => settings.reset(key));
    row.add_suffix(reset);
    const sync = () => {
        reset.visible = textSettingChanged(settings, key);
    };
    return {row, control: row, reset, sync};
}

// The "Reset all" confirmation of one page, not yet presented.
function buildResetAllDialog(settings, page) {
    const count = changedCount(settings, page.id);
    const dialog = new Adw.AlertDialog({
        heading: `Reset all "${page.title}" settings?`,
        body: count === 1
            ? 'The one value you changed on this tab goes back to its default.'
            : `All ${count} values you changed on this tab go back to their defaults.`,
    });
    dialog.add_response('cancel', 'Cancel');
    dialog.add_response('reset', 'Reset all');
    dialog.set_response_appearance('reset', Adw.ResponseAppearance.DESTRUCTIVE);
    dialog.set_default_response('cancel');
    dialog.set_close_response('cancel');
    dialog.connect('response', (_dialog, response) => {
        if (response === 'reset')
            resetPage(settings, page.id);
    });
    return dialog;
}

// Builds one of the UI_PAGES. Returns {page, rows, textRows, resetAll,
// buildResetAllDialog}: prefs.js only needs `page`; the rest is there for the
// smoke test.
export function buildUiStylePage(settings, window, pageId) {
    const info = UI_PAGES.find(p => p.id === pageId);
    const page = new Adw.PreferencesPage({title: info.title, icon_name: info.icon});

    const resetAll = new Gtk.Button({
        label: 'Reset all',
        valign: Gtk.Align.CENTER,
        css_classes: ['destructive-action'],
        visible: false,
    });
    resetAll.connect('clicked', () => buildResetAllDialog(settings, info).present(window));
    const intro = new Adw.PreferencesGroup({
        title: info.title,
        description: `${info.description} Changes apply immediately. A changed value gets a reset button.`,
        header_suffix: resetAll,
    });
    page.add(intro);

    // Set while the rows are being brought in line with the setting, so
    // showing a value is not taken for the user changing it.
    const guard = {syncing: false};
    const rows = new Map();
    const textRows = new Map();
    for (const {title, description, props, settings: textSettings = []} of pageGroups(pageId)) {
        const group = new Adw.PreferencesGroup({title, description: description ?? ''});
        page.add(group);
        for (const textSetting of textSettings) {
            const built = buildTextSettingRow(textSetting, settings);
            group.add(built.row);
            textRows.set(textSetting.key, built);
        }
        for (const prop of props) {
            const built = buildRow(prop, settings, guard);
            group.add(built.row);
            rows.set(prop.id, built);
        }
    }

    const syncAll = () => {
        const overrides = loadOverrides(settings);
        guard.syncing = true;
        for (const {sync} of rows.values())
            sync(overrides);
        guard.syncing = false;
        for (const {sync} of textRows.values())
            sync();
        resetAll.visible = changedCount(settings, pageId) > 0;
    };
    settings.connect(`changed::${UI_STYLE_KEY}`, syncAll);
    for (const key of textRows.keys())
        settings.connect(`changed::${key}`, syncAll);
    syncAll();

    return {page, rows, textRows, resetAll, buildResetAllDialog: () => buildResetAllDialog(settings, info)};
}

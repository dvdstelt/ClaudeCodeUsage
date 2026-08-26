// Profile list management: each profile is {id, label, configDir}, persisted
// as a JSON string in the "profiles" GSettings key (an array of small objects
// doesn't map cleanly onto a GVariant type, so JSON keeps this file and prefs
// simple). Kept free of `resource:///org/gnome/shell` imports so it stays
// usable from prefs and plain gjs, like usageClient.js.
import Gio from 'gi://Gio';
import {discoverConfigDirs, defaultConfigDir} from './usageClient.js';

export function loadProfiles(settings) {
    let list;
    try {
        list = JSON.parse(settings.get_string('profiles'));
    } catch {
        list = [];
    }
    return Array.isArray(list)
        ? list.filter(p => p && typeof p.configDir === 'string' && p.configDir)
        : [];
}

export function saveProfiles(settings, profiles) {
    settings.set_string('profiles', JSON.stringify(profiles));
}

// ".claude" -> "Claude", ".claude-work" -> "Work", ".claude-my-team" -> "My Team".
export function labelForDirName(name) {
    if (name === '.claude')
        return 'Claude';
    const rest = name.replace(/^\.claude-/, '');
    const words = rest.split(/[-_]+/).filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1));
    return words.length > 0 ? words.join(' ') : 'Claude';
}

let seq = 0;
export function makeProfileId() {
    seq += 1;
    return `p${Date.now().toString(36)}${seq.toString(36)}`;
}

// Ensures at least one profile is configured, auto-detecting ~/.claude and any
// sibling ~/.claude-* directory that already holds Claude Code credentials
// (that's the standard CLAUDE_CONFIG_DIR convention for running multiple
// accounts). Runs once: once any profile is saved, later calls are a no-op, so
// a user who deletes down to zero profiles on purpose isn't re-seeded from
// under them by the next `enable()`.
export async function ensureProfiles(settings) {
    const existing = loadProfiles(settings);
    if (existing.length > 0)
        return existing;
    if (settings.get_boolean('profiles-initialized'))
        return existing;

    const discovered = await discoverConfigDirs();
    const seeded = discovered.length > 0
        ? discovered.map(({name, configDir}) => ({id: makeProfileId(), label: labelForDirName(name), configDir}))
        : [{id: makeProfileId(), label: 'Claude', configDir: defaultConfigDir()}];

    saveProfiles(settings, seeded);
    settings.set_boolean('profiles-initialized', true);
    // This is a one-time write that matters (it's what stops re-seeding from
    // clobbering a deliberately-emptied list), and prefs is a short-lived
    // process that may exit right after the window closes; force it to disk
    // instead of trusting the backend's normal async flush.
    Gio.Settings.sync();
    return seeded;
}

#!/usr/bin/env node
// Unit tests for the pure usage model. Runs under plain node (no GI):
//   node tools/test-usageModel.mjs
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {
    normalizeWindows, normalizeSpend, apiSeverityLevel, limitLabel, limitKey,
    selectPanelWindows, windowTag, migratePanelWindows, groupPanelWindows, tierIconName,
    PANEL_SELECTORS, TIER_ICONS,
} from '../src/lib/usageModel.js';

let passed = 0;
const test = (name, fn) => {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
};

// --- severity mapping ---
test('apiSeverityLevel maps the three known values + falls back to ok', () => {
    assert.equal(apiSeverityLevel('critical'), 'crit');
    assert.equal(apiSeverityLevel('warning'), 'warn');
    assert.equal(apiSeverityLevel('normal'), 'ok');
    assert.equal(apiSeverityLevel('something-new'), 'ok');
    assert.equal(apiSeverityLevel(undefined), 'ok');
});

// --- new limits[] shape (real payload, model scoped to Fable at 100%) ---
const live = {
    five_hour: {utilization: 8.0, resets_at: '2026-07-13T07:40:00+00:00'},
    seven_day: {utilization: 64.0, resets_at: '2026-07-15T14:00:00+00:00'},
    seven_day_opus: null,
    tangelo: null,
    limits: [
        {kind: 'session', group: 'session', percent: 8, severity: 'normal', resets_at: '2026-07-13T07:40:00+00:00', scope: null, is_active: false},
        {kind: 'weekly_all', group: 'weekly', percent: 64, severity: 'normal', resets_at: '2026-07-15T14:00:00+00:00', scope: null, is_active: false},
        {kind: 'weekly_scoped', group: 'weekly', percent: 100, severity: 'critical', resets_at: '2026-07-15T14:00:00+00:00', scope: {model: {id: null, display_name: 'Fable'}, surface: null}, is_active: true},
    ],
    spend: {
        used: {amount_minor: 41654, currency: 'USD', exponent: 2},
        limit: {amount_minor: 50000, currency: 'USD', exponent: 2},
        percent: 83, severity: 'warning', enabled: true,
    },
    extra_usage: {is_enabled: true, monthly_limit: 50000, used_credits: 41654.0, utilization: 83.308, currency: 'USD', decimal_places: 2},
};

test('normalizeWindows prefers limits[] and surfaces the scoped Fable window', () => {
    const ws = normalizeWindows(live);
    assert.equal(ws.length, 3, 'three windows');
    // ordered: session, weekly_all, weekly_scoped
    assert.deepEqual(ws.map(w => w.role), ['session', 'weekly', 'scoped']);
    assert.deepEqual(ws.map(w => w.label), ['5-hour', '7-day (all models)', '7-day Fable']);
    const fable = ws[2];
    assert.equal(fable.utilization, 100);
    assert.equal(fable.apiLevel, 'crit');
    assert.equal(fable.isActive, true);
    assert.equal(fable.totalSeconds, 7 * 24 * 3600);
    assert.equal(fable.resetsAt, '2026-07-15T14:00:00+00:00');
    // stable, model-qualified key
    assert.equal(fable.key, 'limit:weekly_scoped:weekly:Fable');
});

test('limits[] entries without a numeric percent are dropped', () => {
    const ws = normalizeWindows({limits: [
        {kind: 'session', group: 'session', percent: 5, severity: 'normal'},
        {kind: 'weekly_scoped', group: 'weekly', percent: null, severity: 'normal', scope: {model: {display_name: 'Ghost'}}},
    ]});
    assert.equal(ws.length, 1);
    assert.equal(ws[0].role, 'session');
});

// --- legacy fallback ---
test('normalizeWindows falls back to legacy keys when limits[] is absent', () => {
    const ws = normalizeWindows({
        five_hour: {utilization: 12, resets_at: 'a'},
        seven_day: {utilization: 40, resets_at: 'b'},
        seven_day_sonnet: {utilization: 22, resets_at: 'c'},
        seven_day_opus: null,
    });
    assert.deepEqual(ws.map(w => w.label), ['5-hour', '7-day', '7-day Sonnet']);
    assert.deepEqual(ws.map(w => w.role), ['session', 'weekly', 'scoped']);
    assert.equal(ws.every(w => w.apiLevel === 'ok'), true);
    assert.equal(ws[0].key, 'legacy:five_hour');
});

test('empty limits[] falls back rather than rendering nothing', () => {
    const ws = normalizeWindows({limits: [], five_hour: {utilization: 3, resets_at: 'x'}});
    assert.equal(ws.length, 1);
    assert.equal(ws[0].role, 'session');
});

test('empty/garbage usage yields no windows without throwing', () => {
    assert.deepEqual(normalizeWindows(null), []);
    assert.deepEqual(normalizeWindows({}), []);
});

// --- labels & keys for unknown future models ---
test('unknown scoped models are humanised, not dropped', () => {
    const e = {kind: 'weekly_scoped', group: 'weekly', percent: 1, scope: {model: {display_name: 'Cinder Cove'}, surface: 'api'}};
    assert.equal(limitLabel(e), '7-day Cinder Cove · Api');
    assert.equal(limitKey(e), 'limit:weekly_scoped:weekly:Cinder Cove:api');
});

// --- spend / extra_usage ---
test('normalizeSpend prefers the structured spend object', () => {
    const s = normalizeSpend(live);
    assert.equal(s.used, 'USD 416.54');
    assert.equal(s.limit, 'USD 500.00');
    assert.equal(s.percent, 83);
    assert.equal(s.level, 'warn');
});

test('normalizeSpend falls back to extra_usage scaled by decimal_places', () => {
    const s = normalizeSpend({extra_usage: {is_enabled: true, monthly_limit: 50000, used_credits: 41654, utilization: 83.3, currency: 'USD', decimal_places: 2}});
    assert.equal(s.used, 'USD 416.54');
    assert.equal(s.limit, 'USD 500.00');
    assert.equal(s.percent, 83);
    assert.equal(s.level, 'ok');
});

test('normalizeSpend returns null when spend is disabled and no extra_usage', () => {
    assert.equal(normalizeSpend({spend: {enabled: false}}), null);
    assert.equal(normalizeSpend({}), null);
});

// --- panel window selection ---
const liveWindows = normalizeWindows(live);
const keys = ws => ws.map(w => w.key);
const SESSION = 'limit:session:session';
const WEEKLY = 'limit:weekly_all:weekly';
const FABLE = 'limit:weekly_scoped:weekly:Fable';

test('selectPanelWindows: each selector alone picks the expected window', () => {
    assert.deepEqual(keys(selectPanelWindows(liveWindows, ['five-hour'])), [SESSION]);
    assert.deepEqual(keys(selectPanelWindows(liveWindows, ['seven-day'])), [WEEKLY]);
    assert.deepEqual(keys(selectPanelWindows(liveWindows, ['scoped'])), [FABLE]);
    // max: Fable is at 100%
    assert.deepEqual(keys(selectPanelWindows(liveWindows, ['max'])), [FABLE]);
    // worst: only Fable is active, so it wins regardless of score
    assert.deepEqual(keys(selectPanelWindows(liveWindows, ['worst'], () => 0)), [FABLE]);
});

test('selectPanelWindows: union keeps role order and drops duplicates', () => {
    // Switch order in the selection must not change the panel order.
    assert.deepEqual(keys(selectPanelWindows(liveWindows, ['scoped', 'five-hour', 'seven-day'])),
        [SESSION, WEEKLY, FABLE]);
    // worst and scoped both resolve to Fable: shown once.
    assert.deepEqual(keys(selectPanelWindows(liveWindows, ['scoped', 'worst'])), [FABLE]);
    assert.deepEqual(keys(selectPanelWindows(liveWindows, PANEL_SELECTORS)), [SESSION, WEEKLY, FABLE]);
});

test('selectPanelWindows: worst uses the caller score over the active pool, else all', () => {
    // No active windows: the score decides across every window.
    const calm = liveWindows.map(w => ({...w, isActive: false}));
    const scoreSession = w => (w.role === 'session' ? 99 : 0);
    assert.deepEqual(keys(selectPanelWindows(calm, ['worst'], scoreSession)), [SESSION]);
});

test('selectPanelWindows: unknown selectors ignored, nothing matched falls back to the first window', () => {
    assert.deepEqual(keys(selectPanelWindows(liveWindows, ['bogus', 'five-hour'])), [SESSION]);
    const noScoped = liveWindows.filter(w => w.role !== 'scoped');
    assert.deepEqual(keys(selectPanelWindows(noScoped, ['scoped'])), [SESSION]);
    assert.deepEqual(keys(selectPanelWindows(liveWindows, [])), [SESSION]);
    assert.deepEqual(selectPanelWindows([], ['five-hour']), []);
    assert.deepEqual(selectPanelWindows(null, ['five-hour']), []);
});

test('windowTag: short tags for the panel', () => {
    assert.deepEqual(liveWindows.map(windowTag), ['5h', '7d', 'Fable']);
    assert.equal(windowTag({role: 'scoped', label: '7-day Cinder Cove · Api'}), 'Cinder Cove');
    assert.equal(windowTag({role: 'scoped', label: '7-day (scoped)'}), 'scoped');
    assert.equal(windowTag({role: 'other', label: 'Usage'}), 'Usage');
});

test('groupPanelWindows: weekly + scoped windows that reset together form one group', () => {
    const w = (key, role, resetsAt) => ({key, role, resetsAt});
    const shape = groups => groups.map(g => g.windows.map(x => x.key));
    const at = (min, sec = '00') => `2026-07-15T14:${String(min).padStart(2, '0')}:${sec}+00:00`;
    // Session stays alone; weekly and scoped share a reset → one group.
    const live = groupPanelWindows([w('s', 'session', at(30)), w('w', 'weekly', at(0)), w('f', 'scoped', at(0))]);
    assert.deepEqual(shape(live), [['s'], ['w', 'f']]);
    assert.deepEqual(live.map(g => g.resetsAt), [at(30), at(0)]);
    // Several scoped windows with the same reset all join the weekly group.
    assert.deepEqual(shape(groupPanelWindows([
        w('w', 'weekly', at(0)), w('f', 'scoped', at(0)), w('o', 'scoped', at(0)),
    ])), [['w', 'f', 'o']]);
    // A session window sharing a reset time is still its own group.
    assert.deepEqual(shape(groupPanelWindows([
        w('s', 'session', at(0)), w('w', 'weekly', at(0)),
    ])), [['s'], ['w']]);
    assert.deepEqual(groupPanelWindows([]), []);
    assert.deepEqual(groupPanelWindows(null), []);
});

test('groupPanelWindows: resets within 5 minutes merge, however they are written', () => {
    const w = (key, role, resetsAt) => ({key, role, resetsAt});
    const shape = groups => groups.map(g => g.windows.map(x => x.key));
    // 4 minutes apart merges, 6 minutes does not.
    assert.deepEqual(shape(groupPanelWindows([
        w('w', 'weekly', '2026-07-15T14:00:00+00:00'), w('f', 'scoped', '2026-07-15T14:04:00+00:00'),
    ])), [['w', 'f']]);
    assert.deepEqual(shape(groupPanelWindows([
        w('w', 'weekly', '2026-07-15T14:00:00+00:00'), w('f', 'scoped', '2026-07-15T14:06:00+00:00'),
    ])), [['w'], ['f']]);
    // Per-window microseconds and a different offset notation are the same reset.
    const mixed = groupPanelWindows([
        w('w', 'weekly', '2026-07-15T14:00:00.076954+00:00'),
        w('f', 'scoped', '2026-07-15T14:00:00.076967Z'),
        w('o', 'scoped', '2026-07-15T16:00:00+02:00'),
    ]);
    assert.deepEqual(shape(mixed), [['w', 'f', 'o']]);
    // The group's reset is its first known one.
    assert.equal(mixed[0].resetsAt, '2026-07-15T14:00:00.076954+00:00');
    // Each window is compared with the group's first reset, so a chain of
    // near-misses (0, +4m, +8m) cannot drift: the third starts a new group.
    assert.deepEqual(shape(groupPanelWindows([
        w('w', 'weekly', '2026-07-15T14:00:00Z'), w('a', 'scoped', '2026-07-15T14:04:00Z'),
        w('b', 'scoped', '2026-07-15T14:08:00Z'),
    ])), [['w', 'a'], ['b']]);
    // A window matching an earlier group joins it, past a group that differs.
    assert.deepEqual(shape(groupPanelWindows([
        w('w', 'weekly', '2026-07-15T14:00:00Z'), w('a', 'scoped', '2026-07-16T09:00:00Z'),
        w('b', 'scoped', '2026-07-15T14:00:00Z'),
    ])), [['w', 'b'], ['a']]);
});

test('groupPanelWindows: a window with no reset time joins the weekly group', () => {
    const w = (key, role, resetsAt) => ({key, role, resetsAt});
    const shape = groups => groups.map(g => g.windows.map(x => x.key));
    const reset = '2026-07-15T14:00:00+00:00';
    // An unused per-model window (no reset yet) sits between two that have one.
    const g = groupPanelWindows([w('w', 'weekly', reset), w('o', 'scoped', null), w('f', 'scoped', reset)]);
    assert.deepEqual(shape(g), [['w', 'o', 'f']]);
    assert.equal(g[0].resetsAt, reset);
    // The group takes the first reset it has, even if its first window has none.
    const late = groupPanelWindows([w('w', 'weekly', null), w('f', 'scoped', 'garbage'), w('o', 'scoped', reset)]);
    assert.deepEqual(shape(late), [['w', 'f', 'o']]);
    assert.equal(late[0].resetsAt, reset);
    // Nothing known at all: still one group, with no countdown.
    const none = groupPanelWindows([w('w', 'weekly', null), w('f', 'scoped', null)]);
    assert.deepEqual(shape(none), [['w', 'f']]);
    assert.equal(none[0].resetsAt, null);
    // A session window with no reset is simply its own group.
    assert.deepEqual(shape(groupPanelWindows([w('s', 'session', null), w('w', 'weekly', reset)])), [['s'], ['w']]);
});

test('tierIconName: most specific artwork, then the base tier, else none', () => {
    assert.equal(tierIconName('MAX'), 'max');
    // No max-20x / max-5x artwork yet: the base tier's icon.
    assert.equal(tierIconName('MAX 20x'), 'max');
    assert.equal(tierIconName('MAX 5x'), 'max');
    assert.equal(tierIconName('PRO'), 'pro');
    assert.equal(tierIconName('TEAM'), 'team');
    assert.equal(tierIconName('ENTERPRISE'), 'enterprise');
    assert.equal(tierIconName('FREE'), 'free');
    // No artwork → no icon (never the Claude spark a second time).
    assert.equal(tierIconName('CLAUDE'), null);
    assert.equal(tierIconName('SOMETHING NEW 3x'), null);
    assert.equal(tierIconName(''), null);
    assert.equal(tierIconName(null), null);
    // Every listed tier resolves to itself.
    for (const name of TIER_ICONS)
        assert.equal(tierIconName(name.toUpperCase().replace(/-/g, ' ')), name);
});

test('TIER_ICONS: every listed tier has its artwork in src/icons', () => {
    for (const name of TIER_ICONS) {
        const file = new URL(`../src/icons/tier-${name}-symbolic.svg`, import.meta.url);
        assert.ok(existsSync(file), `missing ${file.pathname}`);
    }
});

test('migratePanelWindows: seeds the list from the old single choice exactly once', () => {
    const fake = (user, seed) => {
        const writes = [];
        return {
            writes,
            get_user_value: k => (k in user ? user[k] : null),
            get_string: k => user[k],
            set_strv: (k, v) => writes.push([k, v]),
        };
    };
    // Old choice present, new key untouched → migrate.
    let s = fake({'panel-window': 'seven-day'});
    migratePanelWindows(s);
    assert.deepEqual(s.writes, [['panel-windows', ['seven-day']]]);
    // New key already set by the user → leave it alone.
    s = fake({'panel-window': 'seven-day', 'panel-windows': ['five-hour']});
    migratePanelWindows(s);
    assert.deepEqual(s.writes, []);
    // Old key at its default → nothing to migrate.
    s = fake({});
    migratePanelWindows(s);
    assert.deepEqual(s.writes, []);
    // Garbage in the old key is not carried over.
    s = fake({'panel-window': 'nope'});
    migratePanelWindows(s);
    assert.deepEqual(s.writes, []);
});

console.log(`\n${passed} tests passed`);

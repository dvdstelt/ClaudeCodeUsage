#!/usr/bin/env node
// Unit tests for the pure usage model. Runs under plain node (no GI):
//   node tools/test-usageModel.mjs
import assert from 'node:assert/strict';
import {
    normalizeWindows, normalizeSpend, apiSeverityLevel, limitLabel, limitKey,
    selectPanelWindows, windowTag, migratePanelWindows, PANEL_SELECTORS,
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

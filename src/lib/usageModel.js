// Pure data-shaping for the usage endpoint: turns the API payload into the
// ordered list of windows the popup renders, and normalises the spend / extra-
// usage money block. No GI or shell imports, so it runs under plain `node` and
// `gjs` and is unit-testable in isolation (see tools/poll.js and the tests).
//
// The endpoint recently moved its per-window data out of the flat top-level
// keys (`five_hour`, `seven_day`, `seven_day_<model>`) and into a single self-
// describing `limits[]` array, where each entry carries its own `kind`,
// `group`, `percent`, `severity`, `resets_at`, and an optional `scope` naming a
// specific model (e.g. Fable) or surface. We prefer that array when present and
// fall back to the legacy keys for older responses / accounts.

// Window length (seconds) by limit `group`, for the burn-rate projection.
const FIVE_HOUR_SECONDS = 5 * 3600;
const SEVEN_DAY_SECONDS = 7 * 24 * 3600;
export const GROUP_SECONDS = {session: FIVE_HOUR_SECONDS, weekly: SEVEN_DAY_SECONDS};

// Map the API's severity string to the extension's internal level. Unknown or
// missing severities are treated as calm ('ok') so a new value never trips the
// gauge red on its own — the computed burn model still colours it.
export function apiSeverityLevel(sev) {
    switch (sev) {
    case 'critical':
        return 'crit';
    case 'warning':
        return 'warn';
    default: // 'normal', unknown, or missing
        return 'ok';
    }
}

// Title-case an API token like "oauth_apps" or "weekly_scoped" → "Oauth Apps".
function humanizeToken(s) {
    return String(s ?? '')
        .split(/[_\s]+/)
        .filter(Boolean)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
}

// Friendly names for known scoped-model / suffix tokens; anything else is
// title-cased so a model the API adds later still reads sensibly.
const KNOWN_MODEL = {opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', oauth_apps: 'OAuth Apps'};
export function modelLabel(name) {
    return KNOWN_MODEL[name] ?? humanizeToken(name);
}

// Display label for a `limits[]` entry.
export function limitLabel(entry) {
    const model = entry?.scope?.model?.display_name;
    const surface = entry?.scope?.surface;
    let base;
    switch (entry?.kind) {
    case 'session':
        base = '5-hour';
        break;
    case 'weekly_all':
        base = '7-day (all models)';
        break;
    case 'weekly_scoped':
        base = model ? `7-day ${model}` : '7-day (scoped)';
        break;
    default:
        base = humanizeToken(entry?.kind || entry?.group || 'usage');
        if (model)
            base += ` ${model}`;
    }
    if (surface)
        base += ` · ${humanizeToken(surface)}`;
    return base;
}

// Stable identity for a `limits[]` entry so a meter can be reused across polls
// and torn down only when the API stops reporting that window.
export function limitKey(entry) {
    const parts = ['limit', entry?.kind ?? '?', entry?.group ?? '?'];
    const model = entry?.scope?.model?.display_name ?? entry?.scope?.model?.id;
    if (model)
        parts.push(model);
    if (entry?.scope?.surface)
        parts.push(entry.scope.surface);
    return parts.join(':');
}

// Coarse role, so the panel-window selector can find "the session window" or
// "the weekly window" without caring which API shape produced it.
function limitRole(entry) {
    if (entry?.kind === 'session' || entry?.group === 'session')
        return 'session';
    if (entry?.kind === 'weekly_all')
        return 'weekly';
    if (entry?.kind === 'weekly_scoped')
        return 'scoped';
    if (entry?.group === 'weekly')
        return 'weekly';
    return 'other';
}

const ROLE_ORDER = {session: 0, weekly: 1, scoped: 2, other: 3};

// A normalised usage window, independent of which API shape it came from:
//   {key, label, role, utilization, resetsAt, totalSeconds, apiLevel, isActive, order}
function fromLimit(entry) {
    const role = limitRole(entry);
    const totalSeconds = GROUP_SECONDS[entry.group] ??
        (role === 'scoped' || role === 'weekly' ? SEVEN_DAY_SECONDS
            : role === 'session' ? FIVE_HOUR_SECONDS : null);
    return {
        key: limitKey(entry),
        label: limitLabel(entry),
        role,
        utilization: Number(entry.percent),
        resetsAt: entry.resets_at ?? null,
        totalSeconds,
        apiLevel: apiSeverityLevel(entry.severity),
        isActive: !!entry.is_active,
        order: ROLE_ORDER[role],
    };
}

function legacyWindow(key, label, role, win, totalSeconds) {
    return {
        key: `legacy:${key}`,
        label,
        role,
        utilization: Number(win.utilization),
        resetsAt: win.resets_at ?? null,
        totalSeconds,
        apiLevel: 'ok',
        isActive: false,
        order: ROLE_ORDER[role],
    };
}

// The ordered list of windows to display. Prefers the self-describing
// `limits[]` array; falls back to the legacy flat keys (`five_hour`,
// `seven_day`, `seven_day_<model>`) for older API responses or accounts that
// still return them. Entries without a numeric utilization are dropped.
export function normalizeWindows(usage) {
    const limits = usage?.limits;
    if (Array.isArray(limits) && limits.length) {
        const out = limits
            .filter(l => l && l.percent != null && Number.isFinite(Number(l.percent)))
            .map(fromLimit);
        if (out.length) {
            out.sort((a, b) => a.order - b.order);
            return out;
        }
    }

    const out = [];
    if (usage?.five_hour)
        out.push(legacyWindow('five_hour', '5-hour', 'session', usage.five_hour, FIVE_HOUR_SECONDS));
    if (usage?.seven_day)
        out.push(legacyWindow('seven_day', '7-day', 'weekly', usage.seven_day, SEVEN_DAY_SECONDS));
    for (const key of Object.keys(usage ?? {})) {
        const m = /^seven_day_(.+)$/.exec(key);
        const win = usage[key];
        if (m && win)
            out.push(legacyWindow(key, `7-day ${modelLabel(m[1])}`, 'scoped', win, SEVEN_DAY_SECONDS));
    }
    return out;
}

// Format a structured minor-unit money amount ({amount_minor, currency,
// exponent}) as e.g. "USD 416.54". Returns null when the amount is missing.
function formatMinor(m) {
    if (!m || !Number.isFinite(Number(m.amount_minor)))
        return null;
    const exp = Number.isFinite(Number(m.exponent)) ? Number(m.exponent) : 2;
    const value = Number(m.amount_minor) / Math.pow(10, exp);
    const cur = m.currency ? `${m.currency} ` : '';
    return `${cur}${value.toFixed(exp)}`;
}

// Normalise the "extra usage" money block. Prefers the structured `spend`
// object (authoritative minor-unit amounts + severity); falls back to the older
// `extra_usage` shape, now scaling by its own `decimal_places` instead of a
// hard-coded /100. Returns {used, limit, percent, level} or null when there is
// nothing to show.
export function normalizeSpend(usage) {
    const spend = usage?.spend;
    if (spend && spend.enabled) {
        const used = formatMinor(spend.used);
        const limit = formatMinor(spend.limit) ?? formatMinor(spend.cap?.money) ?? formatMinor(spend.cap?.credits);
        if (used || limit) {
            return {
                used: used ?? null,
                limit: limit ?? null,
                percent: Number.isFinite(Number(spend.percent)) ? Number(spend.percent) : null,
                level: apiSeverityLevel(spend.severity),
            };
        }
    }

    const xu = usage?.extra_usage;
    if (xu && xu.is_enabled) {
        const places = Number.isFinite(Number(xu.decimal_places)) ? Number(xu.decimal_places) : 2;
        const div = Math.pow(10, places);
        const cur = xu.currency ? `${xu.currency} ` : '';
        const money = v => Number.isFinite(v) ? `${cur}${(v / div).toFixed(places)}` : null;
        const used = money(Number(xu.used_credits));
        const limit = Number(xu.monthly_limit) > 0 ? money(Number(xu.monthly_limit)) : null;
        if (used || limit) {
            return {
                used: used ?? `${cur}${(0).toFixed(places)}`,
                limit,
                percent: Number.isFinite(Number(xu.utilization)) ? Math.round(Number(xu.utilization)) : null,
                level: 'ok',
            };
        }
    }
    return null;
}

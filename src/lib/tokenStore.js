// Per-profile OAuth tokens from the in-app (PKCE) sign-in, kept as a JSON
// object in the "profile-tokens" GSettings key, keyed by profile id:
//
//   {"p1abc": {"accessToken": "...", "refreshToken": "...", "expiresAt": 173…}}
//
// Each profile signs in to its own Claude account, so a second profile no
// longer has to borrow the first one's token. Tokens live here rather than in
// the "profiles" key so that reading or rewriting the profile list (labels,
// directories) never has to touch credentials.
//
// Kept free of `resource:///org/gnome/shell` imports, like the other lib
// modules, so prefs and plain gjs can use it too.

// The single-token keys this replaces. Still read once per profile so an
// existing in-app sign-in survives the upgrade (see migrateLegacyToken).
const LEGACY_ACCESS = 'access-token';
const LEGACY_REFRESH = 'refresh-token';
const LEGACY_EXPIRES = 'expires-at';

function loadAll(settings) {
    try {
        const parsed = JSON.parse(settings.get_string('profile-tokens'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function saveAll(settings, map) {
    settings.set_string('profile-tokens', JSON.stringify(map));
}

// The stored token set for one profile, or null when it has never signed in.
export function getToken(settings, profileId) {
    if (!settings || !profileId)
        return null;
    const entry = loadAll(settings)[profileId];
    return entry?.accessToken ? entry : null;
}

// Stores (or replaces) one profile's tokens. expiresAt is a millisecond
// timestamp; pass 0 when the endpoint didn't say.
export function setToken(settings, profileId, {accessToken, refreshToken = '', expiresAt = 0}) {
    if (!settings || !profileId)
        return;
    const map = loadAll(settings);
    map[profileId] = {accessToken, refreshToken, expiresAt};
    saveAll(settings, map);
}

// Forgets one profile's tokens (used by Disconnect, and when a profile is
// removed so its credentials don't linger in settings).
export function clearToken(settings, profileId) {
    if (!settings || !profileId)
        return;
    const map = loadAll(settings);
    if (profileId in map) {
        delete map[profileId];
        saveAll(settings, map);
    }
}

// Moves a pre-existing single in-app sign-in onto one profile, once. Before
// per-profile tokens there was one global token set; without this, upgrading
// would silently sign that user out. Only runs when the profile has no token of
// its own, and clears the legacy keys so it can't be claimed twice.
export function migrateLegacyToken(settings, profileId) {
    if (!settings || !profileId)
        return null;
    if (getToken(settings, profileId))
        return null;
    const accessToken = settings.get_string(LEGACY_ACCESS);
    if (!accessToken)
        return null;

    const entry = {
        accessToken,
        refreshToken: settings.get_string(LEGACY_REFRESH),
        expiresAt: Number(settings.get_int64(LEGACY_EXPIRES)) || 0,
    };
    setToken(settings, profileId, entry);
    settings.set_string(LEGACY_ACCESS, '');
    settings.set_string(LEGACY_REFRESH, '');
    settings.set_int64(LEGACY_EXPIRES, 0);
    return entry;
}

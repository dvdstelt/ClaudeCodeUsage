import './versions.js';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
// Public OAuth client id of the "Claude Code" application (from /api/oauth/profile).
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

const BETA_HEADER = 'oauth-2025-04-20';
const API_VERSION = '2023-06-01';
// Refresh when the token expires within this many milliseconds.
const REFRESH_SKEW_MS = 5 * 60 * 1000;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

// Default Claude OAuth access-token lifetime (8 hours) when the token
// endpoint omits expires_in.
const DEFAULT_EXPIRES_IN = 8 * 3600;

function credentialsPath() {
    return GLib.build_filenamev([GLib.get_home_dir(), '.claude', '.credentials.json']);
}

// True when Claude Code has a usable OAuth token on disk. Used by prefs to
// hide the in-extension sign-in UI: if Claude Code can supply a token, the
// extension rides on it and the user never needs to log in separately.
export function claudeCodeCredentialsAvailable() {
    try {
        const file = Gio.File.new_for_path(credentialsPath());
        if (!file.query_exists(null))
            return false;
        const [ok, bytes] = file.load_contents(null);
        if (!ok)
            return false;
        const root = JSON.parse(decoder.decode(bytes));
        return !!root?.claudeAiOauth?.accessToken;
    } catch {
        return false;
    }
}

export class UsageError extends Error {
    constructor(message, {status = 0, body = ''} = {}) {
        super(message);
        this.name = 'UsageError';
        this.status = status;
        this.body = body;
    }
}

export class UsageClient {
    // settings is optional; when provided it supplies the extension's own
    // OAuth tokens (from the in-app sign-in) as a fallback for users without
    // Claude Code installed.
    constructor(settings = null) {
        this._settings = settings;
        this._session = new Soup.Session();
        this._session.timeout = 15;
    }

    // Reads Claude Code's credentials, or returns null when absent/unusable.
    _tryReadCredentials() {
        try {
            const file = Gio.File.new_for_path(credentialsPath());
            if (!file.query_exists(null))
                return null;
            const [ok, bytes] = file.load_contents(null);
            if (!ok)
                return null;
            const root = JSON.parse(decoder.decode(bytes));
            return root?.claudeAiOauth?.accessToken ? root : null;
        } catch {
            return null;
        }
    }

    _writeCredentials(root) {
        const file = Gio.File.new_for_path(credentialsPath());
        const data = encoder.encode(JSON.stringify(root, null, 2));
        // PRIVATE keeps the file at 0600 so the token stays owner-only.
        file.replace_contents(data, null, false, Gio.FileCreateFlags.PRIVATE, null);
    }

    _request(method, url, {token, jsonBody} = {}) {
        return new Promise((resolve, reject) => {
            const msg = Soup.Message.new(method, url);
            const headers = msg.get_request_headers();
            headers.append('anthropic-beta', BETA_HEADER);
            headers.append('anthropic-version', API_VERSION);
            headers.append('Accept', 'application/json');
            if (token)
                headers.append('Authorization', `Bearer ${token}`);
            if (jsonBody !== undefined) {
                const raw = encoder.encode(JSON.stringify(jsonBody));
                msg.set_request_body_from_bytes('application/json', new GLib.Bytes(raw));
            }

            this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, res) => {
                try {
                    const bytes = session.send_and_read_finish(res);
                    // Read the raw integer; msg.get_status() marshals to the
                    // Soup.Status enum, which lacks some codes (e.g. 429) and
                    // would throw "N is not a valid value for enumeration Status".
                    const status = msg.status_code;
                    const text = bytes ? decoder.decode(bytes.get_data()) : '';
                    if (status < 200 || status >= 300) {
                        reject(new UsageError(`HTTP ${status} from ${url}`, {status, body: text}));
                        return;
                    }
                    resolve(text ? JSON.parse(text) : {});
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    // Trades a refresh token for a fresh token set at the OAuth token endpoint.
    async _exchangeRefreshToken(refreshToken) {
        const data = await this._request('POST', TOKEN_URL, {
            jsonBody: {
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
                client_id: CLIENT_ID,
            },
        });
        if (!data.access_token)
            throw new UsageError('Refresh response missing access_token', {body: JSON.stringify(data)});
        return data;
    }

    // Refreshes Claude Code's on-disk credentials in place.
    async _refreshFileToken(root) {
        const oauth = root.claudeAiOauth;
        const data = await this._exchangeRefreshToken(oauth.refreshToken);
        oauth.accessToken = data.access_token;
        if (data.refresh_token)
            oauth.refreshToken = data.refresh_token;
        if (data.expires_in)
            oauth.expiresAt = Date.now() + data.expires_in * 1000;
        this._writeCredentials(root);
        return oauth.accessToken;
    }

    // Refreshes the extension's own tokens, persisting them back to GSettings.
    async _refreshSettingsToken() {
        const refreshToken = this._settings?.get_string('refresh-token');
        if (!refreshToken)
            throw new UsageError('Not connected; sign in from extension settings');
        const data = await this._exchangeRefreshToken(refreshToken);
        this._settings.set_string('access-token', data.access_token);
        if (data.refresh_token)
            this._settings.set_string('refresh-token', data.refresh_token);
        this._settings.set_int64('expires-at',
            Date.now() + (data.expires_in ?? DEFAULT_EXPIRES_IN) * 1000);
        return data.access_token;
    }

    // The extension's own access token, refreshing when close to expiry.
    async _settingsToken() {
        const token = this._settings?.get_string('access-token');
        if (!token)
            throw new UsageError('No Claude OAuth token found; sign in with Claude Code or from extension settings');
        const expiresAt = Number(this._settings.get_int64('expires-at')) || 0;
        if (expiresAt && expiresAt - Date.now() > REFRESH_SKEW_MS)
            return token;
        return this._refreshSettingsToken();
    }

    // Returns a valid access token, refreshing (and persisting) if close to
    // expiry. Prefers Claude Code's credentials; falls back to the extension's
    // own OAuth tokens when Claude Code is not signed in.
    async _validToken() {
        const root = this._tryReadCredentials();
        if (root) {
            const oauth = root.claudeAiOauth;
            const expiresAt = Number(oauth.expiresAt) || 0;
            if (expiresAt && expiresAt - Date.now() > REFRESH_SKEW_MS)
                return oauth.accessToken;
            return this._refreshFileToken(root);
        }
        return this._settingsToken();
    }

    async fetchUsage() {
        const token = await this._validToken();
        return this._request('GET', USAGE_URL, {token});
    }

    async fetchProfile() {
        const token = await this._validToken();
        return this._request('GET', PROFILE_URL, {token});
    }

    // Tier shown instantly from disk, without a network round-trip. Returns
    // nulls when Claude Code is not signed in (the in-app token path has no
    // tier on disk; it arrives with the profile fetch instead).
    tierFromDisk() {
        const oauth = this._tryReadCredentials()?.claudeAiOauth;
        return {
            subscriptionType: oauth?.subscriptionType ?? null,
            rateLimitTier: oauth?.rateLimitTier ?? null,
        };
    }
}

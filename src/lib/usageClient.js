import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
// Pin Soup 3.0 inline: some systems still have the 2.4 typelib installed, and
// without a version the prefs process (where the shell hasn't already loaded
// Soup) could pick the wrong one.
import Soup from 'gi://Soup?version=3.0';

import {
    USAGE_URL, PROFILE_URL, TOKEN_URL, CLIENT_ID,
    BETA_HEADER, API_VERSION, DEFAULT_EXPIRES_IN,
    encoder, decoder,
} from './oauth.js';

// Refresh when the token expires within this many milliseconds.
const REFRESH_SKEW_MS = 5 * 60 * 1000;

function credentialsPath() {
    return GLib.build_filenamev([GLib.get_home_dir(), '.claude', '.credentials.json']);
}

// Reads and parses Claude Code's credentials file asynchronously (shell code
// must avoid synchronous file IO). Resolves to the parsed root object when it
// holds an access token, or null otherwise. Never rejects: a missing file or
// bad JSON resolves to null.
async function readCredentialsRoot() {
    try {
        const file = Gio.File.new_for_path(credentialsPath());
        const bytes = await new Promise((resolve, reject) => {
            file.load_contents_async(null, (f, res) => {
                try {
                    const [ok, data] = f.load_contents_finish(res);
                    resolve(ok ? data : null);
                } catch (e) {
                    reject(e);
                }
            });
        });
        if (!bytes)
            return null;
        const root = JSON.parse(decoder.decode(bytes));
        return root?.claudeAiOauth?.accessToken ? root : null;
    } catch {
        return null;
    }
}

// True when Claude Code has a *usable* OAuth token on disk. Used by prefs to
// hide the in-extension sign-in UI: if Claude Code can supply a token, the
// extension rides on it and the user never needs to log in separately.
//
// An expired access token counts as unavailable: we can't tell without a
// network call whether the refresh token still works (it may have expired too,
// e.g. for someone who only uses Claude Desktop), so we surface the in-app
// sign-in as a fallback. An active CLI user keeps a non-expired access token,
// so the sign-in stays hidden for them.
export async function claudeCodeCredentialsAvailable() {
    const root = await readCredentialsRoot();
    if (!root)
        return false;
    const expiresAt = Number(root.claudeAiOauth.expiresAt) || 0;
    return !expiresAt || expiresAt > Date.now();
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
        // Shared in-flight token resolution; see _validToken().
        this._tokenPromise = null;
    }

    // Writes Claude Code's credentials back asynchronously (no synchronous file
    // IO on the shell main loop).
    _writeCredentials(root) {
        const file = Gio.File.new_for_path(credentialsPath());
        const data = encoder.encode(JSON.stringify(root, null, 2));
        return new Promise((resolve, reject) => {
            // PRIVATE keeps the file at 0600 so the token stays owner-only.
            file.replace_contents_bytes_async(
                new GLib.Bytes(data), null, false,
                Gio.FileCreateFlags.PRIVATE, null, (f, res) => {
                    try {
                        f.replace_contents_finish(res);
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    _request(method, url, {token, jsonBody, cancellable = null} = {}) {
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

            this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (session, res) => {
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
        let data;
        try {
            data = await this._request('POST', TOKEN_URL, {
                jsonBody: {
                    grant_type: 'refresh_token',
                    refresh_token: refreshToken,
                    client_id: CLIENT_ID,
                },
            });
        } catch (e) {
            // A 400/401 from the token endpoint means the refresh token itself
            // is expired or revoked (e.g. invalid_grant), not a transient
            // network error. Surface it as a session-expired (401) condition so
            // the UI tells the user to sign in again instead of showing a bare
            // "HTTP 400".
            if (e instanceof UsageError && (e.status === 400 || e.status === 401))
                throw new UsageError('Session expired; sign in to Claude Code again',
                    {status: 401, body: e.body});
            throw e;
        }
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
        await this._writeCredentials(root);
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
    //
    // Concurrent callers share one in-flight resolution: fetchUsage and
    // fetchProfile run in parallel, and without this a near-expiry token would
    // be refreshed twice at once. Two simultaneous refresh-token exchanges can
    // each rotate the refresh token and clobber the other's persisted
    // credentials, so we deduplicate to a single refresh.
    _validToken() {
        if (!this._tokenPromise) {
            this._tokenPromise = this._resolveToken()
                .finally(() => {
                    this._tokenPromise = null;
                });
        }
        return this._tokenPromise;
    }

    async _resolveToken() {
        const root = await readCredentialsRoot();
        if (root) {
            const oauth = root.claudeAiOauth;
            const expiresAt = Number(oauth.expiresAt) || 0;
            if (expiresAt && expiresAt - Date.now() > REFRESH_SKEW_MS)
                return oauth.accessToken;
            try {
                return await this._refreshFileToken(root);
            } catch (e) {
                // Claude Code's credentials are dead (e.g. its refresh token
                // expired, which happens when the CLI is unused and only Claude
                // Desktop is signed in). Fall back to the extension's own in-app
                // token if the user has signed in; otherwise surface the error.
                if (this._settings?.get_string('access-token'))
                    return this._settingsToken();
                throw e;
            }
        }
        return this._settingsToken();
    }

    async fetchUsage(cancellable = null) {
        const token = await this._validToken();
        return this._request('GET', USAGE_URL, {token, cancellable});
    }

    async fetchProfile(cancellable = null) {
        const token = await this._validToken();
        return this._request('GET', PROFILE_URL, {token, cancellable});
    }

    // Tier shown (almost) instantly from disk, without a network round-trip.
    // Returns nulls when Claude Code is not signed in (the in-app token path
    // has no tier on disk; it arrives with the profile fetch instead).
    async tierFromDisk() {
        const oauth = (await readCredentialsRoot())?.claudeAiOauth;
        return {
            subscriptionType: oauth?.subscriptionType ?? null,
            rateLimitTier: oauth?.rateLimitTier ?? null,
        };
    }
}

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {claudeCodeCredentialsAvailable} from './lib/usageClient.js';

const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';
const OAUTH_SCOPES = 'user:profile user:inference';
const DEFAULT_EXPIRES_IN = 8 * 3600;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// URL-safe base64 without padding, as required by PKCE.
function base64url(bytes) {
    return GLib.base64_encode(bytes)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
}

function randomToken() {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++)
        bytes[i] = GLib.random_int_range(0, 256);
    return base64url(bytes);
}

function codeChallenge(verifier) {
    const hex = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, verifier, -1);
    const raw = new Uint8Array(32);
    for (let i = 0; i < 32; i++)
        raw[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return base64url(raw);
}

export default class ClaudeUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'Panel',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        // ---- which elements appear in the panel ----
        const elements = new Adw.PreferencesGroup({
            title: 'Panel elements',
            description: 'Choose what to show in the top bar.',
        });
        page.add(elements);

        const toggles = [
            ['show-icon', 'Claude icon'],
            ['show-percentage', 'Usage percentage'],
            ['show-tier', 'Subscription tier'],
        ];
        for (const [key, title] of toggles) {
            const row = new Adw.SwitchRow({title});
            elements.add(row);
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        }

        const gauges = new Gtk.StringList();
        gauges.append('Circle');
        gauges.append('Bar');
        gauges.append('None');
        const gaugeKeys = ['ring', 'bar', 'none'];

        const gaugeRow = new Adw.ComboRow({
            title: 'Usage gauge',
            subtitle: 'Show a circular ring, a horizontal bar, or no gauge.',
            model: gauges,
        });
        gaugeRow.selected = Math.max(0, gaugeKeys.indexOf(settings.get_string('panel-gauge')));
        gaugeRow.connect('notify::selected', () => {
            settings.set_string('panel-gauge', gaugeKeys[gaugeRow.selected]);
        });
        settings.connect('changed::panel-gauge', () => {
            gaugeRow.selected = Math.max(0, gaugeKeys.indexOf(settings.get_string('panel-gauge')));
        });
        elements.add(gaugeRow);

        // ---- behaviour ----
        const behaviour = new Adw.PreferencesGroup({title: 'Behaviour'});
        page.add(behaviour);

        const windows = new Gtk.StringList();
        windows.append('5-hour window');
        windows.append('7-day window');
        windows.append('Most constrained');
        const windowKeys = ['five-hour', 'seven-day', 'max'];

        const windowRow = new Adw.ComboRow({
            title: 'Panel reflects',
            subtitle: 'Which usage window the ring and percentage show.',
            model: windows,
        });
        windowRow.selected = Math.max(0, windowKeys.indexOf(settings.get_string('panel-window')));
        windowRow.connect('notify::selected', () => {
            settings.set_string('panel-window', windowKeys[windowRow.selected]);
        });
        settings.connect('changed::panel-window', () => {
            windowRow.selected = Math.max(0, windowKeys.indexOf(settings.get_string('panel-window')));
        });
        behaviour.add(windowRow);

        const interval = new Adw.SpinRow({
            title: 'Refresh interval',
            subtitle: 'Seconds between usage updates.',
            adjustment: new Gtk.Adjustment({
                lower: 30,
                upper: 600,
                step_increment: 10,
                page_increment: 60,
            }),
        });
        behaviour.add(interval);
        settings.bind('poll-seconds', interval, 'value', Gio.SettingsBindFlags.DEFAULT);

        // ---- sign-in (only when Claude Code can't supply a token) ----
        // If Claude Code is signed in, the extension rides on its credentials
        // and there's nothing for the user to do here, so the whole group is
        // omitted rather than shown disabled.
        if (!claudeCodeCredentialsAvailable())
            this._addAuthGroup(page, settings);

        this._addAboutGroup(page);
    }

    // Adds a centered footer crediting the author, linking to the project for
    // bug reports and feature requests, and showing the version.
    _addAboutGroup(page) {
        const footer = new Adw.PreferencesGroup();
        page.add(footer);

        const url = this.metadata.url ?? 'https://github.com/dvdstelt/ClaudeExtension';
        const issuesUrl = `${url}/issues/new`;

        const buttons = new Gtk.Box({
            spacing: 8,
            margin_bottom: 16,
            halign: Gtk.Align.CENTER,
        });
        buttons.append(this._buildLinkButton('Report a bug', issuesUrl));
        buttons.append(this._buildLinkButton('Request a feature', issuesUrl));
        footer.add(buttons);

        footer.add(new Gtk.Label({
            label: 'Have an issue, want to suggest a feature, or contribute?',
            margin_bottom: 4,
        }));
        footer.add(new Gtk.Label({
            label: `Open a new issue on <a href="${url}">GitHub</a>!`,
            use_markup: true,
            margin_bottom: 24,
        }));

        footer.add(new Gtk.Label({
            label: 'Created by <b>Dennis van der Stelt</b>',
            use_markup: true,
            margin_bottom: 4,
        }));

        const version = this.metadata['version-name'] ?? String(this.metadata.version ?? '');
        if (version) {
            footer.add(new Gtk.Label({
                label: `· Claude Code Usage Monitor v${version} ·`,
                css_classes: ['dim-label'],
            }));
        }
    }

    // A plain button that opens a URL in the default browser.
    _buildLinkButton(label, uri) {
        const btn = new Gtk.Button({label, hexpand: false});
        btn.connect('clicked', () => {
            Gio.AppInfo.launch_default_for_uri(uri, null);
        });
        return btn;
    }

    // Adds an Authentication group with a PKCE OAuth sign-in flow: Connect opens
    // the browser, the user pastes back the code, and tokens land in GSettings.
    _addAuthGroup(page, settings) {
        const authGroup = new Adw.PreferencesGroup({
            title: 'Account',
            description: 'Claude Code was not detected. Sign in so the extension can read your usage.',
        });
        page.add(authGroup);

        const isConnected = () => settings.get_string('access-token') !== '';

        const statusRow = new Adw.ActionRow({title: 'Status'});
        const statusLabel = new Gtk.Label({valign: Gtk.Align.CENTER});
        statusRow.add_suffix(statusLabel);
        authGroup.add(statusRow);

        const setStatus = (msg, connected) => {
            statusLabel.set_label(msg);
            statusLabel.set_css_classes(connected ? ['success'] : ['dim-label']);
        };

        const connectRow = new Adw.ActionRow({
            title: 'Connect Claude account',
            subtitle: 'Opens your browser to authorize the extension.',
        });
        const connectButton = new Gtk.Button({
            label: 'Connect',
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        connectRow.add_suffix(connectButton);
        connectRow.set_activatable_widget(connectButton);
        authGroup.add(connectRow);

        const codeRow = new Adw.EntryRow({
            title: 'Paste code from browser',
            show_apply_button: true,
        });
        codeRow.set_visible(false);
        authGroup.add(codeRow);

        const disconnectRow = new Adw.ActionRow({
            title: 'Disconnect',
            subtitle: 'Remove the stored sign-in.',
        });
        const disconnectButton = new Gtk.Button({
            label: 'Disconnect',
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
        });
        disconnectRow.add_suffix(disconnectButton);
        disconnectRow.set_activatable_widget(disconnectButton);
        disconnectRow.set_visible(isConnected());
        authGroup.add(disconnectRow);

        setStatus(isConnected() ? 'Connected' : 'Not connected', isConnected());

        // PKCE state for the in-progress flow.
        let codeVerifier = null;
        let oauthState = null;

        connectButton.connect('clicked', () => {
            codeVerifier = randomToken();
            oauthState = randomToken();
            const params = [
                'response_type=code',
                `client_id=${encodeURIComponent(CLIENT_ID)}`,
                `redirect_uri=${encodeURIComponent(REDIRECT_URI)}`,
                `scope=${encodeURIComponent(OAUTH_SCOPES)}`,
                `code_challenge=${encodeURIComponent(codeChallenge(codeVerifier))}`,
                'code_challenge_method=S256',
                `state=${encodeURIComponent(oauthState)}`,
            ].join('&');
            Gio.AppInfo.launch_default_for_uri(`${AUTHORIZE_URL}?${params}`, null);
            codeRow.set_text('');
            codeRow.set_visible(true);
            setStatus('Waiting for code…', false);
        });

        codeRow.connect('apply', () => {
            if (!codeVerifier) {
                setStatus('Click Connect first', false);
                return;
            }

            // Accept the raw "code#state" the callback page shows, or a full
            // pasted callback URL.
            let input = codeRow.get_text().trim();
            let code = input;
            let state = oauthState;
            try {
                const url = new URL(input);
                if (url.searchParams.has('code'))
                    code = url.searchParams.get('code');
                if (url.searchParams.has('state'))
                    state = url.searchParams.get('state');
            } catch {
                const hash = code.indexOf('#');
                if (hash !== -1) {
                    state = code.slice(hash + 1);
                    code = code.slice(0, hash);
                }
            }

            if (!code) {
                setStatus('Code cannot be empty', false);
                return;
            }

            setStatus('Exchanging code…', false);
            connectButton.set_sensitive(false);

            const body = JSON.stringify({
                grant_type: 'authorization_code',
                code,
                state,
                client_id: CLIENT_ID,
                redirect_uri: REDIRECT_URI,
                code_verifier: codeVerifier,
            });
            const session = new Soup.Session();
            const message = Soup.Message.new('POST', TOKEN_URL);
            message.request_headers.append('Content-Type', 'application/json');
            message.set_request_body_from_bytes(
                'application/json', new GLib.Bytes(encoder.encode(body)));

            session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (sess, result) => {
                try {
                    const bytes = sess.send_and_read_finish(result);
                    const text = bytes ? decoder.decode(bytes.get_data()) : '';
                    if (message.status_code !== 200) {
                        console.error(`Claude Code Usage Monitor prefs: token exchange HTTP ${message.status_code}: ${text}`);
                        setStatus(`Error ${message.status_code}`, false);
                        return;
                    }
                    const resp = JSON.parse(text);
                    settings.set_string('refresh-token', resp.refresh_token ?? '');
                    settings.set_int64('expires-at',
                        Date.now() + (resp.expires_in ?? DEFAULT_EXPIRES_IN) * 1000);
                    // Set access-token last: the extension watches it to refetch.
                    settings.set_string('access-token', resp.access_token);
                    setStatus('Connected', true);
                    codeRow.set_visible(false);
                    disconnectRow.set_visible(true);
                    codeVerifier = null;
                    oauthState = null;
                } catch (e) {
                    console.error(`Claude Code Usage Monitor prefs: token exchange failed: ${e.message}`);
                    setStatus('Exchange failed', false);
                } finally {
                    connectButton.set_sensitive(true);
                }
            });
        });

        disconnectButton.connect('clicked', () => {
            settings.set_string('refresh-token', '');
            settings.set_int64('expires-at', 0);
            settings.set_string('access-token', '');
            setStatus('Not connected', false);
            disconnectRow.set_visible(false);
            codeRow.set_visible(false);
            codeVerifier = null;
            oauthState = null;
        });
    }
}

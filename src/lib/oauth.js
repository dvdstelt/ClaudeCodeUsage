// Shared OAuth / API constants and small text-codec helpers, imported by both
// the usage client and the preferences sign-in flow so the values live in one
// place. Keep this free of `resource:///org/gnome/shell` imports so it stays
// usable from prefs (and plain gjs) as well as the shell.

// Public OAuth client id of the "Claude Code" application (from /api/oauth/profile).
export const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

// API endpoints.
export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
export const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';

// In-app PKCE sign-in endpoints.
export const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
export const REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';
export const OAUTH_SCOPES = 'user:profile user:inference';

// Required request headers for the usage/profile endpoints.
export const BETA_HEADER = 'oauth-2025-04-20';
export const API_VERSION = '2023-06-01';

// Default Claude OAuth access-token lifetime (8 hours) when the token endpoint
// omits expires_in.
export const DEFAULT_EXPIRES_IN = 8 * 3600;

export const encoder = new TextEncoder();
export const decoder = new TextDecoder();

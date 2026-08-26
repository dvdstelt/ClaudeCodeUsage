// Pure-node tests for the per-profile token store (no GI, no network):
//   node tools/test-tokenStore.mjs
import {getToken, setToken, clearToken, migrateLegacyToken} from '../src/lib/tokenStore.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? (pass++, console.log('  ok  ' + name)) : (fail++, console.log('  FAIL ' + name)); };

// Minimal stand-in for Gio.Settings covering the keys the store touches.
function fakeSettings(init = {}) {
    const s = {'profile-tokens': '{}', 'access-token': '', 'refresh-token': '', 'expires-at': 0, ...init};
    return {
        get_string: k => s[k], set_string: (k, v) => { s[k] = v; },
        get_int64: k => s[k], set_int64: (k, v) => { s[k] = v; },
        _raw: s,
    };
}

let st = fakeSettings();
ok('unknown profile has no token', getToken(st, 'p1') === null);

setToken(st, 'p1', {accessToken: 'A1', refreshToken: 'R1', expiresAt: 123});
ok('token round-trips', getToken(st, 'p1')?.accessToken === 'A1');
ok('other profile still empty', getToken(st, 'p2') === null);

setToken(st, 'p2', {accessToken: 'A2'});
ok('profiles are independent', getToken(st, 'p1').accessToken === 'A1' && getToken(st, 'p2').accessToken === 'A2');
ok('defaults applied', getToken(st, 'p2').refreshToken === '' && getToken(st, 'p2').expiresAt === 0);

clearToken(st, 'p1');
ok('clear removes only that profile', getToken(st, 'p1') === null && getToken(st, 'p2').accessToken === 'A2');

// Malformed settings must not throw.
st = fakeSettings({'profile-tokens': 'not json'});
ok('malformed JSON degrades to empty', getToken(st, 'p1') === null);
st = fakeSettings({'profile-tokens': '[1,2,3]'});
ok('array JSON rejected', getToken(st, 'p1') === null);

// Legacy migration.
st = fakeSettings({'access-token': 'OLD', 'refresh-token': 'OLDR', 'expires-at': 999});
const migrated = migrateLegacyToken(st, 'p1');
ok('legacy token migrates', migrated?.accessToken === 'OLD' && getToken(st, 'p1').refreshToken === 'OLDR');
ok('legacy keys cleared after migration', st._raw['access-token'] === '' && st._raw['expires-at'] === 0);
ok('second profile cannot claim it twice', migrateLegacyToken(st, 'p2') === null);

st = fakeSettings({'access-token': 'OLD'});
setToken(st, 'p1', {accessToken: 'MINE'});
ok('existing token is not overwritten by migration', migrateLegacyToken(st, 'p1') === null && getToken(st, 'p1').accessToken === 'MINE');

st = fakeSettings();
ok('no legacy token to migrate', migrateLegacyToken(st, 'p1') === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

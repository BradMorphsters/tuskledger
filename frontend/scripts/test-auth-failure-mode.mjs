/**
 * Regression guard: an unreachable backend must NOT look like a logged-out user.
 *
 *   node scripts/test-auth-failure-mode.mjs      (run from frontend/)
 *
 * Plain Node, no vitest/jsdom — it lifts the real request() from
 * src/api/client.js and the real refreshAuth() text from src/App.jsx and runs
 * them against a stubbed fetch. Mirrors scripts/test-ask-intent.mjs in mobile/.
 *
 * Why this exists: /api/auth/status has no auth dependency and always answers
 * 200, reporting setup_required / authenticated in the body. So a THROWN error
 * from it never means "log in" — it means the request didn't reach our backend.
 * On 2026-09-09 another app took port 8000, every /api call hit it, and the
 * frontend showed a login prompt to a user running DEV_BYPASS_AUTH=true who
 * had no password to type. The first three cases below are that bug; the last
 * three make sure the fix didn't break the real auth screens.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

const client = fs.readFileSync(path.join(SRC, 'api', 'client.js'), 'utf8');
const makeRequest = new Function(`${client.slice(0, client.indexOf('// Auth'))}\n return request;`);

const app = fs.readFileSync(path.join(SRC, 'App.jsx'), 'utf8');
const fnText = app.slice(app.indexOf('const refreshAuth'), app.indexOf('  useEffect(() => {\n    refreshAuth()'));
const makeRefresh = new Function('getAuthStatus', 'setAuthState', `${fnText}\n return refreshAuth;`);

let failures = 0;
async function check(label, fetchImpl, expect) {
  globalThis.fetch = fetchImpl;
  let state = {};
  const request = makeRequest();
  const refreshAuth = makeRefresh(() => request('/auth/status'), (s) => { state = s; });
  await refreshAuth();
  const got = { down: !!state.backendDown, setup: !!state.setup_required, authed: !!state.authenticated };
  const ok = got.down === expect.down && got.setup === expect.setup && got.authed === expect.authed;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        got ${JSON.stringify(got)}  want ${JSON.stringify(expect)}`);
}

const res = (status, obj) => async () => ({
  ok: status >= 200 && status < 300, status, statusText: 'stub', json: async () => obj,
});

// Backend problems — must show the "can't reach the backend" screen.
await check('another app owns the port (404)', res(404, { detail: 'Not Found' }), { down: true, setup: false, authed: false });
await check('backend not running (network error)', async () => { throw new TypeError('Failed to fetch'); }, { down: true, setup: false, authed: false });
await check('backend error (500)', res(500, { detail: 'boom' }), { down: true, setup: false, authed: false });

// Real auth states — must still reach Setup / Login / the app.
await check('genuinely logged out -> Login', res(200, { setup_required: false, authenticated: false }), { down: false, setup: false, authed: false });
await check('fresh install -> Setup', res(200, { setup_required: true, authenticated: false }), { down: false, setup: true, authed: false });
await check('authenticated -> app', res(200, { setup_required: false, authenticated: true, username: 'dev' }), { down: false, setup: false, authed: true });

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);

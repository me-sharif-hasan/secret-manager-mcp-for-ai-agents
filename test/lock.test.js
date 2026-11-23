import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sandbox, CLI, childEnv } from './helpers.js';

const dir = sandbox();
process.env.SECRETMGR_KDF_FAST = '1'; // quick scrypt for tests only
delete process.env.CLAUDECODE;
const vault = await import('../src/core/vault.js');
const st = await import('../src/core/state.js');
const lockbox = await import('../src/core/lockbox.js');
const { file } = await import('../src/core/paths.js');
const { wrapCommand } = await import('../src/hooks/guard.js');
const { buildApp } = await import('../src/server/api.js');

const SECRET = 'prod-Qm81-very-secret-value';
const PW1 = 'Correct-horse-battery-7';
const PW2 = 'Another-long-pass-42!';

const cli = (args, input = '') => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: childEnv(), input });
const out = (r) => `${r.stdout}${r.stderr}`;

vault.createGroup('shop');
st.setDefaultGroup('shop');
vault.setVar('shop', 'PG_PASS', { values: { dev: 'dev-value-123', prod: SECRET } });
const keyB64 = fs.readFileSync(file('master.key'), 'utf8').trim();

after(() => {
  cli(['lock']); // stops the key agent if a test left one running
});

test('strength: short, common and repetitive passwords are refused; a long random one passes', () => {
  assert.equal(lockbox.checkStrength('Ab1!xyz').ok, false, '7 characters');
  assert.match(lockbox.checkStrength('abcdefgh').reason, /capital.*number.*special/);
  assert.match(lockbox.checkStrength('ABCDEFG1!').reason, /small letter/);
  assert.match(lockbox.checkStrength('Abcdefgh!').reason, /number/);
  assert.match(lockbox.checkStrength('Abcdefg1').reason, /special/);
  assert.match(lockbox.checkStrength('Password1!').reason, /common/);
  assert.equal(lockbox.checkStrength('Abcd3fg!').ok, true, 'exactly 8 characters with all four kinds is accepted');
  assert.equal(lockbox.checkStrength('7QK2M-xh9td-4RW6B-NP3vc').ok, true);
  assert.equal(lockbox.checkStrength(PW1).ok, true);
});

test('wrap/unwrap: right password returns the key, wrong password is refused, change works', async () => {
  const key = Buffer.alloc(32, 7);
  const before = fs.existsSync(file('lock.json'));
  assert.equal(before, false);
  await lockbox.protect(PW1, key);
  assert.ok((await lockbox.unwrap(PW1)).equals(key));
  await assert.rejects(() => lockbox.unwrap('not the password at all!'), lockbox.WrongPasswordError);
  await assert.rejects(() => lockbox.changePassword('wrong one wrong one 1!', PW2), lockbox.WrongPasswordError);
  await assert.rejects(() => lockbox.changePassword(PW1, 'weak'), /at least 8/);
  await lockbox.changePassword(PW1, PW2);
  await assert.rejects(() => lockbox.unwrap(PW1), lockbox.WrongPasswordError);
  assert.ok((await lockbox.unwrap(PW2)).equals(key));
  fs.rmSync(file('lock.json')); // back to an unprotected vault for the end-to-end test below
});

test('lock.json with weak key-derivation settings is refused (downgrade guard)', async () => {
  await lockbox.protect(PW1, Buffer.alloc(32, 1));
  const lock = JSON.parse(fs.readFileSync(file('lock.json'), 'utf8'));
  lock.kdf.N = 2;
  fs.writeFileSync(file('lock.json'), JSON.stringify(lock));
  await assert.rejects(() => lockbox.unwrap(PW1), /too weak/);
  fs.rmSync(file('lock.json'));
});

test('protect: the key is removed everywhere, so vault + lock.json + keychain files alone cannot decrypt', () => {
  let r = cli(['protect'], `${PW1}\n${PW1}\n`);
  assert.equal(r.status, 0, out(r));
  assert.ok(fs.existsSync(file('lock.json')));
  assert.ok(!fs.existsSync(file('master.key')), 'master.key must be gone');
  for (const f of fs.readdirSync(path.dirname(file('x')))) {
    const p = path.join(path.dirname(file('x')), f);
    if (!fs.statSync(p).isFile()) continue;
    const text = fs.readFileSync(p, 'latin1');
    assert.ok(!text.includes(keyB64), `${f} must not contain the vault key`);
    assert.ok(!text.includes(SECRET), `${f} must not contain a plaintext secret`);
  }
  r = cli(['protect'], `${PW1}\n${PW1}\n`);
  assert.notEqual(r.status, 0, 'cannot protect twice');
});

test('unlocked: normal commands work; locked: they refuse, and activations end', () => {
  st.activate('shop', 'dev', {});
  assert.match(out(cli(['list', '--env', 'prod'])), /PG_PASS/);
  assert.match(out(cli(['status'])), /unlocked/);

  let r = cli(['lock']);
  assert.equal(r.status, 0, out(r));
  r = cli(['list', '--env', 'prod']);
  assert.notEqual(r.status, 0);
  assert.match(out(r), /locked/i);
  assert.match(out(cli(['status'])), /LOCKED/);
  assert.deepEqual(Object.keys(st.getState().active), [], 'locking ends agent activations');
  const v = cli(['export', '--env', 'prod']);
  assert.notEqual(v.status, 0);
  assert.ok(!out(v).includes(SECRET));
});

test('unlock: wrong password fails, right password works, and the version file changes so terminals reload', () => {
  const v0 = fs.readFileSync(file('version'), 'utf8');
  let r = cli(['unlock'], 'wrong password wrong password 1\n');
  assert.notEqual(r.status, 0);
  assert.match(out(r), /Wrong password/);
  r = cli(['unlock'], `${PW1}\n`);
  assert.equal(r.status, 0, out(r));
  assert.notEqual(fs.readFileSync(file('version'), 'utf8'), v0);
  assert.match(out(cli(['list', '--env', 'prod'])), /PG_PASS/);
});

test('terminal script while locked unloads what the shell had loaded (fails closed)', () => {
  cli(['lock']);
  const r = spawnSync(process.execPath, [CLI, 'env', '--env', 'dev', '--shell', 'bash'], { encoding: 'utf8', env: childEnv({ __SECRETMGR_KEYS: 'PG_PASS' }) });
  assert.match(r.stdout, /unset PG_PASS/);
  assert.ok(!r.stdout.includes('export PG_PASS'));
  assert.match(r.stderr, /locked/i);
});

test('agent Bash wrapper while locked: commands run with nothing loaded, output passes through, banner says locked', () => {
  const cmd = wrapCommand('echo "hello"; echo "pw=[${PG_PASS:-unset}]"', process.execPath, CLI, { locked: true });
  const r = spawnSync('bash', ['-c', cmd], { encoding: 'utf8', env: childEnv({ PG_PASS: 'stale-inherited', __SECRETMGR_KEYS: 'PG_PASS' }) });
  assert.match(r.stdout, /no secrets loaded/);
  assert.match(r.stdout, /hello/);
  assert.match(r.stdout, /pw=\[unset\]/, 'tracked inherited variables are stripped');
  assert.ok(!r.stdout.includes('stale-inherited'));
});

test('agent Bash wrapper (normal) fails closed when the vault locks after the hook decided', () => {
  cli(['lock']);
  const cmd = wrapCommand('echo ran', process.execPath, CLI);
  const r = spawnSync('bash', ['-c', cmd], { encoding: 'utf8', env: childEnv() });
  assert.ok(!r.stdout.includes('ran'), 'the command must not run without protection');
});

test('passwd via CLI: old password stops working', () => {
  assert.equal(cli(['unlock'], `${PW1}\n`).status, 0);
  let r = cli(['passwd'], `wrong wrong wrong wrong 1!\n${PW2}\n${PW2}\n`);
  assert.notEqual(r.status, 0);
  r = cli(['passwd'], `${PW1}\n${PW2}\n${PW2}\n`);
  assert.equal(r.status, 0, out(r));
  cli(['lock']);
  assert.notEqual(cli(['unlock'], `${PW1}\n`).status, 0);
  assert.equal(cli(['unlock'], `${PW2}\n`).status, 0);
});

test('idle auto-lock: the agent locks itself and clears activations', async () => {
  cli(['lock']);
  fs.writeFileSync(file('config.json'), JSON.stringify({ idleLockMin: 0.02 })); // ~1.2 s
  assert.equal(cli(['unlock'], `${PW2}\n`).status, 0);
  st.activate('shop', 'dev', {});
  await new Promise((r) => setTimeout(r, 2500));
  assert.match(out(cli(['status'])), /LOCKED/);
  assert.deepEqual(Object.keys(st.getState().active), []);
  fs.writeFileSync(file('config.json'), JSON.stringify({ idleLockMin: 30 }));
});

test('dashboard: the master password is the login. A link token alone never shows the vault, locked or unlocked', async () => {
  const token = 'test-token';
  const app = await buildApp({ token, port: 0 });
  const h = { authorization: `Bearer ${token}` };
  const withSession = (s) => ({ ...h, 'x-session': s });
  const call = (method, url, payload, headers = h) => app.inject({ method, url, payload, headers });

  // Vault LOCKED, token only.
  cli(['lock']);
  let r = await call('GET', '/api/state');
  assert.equal(r.statusCode, 200);
  assert.deepEqual([r.json().protected, r.json().locked, r.json().loggedIn], [true, true, false]);
  assert.equal(r.json().groups, undefined, 'no vault details before sign-in');
  r = await call('GET', '/api/groups/shop');
  assert.equal(r.statusCode, 401);
  assert.equal(r.json().code, 'login');

  // Vault UNLOCKED (say, from a terminal earlier), token only: still nothing.
  assert.equal(cli(['unlock'], `${PW2}\n`).status, 0);
  r = await call('GET', '/api/state');
  assert.equal(r.json().loggedIn, false);
  assert.equal(r.json().groups, undefined);
  assert.equal(r.json().active, undefined);
  for (const [m, u, p] of [
    ['GET', '/api/groups/shop'],
    ['POST', '/api/groups/shop/vars/PG_PASS/reveal', { env: 'prod' }],
    ['GET', '/api/groups/shop/export?env=prod'],
    ['GET', '/api/audit'],
    ['GET', '/api/security'],
    ['POST', '/api/security/lock', {}],
    ['PUT', '/api/security/idle', { minutes: 0 }],
  ]) {
    r = await call(m, u, p);
    assert.equal(r.statusCode, 401, `${m} ${u} must need sign-in`);
    assert.ok(!r.body.includes(SECRET));
  }

  // A bad token is a different failure from a missing session.
  r = await app.inject({ method: 'GET', url: '/api/state', headers: { authorization: 'Bearer nope' } });
  assert.equal(r.statusCode, 401);
  assert.equal(r.json().code, 'token');

  // Sign in: wrong password is refused (403, not 401), the right one starts a session.
  r = await call('POST', '/api/security/login', { password: 'Wrong-pass-99' });
  assert.equal(r.statusCode, 403);
  assert.match(r.json().error, /Wrong password/);
  r = await call('POST', '/api/security/login', { password: PW2 });
  assert.equal(r.statusCode, 200, r.body);
  const session = r.json().session;
  assert.ok(session && session.length > 20);
  r = await call('GET', '/api/groups/shop', undefined, withSession(session));
  assert.equal(r.statusCode, 200);
  r = await call('GET', '/api/state', undefined, withSession(session));
  assert.equal(r.json().loggedIn, true);
  assert.ok(r.json().groups.length >= 1);
  r = await call('GET', '/api/groups/shop', undefined, withSession('made-up-session'));
  assert.equal(r.statusCode, 401, 'a guessed session id is refused');
  r = await call('PUT', '/api/security/password', { current: PW2, next: 'weak' }, withSession(session));
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /at least 8/);

  // Sign out ends only that session.
  r = await call('POST', '/api/security/logout', {}, withSession(session));
  assert.equal(r.statusCode, 200);
  r = await call('GET', '/api/groups/shop', undefined, withSession(session));
  assert.equal(r.statusCode, 401);
  assert.match(cli(['status']).stdout, /unlocked/, 'the vault itself stays unlocked after sign-out');

  // Lock ends every session and signing in again unlocks.
  r = await call('POST', '/api/security/login', { password: PW2 });
  const s2 = r.json().session;
  r = await call('POST', '/api/security/lock', {}, withSession(s2));
  assert.equal(r.json().unlocked, false);
  r = await call('GET', '/api/state', undefined, withSession(s2));
  assert.deepEqual([r.json().locked, r.json().loggedIn], [true, false]);
  r = await call('POST', '/api/security/login', { password: PW2 });
  assert.equal(r.statusCode, 200, 'signing in unlocks a locked vault');
  const s3 = r.json().session;
  assert.equal((await call('GET', '/api/groups/shop', undefined, withSession(s3))).statusCode, 200);

  // Guessing is throttled, even for the right password afterwards.
  for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/api/security/login', { password: 'Nope-nope-99' })).statusCode, 403);
  r = await call('POST', '/api/security/login', { password: PW2 });
  assert.equal(r.statusCode, 429);
  await app.close();
});

test('an open dashboard tab does not defeat auto-lock (status polls are not activity)', async () => {
  cli(['lock']);
  fs.writeFileSync(file('config.json'), JSON.stringify({ idleLockMin: 0.03 })); // about 1.8 s
  const token = 'tok2';
  const app = await buildApp({ token, port: 0 });
  const h = { authorization: `Bearer ${token}` };
  let r = await app.inject({ method: 'POST', url: '/api/security/login', headers: h, payload: { password: PW2 } });
  assert.equal(r.statusCode, 200, r.body);
  const hs = { ...h, 'x-session': r.json().session };
  const until = Date.now() + 3500;
  while (Date.now() < until) {
    await app.inject({ method: 'GET', url: '/api/state', headers: hs });
    await new Promise((res) => setTimeout(res, 300));
  }
  assert.match(cli(['status']).stdout, /LOCKED/, 'polling every 300 ms must not keep the vault unlocked');
  r = await app.inject({ method: 'GET', url: '/api/state', headers: hs });
  assert.equal(r.json().loggedIn, false, 'and the session ended with the lock');
  fs.writeFileSync(file('config.json'), JSON.stringify({ idleLockMin: 30 }));
  await app.close();
});

test('MCP while locked: names nothing, posts an unlock request', async () => {
  cli(['lock']);
  const { createServer } = await import('../src/mcp/server.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const server = createServer();
  const client = new Client({ name: 't', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const r = await client.callTool({ name: 'activate_env', arguments: { env: 'dev' } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /locked/i);
  assert.ok(st.getState().unlockRequestedAt, 'the dashboard is told the agent is waiting');
  assert.ok(!JSON.stringify(r).includes(SECRET));
});

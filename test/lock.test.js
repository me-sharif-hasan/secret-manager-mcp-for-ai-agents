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
const PW1 = 'correct horse battery staple 7';
const PW2 = 'another long passphrase 42 !';

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
  assert.equal(lockbox.checkStrength('short1!').ok, false);
  assert.equal(lockbox.checkStrength('password12345!!').ok, false);
  assert.equal(lockbox.checkStrength('aaaaaaaaaaaaaaaa').ok, false);
  assert.equal(lockbox.checkStrength('7QK2M-XH9TD-4RW6B-NP3VC').ok, true);
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
  await assert.rejects(() => lockbox.changePassword(PW1, 'weak'), /at least 12/);
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

test('dashboard API: locked state, 423 on vault routes, unlock needs the password, throttled after repeated failures', async () => {
  cli(['lock']);
  const token = 'test-token';
  const app = await buildApp({ token, port: 0 });
  const call = (method, url, body) => app.inject({ method, url, payload: body, headers: { authorization: `Bearer ${token}`, host: undefined } });
  const get = async (url) => (await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } }));

  let r = await get('/api/state');
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().locked, true);
  assert.deepEqual(r.json().groups, []);
  r = await get('/api/groups/shop');
  assert.equal(r.statusCode, 423);
  assert.ok(!r.body.includes(SECRET));

  const post = (url, payload, method = 'POST') => app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });
  r = await post('/api/security/unlock', { password: PW2 });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().unlocked, true);
  r = await get('/api/groups/shop');
  assert.equal(r.statusCode, 200);

  r = await post('/api/security/password', { current: PW2, next: 'weak' }, 'PUT');
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /at least 12/);

  r = await post('/api/security/lock', {});
  assert.equal(r.json().unlocked, false);
  for (let i = 0; i < 5; i++) assert.equal((await post('/api/security/unlock', { password: 'nope nope nope nope 99' })).statusCode, 401);
  r = await post('/api/security/unlock', { password: PW2 });
  assert.equal(r.statusCode, 429, 'correct password is also refused while throttled');
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

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sandbox, CLI, childEnv } from './helpers.js';

sandbox();
delete process.env.SECRETMGR_ALLOW_UNPROTECTED; // here the real rule applies: a master password is required
process.env.SECRETMGR_KDF_FAST = '1';
delete process.env.CLAUDECODE;
const vault = await import('../src/core/vault.js');
const st = await import('../src/core/state.js');
const { requiresSetup } = await import('../src/core/lockbox.js');
const { buildApp } = await import('../src/server/api.js');

const SECRET = 'dev-Zk39-secret-value-for-gate';
const PW = 'Correct-horse-battery-9';

vault.createGroup('shop');
st.setDefaultGroup('shop');
vault.setVar('shop', 'PG_PASS', { values: { dev: SECRET } });
st.activate('shop', 'dev', {});

const cli = (args, input = '', env = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: childEnv({ SECRETMGR_ALLOW_UNPROTECTED: '', ...env }), input });

after(() => {
  cli(['lock']);
});

test('a vault without a master password requires setup', () => {
  assert.equal(requiresSetup(), true);
});

test('MCP: every tool refuses until a master password exists, and asks the owner to set one', async () => {
  const { createServer } = await import('../src/mcp/server.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const server = createServer();
  const client = new Client({ name: 't', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  for (const name of ['activate_env', 'list_vars', 'status']) {
    const r = await client.callTool({ name, arguments: name === 'status' ? {} : { env: 'dev' } });
    assert.equal(r.isError, true, name);
    assert.match(r.content[0].text, /master password/i);
    assert.ok(!JSON.stringify(r).includes(SECRET));
  }
  assert.ok(st.getState().unlockRequestedAt, 'the dashboard is told the agent is waiting');
});

test('Bash hook: commands still run, but nothing is loaded even though dev is active', () => {
  const event = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo "pw=[${PG_PASS:-unset}]"' } });
  const h = cli(['hook', 'pretooluse'], event);
  assert.equal(h.status, 0, h.stderr);
  const reply = JSON.parse(h.stdout).hookSpecificOutput;
  assert.match(reply.updatedInput.command, /--locked/);
  const r = spawnSync('bash', ['-c', reply.updatedInput.command], { encoding: 'utf8', env: childEnv({ SECRETMGR_ALLOW_UNPROTECTED: '' }) });
  assert.match(r.stdout, /no secrets loaded/);
  assert.match(r.stdout, /pw=\[unset\]/);
  assert.ok(!r.stdout.includes(SECRET));
});

test('dashboard API: needsSetup is reported and agent activation is refused', async () => {
  const token = 'tok';
  const app = await buildApp({ token, port: 0 });
  const h = { authorization: `Bearer ${token}` };
  let r = await app.inject({ method: 'GET', url: '/api/state', headers: h });
  assert.equal(r.json().needsSetup, true);
  r = await app.inject({ method: 'POST', url: '/api/agent/activate', headers: h, payload: { group: 'shop', env: 'dev' } });
  assert.equal(r.statusCode, 403);
  assert.match(r.json().error, /master password/i);
  r = await app.inject({ method: 'POST', url: '/api/security/enable', headers: h, payload: { password: 'short' } });
  assert.equal(r.statusCode, 400, 'a weak password is refused');
  r = await app.inject({ method: 'POST', url: '/api/security/enable', headers: h, payload: { password: PW } });
  assert.equal(r.statusCode, 200, r.body);
  assert.ok(r.json().session, 'setting the password signs you in');
  r = await app.inject({ method: 'GET', url: '/api/state', headers: h });
  assert.equal(r.json().needsSetup, false);
  assert.equal(r.json().protected, true);
  await app.close();
  assert.equal(requiresSetup(), false);
});

test('init without a terminal does not hang and says a master password is required', () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'secretmgr-init-'));
  fs.mkdirSync(path.join(fresh, 'home'));
  const r = cli(['init', '--yes'], '', { SECRETMGR_HOME: path.join(fresh, 'data'), HOME: path.join(fresh, 'home') });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /master password is required/i);
});

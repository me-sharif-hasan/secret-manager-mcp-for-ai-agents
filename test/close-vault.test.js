import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { sandbox, CLI, childEnv } from './helpers.js';

sandbox();
process.env.SECRETMGR_KDF_FAST = '1';
delete process.env.CLAUDECODE;
const vault = await import('../src/core/vault.js');
const st = await import('../src/core/state.js');
const { readAudit } = await import('../src/core/audit.js');
const { file } = await import('../src/core/paths.js');

const PW = 'correct horse battery staple 5';
const cli = (args, input = '') => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: childEnv(), input });

vault.createGroup('shop');
st.setDefaultGroup('shop');
vault.setVar('shop', 'PG_PASS', { values: { dev: 'dev-value-close-test' } });
assert.equal(cli(['protect'], `${PW}\n${PW}\n`).status, 0);
st.activate('shop', 'dev', {});

after(() => {
  cli(['lock']);
});

async function connect() {
  const { createServer } = await import('../src/mcp/server.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const server = createServer();
  const client = new Client({ name: 't', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

test('close_vault locks the vault, ends activations and is audited as the agent', async () => {
  const client = await connect();
  assert.match(cli(['status']).stdout, /unlocked/);
  const r = await client.callTool({ name: 'close_vault', arguments: {} });
  assert.notEqual(r.isError, true);
  assert.match(r.content[0].text, /locked/);
  assert.match(cli(['status']).stdout, /LOCKED/);
  assert.deepEqual(Object.keys(st.getState().active), []);
  assert.ok(readAudit({ limit: 20 }).some((e) => e.action === 'lock' && e.actor === 'agent'));
});

test('close_vault when already locked is a calm no-op, and it never opens a browser', async () => {
  const client = await connect();
  const r = await client.callTool({ name: 'close_vault', arguments: {} });
  assert.notEqual(r.isError, true);
  assert.match(r.content[0].text, /already locked/);
  assert.equal(fs.existsSync(file('unlock-ui.json')), false, 'no unlock window was requested');
});

test('after close_vault the agent still cannot get secrets without the owner unlocking', async () => {
  const client = await connect();
  const r = await client.callTool({ name: 'activate_env', arguments: { env: 'dev' } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /locked/i);
  assert.ok(!JSON.stringify(r).includes('dev-value-close-test'));
});

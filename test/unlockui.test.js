import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sandbox } from './helpers.js';

sandbox();
delete process.env.SECRETMGR_NO_AUTO_OPEN; // this file exercises the opener, with a fake launcher
delete process.env.SECRETMGR_ALLOW_UNPROTECTED; // and the real rule: no master password yet
delete process.env.CLAUDECODE;
const vault = await import('../src/core/vault.js');
const st = await import('../src/core/state.js');
const { file } = await import('../src/core/paths.js');
const { openUnlockUi, setLauncherForTests } = await import('../src/core/unlockui.js');

vault.createGroup('shop');
st.setDefaultGroup('shop');

let launches = 0;
setLauncherForTests(() => launches++);

test('the opener launches once, then refuses for two minutes (no window spam)', () => {
  assert.equal(openUnlockUi(), 'opened');
  assert.equal(openUnlockUi(), 'recent');
  assert.equal(launches, 1);
  fs.rmSync(file('unlock-ui.json'));
});

test('it can be turned off in config.json', () => {
  fs.writeFileSync(file('config.json'), JSON.stringify({ autoOpenUnlock: false }));
  assert.equal(openUnlockUi(), 'disabled');
  assert.equal(launches, 1);
  fs.rmSync(file('config.json'));
});

test('MCP: only tools that want secrets open the browser, and the agent is told what happened', async () => {
  const { createServer } = await import('../src/mcp/server.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const server = createServer();
  const client = new Client({ name: 't', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  launches = 0;

  let r = await client.callTool({ name: 'status', arguments: {} });
  assert.equal(r.isError, true);
  assert.equal(launches, 0, 'a status check must not open a window');

  r = await client.callTool({ name: 'activate_env', arguments: { env: 'dev' } });
  assert.equal(launches, 1);
  assert.match(r.content[0].text, /browser window was opened for the owner/);
  assert.match(r.content[0].text, /master password/i);
  assert.match(r.content[0].text, /Never ask for or suggest a password/);

  r = await client.callTool({ name: 'activate_env', arguments: { env: 'dev' } });
  assert.equal(launches, 1, 'a second attempt within two minutes does not open another window');
  assert.match(r.content[0].text, /a moment ago/);
});

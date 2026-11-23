import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { sandbox } from './helpers.js';

sandbox();
const { parseEnv, serializeEnv } = await import('../src/core/envfile.js');
const vault = await import('../src/core/vault.js');
const st = await import('../src/core/state.js');
const { createRedactor } = await import('../src/core/redact.js');
const { agentEnvironment, agentActivate } = await import('../src/core/policy.js');
const { agentScript, terminalScript, emit } = await import('../src/shell/env.js');
const { file } = await import('../src/core/paths.js');

test('env parser: quotes, export, comments, multiline, errors', () => {
  const { entries, errors } = parseEnv(
    [
      '# comment',
      'A=plain',
      'export B="with space"',
      "C='single $literal'",
      'D=value # trailing comment',
      'E="line1\\nline2"',
      'F="multi',
      'line"',
      'G=',
      'bad line here',
      'H="unterminated',
    ].join('\n'),
  );
  const m = Object.fromEntries(entries.map((e) => [e.key, e.value]));
  assert.equal(m.A, 'plain');
  assert.equal(m.B, 'with space');
  assert.equal(m.C, 'single $literal');
  assert.equal(m.D, 'value');
  assert.equal(m.E, 'line1\nline2');
  assert.equal(m.F, 'multi\nline');
  assert.equal(m.G, '');
  assert.equal(errors.length, 2);
  assert.match(errors[0].reason, /KEY=VALUE/);
  assert.match(errors[1].reason, /unterminated/);
});

test('env serializer round-trips through the parser', () => {
  const vars = { A: 'plain', B: 'has space', C: 'quote"inside', D: 'line1\nline2', E: '', F: 'hash # not comment', G: 'back\\slash' };
  const parsed = Object.fromEntries(parseEnv(serializeEnv(vars)).entries.map((e) => [e.key, e.value]));
  assert.deepEqual(parsed, vars);
});

test('vault: encrypted at rest, groups, env settings, access, import', () => {
  vault.createGroup('shop');
  vault.setVar('shop', 'PG_PASS', { values: { dev: 'dev-secret-value-123', prod: 'prod-secret-value-456' } });
  const raw = fs.readFileSync(file('vault.enc'), 'utf8');
  assert.ok(!raw.includes('dev-secret-value-123'), 'plaintext must not appear in vault file');
  assert.ok(!raw.includes('PG_PASS'), 'key names are encrypted too');
  assert.equal(fs.statSync(file('vault.enc')).mode & 0o777, 0o600);

  const v = vault.viewGroup('shop').vars[0];
  assert.equal(v.access.dev, 'use');
  assert.equal(v.access.prod, 'none', 'prod defaults to hidden from agent');
  assert.ok(!JSON.stringify(vault.viewGroup('shop')).includes('secret-value'), 'view never contains values');
  assert.equal(vault.reveal('shop', 'PG_PASS', 'dev'), 'dev-secret-value-123');

  const dry = vault.importEnv('shop', 'dev', 'PG_PASS=dev-secret-value-123\nNEW_ONE=abc\nPG_HOST=db.internal\nbad line', { dryRun: true });
  assert.equal(dry.written, 0);
  assert.equal(dry.rows.filter((r) => r.status === 'invalid').length, 1);
  assert.equal(dry.rows.find((r) => r.key === 'PG_PASS').status, 'unchanged');
  assert.equal(dry.rows.find((r) => r.key === 'NEW_ONE').status, 'new');
  const real = vault.importEnv('shop', 'dev', 'PG_HOST=db.internal\nNEW_ONE=abc', { access: 'write' });
  assert.equal(real.written, 2);
  assert.equal(vault.viewGroup('shop').vars.find((x) => x.key === 'NEW_ONE').access.dev, 'write');
  assert.match(vault.exportEnv('shop', 'dev'), /PG_HOST=db\.internal/);

  assert.throws(() => vault.setVar('shop', 'bad-name', {}), /Variable name/);
  assert.throws(() => vault.createGroup('Shop'), /Group name/);
  assert.throws(() => vault.createGroup('shop'), /already exists/);
});

test('redactor: raw, base64, url-encoded, split across chunks', async () => {
  const secret = 'S3cr3t/value+with=chars&more';
  const r = createRedactor([{ key: 'API_KEY', value: secret }, { key: 'PORT', value: '5432' }]);
  const b64 = Buffer.from(secret).toString('base64');
  const text = `raw=${secret} b64=${b64} url=${encodeURIComponent(secret)} port=5432`;
  const out = r.redactString(text);
  assert.ok(!out.includes(secret) && !out.includes(b64) && !out.includes(encodeURIComponent(secret)));
  assert.ok(out.includes('port=5432'), 'short non-sensitive values are left alone');

  // chunk boundaries inside the secret
  const r2 = createRedactor([{ key: 'API_KEY', value: secret }]);
  const chunks = [];
  const input = `before ${secret} after`;
  const stream = Readable.from([input.slice(0, 12), input.slice(12, 20), input.slice(20)]).pipe(r2.stream());
  for await (const c of stream) chunks.push(c.toString());
  const joined = chunks.join('');
  assert.equal(joined, 'before [REDACTED:API_KEY] after');
});

test('policy: activation gates, suffixed names, primary, kill switch', async () => {
  // dev: allowed no approval; uat: allowed; prod: off
  const dev = await agentActivate({ env: 'dev', group: 'shop' });
  assert.equal(dev.ok, true);
  assert.ok(dev.variables.some((x) => x.name === 'PG_PASS' && x.suffixed === 'PG_PASS__DEV'));
  assert.equal(dev.guidance.level, 'full');
  assert.match(dev.guidance.text, /ask the user for explicit confirmation/i);

  const prod = await agentActivate({ env: 'prod', group: 'shop' });
  assert.equal(prod.ok, false);
  assert.match(prod.reason, /not allowed/);

  vault.setEnvSettings('shop', 'prod', { allow: true, approval: false });
  vault.setAccess('shop', 'PG_PASS', 'prod', 'use');
  const prod2 = await agentActivate({ env: 'prod', group: 'shop' });
  assert.equal(prod2.ok, true);

  let env = agentEnvironment();
  assert.equal(env.vars.PG_PASS, 'dev-secret-value-123', 'first activated env is primary');
  assert.equal(env.vars.PG_PASS__DEV, 'dev-secret-value-123');
  assert.equal(env.vars.PG_PASS__PROD, 'prod-secret-value-456');

  st.setPrimary('prod');
  env = agentEnvironment();
  assert.equal(env.vars.PG_PASS, 'prod-secret-value-456');

  vault.setAccess('shop', 'PG_PASS', 'prod', 'none');
  assert.ok(!('PG_PASS__PROD' in agentEnvironment().vars), 'access none removes the variable from an active env');
  vault.setAccess('shop', 'PG_PASS', 'prod', 'use');

  const script = agentScript();
  assert.match(script, /^unset .*PG_PASS/m);
  assert.match(script, /export PG_PASS__DEV='dev-secret-value-123'/);
  assert.match(script, /\[secretmgr env=dev:FULL\*?,prod:READ-ONLY\*?\]/);

  st.setKilled(true);
  assert.deepEqual(agentEnvironment().vars, {});
  assert.deepEqual(st.getState().active, {}, 'kill clears active environments');
  assert.match(agentScript(), /kill switch is on/);
  assert.ok(!agentScript().includes('export '));
  const denied = await agentActivate({ env: 'dev', group: 'shop' });
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /kill switch/i);
  st.setKilled(false);
});

test('policy: expiry removes activations', async () => {
  vault.setEnvSettings('shop', 'dev', { expiryMin: 1 });
  st.activate('shop', 'dev', { expiryMin: 1 });
  st.mutateState((s) => {
    s.active.dev.expiresAt = Date.now() - 1000;
  });
  assert.equal(st.getState().active.dev, undefined);
  vault.setEnvSettings('shop', 'dev', { expiryMin: null });
});

test('approval flow: agent waits, owner approves', async () => {
  vault.setEnvSettings('shop', 'uat', { allow: true, approval: true });
  const pending = agentActivate({ env: 'uat', group: 'shop' });
  await new Promise((r) => setTimeout(r, 200));
  const [req] = st.pendingApprovals();
  assert.equal(req.env, 'uat');
  st.decideApproval(req.id, true, { expiryMin: 30 });
  const r = await pending;
  assert.equal(r.ok, true);
  assert.ok(st.getState().active.uat.expiresAt > Date.now());
  st.deactivate('uat');

  const pending2 = agentActivate({ env: 'uat', group: 'shop' });
  await new Promise((r2) => setTimeout(r2, 200));
  st.decideApproval(st.pendingApprovals()[0].id, false);
  const r2 = await pending2;
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /declined/);
});

test('terminal env: all values, tracked keys, kill clears', () => {
  st.deactivate('dev');
  process.env.__SECRETMGR_KEYS = '';
  const { script } = terminalScript('bash', { env: 'prod', group: 'shop' });
  assert.match(script, /export PG_PASS='prod-secret-value-456'/, 'user terminals get every value, regardless of agent access');
  assert.match(script, /export __SECRETMGR_KEYS=/);

  process.env.__SECRETMGR_KEYS = 'PG_PASS NEW_ONE';
  st.setKilled(true);
  const killed = terminalScript('bash', { env: 'prod', group: 'shop' });
  assert.match(killed.script, /^unset PG_PASS NEW_ONE$/m);
  assert.ok(!killed.script.includes('export PG'));
  st.setKilled(false);
  delete process.env.__SECRETMGR_KEYS;
});

test('shell quoting survives hostile values', () => {
  const nasty = `it's "quoted" $(whoami) \`id\` ; rm -rf / \\ %PATH%\nnewline`;
  assert.match(emit('bash', { set: { X: nasty } }), /export X='it'\\''s/);
  assert.throws(() => emit('bash', { set: { 'BAD;NAME': 'x' } }), /unsafe variable name/);
  assert.throws(() => emit('bash', { unset: ['A B'] }), /unsafe variable name/);
});

test('deleteEnv removes values, access rules and agent references; keeps at least one env', async () => {
  vault.createGroup('tmp-group');
  vault.setVar('tmp-group', 'A_KEY', { values: { dev: 'dev-value-123456', uat: 'uat-value-123456' } });
  vault.setEnvSettings('tmp-group', 'uat', { allow: true, approval: false });
  st.activate('tmp-group', 'uat', {});
  st.setTerminalDefaultEnv('uat');
  assert.ok(st.getState().active.uat);

  const r = vault.deleteEnv('tmp-group', 'uat');
  st.afterEnvDeleted('tmp-group', 'uat', r.remaining[0]);
  assert.equal(r.removedValues, 1);
  assert.deepEqual(r.remaining, ['dev', 'prod']);
  const view = vault.viewGroup('tmp-group');
  assert.ok(!view.envs.uat);
  assert.ok(!('uat' in view.vars[0].access) && !('uat' in view.vars[0].masked));
  assert.ok(!JSON.stringify(vault.load()).includes('uat-value-123456'), 'deleted values are gone from the vault');
  assert.equal(st.getState().active.uat, undefined, 'agent activation of the deleted env is cleared');
  assert.equal(st.getState().terminalDefaultEnv, 'dev', 'terminal default falls back to a remaining env');
  assert.throws(() => vault.deleteEnv('tmp-group', 'uat'), /does not exist/);

  vault.deleteEnv('tmp-group', 'prod');
  assert.throws(() => vault.deleteEnv('tmp-group', 'dev'), /at least one environment/);
});

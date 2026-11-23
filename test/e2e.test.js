import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sandbox, CLI, childEnv } from './helpers.js';

const dir = sandbox();
delete process.env.CLAUDECODE; // tests may run inside Claude Code
const vault = await import('../src/core/vault.js');
const st = await import('../src/core/state.js');
const { wrapCommand, analyzeCommand } = await import('../src/hooks/guard.js');
const { initScript } = await import('../src/shell/init.js');
const install = await import('../src/shell/install.js');
const { file } = await import('../src/core/paths.js');
const { buildApp } = await import('../src/server/api.js');

const DEV_PW = 'dev-Zk39-secret-value';
const PROD_PW = 'prod-Qm81-secret-value';

vault.createGroup('shop');
st.setDefaultGroup('shop');
vault.setVar('shop', 'PG_PASS', { values: { dev: DEV_PW, prod: PROD_PW } });
vault.setVar('shop', 'PG_HOST', { values: { prod: 'prod-db.internal.example' } });
st.activate('shop', 'dev', {});

const run = (cmd, opts = {}) => spawnSync('bash', ['-c', cmd], { encoding: 'utf8', env: childEnv(opts.env), cwd: opts.cwd, input: opts.input });
const wrapped = (c) => wrapCommand(c, process.execPath, CLI);

test('wrapper: loads active env, redacts output, banner, exit code, cwd carried back', () => {
  const r = run(`${wrapped('echo "pw=$PG_PASS"; printf "len=%s\\n" "${#PG_PASS}"; cd /tmp; exit 7')}\npwd`);
  assert.ok(!r.stdout.includes(DEV_PW), 'secret value must never reach stdout');
  assert.match(r.stdout, /\[secretmgr env=dev:FULL\]/);
  assert.match(r.stdout, /pw=\[REDACTED:PG_PASS\]/);
  assert.match(r.stdout, new RegExp(`len=${DEV_PW.length}`), 'the real value was available to the command');
  assert.equal(r.stdout.trim().split('\n').pop(), '/tmp', 'cd inside the command persists');
  const code = run(`${wrapped('exit 7')}\necho "rc=$?"`);
  assert.match(code.stdout, /rc=7/);
});

test('wrapper: command can really use the secret (psql-style), value never printed', () => {
  const r = run(wrapped('PGPASSWORD="$PG_PASS" bash -c \'test "$PGPASSWORD" = "' + DEV_PW + '" && echo auth-ok\''));
  assert.match(r.stdout, /auth-ok/);
  assert.ok(!r.stdout.includes(DEV_PW));
});

test('wrapper: base64 and url-encoded copies are redacted too', () => {
  const r = run(wrapped('printf "%s" "$PG_PASS" | base64'));
  assert.ok(!r.stdout.includes(Buffer.from(DEV_PW).toString('base64')));
  assert.match(r.stdout, /REDACTED:PG_PASS/);
});

test('wrapper: strips inherited secrets from the launching shell', () => {
  const r = run(wrapped('echo "host=[${PG_HOST-unset}] pw=${PG_PASS_OTHER-unset}"'), { env: { PG_HOST: 'inherited-from-terminal-value', PG_PASS: 'stale-terminal-pass' } });
  assert.match(r.stdout, /host=\[unset\]/, 'an inherited managed variable that is not active must be removed');
  assert.ok(!r.stdout.includes('inherited-from-terminal-value'));
});

test('wrapper: two environments at once use suffixed names; primary gets plain name', () => {
  vault.setEnvSettings('shop', 'prod', { allow: true, approval: false });
  vault.setAccess('shop', 'PG_PASS', 'prod', 'use');
  vault.setAccess('shop', 'PG_HOST', 'prod', 'use');
  st.activate('shop', 'prod', {});
  const r = run(wrapped('[ "$PG_PASS__DEV" != "$PG_PASS__PROD" ] && echo distinct; [ "$PG_PASS" = "$PG_PASS__DEV" ] && echo primary-is-dev; echo "h=$PG_HOST__PROD"'));
  assert.match(r.stdout, /distinct/);
  assert.match(r.stdout, /primary-is-dev/);
  assert.match(r.stdout, /\[secretmgr env=dev:FULL\*,prod:READ-ONLY\]/);
  assert.match(r.stdout, /h=\[REDACTED:PG_HOST\]/);
  st.deactivate('prod');
});

test('wrapper: kill switch and env change take effect on the very next command', () => {
  st.setKilled(true);
  const killed = run(wrapped('echo "pw=[${PG_PASS-unset}]"'));
  assert.match(killed.stdout, /kill switch is on/);
  assert.match(killed.stdout, /pw=\[unset\]/);
  st.setKilled(false);
  const none = run(wrapped('echo "pw=[${PG_PASS-unset}]"'));
  assert.match(none.stdout, /pw=\[unset\]/, 'activations are cleared by the kill switch and are not silently restored');
  st.activate('shop', 'dev', {});
  assert.match(run(wrapped('echo "pw=[${PG_PASS-unset}]"')).stdout, /pw=\[\[REDACTED:PG_PASS\]\]/);
});

test('wrapper: fails closed when the vault key is unavailable', () => {
  const broken = path.join(dir, 'broken');
  fs.mkdirSync(broken, { recursive: true });
  fs.copyFileSync(file('vault.enc'), path.join(broken, 'vault.enc'));
  const marker = path.join(dir, 'should-not-exist');
  const r = run(wrapped(`touch ${marker}; echo ran`), { env: { SECRETMGR_HOME: broken } });
  assert.notEqual(r.status, 0);
  assert.ok(!fs.existsSync(marker), 'the command must not run');
  assert.match(r.stderr + r.stdout, /command not run|output withheld/);
});

test('guard: blocks dumps and prints, allows normal use', () => {
  const names = ['PG_PASS', 'PG_PASS__DEV', 'PG_HOST'];
  const deny = ['env', 'printenv', 'printenv PG_PASS', 'echo $PG_PASS', 'echo "token: ${PG_PASS__DEV}"', 'export -p', 'set | grep PASS', 'cat /proc/self/environ', 'ls; env | sort', 'cat ~/.secretmgr/master.key', 'secretmgr reveal PG_PASS --env dev', 'node /x/src/cli/index.js env --shell bash --env prod', 'secretmgr kill --off', 'declare -p PG_PASS', 'printf "%s" "$PG_HOST" > /tmp/x; cat /tmp/x | cat'];
  for (const c of deny) assert.ok(analyzeCommand(c, names), `should block: ${c}`);
  const allow = ['PGPASSWORD="$PG_PASS" psql -h "$PG_HOST" -U app -c "select 1"', 'env FOO=1 node app.js', 'npm run migrate', 'git status', 'curl -H "Authorization: Bearer $PG_PASS" https://x.test', 'export NODE_ENV=production', 'echo hello', 'psql "host=$PG_HOST password=$PG_PASS" -c "select 1"'];
  for (const c of allow) assert.equal(analyzeCommand(c, names), null, `should allow: ${c}`);
});

test('hook: deny / rewrite / pass-through / fail closed', () => {
  const hook = (event, raw) => {
    const r = spawnSync(process.execPath, [CLI, 'hook', 'pretooluse'], { input: raw ?? JSON.stringify(event), encoding: 'utf8', env: childEnv() });
    return { out: r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null, status: r.status };
  };
  const denied = hook({ tool_name: 'Bash', tool_input: { command: 'echo $PG_PASS' } });
  assert.equal(denied.out.permissionDecision, 'deny');
  assert.match(denied.out.permissionDecisionReason, /print a secret/);

  const ok = hook({ tool_name: 'Bash', tool_input: { command: 'PGPASSWORD="$PG_PASS" psql -c "select 1"', description: 'q' } });
  assert.equal(ok.out.hookEventName, 'PreToolUse');
  assert.equal(ok.out.permissionDecision, undefined, 'does not override the user permission flow by default');
  assert.ok(ok.out.updatedInput.command.includes('PGPASSWORD="$PG_PASS" psql -c "select 1"'), 'original command stays readable');
  assert.equal(ok.out.updatedInput.description, 'q', 'other tool_input fields are preserved');
  assert.match(ok.out.updatedInput.command, /exec-env/);
  assert.match(ok.out.updatedInput.command, /redact/);

  fs.writeFileSync(file('config.json'), JSON.stringify({ hookAutoApprove: true }));
  assert.equal(hook({ tool_name: 'Bash', tool_input: { command: 'ls' } }).out.permissionDecision, 'allow');
  fs.rmSync(file('config.json'));

  assert.equal(hook({ tool_name: 'Read', tool_input: { file_path: '/x' } }).out, null, 'other tools are untouched');
  const bad = hook(null, '{not json');
  assert.equal(bad.out.permissionDecision, 'deny', 'garbage input fails closed');
});

test('shell hook (bash): use, resync on change, kill clears, agent shells skipped', () => {
  const script = path.join(dir, 'init.bash');
  fs.writeFileSync(script, initScript('bash'));
  const env = { SECRETMGR_BIN: `${process.execPath} ${CLI}`, SECRETMGR_ENV: '', CLAUDECODE: '' };
  delete env.CLAUDECODE;
  st.deactivate('dev');
  const prog = [
    `. ${script}`,
    'secretmgr use dev', 'echo "1:[$PG_PASS]"',
    'secretmgr use prod', 'echo "2:[$PG_PASS][$PG_HOST]"',
    'secretmgr use dev', 'echo "3:[$PG_PASS][${PG_HOST-unset}]"',
    `${process.execPath} ${CLI} kill`, '__secretmgr_sync', 'echo "4:[${PG_PASS-unset}]"',
    `${process.execPath} ${CLI} kill --off`, '__secretmgr_sync', 'echo "5:[${PG_PASS-unset}]"',
    'secretmgr unload', 'echo "6:[${PG_PASS-unset}]"',
  ].join('\n');
  const r = spawnSync('bash', ['--noprofile', '--norc', '-i', '-c', prog], { encoding: 'utf8', env: childEnv(env) });
  assert.match(r.stdout, new RegExp(`1:\\[${DEV_PW}\\]`));
  assert.match(r.stdout, new RegExp(`2:\\[${PROD_PW}\\]\\[prod-db.internal.example\\]`));
  assert.match(r.stdout, new RegExp(`3:\\[${DEV_PW}\\]\\[unset\\]`), 'PG_HOST does not exist in dev and must be unset, not stale');
  assert.match(r.stdout, /4:\[unset\]/, 'kill switch clears the terminal on the next prompt');
  assert.match(r.stdout, new RegExp(`5:\\[${DEV_PW}\\]`), 'restoring access brings the terminal back on its next prompt');
  assert.match(r.stdout, /6:\[unset\]/);

  const agent = spawnSync('bash', ['--noprofile', '--norc', '-i', '-c', `. ${script}; secretmgr use dev 2>&1 | head -1; echo "[$PG_PASS]"`], { encoding: 'utf8', env: childEnv({ ...env, CLAUDECODE: '1' }) });
  assert.ok(!agent.stdout.includes(DEV_PW), 'agent shells (CLAUDECODE set) never load secrets');
});

test('shell hook (zsh): same behaviour', { skip: spawnSync('which', ['zsh']).status !== 0 }, () => {
  const script = path.join(dir, 'init.zsh');
  fs.writeFileSync(script, initScript('zsh'));
  const env = { SECRETMGR_BIN: `${process.execPath} ${CLI}` };
  const prog = [`. ${script}`, 'secretmgr use dev', 'echo "1:[$PG_PASS]"', 'secretmgr use prod', 'echo "2:[$PG_PASS]"', 'secretmgr unload', 'echo "3:[${PG_PASS-unset}]"'].join('\n');
  const r = spawnSync('zsh', ['-f', '-i', '-c', prog], { encoding: 'utf8', env: childEnv(env) });
  assert.match(r.stdout, new RegExp(`1:\\[${DEV_PW}\\]`));
  assert.match(r.stdout, new RegExp(`2:\\[${PROD_PW}\\]`));
  assert.match(r.stdout, /3:\[unset\]/);
});

test('terminal env refuses non-interactive callers (agent Bash has no TTY)', () => {
  const r = spawnSync(process.execPath, [CLI, 'env', '--shell', 'bash', '--env', 'dev'], { encoding: 'utf8', env: { ...process.env, SECRETMGR_ALLOW_NONTTY: '' }, input: '' });
  assert.equal(r.status, 3);
  assert.ok(!r.stdout.includes(DEV_PW));
  for (const args of [['reveal', 'PG_PASS', '--env', 'dev'], ['export', '--env', 'dev']]) {
    const x = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, SECRETMGR_ALLOW_NONTTY: '' }, input: '' });
    assert.equal(x.status, 3);
    assert.ok(!x.stdout.includes(DEV_PW));
  }
});

test('installer: idempotent, backs up, removes cleanly; Claude settings merged not clobbered', () => {
  const rc = path.join(process.env.HOME, '.bashrc');
  fs.writeFileSync(rc, '# my config\nalias ll="ls -l"\n');
  install.installShells({ shells: ['bash'] });
  install.installShells({ shells: ['bash'] });
  const text = fs.readFileSync(rc, 'utf8');
  assert.equal(text.split('# >>> secretmgr >>>').length - 1, 1, 'exactly one block after installing twice');
  assert.match(text, /alias ll="ls -l"/);
  assert.ok(fs.existsSync(`${rc}.secretmgr.bak`));
  assert.ok(fs.existsSync(path.join(file('init'), 'init.bash')));
  install.uninstallShells();
  const after = fs.readFileSync(rc, 'utf8');
  assert.ok(!after.includes('secretmgr'));
  assert.match(after, /alias ll="ls -l"/);

  const settings = path.join(process.env.HOME, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ model: 'x', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }], Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] } }));
  const saved = process.env.PATH;
  process.env.PATH = '/nonexistent'; // make sure the `claude` CLI is not invoked
  try {
    install.installClaude();
    install.installClaude();
  } finally {
    process.env.PATH = saved;
  }
  const cfg = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.equal(cfg.model, 'x');
  assert.ok(cfg.hooks.Stop, 'unrelated hooks kept');
  const all = cfg.hooks.PreToolUse.flatMap((e) => e.hooks.map((h) => h.command));
  assert.ok(all.includes('echo mine'));
  assert.equal(all.filter((c) => c.includes('hook pretooluse')).length, 1);
  assert.ok(install.uninstallClaude());
  const cfg2 = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.deepEqual(cfg2.hooks.PreToolUse.flatMap((e) => e.hooks.map((h) => h.command)), ['echo mine']);
});

test('API: auth, host check, CRUD, reveal, import, kill, no values in views', async () => {
  const app = await buildApp({ token: 'tok123' });
  const call = (method, url, body, token = 'tok123') => app.inject({ method, url, payload: body, headers: token ? { authorization: `Bearer ${token}` } : {} });

  assert.equal((await call('GET', '/api/state', null, null)).statusCode, 401);
  assert.equal((await call('GET', '/api/state', null, 'wrong')).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/api/health' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/kill', payload: { on: true }, headers: { authorization: 'Bearer tok123', origin: 'https://evil.example' } })).statusCode, 403);

  const s = (await call('GET', '/api/state')).json();
  assert.ok(s.groups.some((g) => g.name === 'shop'));

  assert.equal((await call('POST', '/api/groups', { name: 'billing-worker' })).statusCode, 201);
  assert.equal((await call('POST', '/api/groups', { name: 'billing-worker' })).statusCode, 409);
  assert.equal((await call('POST', '/api/groups', { name: 'Bad Name' })).statusCode, 400);

  assert.equal((await call('POST', '/api/groups/billing-worker/vars', { key: 'STRIPE_KEY', values: { dev: 'sk_test_abcdefghijklmnop' } })).statusCode, 201);
  const view = (await call('GET', '/api/groups/billing-worker')).json();
  assert.ok(!JSON.stringify(view).includes('abcdefghijklmnop'), 'API view must not contain values');
  assert.equal(view.vars[0].masked.dev, 'sk_t••••••••');

  assert.equal((await call('PUT', '/api/groups/billing-worker/vars/STRIPE_KEY/access', { env: 'dev', level: 'write' })).statusCode, 200);
  assert.equal((await call('PUT', '/api/groups/billing-worker/vars/STRIPE_KEY/access', { env: 'dev', level: 'root' })).statusCode, 400);
  assert.equal((await call('POST', '/api/groups/billing-worker/vars/STRIPE_KEY/reveal', { env: 'dev' })).json().value, 'sk_test_abcdefghijklmnop');

  const dry = (await call('POST', '/api/groups/billing-worker/import', { env: 'dev', text: 'A_ONE=1234567\nSTRIPE_KEY=sk_test_abcdefghijklmnop\nnope', dryRun: true })).json();
  assert.deepEqual(dry.rows.map((r) => r.status).sort(), ['invalid', 'new', 'unchanged']);
  const imp = (await call('POST', '/api/groups/billing-worker/import', { env: 'dev', text: 'A_ONE=1234567', access: 'use' })).json();
  assert.equal(imp.written, 1);
  const exp = await call('GET', '/api/groups/billing-worker/export?env=dev');
  assert.match(exp.body, /A_ONE=1234567/);

  await call('PUT', '/api/groups/shop/envs/prod', { allow: false });
  assert.equal((await call('POST', '/api/agent/activate', { group: 'shop', env: 'prod' })).statusCode, 403);
  assert.equal((await call('POST', '/api/agent/activate', { group: 'shop', env: 'dev' })).statusCode, 200);
  assert.equal((await call('POST', '/api/kill', { on: true })).json().killed, true);
  assert.deepEqual((await call('GET', '/api/state')).json().active, {});

  const log = (await call('GET', '/api/audit')).json();
  assert.ok(log.some((r) => r.action === 'reveal'));
  assert.ok(!JSON.stringify(log).includes('sk_test_abcdefghijklmnop'), 'audit log never holds values');
  assert.ok(!JSON.stringify(log).includes(DEV_PW));
  await call('POST', '/api/kill', { on: false });
  await app.close();

  const guarded = await buildApp({ token: 'tok123', port: 7777 });
  assert.equal((await guarded.inject({ method: 'GET', url: '/api/health', headers: { host: 'evil.example:7777' } })).statusCode, 403, 'DNS rebinding host refused');
  assert.equal((await guarded.inject({ method: 'GET', url: '/api/health', headers: { host: '127.0.0.1:7777' } })).statusCode, 200);
  await guarded.close();
});

test('MCP server: tools return names only, honour gates and kill switch', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp'], env: { ...process.env } });
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(transport);
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ['activate_env', 'deactivate_env', 'list_envs', 'list_vars', 'run_with_secrets', 'set_var', 'status']);
    const call = async (name, args = {}) => {
      const r = await client.callTool({ name, arguments: args });
      return { isError: Boolean(r.isError), text: r.content.map((c) => c.text).join('\n') };
    };
    st.setKilled(false);
    st.deactivate('dev');
    const all = [];

    const envs = await call('list_envs', { group: 'shop' });
    all.push(envs.text);
    assert.match(envs.text, /"env": "prod"/);

    vault.setEnvSettings('shop', 'prod', { allow: false });
    const denied = await call('activate_env', { env: 'prod', group: 'shop' });
    all.push(denied.text);
    assert.equal(denied.isError, true);
    assert.match(denied.text, /not allowed|has not allowed/);

    const act = await call('activate_env', { env: 'dev', group: 'shop' });
    all.push(act.text);
    assert.equal(act.isError, false);
    assert.match(act.text, /PG_PASS__DEV/);
    assert.match(act.text, /GUIDANCE FOR \\"dev\\": FULL/);

    const vars = await call('list_vars', { env: 'dev', group: 'shop' });
    all.push(vars.text);
    assert.ok(!vars.text.includes('PG_HOST'), 'PG_HOST has no dev value, and prod access is none, so it is not listed for dev');

    vault.setAccess('shop', 'PG_PASS', 'dev', 'use');
    const write = await call('set_var', { key: 'PG_PASS', env: 'dev', value: 'agent-chosen-value', group: 'shop' });
    all.push(write.text);
    assert.equal(write.isError, true, 'use access is not enough to write');
    assert.equal(vault.reveal('shop', 'PG_PASS', 'dev'), DEV_PW, 'value unchanged');

    vault.setAccess('shop', 'PG_PASS', 'dev', 'write');
    const ok = await call('set_var', { key: 'PG_PASS', env: 'dev', value: 'rotated-by-agent-value', group: 'shop' });
    all.push(ok.text);
    assert.equal(ok.isError, false);
    assert.ok(!ok.text.includes('rotated-by-agent-value'), 'value is not echoed back');
    assert.equal(vault.reveal('shop', 'PG_PASS', 'dev'), 'rotated-by-agent-value');

    const run = await call('run_with_secrets', { command: 'echo "pw=$PG_PASS"; echo "pw2=$PG_PASS__DEV"' });
    all.push(run.text);
    assert.match(run.text, /pw=\[REDACTED:PG_PASS\]/);
    assert.match(run.text, /\[secretmgr env=dev:FULL\]/);

    st.setKilled(true);
    const killed = await call('activate_env', { env: 'dev', group: 'shop' });
    all.push(killed.text);
    assert.equal(killed.isError, true);
    const killedRun = await call('run_with_secrets', { command: 'echo "[${PG_PASS-unset}]"' });
    all.push(killedRun.text);
    assert.match(killedRun.text, /\[unset\]/);
    st.setKilled(false);

    for (const secret of [DEV_PW, PROD_PW, 'rotated-by-agent-value', 'prod-db.internal.example']) {
      assert.ok(!all.join('\n').includes(secret), `a secret value leaked through MCP output: ${secret}`);
    }
  } finally {
    await client.close();
  }
});

test('guidance: levels are returned, banner shows them, enforcement blocks by level only for that env\'s variables', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const hook = (command) => {
    const r = spawnSync(process.execPath, [CLI, 'hook', 'pretooluse'], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }), encoding: 'utf8', env: childEnv() });
    return JSON.parse(r.stdout).hookSpecificOutput;
  };
  vault.setEnvSettings('shop', 'prod', { allow: true, approval: false, guidance: 'read_only', enforce: true });
  vault.setAccess('shop', 'PG_PASS', 'prod', 'use');
  st.setKilled(false);
  st.deactivate('dev');
  st.deactivate('prod');
  st.activate('shop', 'dev', {});
  st.activate('shop', 'prod', {});

  const drop = hook('PGPASSWORD="$PG_PASS__PROD" psql -c "DROP TABLE orders"');
  assert.equal(drop.permissionDecision, 'deny');
  assert.match(drop.permissionDecisionReason, /READ-ONLY guidance for "prod"/);
  assert.match(drop.permissionDecisionReason, /ENFORCED/);
  assert.equal(hook('PGPASSWORD="$PG_PASS__PROD" psql -c "select count(*) from orders"').permissionDecision, undefined, 'reads on read-only are fine');
  assert.equal(hook('PGPASSWORD="$PG_PASS" psql -c "DROP TABLE scratch"').permissionDecision, undefined, 'plain names are dev (primary, FULL): not blocked');
  assert.equal(hook('psql -c "DROP TABLE scratch"').permissionDecision, undefined, 'commands that use no secret are not this feature\'s business');

  vault.setEnvSettings('shop', 'prod', { guidance: 'write' });
  assert.equal(hook('PGPASSWORD="$PG_PASS__PROD" psql -c "update t set a=1 where id=2"').permissionDecision, undefined, 'writes allowed at WRITE');
  assert.equal(hook('PGPASSWORD="$PG_PASS__PROD" psql -c "delete from t"').permissionDecision, 'deny', 'destructive blocked at WRITE');
  assert.equal(hook('kubectl delete pod x --token "$PG_PASS__PROD"').permissionDecision, 'deny');

  vault.setEnvSettings('shop', 'prod', { guidance: 'read_only', enforce: false });
  assert.equal(hook('PGPASSWORD="$PG_PASS__PROD" psql -c "DROP TABLE orders"').permissionDecision, undefined, 'guidance without enforcement only advises');
  const banner = spawnSync('bash', ['-c', wrapCommand('true', process.execPath, CLI)], { encoding: 'utf8', env: childEnv() });
  assert.match(banner.stdout, /\[secretmgr env=dev:FULL\*,prod:READ-ONLY\]/, 'every command output repeats the guidance level');

  assert.throws(() => vault.setEnvSettings('shop', 'prod', { guidance: 'yolo' }), /guidance must be one of/);
  st.deactivate('prod');
  vault.setEnvSettings('shop', 'prod', { allow: false, enforce: true });
  void Client;
});

test('dashboard static files and SPA fallback are served, API 404s stay JSON', async () => {
  const { ROOT } = await import('./helpers.js');
  const dist = path.join(ROOT, 'dashboard', 'dist');
  if (!fs.existsSync(path.join(dist, 'index.html'))) return; // dashboard not built in this checkout
  const app = await buildApp({ token: 'tok123', staticDir: dist });
  const home = await app.inject({ method: 'GET', url: '/' });
  assert.equal(home.statusCode, 200);
  assert.match(home.body, /<div id="root">/);
  const spa = await app.inject({ method: 'GET', url: '/some/client/route' });
  assert.equal(spa.statusCode, 200);
  assert.match(spa.body, /<div id="root">/);
  const nope = await app.inject({ method: 'GET', url: '/api/nope', headers: { authorization: 'Bearer tok123' } });
  assert.equal(nope.statusCode, 404);
  assert.ok(!/<html/i.test(nope.body));
  await app.close();
});

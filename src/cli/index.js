#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as vault from '../core/vault.js';
import * as st from '../core/state.js';
import { audit } from '../core/audit.js';
import { createRedactor } from '../core/redact.js';
import { resolveGroup } from '../core/policy.js';
import { keyBackendName, getMasterKey, preloadKey } from '../core/keystore.js';
import * as security from '../core/security.js';
import { isProtected, LockedError, checkStrength, requiresSetup } from '../core/lockbox.js';
import { file } from '../core/paths.js';
import { randomToken } from '../core/crypto.js';
import { terminalScript, agentScript, SHELLS } from '../shell/env.js';
import { initScript } from '../shell/init.js';
import { installShells, uninstallShells, installClaude, uninstallClaude } from '../shell/install.js';
import { execUserShell } from '../shell/runner.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const HELP = `secretmgr: keep secrets out of AI agent chats

Setup
  init [--yes]                 Create the vault, install shell hooks and the Claude Code integration
  install [--shell bash,zsh] [--claude]   (Re)install hooks      uninstall   Remove them
  dashboard [--port 7777] [--no-open]     Start the local dashboard

Daily use (inside a terminal that ran \`secretmgr install\`)
  secretmgr use <env> [group]  Load an environment into this shell      unload   Remove it
  shell --env <env> [--group g]            Open a subshell with an environment loaded
  list --env <env> [--group g]             Variable names and agent access
  set KEY --env <env> [--access use]       Set a value (read from stdin or a hidden prompt)
  reveal KEY --env <env>                   Print a value (interactive terminals only)
  import FILE --env <env> [--access use] [--dry-run] [--delete-source]
  export --env <env>                       Print a .env (interactive terminals only)
  group create <name> | group list
  kill [--off]                 Kill switch: cut all agent access (and clear terminals)
  status

Master password (the vault key is then wrapped by your password and is not stored anywhere)
  protect                      Set a master password (or use the dashboard: Security)
  unlock | lock                Unlock the vault for this login session | lock it now
  passwd                       Change the master password

Internal: env, shell-init, exec-env, redact, hook pretooluse, mcp, agent, unlock-ui
`;

const die = (msg, code = 1) => {
  process.stderr.write(`secretmgr: ${msg}\n`);
  process.exit(code);
};

/** Commands that print values must be run by a person at a terminal, not piped through an agent. */
function requireHuman(what) {
  if (!process.stdin.isTTY && process.env.SECRETMGR_ALLOW_NONTTY !== '1') die(`${what} needs an interactive terminal`, 3);
}

async function readSecretValue(prompt) {
  if (!process.stdin.isTTY) {
    let data = '';
    for await (const c of process.stdin) data += c;
    return data.replace(/\r?\n$/, '');
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  rl._writeToOutput = (s) => {
    if (s.includes(prompt)) process.stderr.write(s);
  };
  const v = await rl.question(prompt);
  rl.close();
  process.stderr.write('\n');
  return v;
}

/** Hidden prompts for passwords. Non-interactive input (one answer per line) is for tests only. */
let pipedLines = null;
async function readPasswords(prompts) {
  if (!process.stdin.isTTY) {
    if (process.env.SECRETMGR_ALLOW_NONTTY !== '1') die('passwords are only read from an interactive terminal', 3);
    if (!pipedLines) {
      let data = '';
      for await (const c of process.stdin) data += c;
      pipedLines = data.split(/\r?\n/);
    }
    return pipedLines.splice(0, prompts.length);
  }
  const out = [];
  for (const p of prompts) out.push(await readSecretValue(p));
  return out;
}

async function newPassword() {
  const [pw, again] = await readPasswords(['New master password: ', 'Repeat it: ']);
  if (pw !== again) die('the two passwords differ');
  const s = checkStrength(pw);
  if (!s.ok) die(s.reason);
  return pw;
}

async function confirm(question, yes) {
  if (yes) return true;
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const a = (await rl.question(`${question} [Y/n] `)).trim().toLowerCase();
  rl.close();
  return a === '' || a === 'y' || a === 'yes';
}

function flags(argv, options) {
  return parseArgs({ args: argv, options, allowPositionals: true, strict: false });
}

// Piping into `head` and friends closes stdout early; that is not an error.
process.stdout.on('error', (e) => {
  if (e.code === 'EPIPE') process.exit(0);
  throw e;
});

const [cmd, ...rest] = process.argv.slice(2);

async function main() {
  if (cmd && cmd !== 'agent' && cmd !== 'help') await preloadKey();
  switch (cmd) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return process.stdout.write(HELP);

    case 'init': {
      const { values } = flags(rest, { yes: { type: 'boolean', short: 'y' } });
      if (!vault.vaultExists()) {
        vault.createGroup('default');
        st.setDefaultGroup('default');
        process.stdout.write(`Vault created. Master key stored in: ${(getMasterKey(), keyBackendName())}\n`);
        if (keyBackendName() === 'file (0600)') process.stdout.write('  (No OS keychain found; key is in a 0600 file. Anyone who can read your home directory can read the vault.)\n');
      } else process.stdout.write('Vault already exists.\n');
      if (await confirm('Add secretmgr to your shell startup files (bash/zsh/fish/PowerShell)?', values.yes)) {
        for (const r of installShells()) process.stdout.write(`  shell hook: ${r.shell} -> ${r.file}\n`);
      } else process.stdout.write('Skipped shell hooks. Run `secretmgr install` later.\n');
      if (await confirm('Register the MCP server and the Bash protection hook with Claude Code?', values.yes)) {
        const r = installClaude();
        process.stdout.write(`  claude hook: ${r.settings}\n  claude mcp: ${r.mcp}\n`);
      } else process.stdout.write('Skipped Claude Code. Run `secretmgr install --claude` later.\n');
      if (isProtected()) {
        process.stdout.write('\nNext: `secretmgr dashboard`, then open a new terminal.\n');
        return;
      }
      process.stdout.write('\nA master password is required before agents can use any secret.\n');
      if (!process.stdin.isTTY) {
        process.stdout.write('Set it with `secretmgr protect`, or open `secretmgr dashboard`.\n');
        return;
      }
      process.stdout.write('Opening the dashboard so you can set it. Press Ctrl+C here when you are done.\n');
      return startDashboard({ open: true, screen: 'security' });
    }

    case 'install': {
      const { values } = flags(rest, { shell: { type: 'string' }, claude: { type: 'boolean' } });
      const only = values.shell ? values.shell.split(',') : undefined;
      if (!values.claude || values.shell) for (const r of installShells({ shells: only })) process.stdout.write(`shell hook: ${r.shell} -> ${r.file}\n`);
      if (values.claude || (!values.shell && !values.claude)) {
        const r = installClaude();
        process.stdout.write(`claude hook: ${r.settings}\nclaude mcp: ${r.mcp}\n`);
      }
      return;
    }

    case 'uninstall': {
      for (const r of uninstallShells()) process.stdout.write(`removed shell hook: ${r.shell} (${r.file})\n`);
      if (uninstallClaude()) process.stdout.write('removed Claude Code hook (run `claude mcp remove secretmgr` for the MCP entry)\n');
      process.stdout.write('Your vault is untouched.\n');
      return;
    }

    case 'dashboard': {
      const { values } = flags(rest, { port: { type: 'string' }, 'no-open': { type: 'boolean' } });
      return startDashboard({ port: values.port, open: !values['no-open'] });
    }

    case 'env': {
      const { values } = flags(rest, { shell: { type: 'string' }, env: { type: 'string' }, group: { type: 'string' }, unload: { type: 'boolean' } });
      requireHuman('`secretmgr env`');
      const shell = values.shell || 'bash';
      if (!SHELLS.includes(shell)) die(`unsupported shell: ${shell}`);
      if (!values.unload && !values.env) die('--env is required');
      try {
        const { script, note } = terminalScript(shell, { env: values.env, group: values.group, unload: values.unload });
        process.stdout.write(script);
        if (note) process.stderr.write(note + '\n');
      } catch (e) {
        // Fail closed: clear what we loaded earlier instead of leaving a stale environment.
        process.stdout.write(terminalScript(shell, { unload: true }).script);
        process.stderr.write(`secretmgr: ${e.message}\n`);
      }
      return;
    }

    case 'shell-init': {
      const shell = rest[0];
      if (!['bash', 'zsh', 'fish', 'pwsh'].includes(shell)) die('usage: secretmgr shell-init <bash|zsh|fish|pwsh>');
      return process.stdout.write(initScript(shell));
    }

    case 'exec-env':
      return process.stdout.write(agentScript({ locked: rest.includes('--locked') }));

    case 'redact': {
      if (rest.includes('--locked')) {
        // The wrapper loaded nothing because the vault was locked when the command started.
        process.stdin.pipe(process.stdout);
        return;
      }
      let redactor;
      try {
        redactor = createRedactor(vault.allSecrets());
      } catch (e) {
        // Fail closed: if we cannot know the secrets we must not pass output through unredacted.
        process.stdin.resume();
        process.stdout.write(`secretmgr: output withheld because the vault could not be opened (${e.message})\n`);
        return;
      }
      process.stdin.pipe(redactor.stream()).pipe(process.stdout);
      return;
    }

    case 'hook': {
      if (rest[0] !== 'pretooluse') die('usage: secretmgr hook pretooluse');
      const { runPreToolUseHook } = await import('../hooks/pretooluse.js');
      return runPreToolUseHook();
    }

    case 'mcp': {
      const { runMcp } = await import('../mcp/server.js');
      return runMcp();
    }

    case 'agent':
      return (await import('../core/keyagent.js')).runKeyAgent();

    case 'unlock-ui':
      return startDashboard({ open: true, idleExitMin: 5, exitWhenUnlocked: true, mode: 'unlock' });

    case 'protect': {
      if (isProtected()) die('the vault already has a master password. Use `secretmgr passwd` to change it');
      if (!vault.vaultExists()) die('no vault yet. Run `secretmgr init` first');
      process.stderr.write('Choose a long, random password. There is NO recovery: if you forget it, the vault cannot be opened.\n');
      await security.enableProtection(await newPassword());
      return process.stdout.write('Master password set. The key was removed from the keychain; the vault is unlocked for this login session.\n');
    }

    case 'unlock': {
      if (!isProtected()) return process.stdout.write('The vault has no master password; nothing to unlock.\n');
      const [pw] = await readPasswords(['Master password: ']);
      await security.unlock(pw);
      return process.stdout.write('Unlocked.\n');
    }

    case 'lock': {
      if (!isProtected()) die('the vault has no master password. Set one with `secretmgr protect`');
      await security.lock();
      return process.stdout.write('Locked. Agent activations ended; terminals clear their variables on the next prompt.\n');
    }

    case 'passwd': {
      if (!isProtected()) die('the vault has no master password. Set one with `secretmgr protect`');
      const [current] = await readPasswords(['Current master password: ']);
      await security.changePassword(current, await newPassword());
      return process.stdout.write('Master password changed.\n');
    }

    case 'kill': {
      const { values } = flags(rest, { off: { type: 'boolean' } });
      if (values.off) requireHuman('turning the kill switch off');
      st.setKilled(!values.off, 'you');
      return process.stdout.write(values.off ? 'Kill switch OFF. Agent access restored to your saved policies.\n' : 'Kill switch ON. All agent access is cut; terminals clear on their next prompt.\n');
    }

    case 'status': {
      const s = st.getState();
      process.stdout.write(`kill switch: ${s.killed ? 'ON' : 'off'}\n`);
      if (isProtected()) {
        const sec = await security.securityStatus();
        process.stdout.write(`vault: protected by master password, ${sec.unlocked ? `unlocked (${sec.idleMin ? `auto-locks after ${sec.idleMin} min idle` : 'no auto-lock'})` : 'LOCKED'}\n`);
        if (sec.leftoverKey) process.stdout.write('WARNING: a plain copy of the key is still stored. Run `secretmgr unlock` to remove it.\n');
      } else process.stdout.write(`key storage: ${vault.vaultExists() ? (getMasterKey(), keyBackendName()) : 'no vault yet'}  (no master password; run \`secretmgr protect\`)\n`);
      process.stdout.write(`groups: ${vault.vaultExists() && !(isProtected() && !(await security.securityStatus()).unlocked) ? vault.listGroups().map((g) => `${g.name}(${g.variableCount})`).join(', ') || '-' : '-'}\n`);
      process.stdout.write(`agent active: ${Object.entries(s.active).map(([e, a]) => `${e}${a.primary ? '*' : ''}`).join(', ') || 'none'}\n`);
      return;
    }

    case 'group': {
      if (rest[0] === 'create' && rest[1]) {
        const r = vault.createGroup(rest[1]);
        if (!st.getState().defaultGroup) st.setDefaultGroup(r.name);
        return process.stdout.write(`created group ${r.name} (${r.envs.join(', ')})\n`);
      }
      if (rest[0] === 'list') return process.stdout.write(vault.listGroups().map((g) => `${g.name}\t${g.envs.join(',')}\t${g.variableCount} vars`).join('\n') + '\n');
      return die('usage: secretmgr group create <name> | group list');
    }

    case 'list': {
      const { values } = flags(rest, { env: { type: 'string' }, group: { type: 'string' } });
      const g = resolveGroup(values.group);
      const view = vault.viewGroup(g);
      const env = values.env;
      for (const v of view.vars) process.stdout.write(`${v.key}\t${env ? `${v.access[env]}\t${v.masked[env] ?? '(not set)'}` : JSON.stringify(v.access)}\n`);
      return;
    }

    case 'set': {
      const { values, positionals } = flags(rest, { env: { type: 'string' }, group: { type: 'string' }, access: { type: 'string' } });
      const key = positionals[0];
      if (!key || !values.env) die('usage: secretmgr set KEY --env <env> [--group g] [--access none|use|write]   (value from stdin or prompt)');
      const g = resolveGroup(values.group);
      const value = await readSecretValue(`Value for ${key} (${values.env}): `);
      vault.setVar(g, key, { values: { [values.env]: value }, access: values.access ? { [values.env]: values.access } : {} });
      audit({ actor: 'you', action: 'set_var', group: g, env: values.env, key, result: 'cli' });
      return process.stdout.write(`saved ${key} in ${g}/${values.env}\n`);
    }

    case 'reveal': {
      requireHuman('`secretmgr reveal`');
      const { values, positionals } = flags(rest, { env: { type: 'string' }, group: { type: 'string' } });
      if (!positionals[0] || !values.env) die('usage: secretmgr reveal KEY --env <env>');
      const g = resolveGroup(values.group);
      const v = vault.reveal(g, positionals[0], values.env);
      audit({ actor: 'you', action: 'reveal', group: g, env: values.env, key: positionals[0], result: 'cli' });
      return process.stdout.write(v + '\n');
    }

    case 'import': {
      const { values, positionals } = flags(rest, { env: { type: 'string' }, group: { type: 'string' }, access: { type: 'string' }, 'dry-run': { type: 'boolean' }, 'delete-source': { type: 'boolean' } });
      if (!positionals[0] || !values.env) die('usage: secretmgr import FILE --env <env> [--group g] [--access use] [--dry-run] [--delete-source]');
      const g = resolveGroup(values.group);
      const text = fs.readFileSync(positionals[0], 'utf8');
      const r = vault.importEnv(g, values.env, text, { access: values.access || 'use', dryRun: values['dry-run'] });
      for (const row of r.rows) process.stdout.write(`line ${row.line}\t${row.status}\t${row.key ?? row.reason}\n`);
      if (values['dry-run']) return process.stdout.write('dry run: nothing written\n');
      audit({ actor: 'you', action: 'import_env', group: g, env: values.env, result: `${r.written} written` });
      process.stdout.write(`imported ${r.written} variables into ${g}/${values.env}\n`);
      if (values['delete-source'] && (await confirm(`Overwrite and delete ${positionals[0]}?`, false))) {
        const size = fs.statSync(positionals[0]).size;
        fs.writeFileSync(positionals[0], Buffer.alloc(size, 0));
        fs.unlinkSync(positionals[0]);
        process.stdout.write('source file overwritten with zeros and deleted (note: not guaranteed on SSDs or journaled filesystems)\n');
      }
      return;
    }

    case 'export': {
      requireHuman('`secretmgr export`');
      const { values } = flags(rest, { env: { type: 'string' }, group: { type: 'string' } });
      if (!values.env) die('usage: secretmgr export --env <env> [--group g]');
      const g = resolveGroup(values.group);
      audit({ actor: 'you', action: 'export_env', group: g, env: values.env, result: 'cli' });
      return process.stdout.write(vault.exportEnv(g, values.env));
    }

    case 'shell': {
      const { values } = flags(rest, { env: { type: 'string' }, group: { type: 'string' } });
      if (!values.env) die('usage: secretmgr shell --env <env> [--group g]');
      return execUserShell({ env: values.env, group: values.group });
    }

    case 'use':
    case 'load':
    case 'unload':
      return die(`\`secretmgr ${cmd}\` is a shell function. Run \`secretmgr install\`, then open a new terminal. (One-off alternative: secretmgr shell --env <env>)`);

    default:
      process.stderr.write(`unknown command: ${cmd}\n\n${HELP}`);
      process.exit(2);
  }
}

/** Start the local dashboard server (the process stays alive while it listens). */
async function startDashboard({ port: wanted, open, screen, idleExitMin, exitWhenUnlocked, mode } = {}) {
  const { buildApp } = await import('../server/api.js');
  let port = Number(wanted || process.env.SECRETMGR_PORT || 7777);
  const token = randomToken();
  let lastActivity = Date.now();
  for (let tries = 0; ; tries++) {
    const app = await buildApp({ token, port, staticDir: path.resolve(HERE, '../../dashboard/dist'), onActivity: () => (lastActivity = Date.now()) });
    try {
      await app.listen({ host: '127.0.0.1', port });
      if (idleExitMin) {
        // Short-lived window opened for an agent: an open tab polls every few seconds, a closed one lets it expire.
        setInterval(() => {
          if (Date.now() - lastActivity > idleExitMin * 60_000) app.close().finally(() => process.exit(0));
        }, 15_000);
      }
      if (exitWhenUnlocked) {
        // The window exists to unlock or set up the vault. Once it has seen the vault blocked and then ready,
        // give the page a moment to say "all set" and exit.
        let armed = false;
        let exiting = false;
        setInterval(async () => {
          const blocked = requiresSetup() || !(await security.securityStatus()).unlocked;
          if (blocked) armed = true;
          else if (armed && !exiting) {
            exiting = true;
            setTimeout(() => app.close().finally(() => process.exit(0)), 3000);
          }
        }, 1000);
      }
      const url = `http://127.0.0.1:${port}/#token=${token}${screen ? `&screen=${screen}` : ''}${mode ? `&mode=${mode}` : ''}`;
      process.stdout.write(`secretmgr dashboard running (local only). Open:\n  ${url}\nCtrl+C to stop.\n`);
      if (open) {
        const opener = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
        spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
      }
      return;
    } catch (e) {
      await app.close();
      if (e.code === 'EADDRINUSE' && tries < 10) port++;
      else throw e;
    }
  }
}

main().catch((e) => die(e instanceof LockedError ? `${e.message}` : e.message));

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
import { keyBackendName, getMasterKey } from '../core/keystore.js';
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

Internal: env, shell-init, exec-env, redact, hook pretooluse, mcp
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
      process.stdout.write('\nNext: `secretmgr dashboard`, then open a new terminal.\n');
      return;
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
      const { buildApp } = await import('../server/api.js');
      let port = Number(values.port || process.env.SECRETMGR_PORT || 7777);
      const token = randomToken();
      for (let tries = 0; ; tries++) {
        const app = await buildApp({ token, port, staticDir: path.resolve(HERE, '../../dashboard/dist') });
        try {
          await app.listen({ host: '127.0.0.1', port });
          const url = `http://127.0.0.1:${port}/#token=${token}`;
          process.stdout.write(`secretmgr dashboard running (local only). Open:\n  ${url}\nCtrl+C to stop.\n`);
          if (!values['no-open']) {
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
      return process.stdout.write(agentScript());

    case 'redact': {
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

    case 'kill': {
      const { values } = flags(rest, { off: { type: 'boolean' } });
      if (values.off) requireHuman('turning the kill switch off');
      st.setKilled(!values.off, 'you');
      return process.stdout.write(values.off ? 'Kill switch OFF. Agent access restored to your saved policies.\n' : 'Kill switch ON. All agent access is cut; terminals clear on their next prompt.\n');
    }

    case 'status': {
      const s = st.getState();
      process.stdout.write(`kill switch: ${s.killed ? 'ON' : 'off'}\n`);
      process.stdout.write(`key storage: ${vault.vaultExists() ? (getMasterKey(), keyBackendName()) : 'no vault yet'}\n`);
      process.stdout.write(`groups: ${vault.vaultExists() ? vault.listGroups().map((g) => `${g.name}(${g.variableCount})`).join(', ') || '-' : '-'}\n`);
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

main().catch((e) => die(e.message));

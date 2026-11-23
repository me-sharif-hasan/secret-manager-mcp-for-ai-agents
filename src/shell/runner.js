import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import * as vault from '../core/vault.js';
import { createRedactor } from '../core/redact.js';
import { agentEnvironment, managedNames, resolveGroup, checkGuidance } from '../core/policy.js';
import { getState } from '../core/state.js';
import { audit } from '../core/audit.js';

const MAX_CAPTURE = 200_000;

/**
 * Run a command with the agent environment injected into the CHILD process only and
 * redacted output captured. Used by the MCP `run_with_secrets` tool for agent CLIs that
 * have no Bash hook. Returns { code, output, redactions }.
 */
export function runScoped(command, { cwd, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const agentEnv = agentEnvironment();
    const blocked = checkGuidance(command, agentEnv.envs);
    if (blocked) {
      audit({ actor: 'agent', action: 'run_with_secrets', result: 'blocked by environment guidance' });
      return resolve({ code: 126, output: `secretmgr: ${blocked}`, redactions: 0, envs: agentEnv.envs, killed: false });
    }
    const env = { ...process.env };
    for (const k of managedNames()) delete env[k];
    Object.assign(env, agentEnv.vars);
    const redactor = createRedactor(vault.allSecrets());
    let output = '';
    let truncated = false;
    const sink = (chunk) => {
      if (output.length < MAX_CAPTURE) output += chunk.toString();
      else truncated = true;
    };
    const child = spawn('bash', ['-c', command], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = child.stdout.pipe(redactor.stream());
    const err = child.stderr.pipe(redactor.stream());
    out.on('data', sink);
    err.on('data', sink);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    let pending = 3;
    let exit = 1;
    const done = () => {
      if (--pending) return;
      clearTimeout(timer);
      audit({
        actor: 'agent',
        action: 'run_with_secrets',
        env: agentEnv.envs.map((e) => e.env).join(',') || '-',
        result: agentEnv.killed ? 'kill switch on, nothing loaded' : `exit ${exit}`,
        detail: redactor.redactString(command.slice(0, 160)),
        redactions: redactor.stats.count,
      });
      resolve({ code: exit, output: (output + (truncated ? '\n[output truncated]' : '')).trim(), redactions: redactor.stats.count, envs: agentEnv.envs, killed: agentEnv.killed });
    };
    child.on('close', (code, sig) => {
      exit = code ?? (sig ? 128 : 1);
      done();
    });
    out.on('end', done);
    err.on('end', done);
  });
}

/** Replace this process with the user's shell, with one environment loaded (for `secretmgr shell`). */
export function execUserShell({ env, group }) {
  const g = resolveGroup(group);
  const vars = vault.resolve(g, env, { agent: false });
  const state = getState();
  if (state.killed) throw new Error('The kill switch is on. Restore access in the dashboard first.');
  const shell = process.env.SHELL || (process.platform === 'win32' ? process.env.COMSPEC || 'cmd.exe' : '/bin/bash');
  const childEnv = { ...process.env, ...vars, SECRETMGR_ENV: env, SECRETMGR_GROUP: g, __SECRETMGR_KEYS: Object.keys(vars).join(' ') };
  const args = [];
  let cleanup = null;
  if (/bash$/.test(shell)) {
    const rc = `${os.tmpdir()}/secretmgr-rc-${process.pid}`;
    fs.writeFileSync(rc, `[ -r ~/.bashrc ] && . ~/.bashrc\nPS1="(secretmgr:${env}) $PS1"\n`, { mode: 0o600 });
    args.push('--rcfile', rc);
    cleanup = () => fs.rmSync(rc, { force: true });
  }
  audit({ actor: 'you', action: 'open_shell', group: g, env, result: 'ok' });
  const r = spawnSync(shell, args, { stdio: 'inherit', env: childEnv });
  cleanup?.();
  process.exit(r.status ?? 0);
}

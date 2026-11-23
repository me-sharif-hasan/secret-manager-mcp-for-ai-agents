import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as vault from '../core/vault.js';
import * as st from '../core/state.js';
import { agentActivate, resolveGroup, envSuffix } from '../core/policy.js';
import { guidanceText, LEVEL_LABEL } from '../core/guidance.js';
import { audit } from '../core/audit.js';
import { runScoped } from '../shell/runner.js';
import { withKey } from '../core/keystore.js';
import { LockedError, requiresSetup, isProtected } from '../core/lockbox.js';
import { lock as lockVault, securityStatus } from '../core/security.js';
import { openUnlockUi } from '../core/unlockui.js';

const INSTRUCTIONS = `This server manages secrets WITHOUT ever returning their values.
Workflow: call list_envs, then activate_env("dev") (or another allowed environment). Afterwards, every Bash command you run can reference secrets as ordinary shell variables, for example:
  PGPASSWORD="$PG_PASS" psql -h "$PG_HOST" -U app -d app -c "select 1"
The primary environment provides plain names ($PG_PASS). Every active environment also provides suffixed names ($PG_PASS__DEV, $PG_PASS__PROD), which is how you use two environments at once.
Never print, echo, or write a secret variable anywhere. Output is redacted, but do not rely on that. If a variable you need is missing, it may be hidden from agents: ask the user rather than searching for it.
activate_env returns the owner's GUIDANCE for that environment (read-only, write or full). Follow it strictly. Every command banner repeats it, and the owner may enforce it by blocking commands. If in doubt about whether an action is allowed, ask the user.
If activate_env is denied, tell the user which environment you need and why; they can enable it in the dashboard.
When the user asks you to lock up, or says you are finished with secrets, call close_vault. It locks the vault again, ends all activations and makes the owner's terminals clear their variables; the owner must unlock it to continue. Do not call it on your own initiative.
Use run_with_secrets only when Bash is unavailable or not protected by the secretmgr hook.`;

const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const fail = (msg) => ({ isError: true, content: [{ type: 'text', text: msg }] });

const LOCKED_TEXT = 'The vault is locked, so no secret is available.';
const SETUP_TEXT = 'The owner has not set a master password yet, and agents cannot use any secret until they do.';
const WANTS_SECRETS = new Set(['activate_env', 'run_with_secrets', 'set_var']);

/** Post the request for the dashboard and, for tools that want secrets, open the owner's browser (rate-limited). */
function blockedReply(tool, base) {
  st.requestUnlock();
  const opened = WANTS_SECRETS.has(tool) ? openUnlockUi() : 'disabled';
  const next =
    opened === 'opened'
      ? 'A browser window was opened for the owner. Wait for them to finish there, then retry. If no window appeared, ask them to run `secretmgr dashboard`.'
      : opened === 'recent'
        ? 'A browser window was opened a moment ago and is waiting for the owner. Ask them to finish there (or run `secretmgr dashboard`), then retry.'
        : 'Ask the owner to run `secretmgr dashboard` (or `secretmgr unlock`), then retry.';
  return fail(`${base} ${next} Never ask for or suggest a password.`);
}

export function createServer() {
  const server = new McpServer({ name: 'secretmgr', version: '0.1.0' }, { instructions: INSTRUCTIONS });

  // Every tool runs with the vault key only for the duration of the call; a locked vault answers politely.
  const register = server.registerTool.bind(server);
  server.registerTool = (name, config, handler) =>
    register(name, config, async (...args) => {
      if (requiresSetup()) {
        audit({ actor: 'agent', action: name, result: 'denied: master password not set' });
        return blockedReply(name, SETUP_TEXT);
      }
      try {
        return await withKey(() => handler(...args));
      } catch (e) {
        if (!(e instanceof LockedError)) throw e;
        audit({ actor: 'agent', action: name, result: 'denied: vault locked' });
        return blockedReply(name, LOCKED_TEXT);
      }
    });

  // Locking only ever reduces access, so it needs no approval and must work even when already locked.
  // It is registered directly (not through the key-bracketing wrapper above).
  register(
    'close_vault',
    {
      description:
        'Lock the vault again: ends every activation, drops the key from memory, and makes the owner\'s terminals clear their variables on the next prompt. Use it when the owner asks you to lock up or says you are finished. The owner must unlock to continue.',
    },
    async () => {
      if (!isProtected()) return fail('No master password is set, so there is nothing to lock.');
      if (!(await securityStatus()).unlocked) return text({ locked: true, note: 'The vault was already locked.' });
      await lockVault('agent');
      return text({ locked: true, note: 'The vault is locked and all activations have ended. The owner must unlock it before you can use secrets again.' });
    },
  );

  server.registerTool(
    'status',
    { description: 'Show whether the kill switch is on and which environments are currently active for the agent. Names only.' },
    async () => {
      const s = st.getState();
      return text({
        killSwitch: s.killed,
        active: Object.entries(s.active).map(([env, a]) => {
          const cfg = vault.viewGroup(a.group).envs[env];
          return { env, group: a.group, primary: a.primary, expiresAt: a.expiresAt ? new Date(a.expiresAt).toISOString() : null, guidance: cfg?.guidance, guidanceText: cfg ? guidanceText(env, cfg.guidance, cfg.enforce) : undefined };
        }),
      });
    },
  );

  server.registerTool(
    'list_envs',
    {
      description: 'List environments of a group, whether you may activate each one, and which are active now.',
      inputSchema: { group: z.string().optional().describe('Group name. Defaults to the owner\'s selected group.') },
    },
    async ({ group }) => {
      try {
        const g = resolveGroup(group);
        const view = vault.viewGroup(g);
        const s = st.getState();
        return text({
          group: g,
          killSwitch: s.killed,
          environments: Object.entries(view.envs).map(([env, e]) => ({
            env,
            mayActivate: e.allow && !s.killed,
            needsOwnerApproval: e.allow && e.approval,
            autoExpiresAfterMin: e.expiryMin,
            guidance: e.guidance,
            enforced: e.enforce,
            active: Boolean(s.active[env]),
            primary: Boolean(s.active[env]?.primary),
          })),
        });
      } catch (e) {
        if (e instanceof LockedError) throw e;
        return fail(e.message);
      }
    },
  );

  server.registerTool(
    'activate_env',
    {
      description:
        'Make an environment\'s variables available to your Bash commands. Returns variable NAMES only. Several environments can be active at once; they get suffixed names (KEY__ENV), and the primary one also gets plain names. May wait up to 90 seconds if the owner must approve.',
      inputSchema: {
        env: z.string().describe('Environment name, for example dev, uat or prod'),
        group: z.string().optional(),
        primary: z.boolean().optional().describe('Make this the primary environment (plain variable names)'),
      },
    },
    async ({ env, group, primary }) => {
      try {
        const r = await agentActivate({ env, group, primary });
        return r.ok ? text(r) : fail(r.reason);
      } catch (e) {
        if (e instanceof LockedError) throw e;
        return fail(e.message);
      }
    },
  );

  server.registerTool(
    'deactivate_env',
    { description: 'Stop making an environment\'s variables available.', inputSchema: { env: z.string() } },
    async ({ env }) => text({ deactivated: st.deactivate(env, 'agent') }),
  );

  server.registerTool(
    'list_vars',
    {
      description: 'List variable names you may use in an environment, with your access level (use or write). Variables hidden from agents are not listed. Never returns values.',
      inputSchema: { env: z.string(), group: z.string().optional() },
    },
    async ({ env, group }) => {
      try {
        const g = resolveGroup(group);
        return text(vault.agentVisible(g, env).map((v) => ({ name: v.key, suffixedName: `${v.key}__${envSuffix(env)}`, access: v.access })));
      } catch (e) {
        if (e instanceof LockedError) throw e;
        return fail(e.message);
      }
    },
  );

  server.registerTool(
    'set_var',
    {
      description: 'Create or update a variable value in an environment. Allowed only where the owner granted "write" access (or the environment default is write). The value you pass is stored encrypted and not echoed back.',
      inputSchema: { key: z.string(), env: z.string(), value: z.string(), group: z.string().optional() },
    },
    async ({ key, env, value, group }) => {
      try {
        const s = st.getState();
        if (s.killed) return fail('The kill switch is on.');
        const g = resolveGroup(group);
        const view = vault.viewGroup(g);
        if (!view.envs[env]) return fail(`Environment "${env}" does not exist.`);
        const existing = view.vars.find((v) => v.key === key);
        const level = existing ? existing.access[env] : view.envs[env].defaultAccess;
        if (level !== 'write') {
          audit({ actor: 'agent', action: 'set_var', group: g, env, key, result: 'denied: needs write access' });
          return fail(`You do not have write access to ${key} in ${env}. Ask the owner to grant it in the dashboard.`);
        }
        vault.setVar(g, key, { values: { [env]: value }, access: existing ? {} : { [env]: 'write' } });
        audit({ actor: 'agent', action: 'set_var', group: g, env, key, result: 'ok' });
        return text({ ok: true, key, env });
      } catch (e) {
        if (e instanceof LockedError) throw e;
        return fail(e.message);
      }
    },
  );

  server.registerTool(
    'run_with_secrets',
    {
      description:
        'Fallback for agents without the Bash hook: run a shell command with the currently active environments injected into that process only. Output is redacted. Activate an environment first.',
      inputSchema: { command: z.string(), cwd: z.string().optional() },
    },
    async ({ command, cwd }) => {
      const r = await runScoped(command, { cwd });
      const banner = r.killed ? '[kill switch is on: no secrets loaded]' : r.envs.length ? `[secretmgr env=${r.envs.map((e) => `${e.env}:${LEVEL_LABEL[e.guidance]}${e.primary && r.envs.length > 1 ? '*' : ''}`).join(',')}]` : '[no environment active]';
      return { isError: r.code !== 0, content: [{ type: 'text', text: `${banner}\nexit ${r.code}\n${r.output}` }] };
    },
  );

  return server;
}

export async function runMcp() {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

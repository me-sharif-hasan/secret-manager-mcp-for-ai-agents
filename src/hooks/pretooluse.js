import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { analyzeCommand, wrapCommand } from './guard.js';
import { managedNames, agentEnvironment, checkGuidance } from '../core/policy.js';
import { getState } from '../core/state.js';
import { audit } from '../core/audit.js';
import { file } from '../core/paths.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../cli/index.js');

function reply(obj) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...obj } }));
}

function config() {
  try {
    return JSON.parse(fs.readFileSync(file('config.json'), 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Claude Code PreToolUse hook for the Bash tool. Reads the event JSON on stdin.
 * Fails closed: any error denies the command instead of letting it run unprotected.
 */
export async function runPreToolUseHook() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  try {
    const event = JSON.parse(raw || '{}');
    if (event.tool_name !== 'Bash') return;
    const command = event.tool_input?.command;
    if (typeof command !== 'string' || !command.trim()) return;

    const state = getState();
    const names = managedNames();
    const why = analyzeCommand(command, names);
    if (why) {
      audit({ actor: 'agent', action: 'bash', result: `blocked: ${why}` });
      return reply({ permissionDecision: 'deny', permissionDecisionReason: `secretmgr blocked this command: ${why}.` });
    }
    if (state.killed && [...names].some((n) => new RegExp(`\\$\\{?${n}\\b`).test(command))) {
      audit({ actor: 'agent', action: 'bash', result: 'blocked: kill switch' });
      return reply({ permissionDecision: 'deny', permissionDecisionReason: 'secretmgr: the kill switch is on, so secret variables are unavailable.' });
    }

    const blocked = checkGuidance(command, agentEnvironment().envs);
    if (blocked) {
      audit({ actor: 'agent', action: 'bash', result: 'blocked by environment guidance' });
      return reply({ permissionDecision: 'deny', permissionDecisionReason: `secretmgr: ${blocked}` });
    }

    const out = {
      updatedInput: { ...event.tool_input, command: wrapCommand(command, process.execPath, CLI) },
      permissionDecisionReason: 'secretmgr: scoped secret load and output redaction',
    };
    // Default: leave the user's normal permission flow in charge. Opt in to auto-approve via config.json.
    if (config().hookAutoApprove === true) out.permissionDecision = 'allow';
    reply(out);
  } catch (e) {
    reply({ permissionDecision: 'deny', permissionDecisionReason: `secretmgr hook error (failing closed): ${e.message}` });
  }
}

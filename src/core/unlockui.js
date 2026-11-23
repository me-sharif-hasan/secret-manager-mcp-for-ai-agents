import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { file } from './paths.js';

/**
 * When an agent asks for a secret while the vault is locked (or has no master password yet), open the
 * dashboard in the owner's browser so they can unlock or set it up. The window is a short-lived dashboard
 * process (`secretmgr unlock-ui`) with its own fresh token that exits after 5 idle minutes.
 * It is rate-limited so a looping or prompt-injected agent cannot spam windows, and it can be turned off
 * with {"autoOpenUnlock": false} in config.json. The agent only learns that a window was opened.
 */

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../cli/index.js');
const MIN_GAP_MS = 2 * 60_000;

function config() {
  try {
    return JSON.parse(fs.readFileSync(file('config.json'), 'utf8'));
  } catch {
    return {};
  }
}

function defaultLauncher() {
  spawn(process.execPath, [CLI, 'unlock-ui'], { detached: true, stdio: 'ignore', env: process.env }).on('error', () => {}).unref();
}

let launcher = defaultLauncher;
/** Tests swap the launcher so no browser or server is ever started. */
export function setLauncherForTests(fn) {
  launcher = fn || defaultLauncher;
}

/** Returns 'opened', 'recent' (one was opened under 2 minutes ago) or 'disabled'. */
export function openUnlockUi() {
  if (config().autoOpenUnlock === false || process.env.SECRETMGR_NO_AUTO_OPEN === '1') return 'disabled';
  const f = file('unlock-ui.json');
  try {
    if (Date.now() - JSON.parse(fs.readFileSync(f, 'utf8')).at < MIN_GAP_MS) return 'recent';
  } catch {
    /* none yet */
  }
  fs.writeFileSync(f, JSON.stringify({ at: Date.now() }), { mode: 0o600 });
  try {
    launcher();
  } catch {
    return 'disabled';
  }
  return 'opened';
}

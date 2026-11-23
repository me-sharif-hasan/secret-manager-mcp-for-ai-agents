import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CLI = path.join(ROOT, 'src/cli/index.js');

/** Isolated data dir and HOME so tests never touch the real ~/.secretmgr, ~/.bashrc or ~/.claude. */
export function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secretmgr-test-'));
  process.env.SECRETMGR_HOME = path.join(dir, 'data');
  process.env.HOME = path.join(dir, 'home');
  process.env.SECRETMGR_KEY_BACKEND = 'file';
  process.env.SECRETMGR_ALLOW_UNPROTECTED = '1'; // test suite only; real installs require a master password
  fs.mkdirSync(process.env.HOME, { recursive: true });
  return dir;
}

export const childEnv = (extra = {}) => ({ ...process.env, SECRETMGR_ALLOW_NONTTY: '1', ...extra });

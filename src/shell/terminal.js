import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../cli/index.js');
const has = (cmd) => spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8' }).status === 0;

/**
 * Open the system's terminal running `secretmgr shell --env <env>`.
 * Secrets are fetched inside the new terminal by the CLI; they never appear in this command line.
 * Only the Linux path is exercised by tests; macOS and Windows are best effort.
 */
export function openTerminal({ env, group }) {
  const inner = [process.execPath, CLI, 'shell', '--env', env, ...(group ? ['--group', group] : [])];
  let cmd;
  let args;
  if (process.platform === 'darwin') {
    const line = inner.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
    cmd = 'osascript';
    args = ['-e', `tell application "Terminal" to do script ${JSON.stringify(line)}`, '-e', 'tell application "Terminal" to activate'];
  } else if (process.platform === 'win32') {
    cmd = 'cmd.exe';
    args = ['/c', 'start', '', ...(has('wt') ? ['wt'] : []), ...inner];
  } else {
    const candidates = [
      ['x-terminal-emulator', ['-e']],
      ['gnome-terminal', ['--']],
      ['konsole', ['-e']],
      ['xfce4-terminal', ['-x']],
      ['alacritty', ['-e']],
      ['kitty', []],
      ['xterm', ['-e']],
    ];
    const pick = candidates.find(([c]) => has(c));
    if (!pick) throw new Error('No terminal emulator found. Run `secretmgr shell --env ' + env + '` in a terminal yourself.');
    cmd = pick[0];
    args = [...pick[1], ...inner];
  }
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.unref();
  return { terminal: cmd };
}

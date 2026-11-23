import { useEffect, useState } from 'react';
import { Box, Button, Card, CardContent, Chip, IconButton, MenuItem, Paper, Select, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import BoltIcon from '@mui/icons-material/Bolt';
import ShieldIcon from '@mui/icons-material/Shield';
import CheckIcon from '@mui/icons-material/Check';
import { useApp } from '../ctx.jsx';
import { api } from '../api.js';
import { mono } from '../theme.js';

const SHELLS = ['bash', 'zsh', 'fish', 'pwsh', 'cmd'];
const RC = { bash: '~/.bashrc', zsh: '~/.zshrc', fish: '~/.config/fish/config.fish', pwsh: '$PROFILE', cmd: 'registry AutoRun' };

export default function ShellSync() {
  const { data, group, state, refresh, notify, guard } = useApp();
  const [shell, setShell] = useState('bash');
  const [snippet, setSnippet] = useState('');
  const envs = Object.keys(data.envs);
  const active = state?.active || {};

  useEffect(() => {
    api(`/shell/snippet?shell=${shell}`).then((r) => setSnippet(r.line)).catch(guard);
  }, [shell, guard]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      notify('Copied');
    } catch {
      notify('Select the text and copy it');
    }
  };

  const toggle = async (e) => {
    try {
      if (active[e]) await api('/agent/deactivate', { method: 'POST', body: { env: e } });
      else await api('/agent/activate', { method: 'POST', body: { group, env: e } });
      notify(active[e] ? `deactivate_env("${e}")` : `activate_env("${e}")`);
      refresh();
    } catch (err) {
      notify(err.message);
    }
  };

  const names = [];
  Object.entries(active).forEach(([e, a]) => {
    if (a.group !== group) return;
    data.vars.forEach((v) => {
      if (v.masked[e] && (v.access[e] ?? 'none') !== 'none') names.push(`${v.key}__${e.toUpperCase().replace(/[^A-Z0-9]/g, '_')}` + (a.primary ? ` · $${v.key}` : ''));
    });
  });
  const activeEnvs = Object.keys(active);

  return (
    <Box sx={{ display: 'grid', gap: 2 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
        <Chip color="success" icon={<CheckIcon />} label="Hooks check the version file on every prompt" />
        <Button variant="contained" startIcon={<BoltIcon />} onClick={() => api('/shell/install', { method: 'POST', body: {} }).then((r) => notify(`Installed for ${r.installed.map((x) => x.shell).join(', ') || 'no shells found'}`)).catch((e) => notify(e.message))}>
          Install automatically
        </Button>
      </Box>

      <ToggleButtonGroup exclusive size="small" value={shell} onChange={(_, v) => v && setShell(v)} sx={{ alignSelf: 'start', '& .MuiToggleButton-root': { borderRadius: 5, px: 2, textTransform: 'none' } }}>
        {SHELLS.map((s) => (
          <ToggleButton key={s} value={s}>
            {s}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>

      <Card>
        <CardContent sx={{ display: 'grid', gap: 1 }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Typography variant="h6">Manual setup for {RC[shell]}</Typography>
            <IconButton aria-label="Copy" onClick={copy}>
              <ContentCopyIcon />
            </IconButton>
          </Box>
          <Box component="pre" sx={{ ...mono, m: 0, p: 1.5, borderRadius: 3, bgcolor: 'action.hover', overflowX: 'auto' }}>
            {snippet}
          </Box>
          <Typography variant="body2" color="text.secondary">
            Skip this with <code>secretmgr install</code>, or use <code>secretmgr shell --env dev</code> for a one-off subshell. Then <code>secretmgr use uat</code> switches environment in that terminal.
          </Typography>
        </CardContent>
      </Card>

      <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 4 }}>
        <Table sx={{ minWidth: 560 }}>
          <TableHead>
            <TableRow>
              <TableCell>Session</TableCell>
              <TableCell>Following</TableCell>
              <TableCell>Mode</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            <TableRow sx={{ height: 60 }}>
              <TableCell>Your new terminals</TableCell>
              <TableCell>
                <Select
                  size="small"
                  value={envs.includes(state?.terminalDefaultEnv) ? state.terminalDefaultEnv : ''}
                  displayEmpty
                  onChange={(ev) => api('/terminal-default', { method: 'PUT', body: { env: ev.target.value } }).then(() => { notify(`New terminals start on ${ev.target.value}`); refresh(); }).catch((e) => notify(e.message))}
                >
                  {envs.map((e) => (
                    <MenuItem key={e} value={e}>
                      {e}
                    </MenuItem>
                  ))}
                </Select>
              </TableCell>
              <TableCell>
                <Chip size="small" label="every prompt" />
              </TableCell>
            </TableRow>
            <TableRow sx={{ height: 60 }}>
              <TableCell>Claude Code (agent)</TableCell>
              <TableCell>
                <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap', alignItems: 'center' }}>
                  {envs.map((e) => (
                    <Chip key={e} clickable color={active[e] ? 'primary' : 'default'} variant={active[e] ? 'filled' : 'outlined'} icon={active[e] ? <CheckIcon /> : undefined} label={e + (active[e]?.primary && activeEnvs.length > 1 ? ' ★' : '')} onClick={() => toggle(e)} />
                  ))}
                  {activeEnvs.length > 1 && (
                    <>
                      <Typography variant="body2" color="text.secondary">
                        primary
                      </Typography>
                      <Select size="small" value={activeEnvs.find((e) => active[e].primary) || activeEnvs[0]} onChange={(ev) => api('/agent/primary', { method: 'PUT', body: { env: ev.target.value } }).then(refresh).catch((e) => notify(e.message))}>
                        {activeEnvs.map((e) => (
                          <MenuItem key={e} value={e}>
                            {e}
                          </MenuItem>
                        ))}
                      </Select>
                    </>
                  )}
                </Box>
              </TableCell>
              <TableCell>
                <Chip size="small" color="success" icon={<ShieldIcon />} label="scoped load" />
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </TableContainer>

      <Card>
        <CardContent sx={{ display: 'grid', gap: 1 }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1 }}>
            <Typography variant="h6">Variables in the agent shell right now</Typography>
            <Typography variant="body2" color="text.secondary">
              Names only. Values never leave the vault.
            </Typography>
          </Box>
          {state?.killed ? (
            <Chip color="error" label="Kill switch is on. Nothing is loaded." sx={{ alignSelf: 'start' }} />
          ) : names.length ? (
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
              {names.map((n) => (
                <Chip key={n} label={n} sx={mono} />
              ))}
            </Box>
          ) : (
            <Typography color="text.secondary">No environment is active. The agent calls activate_env to load one, or you can tap a chip above.</Typography>
          )}
        </CardContent>
      </Card>
    </Box>
  );
}

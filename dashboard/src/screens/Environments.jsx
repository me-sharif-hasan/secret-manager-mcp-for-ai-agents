import { useState } from 'react';
import {
  Box, Button, Card, CardContent, Chip, Collapse, Dialog, DialogActions, DialogContent, DialogTitle, Fab, MenuItem, Select, Switch, TextField, Typography,
} from '@mui/material';
import TerminalIcon from '@mui/icons-material/Terminal';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import AddIcon from '@mui/icons-material/Add';
import { useApp } from '../ctx.jsx';
import { api } from '../api.js';
import { LEVELS, labelOf } from '../ui.jsx';

const EXPIRY = [['never', null], ['15 min', 15], ['30 min', 30], ['60 min', 60], ['2 hours', 120]];
const GUIDANCE_HELP = {
  read_only: 'The agent is told: only read data, change nothing, stop and ask if a change is needed.',
  write: 'The agent is told: it may write, but no destructive operations (drop, truncate, delete, destroy, force-push).',
  full: 'The agent is told: it may operate, but must ask you before anything destructive or irreversible.',
};

function Row({ label, hint, children, off }) {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 1.5, minHeight: 40, opacity: off ? 0.4 : 1, pointerEvents: off ? 'none' : 'auto' }}>
      <Box sx={{ minWidth: 0 }}>
        <Typography>{label}</Typography>
        {hint && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
            {hint}
          </Typography>
        )}
      </Box>
      {children}
    </Box>
  );
}

export default function Environments() {
  const { data, group, state, refresh, notify, guard } = useApp();
  const [showText, setShowText] = useState({});
  const [creating, setCreating] = useState(false);
  const envs = Object.keys(data.envs);

  const patch = (env, body) => api(`/groups/${group}/envs/${env}`, { method: 'PUT', body }).then(refresh).catch((e) => notify(e.message));
  const openShell = (env) =>
    api('/shell/open', { method: 'POST', body: { group, env } })
      .then((r) => notify(`Opened ${r.terminal} with ${env} loaded${env === 'prod' ? '. This open is logged.' : ''}`))
      .catch((e) => notify(e.message));

  return (
    <Box sx={{ display: 'grid', gap: 2, pb: 9 }}>
      <Typography color="text.secondary">
        Group <b>{group}</b>. Each environment keeps its own value for every key, and its own rules for what the agent may do.
      </Typography>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 2 }}>
        {envs.map((e) => {
          const c = data.envs[e];
          const active = Boolean(state?.active?.[e]);
          return (
            <Card key={e} sx={{ display: 'flex' }}>
              <CardContent sx={{ display: 'flex', flexDirection: 'column', gap: 1, flex: 1 }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Typography variant="h6">{e}</Typography>
                  <Box sx={{ display: 'flex', gap: 0.5 }}>
                    {active && <Chip size="small" color="success" label="active for agent" />}
                    <Chip size="small" label={`${data.vars.length} variables`} />
                  </Box>
                </Box>

                <Row label="Default agent access" hint="For new variables">
                  <Select size="small" value={c.defaultAccess} onChange={(ev) => patch(e, { defaultAccess: ev.target.value })}>
                    {LEVELS.map((l) => (
                      <MenuItem key={l} value={l}>
                        {l}
                      </MenuItem>
                    ))}
                  </Select>
                </Row>

                <Row label="Agent may activate" hint={c.allow ? 'activate_env is allowed' : 'activate_env returns denied'}>
                  <Switch checked={c.allow} onChange={(ev) => patch(e, { allow: ev.target.checked })} slotProps={{ input: { 'aria-label': `Allow agent to activate ${e}` } }} />
                </Row>
                <Row label="Approve each activation" off={!c.allow}>
                  <Switch checked={c.approval} onChange={(ev) => patch(e, { approval: ev.target.checked })} slotProps={{ input: { 'aria-label': `Approval required in ${e}` } }} />
                </Row>
                <Row label="Auto-expire" off={!c.allow}>
                  <Select size="small" value={c.expiryMin ?? null} onChange={(ev) => patch(e, { expiryMin: ev.target.value })}>
                    {EXPIRY.map(([l, v]) => (
                      <MenuItem key={l} value={v}>
                        {l}
                      </MenuItem>
                    ))}
                  </Select>
                </Row>

                <Row label="Guidance for the agent" hint={labelOf[c.guidance]}>
                  <Select size="small" value={c.guidance} onChange={(ev) => patch(e, { guidance: ev.target.value })}>
                    <MenuItem value="read_only">Read-only</MenuItem>
                    <MenuItem value="write">Write</MenuItem>
                    <MenuItem value="full">Full</MenuItem>
                  </Select>
                </Row>
                <Row label="Enforce with command checks" hint={c.guidance === 'full' ? 'Full only advises' : c.enforce ? 'Mutating commands are blocked' : 'Advice only, nothing is blocked'} off={c.guidance === 'full'}>
                  <Switch checked={c.enforce} onChange={(ev) => patch(e, { enforce: ev.target.checked })} slotProps={{ input: { 'aria-label': `Enforce guidance in ${e}` } }} />
                </Row>
                <Box>
                  <Button size="small" onClick={() => setShowText({ ...showText, [e]: !showText[e] })} sx={{ px: 0 }}>
                    {showText[e] ? 'Hide' : 'Show'} what the agent is told
                  </Button>
                  <Collapse in={Boolean(showText[e])}>
                    <Typography variant="body2" sx={{ p: 1.5, borderRadius: 3, bgcolor: 'action.hover' }}>
                      {c.guidanceText}
                    </Typography>
                  </Collapse>
                  {!showText[e] && (
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                      {GUIDANCE_HELP[c.guidance]}
                    </Typography>
                  )}
                </Box>

                <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 'auto', pt: 1 }}>
                  <Button variant="contained" startIcon={<TerminalIcon />} onClick={() => openShell(e)} disabled={state?.killed}>
                    Open shell
                  </Button>
                  <Button variant="outlined" startIcon={<ContentCopyIcon />} title="Clone to new environment" onClick={() => setCreating(e)}>
                    Clone
                  </Button>
                </Box>
              </CardContent>
            </Card>
          );
        })}
      </Box>
      <Fab variant="extended" color="primary" onClick={() => setCreating(true)} sx={{ position: 'fixed', right: 32, bottom: 32, borderRadius: 4 }}>
        <AddIcon sx={{ mr: 1 }} /> New environment
      </Fab>
      {creating && <NewEnvDialog cloneFrom={typeof creating === 'string' ? creating : ''} envs={envs} onClose={() => setCreating(false)} />}
    </Box>
  );
}

function NewEnvDialog({ cloneFrom, envs, onClose }) {
  const { group, refresh, notify } = useApp();
  const [name, setName] = useState('');
  const [from, setFrom] = useState(cloneFrom);
  const [err, setErr] = useState('');
  const go = async () => {
    try {
      await api(`/groups/${group}/envs`, { method: 'POST', body: { name: name.trim().toLowerCase(), cloneFrom: from || undefined } });
      notify(`Created ${name}. Agent activation is off until you enable it.`);
      onClose();
      refresh();
    } catch (e) {
      setErr(e.message);
    }
  };
  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>New environment</DialogTitle>
      <DialogContent sx={{ display: 'grid', gap: 2, pt: '8px !important' }}>
        <TextField autoFocus label="Name" placeholder="staging" value={name} onChange={(e) => setName(e.target.value)} error={Boolean(err)} helperText={err || 'Lowercase letters, numbers, hyphens'} />
        <TextField select label="Copy keys and access rules from" value={from} onChange={(e) => setFrom(e.target.value)} helperText="Values are never copied">
          <MenuItem value="">Nothing (empty)</MenuItem>
          {envs.map((e) => (
            <MenuItem key={e} value={e}>
              {e}
            </MenuItem>
          ))}
        </TextField>
      </DialogContent>
      <DialogActions sx={{ p: 2 }}>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={go}>
          Create
        </Button>
      </DialogActions>
    </Dialog>
  );
}

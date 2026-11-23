import { useEffect, useRef, useState } from 'react';
import {
  Box, Button, Card, CardContent, Dialog, DialogActions, DialogContent, DialogTitle, Fab, IconButton, InputAdornment, MenuItem, Paper, Select, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, TextField, Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import SearchIcon from '@mui/icons-material/Search';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import { useApp } from '../ctx.jsx';
import { api, ago } from '../api.js';
import { AccessSelect, EnvToggle, LevelChip, Confirm, LEVELS } from '../ui.jsx';
import { mono } from '../theme.js';

export default function Variables() {
  const { data, group, env, setEnv, refresh, notify, setScreen, state, guard } = useApp();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(null);
  const [revealed, setRevealed] = useState({});
  const [edit, setEdit] = useState(null); // null | { key|null }
  const [del, setDel] = useState(null);
  const timers = useRef({});
  const envs = Object.keys(data.envs);
  const rows = data.vars.filter((v) => !q || v.key.includes(q.toUpperCase()));
  const selected = data.vars.find((v) => v.key === sel);
  const dead = state?.killed;

  useEffect(() => () => Object.values(timers.current).forEach(clearTimeout), []);

  const reveal = async (key, e) => {
    const id = `${key}|${e}`;
    if (revealed[id] !== undefined) {
      clearTimeout(timers.current[id]);
      return setRevealed((r) => ({ ...r, [id]: undefined }));
    }
    try {
      const { value } = await api(`/groups/${group}/vars/${key}/reveal`, { method: 'POST', body: { env: e } });
      setRevealed((r) => ({ ...r, [id]: value }));
      timers.current[id] = setTimeout(() => setRevealed((r) => ({ ...r, [id]: undefined })), 10000);
    } catch (err) {
      notify(err.message);
    }
  };

  const setAccess = (key, e, level) =>
    api(`/groups/${group}/vars/${key}/access`, { method: 'PUT', body: { env: e, level } }).then(refresh).catch((err) => notify(err.message));

  return (
    <Box sx={{ display: 'grid', gap: 2, position: 'relative', pb: 9 }}>
      <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
        <EnvToggle envs={envs} value={env} onChange={setEnv} />
        <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
          <TextField
            size="small"
            placeholder="Search variables"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            slotProps={{ input: { startAdornment: <InputAdornment position="start"><SearchIcon /></InputAdornment>, sx: { borderRadius: 7 } } }}
          />
          <Button variant="outlined" startIcon={<UploadFileIcon />} onClick={() => setScreen('import')}>
            Import .env
          </Button>
        </Box>
      </Box>

      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', lg: selected ? 'minmax(0,1fr) 340px' : '1fr' }, alignItems: 'start' }}>
        <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 4 }}>
          <Table sx={{ minWidth: 620 }}>
            <TableHead>
              <TableRow>
                <TableCell>Key</TableCell>
                <TableCell>Value in {env}</TableCell>
                <TableCell>Agent access</TableCell>
                <TableCell>Updated</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((v) => {
                const id = `${v.key}|${env}`;
                const shown = revealed[id];
                return (
                  <TableRow key={v.key} hover selected={sel === v.key} onClick={() => setSel(v.key)} sx={{ cursor: 'pointer', height: 56 }}>
                    <TableCell sx={mono}>{v.key}</TableCell>
                    <TableCell>
                      <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                        <Box component="span" sx={{ ...mono, color: v.masked[env] ? 'text.primary' : 'text.secondary', wordBreak: 'break-all' }}>
                          {shown !== undefined ? shown : v.masked[env] ?? 'not set'}
                        </Box>
                        {v.masked[env] && (
                          <IconButton size="small" aria-label={shown !== undefined ? 'Hide value' : 'Reveal value'} onClick={(e) => { e.stopPropagation(); reveal(v.key, env); }}>
                            {shown !== undefined ? <VisibilityOffIcon fontSize="small" /> : <VisibilityIcon fontSize="small" />}
                          </IconButton>
                        )}
                      </Box>
                    </TableCell>
                    <TableCell>
                      <AccessSelect value={v.access[env]} dead={dead} onChange={(l) => setAccess(v.key, env, l)} />
                    </TableCell>
                    <TableCell sx={{ color: 'text.secondary' }}>{ago(v.updated)}</TableCell>
                  </TableRow>
                );
              })}
              {!rows.length && (
                <TableRow>
                  <TableCell colSpan={4} align="center" sx={{ py: 5, color: 'text.secondary' }}>
                    {data.vars.length ? 'No variable matches your search.' : 'No variables yet. Add one, or import a .env file.'}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>

        {selected && (
          <Card>
            <CardContent sx={{ display: 'grid', gap: 1.5 }}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Typography variant="h6" sx={mono}>
                  {selected.key}
                </Typography>
                <IconButton aria-label="Close" onClick={() => setSel(null)}>
                  <CloseIcon />
                </IconButton>
              </Box>
              {envs.map((e) => (
                <Box key={e}>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Typography fontWeight={500} color="text.secondary">
                      {e}
                    </Typography>
                    <LevelChip level={selected.access[e] ?? 'none'} />
                  </Box>
                  <Typography sx={{ ...mono, wordBreak: 'break-all' }}>{selected.masked[e] ?? 'not set'}</Typography>
                </Box>
              ))}
              <Typography variant="body2" color="text.secondary">
                Updated {ago(selected.updated)}
              </Typography>
              <Box sx={{ display: 'flex', gap: 1 }}>
                <Button variant="outlined" startIcon={<EditIcon />} onClick={() => setEdit({ key: selected.key })}>
                  Edit values
                </Button>
                <Button color="error" startIcon={<DeleteIcon />} onClick={() => setDel(selected.key)}>
                  Delete
                </Button>
              </Box>
            </CardContent>
          </Card>
        )}
      </Box>

      <Fab variant="extended" color="primary" onClick={() => setEdit({ key: null })} sx={{ position: 'fixed', right: 32, bottom: 32, borderRadius: 4 }}>
        <AddIcon sx={{ mr: 1 }} /> Add variable
      </Fab>

      {edit && <EditDialog existing={edit.key ? selected || data.vars.find((v) => v.key === edit.key) : null} onClose={() => setEdit(null)} />}
      <Confirm
        open={Boolean(del)}
        danger
        title={`Delete ${del}?`}
        body="This removes the variable and all of its values in every environment. It cannot be undone."
        confirmLabel="Delete"
        onCancel={() => setDel(null)}
        onConfirm={() => {
          api(`/groups/${group}/vars/${del}`, { method: 'DELETE' })
            .then(() => { notify(`Deleted ${del}`); setSel(null); setDel(null); refresh(); })
            .catch((e) => { setDel(null); guard(e); });
        }}
      />
    </Box>
  );
}

function EditDialog({ existing, onClose }) {
  const { data, group, refresh, notify } = useApp();
  const envs = Object.keys(data.envs);
  const [key, setKey] = useState(existing?.key || '');
  const [vals, setVals] = useState({});
  const [clear, setClear] = useState({});
  const [acc, setAcc] = useState(() => Object.fromEntries(envs.map((e) => [e, existing?.access[e] ?? data.envs[e].defaultAccess])));
  const [err, setErr] = useState('');

  const save = async () => {
    const values = {};
    envs.forEach((e) => {
      if (clear[e]) values[e] = null;
      else if (vals[e]) values[e] = vals[e];
    });
    try {
      await api(`/groups/${group}/vars` + (existing ? `/${existing.key}` : ''), { method: existing ? 'PUT' : 'POST', body: { key, values, access: existing ? undefined : acc } });
      notify(existing ? `Updated ${key}` : `Added ${key}`);
      onClose();
      refresh();
    } catch (e) {
      setErr(e.message);
    }
  };

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{existing ? `Edit ${existing.key}` : 'Add variable'}</DialogTitle>
      <DialogContent sx={{ display: 'grid', gap: 2, pt: '8px !important' }}>
        {!existing && <TextField autoFocus label="Name" placeholder="DATABASE_URL" value={key} onChange={(e) => setKey(e.target.value)} error={Boolean(err)} helperText={err || 'Letters, numbers and underscores'} slotProps={{ htmlInput: { style: mono } }} />}
        {existing && err && <Typography color="error">{err}</Typography>}
        {envs.map((e) => (
          <Box key={e} sx={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: 1, alignItems: 'center' }}>
            <TextField
              label={`Value in ${e}`}
              type="password"
              autoComplete="new-password"
              placeholder={existing ? (existing.masked[e] ? 'unchanged' : 'not set') : 'not set'}
              value={clear[e] ? '' : vals[e] || ''}
              disabled={clear[e]}
              onChange={(ev) => setVals({ ...vals, [e]: ev.target.value })}
              slotProps={{ htmlInput: { style: mono } }}
            />
            {existing ? (
              existing.masked[e] ? (
                <Button size="small" color={clear[e] ? 'primary' : 'error'} onClick={() => setClear({ ...clear, [e]: !clear[e] })}>
                  {clear[e] ? 'Keep' : 'Clear'}
                </Button>
              ) : (
                <span />
              )
            ) : (
              <Select size="small" value={acc[e]} onChange={(ev) => setAcc({ ...acc, [e]: ev.target.value })}>
                {LEVELS.map((l) => (
                  <MenuItem key={l} value={l}>
                    {l}
                  </MenuItem>
                ))}
              </Select>
            )}
          </Box>
        ))}
        {!existing && (
          <Typography variant="caption" color="text.secondary">
            The dropdown on the right is the agent's access in that environment. Leave a value empty to skip that environment.
          </Typography>
        )}
      </DialogContent>
      <DialogActions sx={{ p: 2 }}>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={save}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}

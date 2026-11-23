import { useEffect, useRef, useState } from 'react';
import { Box, Button, Chip, MenuItem, Paper, Select, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography } from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import { useApp } from '../ctx.jsx';
import { api } from '../api.js';
import { EnvToggle, LEVELS } from '../ui.jsx';
import { mono } from '../theme.js';

const SAMPLE = ['# checkout-api local', 'export DATABASE_URL="postgres://app:x7Qp@db.dev.internal/app"', 'STRIPE_KEY=sk_test_51Hq0aEXAMPLE', 'REDIS_URL=redis://localhost:6379 # local cache', "FEATURE_FLAGS='a,b,c'"].join('\n');
const CHIP = { new: 'success', changed: 'warning', unchanged: 'default', invalid: 'error' };

export default function ImportEnv() {
  const { data, group, refresh, notify, setScreen, setEnv } = useApp();
  const envs = Object.keys(data.envs);
  const [target, setTarget] = useState(envs.includes('dev') ? 'dev' : envs[0]);
  const [text, setText] = useState('');
  const [access, setAccess] = useState('use');
  const [rows, setRows] = useState([]);
  const timer = useRef();

  useEffect(() => {
    clearTimeout(timer.current);
    if (!text.trim()) return setRows([]);
    timer.current = setTimeout(() => {
      api(`/groups/${group}/import`, { method: 'POST', body: { env: target, text, access, dryRun: true } })
        .then((r) => setRows(r.rows))
        .catch((e) => notify(e.message));
    }, 250);
    return () => clearTimeout(timer.current);
  }, [text, target, access, group, notify]);

  const pending = rows.filter((r) => r.status === 'new' || r.status === 'changed').length;

  const run = async () => {
    try {
      const r = await api(`/groups/${group}/import`, { method: 'POST', body: { env: target, text, access } });
      notify(`Imported ${r.written} variables into ${target}`);
      setText('');
      setEnv(target);
      await refresh();
      setScreen('variables');
    } catch (e) {
      notify(e.message);
    }
  };

  const exportEnv = async () => {
    try {
      const res = await api(`/groups/${group}/export?env=${target}`, { raw: true });
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `.env.${target}`;
      a.click();
      URL.revokeObjectURL(a.href);
      notify(`Exported .env for ${target}. Delete the file when you are done.`);
    } catch (e) {
      notify(e.message);
    }
  };

  return (
    <Box sx={{ display: 'grid', gap: 2 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap', alignItems: 'center' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
          <Typography color="text.secondary">Target</Typography>
          <EnvToggle envs={envs} value={target} onChange={setTarget} />
        </Box>
        <Button variant="outlined" startIcon={<DownloadIcon />} onClick={exportEnv}>
          Export .env for {target}
        </Button>
      </Box>
      <TextField
        label="Paste .env contents"
        multiline
        minRows={9}
        maxRows={20}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={SAMPLE}
        spellCheck={false}
        slotProps={{ htmlInput: { style: mono } }}
      />
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
        <Typography color="text.secondary">Agent access for new variables</Typography>
        <Select size="small" value={access} onChange={(e) => setAccess(e.target.value)}>
          {LEVELS.map((l) => (
            <MenuItem key={l} value={l}>
              {l}
            </MenuItem>
          ))}
        </Select>
      </Box>
      {rows.length > 0 && (
        <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 4 }}>
          <Table sx={{ minWidth: 520 }}>
            <TableHead>
              <TableRow>
                <TableCell>Line</TableCell>
                <TableCell>Key</TableCell>
                <TableCell>Status</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.line}>
                  <TableCell sx={mono}>{r.line}</TableCell>
                  <TableCell sx={mono}>{r.key ?? r.text}</TableCell>
                  <TableCell>
                    <Chip size="small" color={CHIP[r.status]} label={r.status === 'invalid' ? `invalid: ${r.reason}` : r.status} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
        <Typography color="text.secondary">
          {pending} to write into {target}. Comments and blank lines are skipped. ${'{VAR}'} references are kept literally.
        </Typography>
        <Button variant="contained" disabled={!pending} onClick={run}>
          Import {pending} variables
        </Button>
      </Box>
    </Box>
  );
}

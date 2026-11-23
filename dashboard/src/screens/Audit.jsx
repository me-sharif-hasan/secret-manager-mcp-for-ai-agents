import { useEffect, useState } from 'react';
import { Box, Chip, Paper, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import { useApp } from '../ctx.jsx';
import { api } from '../api.js';
import { mono } from '../theme.js';

export default function Audit() {
  const { state, guard } = useApp();
  const [actor, setActor] = useState('all');
  const [rows, setRows] = useState([]);
  useEffect(() => {
    api(`/audit${actor === 'all' ? '' : `?actor=${actor}`}`).then(setRows).catch(guard);
  }, [actor, state, guard]);

  return (
    <Box sx={{ display: 'grid', gap: 2 }}>
      <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
        <ToggleButtonGroup exclusive size="small" value={actor} onChange={(_, v) => v && setActor(v)} sx={{ '& .MuiToggleButton-root': { borderRadius: 5, px: 2, textTransform: 'none' } }}>
          <ToggleButton value="all">All</ToggleButton>
          <ToggleButton value="agent">Agent</ToggleButton>
          <ToggleButton value="you">You</ToggleButton>
        </ToggleButtonGroup>
        <Typography color="text.secondary">Names and outcomes only. Values are never logged.</Typography>
      </Box>
      <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 4 }}>
        <Table sx={{ minWidth: 720 }}>
          <TableHead>
            <TableRow>
              <TableCell>Time</TableCell>
              <TableCell>Actor</TableCell>
              <TableCell>Action</TableCell>
              <TableCell>Variable</TableCell>
              <TableCell>Env</TableCell>
              <TableCell>Result</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((r, i) => {
              const result = String(r.result ?? '');
              const bad = result.startsWith('blocked') || result.startsWith('denied');
              return (
                <TableRow key={i} sx={{ height: 52 }}>
                  <TableCell sx={{ ...mono, whiteSpace: 'nowrap' }}>{new Date(r.ts).toLocaleTimeString()}</TableCell>
                  <TableCell>{r.actor}</TableCell>
                  <TableCell sx={mono}>{r.action}</TableCell>
                  <TableCell sx={mono}>{r.key || '-'}</TableCell>
                  <TableCell>{r.env || '-'}</TableCell>
                  <TableCell>
                    <Chip size="small" color={bad ? 'error' : result === 'ok' ? 'success' : 'default'} label={result + (r.redactions ? ` · ${r.redactions} redacted` : '')} />
                  </TableCell>
                </TableRow>
              );
            })}
            {!rows.length && (
              <TableRow>
                <TableCell colSpan={6} align="center" sx={{ py: 5, color: 'text.secondary' }}>
                  No activity yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
}

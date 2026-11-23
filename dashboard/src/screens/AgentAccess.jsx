import { Box, Paper, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Chip } from '@mui/material';
import { useApp } from '../ctx.jsx';
import { api } from '../api.js';
import { AccessSelect } from '../ui.jsx';
import { mono } from '../theme.js';

export default function AgentAccess() {
  const { data, group, state, refresh, notify } = useApp();
  const envs = Object.keys(data.envs);
  const set = (key, env, level) => api(`/groups/${group}/vars/${key}/access`, { method: 'PUT', body: { env, level } }).then(refresh).catch((e) => notify(e.message));
  return (
    <Box sx={{ display: 'grid', gap: 2 }}>
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
        <Chip color="error" variant="outlined" label="none: invisible to the agent" />
        <Chip color="success" variant="outlined" label="use: available as $VAR in agent commands, output redacted" />
        <Chip color="warning" variant="outlined" label="write: agent may also set or rotate it" />
      </Box>
      <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 4 }}>
        <Table sx={{ minWidth: 520 }}>
          <TableHead>
            <TableRow>
              <TableCell>Variable</TableCell>
              {envs.map((e) => (
                <TableCell key={e}>{e}</TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {data.vars.map((v) => (
              <TableRow key={v.key} sx={{ height: 56 }}>
                <TableCell sx={mono}>{v.key}</TableCell>
                {envs.map((e) => (
                  <TableCell key={e}>
                    <AccessSelect value={v.access[e]} dead={state?.killed} onChange={(l) => set(v.key, e, l)} />
                  </TableCell>
                ))}
              </TableRow>
            ))}
            {!data.vars.length && (
              <TableRow>
                <TableCell colSpan={envs.length + 1} align="center" sx={{ py: 5, color: 'text.secondary' }}>
                  No variables in this group yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
}

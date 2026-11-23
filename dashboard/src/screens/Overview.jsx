import { useEffect, useState } from 'react';
import { Box, Button, Card, CardContent, Chip, Typography } from '@mui/material';
import KeyIcon from '@mui/icons-material/Key';
import LayersIcon from '@mui/icons-material/Layers';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import BlockIcon from '@mui/icons-material/Block';
import PersonIcon from '@mui/icons-material/Person';
import VerifiedUserIcon from '@mui/icons-material/VerifiedUser';
import { useApp } from '../ctx.jsx';
import { api, ago } from '../api.js';
import { labelOf } from '../ui.jsx';

function Stat({ icon, value, label }) {
  return (
    <Card sx={{ bgcolor: 'action.hover', border: 0, borderRadius: 5 }}>
      <CardContent>
        <Box sx={{ color: 'primary.main', mb: 1 }}>{icon}</Box>
        <Typography sx={{ fontSize: 32, lineHeight: '38px', fontVariantNumeric: 'tabular-nums' }}>{value}</Typography>
        <Typography variant="body2" color="text.secondary">
          {label}
        </Typography>
      </CardContent>
    </Card>
  );
}

export default function Overview() {
  const { data, state, setScreen, setEnv, guard } = useApp();
  const [log, setLog] = useState([]);
  useEffect(() => {
    api('/audit').then((r) => setLog(r.slice(0, 5))).catch(guard);
  }, [state, guard]);

  const envs = Object.keys(data.envs);
  const split = Object.fromEntries(envs.map((e) => [e, { none: 0, use: 0, write: 0 }]));
  data.vars.forEach((v) => envs.forEach((e) => split[e][v.access[e] ?? 'none']++));
  const usable = envs.reduce((n, e) => n + split[e].use + split[e].write, 0);
  const hidden = envs.reduce((n, e) => n + split[e].none, 0);

  return (
    <Box sx={{ display: 'grid', gap: 3 }}>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 1.5 }}>
        <Stat icon={<KeyIcon />} value={data.vars.length} label="Variables" />
        <Stat icon={<LayersIcon />} value={envs.length} label="Environments" />
        <Stat icon={<SmartToyIcon />} value={usable} label="Agent can use or write" />
        <Stat icon={<VisibilityOffIcon />} value={hidden} label="Hidden from agent" />
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 1.5 }}>
        {envs.map((e) => {
          const s = split[e];
          const total = s.none + s.use + s.write || 1;
          const cfg = data.envs[e];
          return (
            <Card key={e}>
              <CardContent sx={{ display: 'grid', gap: 1.5, height: '100%', alignContent: 'start' }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Typography variant="h6">{e}</Typography>
                  <Box sx={{ display: 'flex', gap: 0.5 }}>
                    <Chip size="small" label={labelOf[cfg.guidance]} />
                    {cfg.allow && cfg.approval && <Chip size="small" color="warning" icon={<VerifiedUserIcon />} label="approval" />}
                    {!cfg.allow && <Chip size="small" color="error" label="agent off" />}
                  </Box>
                </Box>
                <Box sx={{ display: 'flex', height: 8, borderRadius: 1, overflow: 'hidden', gap: '2px', bgcolor: 'action.hover' }}>
                  {[['none', 'error.main'], ['use', 'success.main'], ['write', 'warning.main']].map(([k, c]) => (s[k] ? <Box key={k} sx={{ flex: s[k] / total, bgcolor: c }} /> : null))}
                </Box>
                <Typography variant="body2" color="text.secondary">
                  {s.none} none · {s.use} use · {s.write} write
                </Typography>
                <Button
                  variant="outlined"
                  
                  onClick={() => {
                    setEnv(e);
                    setScreen('variables');
                  }}
                >
                  Open variables
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </Box>

      <Card>
        <CardContent>
          <Typography variant="h6" sx={{ mb: 1 }}>
            Recent activity
          </Typography>
          {log.length === 0 && <Typography color="text.secondary">Nothing yet. Agent calls and your own changes show up here.</Typography>}
          {log.map((r, i) => (
            <Box key={i} sx={{ display: 'flex', gap: 2, alignItems: 'center', py: 1.25, borderTop: i ? 1 : 0, borderColor: 'divider' }}>
              <Box sx={(t) => ({ width: 40, height: 40, borderRadius: '50%', display: 'grid', placeItems: 'center', bgcolor: String(r.result).startsWith('blocked') ? 'error.main' : 'action.selected', color: String(r.result).startsWith('blocked') ? t.palette.error.contrastText : 'text.primary' })}>
                {String(r.result).startsWith('blocked') ? <BlockIcon fontSize="small" /> : r.actor === 'agent' ? <SmartToyIcon fontSize="small" /> : <PersonIcon fontSize="small" />}
              </Box>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography fontWeight={500}>
                  {r.actor} · {r.action}
                </Typography>
                <Typography variant="body2" color="text.secondary" noWrap sx={{ fontFamily: '"Roboto Mono", monospace' }}>
                  {[r.key, r.env, r.result].filter(Boolean).join(' · ')}
                </Typography>
              </Box>
              <Typography variant="body2" color="text.secondary">
                {ago(r.ts)}
              </Typography>
            </Box>
          ))}
        </CardContent>
      </Card>
    </Box>
  );
}

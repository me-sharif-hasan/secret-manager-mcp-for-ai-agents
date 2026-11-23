import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert, AppBar, Box, Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, Drawer, IconButton, List, ListItemButton, ListItemIcon,
  ListItemText, MenuItem, Select, Snackbar, TextField, Toolbar, Typography, useMediaQuery, Chip,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import DashboardIcon from '@mui/icons-material/Dashboard';
import KeyIcon from '@mui/icons-material/Key';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import LayersIcon from '@mui/icons-material/Layers';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import TerminalIcon from '@mui/icons-material/Terminal';
import HistoryIcon from '@mui/icons-material/History';
import PowerSettingsNewIcon from '@mui/icons-material/PowerSettingsNew';
import LockOpenIcon from '@mui/icons-material/LockOpen';
import AddIcon from '@mui/icons-material/Add';
import MenuIcon from '@mui/icons-material/Menu';
import ShieldIcon from '@mui/icons-material/Shield';
import { api, AuthError } from './api.js';
import { Ctx } from './ctx.jsx';
import { Confirm } from './ui.jsx';
import Overview from './screens/Overview.jsx';
import Variables from './screens/Variables.jsx';
import ImportEnv from './screens/ImportEnv.jsx';
import Environments from './screens/Environments.jsx';
import AgentAccess from './screens/AgentAccess.jsx';
import ShellSync from './screens/ShellSync.jsx';
import Audit from './screens/Audit.jsx';

const SCREENS = [
  { id: 'overview', name: 'Overview', icon: <DashboardIcon />, el: Overview },
  { id: 'variables', name: 'Variables', icon: <KeyIcon />, el: Variables },
  { id: 'import', name: 'Import .env', icon: <UploadFileIcon />, el: ImportEnv },
  { id: 'envs', name: 'Environments', icon: <LayersIcon />, el: Environments },
  { id: 'access', name: 'Agent access', icon: <SmartToyIcon />, el: AgentAccess },
  { id: 'shell', name: 'Shell sync', icon: <TerminalIcon />, el: ShellSync },
  { id: 'audit', name: 'Audit log', icon: <HistoryIcon />, el: Audit },
];
const DRAWER = 248;

export default function App() {
  const theme = useTheme();
  const wide = useMediaQuery(theme.breakpoints.up('md'));
  const [state, setState] = useState(null);
  const [locked, setLocked] = useState(false);
  const [fatal, setFatal] = useState(null);
  const [group, setGroupRaw] = useState(() => localStorage.getItem('sm-group'));
  const [data, setData] = useState(null);
  const [env, setEnv] = useState('dev');
  const [screen, setScreen] = useState('overview');
  const [snack, setSnack] = useState(null);
  const [killAsk, setKillAsk] = useState(false);
  const [groupDlg, setGroupDlg] = useState(false);
  const [menu, setMenu] = useState(false);

  const notify = useCallback((m) => setSnack(m), []);
  const setGroup = (g) => {
    localStorage.setItem('sm-group', g);
    setGroupRaw(g);
  };

  const guard = useCallback((e) => {
    if (e instanceof AuthError) setLocked(true);
    else setFatal(e.message);
  }, []);

  const loadState = useCallback(async () => {
    try {
      const s = await api('/state');
      setState(s);
      setFatal(null);
      return s;
    } catch (e) {
      guard(e);
    }
  }, [guard]);

  const loadGroup = useCallback(
    async (name) => {
      if (!name) return setData(null);
      try {
        const d = await api(`/groups/${name}`);
        setData(d);
        setEnv((cur) => (d.envs[cur] ? cur : Object.keys(d.envs)[0]));
      } catch (e) {
        if (/does not exist/.test(e.message)) setGroupRaw(null);
        else guard(e);
      }
    },
    [guard],
  );

  const refresh = useCallback(async () => {
    const s = await loadState();
    const g = group && s?.groups.some((x) => x.name === group) ? group : s?.defaultGroup && s.groups.some((x) => x.name === s.defaultGroup) ? s.defaultGroup : s?.groups[0]?.name;
    if (g && g !== group) setGroup(g);
    await loadGroup(g);
    setGroupDlg((open) => open || (s && s.groups.length === 0));
  }, [group, loadState, loadGroup]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  const ctx = useMemo(() => ({ state, group, data, env, setEnv, refresh, notify, setScreen, guard }), [state, group, data, env, refresh, notify, guard]);

  if (locked || !sessionStorage.getItem('secretmgr-token')) {
    return (
      <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center', p: 3 }}>
        <Box sx={{ maxWidth: 420, textAlign: 'center', display: 'grid', gap: 2 }}>
          <ShieldIcon color="primary" sx={{ fontSize: 56, mx: 'auto' }} />
          <Typography variant="h5">Dashboard locked</Typography>
          <Typography color="text.secondary">This page needs the one-time token from your terminal. Run the command below and open the link it prints.</Typography>
          <Box component="code" sx={{ p: 1.5, borderRadius: 2, bgcolor: 'action.hover', fontFamily: '"Roboto Mono", monospace' }}>
            secretmgr dashboard
          </Box>
        </Box>
      </Box>
    );
  }

  const killed = state?.killed;
  const Screen = SCREENS.find((s) => s.id === screen).el;

  const nav = (
    <Box sx={{ width: DRAWER, display: 'flex', flexDirection: 'column', height: '100%', p: 1.5, gap: 0.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, px: 1.5, py: 1.5 }}>
        <Box sx={{ width: 36, height: 36, borderRadius: 3, bgcolor: 'primary.main', color: 'primary.contrastText', display: 'grid', placeItems: 'center' }}>
          <ShieldIcon fontSize="small" />
        </Box>
        <Typography fontWeight={500} fontSize={18}>
          Secrets
        </Typography>
      </Box>
      <Box sx={{ px: 0.5, pb: 1.5 }}>
        <Typography variant="caption" color="text.secondary" sx={{ pl: 1.5 }}>
          Group
        </Typography>
        <Box sx={{ display: 'flex', gap: 0.75, alignItems: 'center' }}>
          <Select size="small" fullWidth value={group && state?.groups.some((g) => g.name === group) ? group : ''} onChange={(e) => setGroup(e.target.value)} sx={{ flex: 1, minWidth: 0 }}>
            {(state?.groups || []).map((g) => (
              <MenuItem key={g.name} value={g.name}>
                {g.name}
              </MenuItem>
            ))}
          </Select>
          <IconButton aria-label="New group" title="New group" onClick={() => setGroupDlg(true)} sx={{ border: 1, borderColor: 'divider' }}>
            <AddIcon />
          </IconButton>
        </Box>
      </Box>
      {SCREENS.map((s) => (
        <ListItemButton
          key={s.id}
          selected={screen === s.id}
          onClick={() => {
            setScreen(s.id);
            setMenu(false);
          }}
          sx={{ borderRadius: 6, height: 48, '&.Mui-selected': { bgcolor: 'action.selected' } }}
        >
          <ListItemIcon sx={{ minWidth: 40 }}>{s.icon}</ListItemIcon>
          <ListItemText primary={s.name} slotProps={{ primary: { fontWeight: 500 } }} />
        </ListItemButton>
      ))}
      <Box sx={{ flex: 1 }} />
      <Box sx={{ borderRadius: 4, bgcolor: 'action.hover', p: 1.5, display: 'grid', gap: 0.5 }}>
        <Typography fontWeight={500} fontSize={13} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Box component="span" sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: killed ? 'error.main' : 'success.main' }} />
          Agent {killed ? 'locked' : 'active'}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {killed ? 'Kill switch is on' : Object.keys(state?.active || {}).length ? `Active: ${Object.keys(state.active).join(', ')}` : 'No environment active'}
        </Typography>
      </Box>
      <Typography variant="caption" color="text.secondary" sx={{ px: 1.5, pt: 1 }}>
        Keys in: {state?.keyBackend || '-'}
      </Typography>
    </Box>
  );

  return (
    <Ctx.Provider value={ctx}>
      <Box sx={{ display: 'flex', minHeight: '100vh' }}>
        {wide ? (
          <Drawer variant="permanent" sx={{ width: DRAWER, flexShrink: 0, '& .MuiDrawer-paper': { width: DRAWER, borderRight: 0, bgcolor: 'action.hover' } }}>
            {nav}
          </Drawer>
        ) : (
          <Drawer open={menu} onClose={() => setMenu(false)}>
            {nav}
          </Drawer>
        )}
        <Box component="main" sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <AppBar position="sticky" color="transparent" elevation={0} sx={{ backdropFilter: 'blur(8px)', bgcolor: 'background.default' }}>
            <Toolbar sx={{ gap: 1.5, flexWrap: 'wrap' }}>
              {!wide && (
                <IconButton onClick={() => setMenu(true)} aria-label="Menu">
                  <MenuIcon />
                </IconButton>
              )}
              <Typography variant="h5" sx={{ flex: 1 }}>
                {SCREENS.find((s) => s.id === screen).name}
              </Typography>
              {group && <Chip label={group} size="small" variant="outlined" />}
              {killed ? (
                <Button variant="contained" color="error" startIcon={<LockOpenIcon />} onClick={() => api('/kill', { method: 'POST', body: { on: false } }).then(() => { notify('Agent access restored'); refresh(); }).catch(guard)}>
                  Restore access
                </Button>
              ) : (
                <Button color="error" variant="outlined" startIcon={<PowerSettingsNewIcon />} onClick={() => setKillAsk(true)}>
                  Kill switch
                </Button>
              )}
            </Toolbar>
          </AppBar>

          {killed && (
            <Alert severity="error" icon={<PowerSettingsNewIcon />} sx={{ mx: 3, mb: 1 }}>
              <b>Kill switch is on.</b> Agent commands run with every variable unset, and terminals clear theirs on the next prompt. The dashboard still works.
            </Alert>
          )}
          {state?.approvals?.map((a) => (
            <Alert
              key={a.id}
              severity="warning"
              sx={{ mx: 3, mb: 1 }}
              action={
                <>
                  <Button color="inherit" onClick={() => api(`/approvals/${a.id}`, { method: 'POST', body: { approve: false } }).then(refresh).catch(guard)}>
                    Deny
                  </Button>
                  <Button color="inherit" variant="outlined" sx={{ ml: 1 }} onClick={() => api(`/approvals/${a.id}`, { method: 'POST', body: { approve: true } }).then(() => { notify(`Approved ${a.env}`); refresh(); }).catch(guard)}>
                    Approve
                  </Button>
                </>
              }
            >
              The agent is asking to activate <b>{a.env}</b> in group <b>{a.group}</b>.
            </Alert>
          ))}
          {fatal && (
            <Alert severity="error" sx={{ mx: 3, mb: 1 }} onClose={() => setFatal(null)}>
              {fatal}
            </Alert>
          )}

          <Box sx={{ p: { xs: 2, md: 3 }, pt: 1, flex: 1, minWidth: 0 }}>{data ? <Screen /> : <Typography color="text.secondary">Create a group to get started.</Typography>}</Box>
        </Box>
      </Box>

      <Confirm
        open={killAsk}
        danger
        title="Cut all agent access?"
        body="Every agent command will run with all secrets unset, active environments are cleared, and your terminals clear their variables on the next prompt. Your access policies stay as they are."
        confirmLabel="Kill switch"
        onCancel={() => setKillAsk(false)}
        onConfirm={() => {
          setKillAsk(false);
          api('/kill', { method: 'POST', body: { on: true } }).then(() => { notify('Kill switch on. Agent access cut.'); refresh(); }).catch(guard);
        }}
      />
      <NewGroupDialog
        open={groupDlg}
        first={state && state.groups.length === 0}
        onClose={() => setGroupDlg(false)}
        onCreated={(name) => {
          setGroup(name);
          setGroupDlg(false);
          notify(`Created group ${name} with dev, uat and prod`);
          refresh();
        }}
      />
      <Snackbar open={Boolean(snack)} autoHideDuration={3500} onClose={() => setSnack(null)} message={snack} />
    </Ctx.Provider>
  );
}

function NewGroupDialog({ open, first, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const submit = async () => {
    try {
      const n = name.trim().toLowerCase().replace(/\s+/g, '-');
      await api('/groups', { method: 'POST', body: { name: n } });
      setName('');
      setErr('');
      onCreated(n);
    } catch (e) {
      setErr(e.message);
    }
  };
  return (
    <Dialog open={open} onClose={first ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{first ? 'Create your first group' : 'New group'}</DialogTitle>
      <DialogContent sx={{ display: 'grid', gap: 2, pt: '8px !important' }}>
        <DialogContentText>A group is one project or stack. It starts with dev, uat and prod, each with its own values.</DialogContentText>
        <TextField autoFocus label="Group name" placeholder="payments-service" value={name} onChange={(e) => setName(e.target.value)} error={Boolean(err)} helperText={err || 'Lowercase letters, numbers and hyphens'} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      </DialogContent>
      <DialogActions sx={{ p: 2 }}>
        {!first && <Button onClick={onClose}>Cancel</Button>}
        <Button variant="contained" onClick={submit}>
          Create group
        </Button>
      </DialogActions>
    </Dialog>
  );
}

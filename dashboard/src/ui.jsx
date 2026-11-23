import { Select, MenuItem, ToggleButton, ToggleButtonGroup, Chip, Box, Dialog, DialogTitle, DialogContent, DialogActions, Button, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';

export const LEVELS = ['none', 'use', 'write'];
const COLOR = { none: 'error', use: 'success', write: 'warning' };

const tint = (c) => (t) => ({
  bgcolor: alpha(t.palette[c].main, t.palette.mode === 'dark' ? 0.22 : 0.16),
  color: t.palette.mode === 'dark' ? t.palette[c].main : t.palette[c].dark ?? t.palette[c].main,
});

export function AccessSelect({ value, onChange, dead, disabled }) {
  return (
    <Select
      size="small"
      value={value ?? 'none'}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      sx={(t) => ({
        ...tint(COLOR[value ?? 'none'])(t),
        borderRadius: 2,
        fontWeight: 500,
        fontSize: 13,
        textDecoration: dead ? 'line-through' : 'none',
        '& .MuiOutlinedInput-notchedOutline': { border: 0 },
        '& .MuiSelect-select': { py: 0.5 },
      })}
    >
      {LEVELS.map((l) => (
        <MenuItem key={l} value={l}>
          {l}
        </MenuItem>
      ))}
    </Select>
  );
}

export function LevelChip({ level }) {
  return <Chip size="small" label={level} sx={(t) => ({ ...tint(COLOR[level] ?? 'success')(t), fontWeight: 500 })} />;
}

const DOT = { dev: '#2e9e5b', uat: '#d99100', prod: '#d1382c' };
export function EnvToggle({ envs, value, onChange }) {
  return (
    <ToggleButtonGroup exclusive size="small" value={value} onChange={(_, v) => v && onChange(v)} sx={{ '& .MuiToggleButton-root': { borderRadius: 5, px: 2, textTransform: 'none', gap: 1 } }}>
      {envs.map((e) => (
        <ToggleButton key={e} value={e}>
          <Box component="span" sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: DOT[e] || 'primary.main' }} />
          {e}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}

export function Confirm({ open, title, body, confirmLabel = 'Confirm', danger, onCancel, onConfirm }) {
  return (
    <Dialog open={open} onClose={onCancel} maxWidth="xs" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <Typography color="text.secondary">{body}</Typography>
      </DialogContent>
      <DialogActions sx={{ p: 2 }}>
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="contained" color={danger ? 'error' : 'primary'} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export const labelOf = { read_only: 'Read-only', write: 'Write', full: 'Full' };

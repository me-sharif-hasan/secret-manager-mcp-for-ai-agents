import { createTheme } from '@mui/material/styles';

/** Material 3 flavoured theme (teal seed). Follows the OS light/dark setting. */
export function makeTheme(mode) {
  const dark = mode === 'dark';
  return createTheme({
    palette: {
      mode,
      primary: { main: dark ? '#4dd9d9' : '#00696b', contrastText: dark ? '#003737' : '#ffffff' },
      secondary: { main: dark ? '#b1cccb' : '#4a6363' },
      error: { main: dark ? '#ffb4ab' : '#ba1a1a' },
      success: { main: dark ? '#6fd88a' : '#1b6b35' },
      warning: { main: dark ? '#f0b94f' : '#8a5a00' },
      background: { default: dark ? '#0e1415' : '#f4fafa', paper: dark ? '#151c1d' : '#ffffff' },
      divider: dark ? '#2f3b3c' : '#cfdada',
      text: { primary: dark ? '#dee4e3' : '#161d1d', secondary: dark ? '#bec8c8' : '#3f4948' },
    },
    shape: { borderRadius: 14 },
    typography: {
      fontFamily: '"Roboto", system-ui, sans-serif',
      h5: { fontWeight: 400, fontSize: '1.5rem' },
      h6: { fontWeight: 500 },
      button: { textTransform: 'none', fontWeight: 500, letterSpacing: '.01em' },
    },
    components: {
      MuiButton: { styleOverrides: { root: { borderRadius: 20, height: 40, paddingInline: 22 } } },
      MuiCard: { defaultProps: { variant: 'outlined' }, styleOverrides: { root: { borderRadius: 16 } } },
      MuiPaper: { styleOverrides: { root: { backgroundImage: 'none' } } },
      MuiTableCell: { styleOverrides: { head: { fontWeight: 500, fontSize: 12, letterSpacing: '.04em', color: dark ? '#bec8c8' : '#3f4948' } } },
      MuiDialog: { styleOverrides: { paper: { borderRadius: 28 } } },
    },
  });
}

export const mono = { fontFamily: '"Roboto Mono", ui-monospace, Menlo, monospace', fontSize: 13 };

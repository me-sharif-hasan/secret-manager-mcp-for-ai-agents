import React from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider, CssBaseline, useMediaQuery } from '@mui/material';
import '@fontsource/roboto/400.css';
import '@fontsource/roboto/500.css';
import '@fontsource/roboto-mono/400.css';
import { makeTheme } from './theme.js';
import { initToken } from './api.js';
import App from './App.jsx';

initToken();

function Root() {
  const dark = useMediaQuery('(prefers-color-scheme: dark)');
  const theme = React.useMemo(() => makeTheme(dark ? 'dark' : 'light'), [dark]);
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <App />
    </ThemeProvider>
  );
}

createRoot(document.getElementById('root')).render(<Root />);

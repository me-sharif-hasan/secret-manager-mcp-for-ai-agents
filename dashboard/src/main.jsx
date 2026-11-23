import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/roboto/400.css';
import '@fontsource/roboto/500.css';
import '@fontsource/roboto-mono/400.css';
import './styles.css';
import { initToken } from './api.js';
import App from './App.jsx';

initToken();
createRoot(document.getElementById('root')).render(<App />);

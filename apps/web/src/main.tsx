import '@fontsource-variable/manrope';
import '@fontsource-variable/dm-sans';
import './design/tokens.css';
import './design/base.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';

const root = document.getElementById('root');
if (!root) throw new Error('index.html is missing #root');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

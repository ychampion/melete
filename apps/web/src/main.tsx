import '@fontsource-variable/dm-sans';
import '@fontsource-variable/newsreader/opsz.css';
import './design/tokens.css';
import './design/base.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { registerServiceWorker } from './experience/push.ts';

const root = document.getElementById('root');
if (!root) throw new Error('index.html is missing #root');

registerServiceWorker();

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

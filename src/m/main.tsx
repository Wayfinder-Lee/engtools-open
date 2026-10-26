import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import './mu.css';
import MuApp from './MuApp';

createRoot(document.getElementById('root-mu')!).render(
  <StrictMode>
    <MuApp />
  </StrictMode>
);

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@rendiciones/shared/styles.css';

const root = createRoot(document.getElementById('root')!);

if (!import.meta.env.VITE_FIREBASE_API_KEY || !import.meta.env.VITE_FIREBASE_PROJECT_ID) {
  root.render(
    <div className="center-page">
      <div className="card login-card">
        <h2>Sitio en configuración</h2>
        <p className="muted">Falta conectar el proyecto de Firebase. Vuelve a intentarlo más tarde.</p>
      </div>
    </div>,
  );
} else {
  // Carga diferida: firebase.ts solo se inicializa si hay configuración.
  void import('./App').then(({ App }) =>
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    ),
  );
}

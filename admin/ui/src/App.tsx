import { useEffect, useState } from 'react';
import { api, hasToken } from './api';
import { Dashboard } from './pages/Dashboard';
import { Reports } from './pages/Reports';
import { Users } from './pages/Users';
import { Catalog } from './pages/Catalog';

const PAGES = {
  panel: { label: 'Panel', el: <Dashboard /> },
  rendiciones: { label: 'Rendiciones', el: <Reports /> },
  usuarios: { label: 'Usuarios', el: <Users /> },
  catalogo: { label: 'Áreas y categorías', el: <Catalog /> },
} as const;
type PageKey = keyof typeof PAGES;

export function App() {
  const [page, setPage] = useState<PageKey>('panel');
  const [session, setSession] = useState<{ ok: boolean; emulator: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hasToken()) {
      setError('Abre esta página usando el enlace que aparece en la consola al iniciar la app (npm run admin).');
      return;
    }
    api.get<{ ok: boolean; emulator: boolean }>('/session').then(setSession, (e) => setError(e.message));
  }, []);

  if (error) {
    return (
      <div className="center-page">
        <div className="card login-card"><h2>Sesión no válida</h2><p>{error}</p></div>
      </div>
    );
  }
  if (!session) return <div className="center-page muted">Cargando…</div>;

  return (
    <>
      <header className="topbar">
        <div className="brand">Rendiciones · Owner</div>
        <nav className="nav">
          {(Object.keys(PAGES) as PageKey[]).map((k) => (
            <a key={k} href="#" className={page === k ? 'active' : ''} onClick={(e) => { e.preventDefault(); setPage(k); }}>
              {PAGES[k].label}
            </a>
          ))}
        </nav>
        {session.emulator && <span className="badge manager_approved">EMULADOR</span>}
      </header>
      <main className="container">{PAGES[page].el}</main>
    </>
  );
}

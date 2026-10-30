import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Logo } from '@rendiciones/shared/Logo';
import { api, hasToken } from './api';
import { CompanyContext, type CompanyRow } from './hooks';
import { Dashboard } from './pages/Dashboard';
import { Reports } from './pages/Reports';
import { Companies } from './pages/Companies';
import { Users } from './pages/Users';
import { Flows } from './pages/Flows';
import { Catalog } from './pages/Catalog';
import { Notifications } from './pages/Notifications';
import { BusyOverlay, LogoLoader } from '@rendiciones/shared/Busy';

const PAGES: Record<string, { label: string; icon: string; el: (ctx: { refreshCount: () => void }) => ReactNode }> = {
  panel: { label: 'Panel', icon: '◧', el: () => <Dashboard /> },
  notificaciones: { label: 'Notificaciones', icon: '✉', el: ({ refreshCount }) => <Notifications onChanged={refreshCount} /> },
  rendiciones: { label: 'Rendiciones', icon: '☰', el: () => <Reports /> },
  empresas: { label: 'Empresas', icon: '▦', el: () => <Companies /> },
  usuarios: { label: 'Usuarios', icon: '◉', el: () => <Users /> },
  flujos: { label: 'Flujos de aprobación', icon: '⇉', el: () => <Flows /> },
  catalogo: { label: 'Áreas y categorías', icon: '▤', el: () => <Catalog /> },
};

interface Session {
  ok: boolean;
  emulator: boolean;
  webUrl: string;
}

export function App() {
  const [page, setPage] = useState('panel');
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [companyId, setCompanyIdState] = useState(() => {
    try {
      return localStorage.getItem('company') ?? '';
    } catch {
      return '';
    }
  });

  const setCompanyId = (id: string) => {
    setCompanyIdState(id);
    try {
      localStorage.setItem('company', id);
    } catch {
      /* ignorar */
    }
  };

  const [noticeCount, setNoticeCount] = useState(0);
  const refreshCount = useCallback(() => {
    api.get<{ count: number }>(`/notifications/count${companyId ? `?companyId=${companyId}` : ''}`).then(
      (r) => setNoticeCount(r.count),
      () => undefined,
    );
  }, [companyId]);

  // Contador de notificaciones: al cambiar de sección/empresa y cada 2 minutos.
  useEffect(() => {
    if (!session) return;
    refreshCount();
    const t = setInterval(refreshCount, 120_000);
    return () => clearInterval(t);
  }, [session, page, refreshCount]);

  const reloadCompanies = useCallback(async () => {
    const list = await api.get<CompanyRow[]>('/companies');
    setCompanies(list);
    setCompanyIdState((cur) => (cur && !list.some((c) => c.id === cur) ? '' : cur));
  }, []);

  useEffect(() => {
    if (!hasToken()) {
      setError('Abre esta página usando el enlace que aparece en la consola al iniciar la app (npm run admin).');
      return;
    }
    api.get<Session>('/session').then(
      (s) => {
        setSession(s);
        void reloadCompanies();
      },
      (e) => setError(e.message),
    );
  }, [reloadCompanies]);

  if (error) {
    return (
      <div className="center-page">
        <div className="card login-card">
          <h2>Sesión no válida</h2>
          <p>{error}</p>
        </div>
      </div>
    );
  }
  if (!session) return <LogoLoader page variant="admin" />;

  const companyName = (id: string | null | undefined) => companies.find((c) => c.id === id)?.name ?? id ?? '—';

  return (
    <CompanyContext.Provider value={{ companies, companyId, setCompanyId, reloadCompanies, companyName, webUrl: session.webUrl, goTo: setPage }}>
      <div className="shell admin-shell">
        <aside className="sidebar">
          <a
            href="#"
            className="sidebar-brand"
            title="Ir al inicio"
            onClick={(e) => {
              e.preventDefault();
              setPage('panel');
            }}
          >
            <Logo variant="admin" />
            <div>
              <div className="brand-name">Rendiciones</div>
              <div className="brand-sub">Panel owner</div>
            </div>
          </a>
          <div className="sidebar-company">
            <label htmlFor="company">Empresa</label>
            <select id="company" value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
              <option value="">Todas las empresas</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <nav className="side-nav">
            {Object.entries(PAGES).map(([k, p]) => (
              <a
                key={k}
                href="#"
                className={page === k ? 'active' : ''}
                onClick={(e) => {
                  e.preventDefault();
                  setPage(k);
                }}
              >
                <span className="nav-icon" aria-hidden="true">{p.icon}</span>
                <span>{p.label}</span>
                {k === 'notificaciones' && noticeCount > 0 && <span className="nav-count">{noticeCount}</span>}
              </a>
            ))}
          </nav>
          {session.emulator && <span className="badge pending sidebar-foot">EMULADOR</span>}
        </aside>
        <main className="main">
          <div className="container">{PAGES[page].el({ refreshCount })}</div>
        </main>
      </div>
      <BusyOverlay variant="admin" />
    </CompanyContext.Provider>
  );
}

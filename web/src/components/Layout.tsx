import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { Logo } from '@rendiciones/shared/Logo';
import { useAuth, useSession } from '../auth';
import { listPayments, listPendingForMe } from '../data';
import { useEmulator } from '../firebase';

export function Layout({ children }: { children: ReactNode }) {
  const { logout } = useAuth();
  const { profile, company, areaName } = useSession();
  const [pendingCount, setPendingCount] = useState(0);
  const [toPayCount, setToPayCount] = useState(0);
  const location = useLocation();

  // Contador de pendientes para aprobadores (se refresca al navegar).
  useEffect(() => {
    if (!profile.isApprover) return;
    listPendingForMe(company.id, profile.uid).then((r) => setPendingCount(r.length), () => undefined);
  }, [profile.isApprover, company.id, profile.uid, location.pathname]);

  useEffect(() => {
    if (!profile.paymentsUser) return;
    listPayments(company.id, profile.uid).then((r) => setToPayCount(r.filter((x) => x.status === 'approved').length), () => undefined);
  }, [profile.paymentsUser, company.id, profile.uid, location.pathname]);

  const initials = profile.displayName
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <div className="shell">
      <aside className="sidebar">
        <Link to="/" className="sidebar-brand" title="Ir al inicio">
          <Logo />
          <div>
            <div className="brand-name">Rendiciones</div>
            <div className="brand-sub">{company.name}</div>
          </div>
        </Link>
        <nav className="side-nav">
          <NavLink to="/" end>
            <span className="nav-icon" aria-hidden="true">☰</span>
            <span>Mis rendiciones</span>
          </NavLink>
          <NavLink to="/nueva">
            <span className="nav-icon" aria-hidden="true">＋</span>
            <span>Nueva rendición</span>
          </NavLink>
          <NavLink to="/carga-masiva">
            <span className="nav-icon" aria-hidden="true">⇪</span>
            <span>Carga masiva</span>
          </NavLink>
          {profile.isApprover && (
            <NavLink to="/aprobar">
              <span className="nav-icon" aria-hidden="true">✓</span>
              <span>Por aprobar</span>
              {pendingCount > 0 && <span className="nav-count">{pendingCount}</span>}
            </NavLink>
          )}
          {profile.paymentsUser && (
            <NavLink to="/pagos">
              <span className="nav-icon" aria-hidden="true">💳</span>
              <span>Pagos</span>
              {toPayCount > 0 && <span className="nav-count">{toPayCount}</span>}
            </NavLink>
          )}
        </nav>
        <div className="sidebar-user">
          <NavLink to="/perfil" className="user-link" title="Mi perfil">
            <div className="avatar" aria-hidden="true">{initials}</div>
            <div className="user-meta">
              <div className="strong small">{profile.displayName}</div>
              <div className="muted small">Mi perfil · {areaName}</div>
            </div>
          </NavLink>
          <button className="logout-btn" onClick={() => void logout()} title="Cerrar sesión">
            Salir
          </button>
        </div>
        {useEmulator && <span className="badge pending sidebar-foot">EMULADOR</span>}
      </aside>
      <main className="main">
        <div className="container">{children}</div>
      </main>
    </div>
  );
}

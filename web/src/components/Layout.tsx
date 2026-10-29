import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { Logo } from '@rendiciones/shared/Logo';
import { useAuth, useSession } from '../auth';
import { listPendingForMe } from '../data';
import { useEmulator } from '../firebase';

export function Layout({ children }: { children: ReactNode }) {
  const { logout } = useAuth();
  const { profile, company, areaName } = useSession();
  const [pendingCount, setPendingCount] = useState(0);
  const location = useLocation();

  // Contador de pendientes para aprobadores (se refresca al navegar).
  useEffect(() => {
    if (!profile.isApprover) return;
    listPendingForMe(company.id, profile.uid).then((r) => setPendingCount(r.length), () => undefined);
  }, [profile.isApprover, company.id, profile.uid, location.pathname]);

  const initials = profile.displayName
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <Logo />
          <div>
            <div className="brand-name">Rendiciones</div>
            <div className="brand-sub">{company.name}</div>
          </div>
        </div>
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
        </nav>
        <div className="sidebar-user">
          <div className="avatar" aria-hidden="true">{initials}</div>
          <div className="user-meta">
            <div className="strong small">{profile.displayName}</div>
            <div className="muted small">{areaName}</div>
          </div>
          <button className="icon-btn" onClick={() => void logout()} title="Cerrar sesión" aria-label="Cerrar sesión">
            ⎋
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

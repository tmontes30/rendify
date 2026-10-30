import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { Logo } from '@rendiciones/shared/Logo';
import { useAuth, useSession } from '../auth';
import { watchPayments, watchPendingForMe } from '../data';
import { useEmulator } from '../firebase';

export function Layout({ children }: { children: ReactNode }) {
  const { logout } = useAuth();
  const { profile, company, areaName } = useSession();
  const [pendingCount, setPendingCount] = useState(0);
  const [toPayCount, setToPayCount] = useState(0);

  const [toast, setToast] = useState<string | null>(null);

  // Contadores en vivo; avisa cuando llega algo nuevo.
  useEffect(() => {
    if (!profile.isApprover) return;
    let prev: number | null = null;
    return watchPendingForMe(company.id, profile.uid, (r) => {
      if (prev != null && r.length > prev) setToast(r.length - prev === 1 ? '🔔 Te llegó una rendición para aprobar' : `🔔 Te llegaron ${r.length - prev} rendiciones para aprobar`);
      prev = r.length;
      setPendingCount(r.length);
    });
  }, [profile.isApprover, company.id, profile.uid]);

  useEffect(() => {
    if (!profile.paymentsUser) return;
    let prev: number | null = null;
    return watchPayments(company.id, profile.uid, (r) => {
      const n = r.filter((x) => x.status === 'approved').length;
      if (prev != null && n > prev) setToast('💳 Hay una nueva rendición lista para pagar');
      prev = n;
      setToPayCount(n);
    });
  }, [profile.paymentsUser, company.id, profile.uid]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  const initials = profile.displayName
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <div className="shell">
      <aside className="sidebar">
        <Link to={profile.companyAdmin ? '/personas' : profile.paymentsUser ? '/pagos' : profile.isApprover ? '/aprobar' : '/mis-rendiciones'} className="sidebar-brand" title="Ir al inicio">
          <Logo />
          <div>
            <div className="brand-name">Rendify</div>
            <div className="brand-sub">{company.name}</div>
          </div>
        </Link>
        <nav className="side-nav">
          {profile.isApprover && (
            <NavLink to="/aprobar">
              <span className="nav-icon" aria-hidden="true">✓</span>
              <span>Por aprobar</span>
              {pendingCount > 0 && <span className="nav-count">{pendingCount}</span>}
            </NavLink>
          )}
          {profile.companyAdmin && (
            <>
              <NavLink to="/personas">
                <span className="nav-icon" aria-hidden="true">👥</span>
                <span>Personas</span>
              </NavLink>
              <NavLink to="/flujos">
                <span className="nav-icon" aria-hidden="true">⇉</span>
                <span>Flujos de aprobación</span>
              </NavLink>
            </>
          )}
          {!profile.paymentsUser && !profile.companyAdmin && (
            <>
              <NavLink to="/mis-rendiciones">
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
            </>
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
      {toast && (
        <button className="live-toast" onClick={() => setToast(null)}>
          {toast}
        </button>
      )}
    </div>
  );
}

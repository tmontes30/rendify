import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { ROLE_LABELS } from '@rendiciones/shared';
import { useAuth, useProfile } from '../auth';
import { useEmulator } from '../firebase';

export function Layout({ children }: { children: ReactNode }) {
  const { logout } = useAuth();
  const { profile, areaName } = useProfile();
  return (
    <>
      <header className="topbar">
        <div className="brand">Rendición de gastos</div>
        <nav className="nav">
          <NavLink to="/" end>Mis rendiciones</NavLink>
          {profile.role === 'manager' && <NavLink to="/equipo">Revisar equipo</NavLink>}
        </nav>
        <div className="row small">
          {useEmulator && <span className="badge manager_approved">EMULADOR</span>}
          <span className="hide-sm muted">
            {profile.displayName} · {ROLE_LABELS[profile.role]} · {areaName}
          </span>
          <button onClick={() => void logout()}>Salir</button>
        </div>
      </header>
      <main className="container">{children}</main>
    </>
  );
}

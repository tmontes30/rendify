import { Logo } from '@rendiciones/shared/Logo';
import { useAuth } from '../auth';

/** Pantalla para cuentas sin acceso, o de empresas con el servicio suspendido. */
export function NoAccess({ suspended }: { suspended?: string }) {
  const { logout } = useAuth();
  return (
    <div className="center-page login-bg">
      <div className="card login-card">
        <div className="login-brand">
          <Logo size={44} />
          <div>
            <div className="brand-name">Rendiciones</div>
            <div className="brand-sub">{suspended || 'Rendición de gastos'}</div>
          </div>
        </div>
        {suspended !== undefined ? (
          <>
            <h1>Servicio suspendido temporalmente</h1>
            <p className="muted">
              El acceso a la plataforma de rendiciones de <b>{suspended}</b> está suspendido por el momento. Tus rendiciones y datos se
              mantienen guardados y volverán a estar disponibles cuando se reactive el servicio.
            </p>
            <p className="muted small">Para más información, contacta al área de administración de tu empresa.</p>
          </>
        ) : (
          <>
            <h1>Cuenta sin acceso</h1>
            <p className="muted">Tu cuenta no está habilitada o no tiene una empresa asignada. Contacta al administrador.</p>
          </>
        )}
        <button onClick={() => void logout()} style={{ width: '100%' }}>
          Cerrar sesión
        </button>
      </div>
    </div>
  );
}

import { useAuth } from '../auth';

export function NoAccess() {
  const { logout } = useAuth();
  return (
    <div className="center-page login-bg">
      <div className="card login-card">
        <h2>Cuenta sin acceso</h2>
        <p>Tu cuenta no está habilitada o no tiene un rol asignado. Contacta al administrador.</p>
        <button onClick={() => void logout()}>Cerrar sesión</button>
      </div>
    </div>
  );
}

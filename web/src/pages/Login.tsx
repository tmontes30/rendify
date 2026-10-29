import { useState, type FormEvent } from 'react';
import { Logo } from '@rendiciones/shared/Logo';
import { useAuth } from '../auth';

export function Login() {
  const { login, resetPassword } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'login' | 'reset'>('login');
  const [msg, setMsg] = useState<{ type: 'ok' | 'error'; text: string } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      if (mode === 'login') {
        await login(email, password, remember);
      } else {
        await resetPassword(email).catch(() => undefined);
        // Mensaje genérico: no revela si el correo existe.
        setMsg({ type: 'ok', text: 'Si el correo está registrado, recibirás un enlace para crear una nueva contraseña.' });
      }
    } catch (err) {
      const code = (err as { code?: string }).code ?? '';
      setMsg({
        type: 'error',
        text: code.includes('too-many-requests')
          ? 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.'
          : code.includes('user-disabled')
            ? 'Tu cuenta está deshabilitada. Contacta al administrador.'
            : 'Correo o contraseña incorrectos.',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center-page login-bg">
      <form className="card login-card" onSubmit={submit}>
        <div className="login-brand">
          <Logo size={44} />
          <div>
            <div className="brand-name">Rendiciones</div>
            <div className="brand-sub">Rendición de gastos</div>
          </div>
        </div>
        <h1>{mode === 'login' ? 'Ingresa a tu cuenta' : 'Recupera tu contraseña'}</h1>
        <p className="muted">{mode === 'login' ? 'Ingresa con el usuario que te entregó el administrador.' : 'Te enviaremos un enlace a tu correo.'}</p>
        <div className="field">
          <label htmlFor="email">Correo</label>
          <input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        {mode === 'login' && (
          <>
            <div className="field">
              <label htmlFor="password">Contraseña</label>
              <input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <label className="row" style={{ gap: 8, marginBottom: 12 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              Mantener sesión iniciada en este dispositivo
            </label>
          </>
        )}
        {msg && <div className={`alert ${msg.type}`} style={{ marginBottom: 12 }}>{msg.text}</div>}
        <button className="primary" type="submit" disabled={busy} style={{ width: '100%' }}>
          {busy ? 'Un momento…' : mode === 'login' ? 'Ingresar' : 'Enviar enlace'}
        </button>
        <p style={{ textAlign: 'center', marginBottom: 0 }}>
          <button type="button" className="link" onClick={() => { setMode(mode === 'login' ? 'reset' : 'login'); setMsg(null); }}>
            {mode === 'login' ? '¿Olvidaste tu contraseña?' : 'Volver a ingresar'}
          </button>
        </p>
      </form>
    </div>
  );
}

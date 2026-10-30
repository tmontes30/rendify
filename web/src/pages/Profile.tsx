import { useState, type FormEvent } from 'react';
import { EmailAuthProvider, reauthenticateWithCredential, updatePassword, updateProfile } from 'firebase/auth';
import { doc, updateDoc } from 'firebase/firestore';
import { LIMITS } from '@rendiciones/shared';
import { useAuth, useSession } from '../auth';
import { db } from '../firebase';
import { useGlobalBusy } from '@rendiciones/shared/Busy';

type Msg = { type: 'ok' | 'error'; text: string } | null;

export function Profile() {
  const { logout, resetPassword } = useAuth();
  const { profile, company, areaName, flow } = useSession();

  return (
    <div className="stack">
      <div className="page-header">
        <div>
          <h1>Mi perfil</h1>
          <p className="muted page-sub">Tus datos y tu contraseña.</p>
        </div>
        <button onClick={() => void logout()}>Cerrar sesión</button>
      </div>

      <div className="grid grid-2">
        <NameCard />
        <PasswordCard />
      </div>

      <div className="card">
        <h2>Tu cuenta</h2>
        <div className="info-grid">
          <Info label="Correo" value={profile.email} />
          <Info label="Empresa" value={company.name} />
          <Info label="Área" value={areaName} />
          <Info label="Flujo de aprobación" value={flow?.name ?? 'Sin flujo asignado'} />
          <Info label="Aprobador" value={profile.isApprover ? 'Sí, apruebas rendiciones de tu equipo' : 'No'} />
        </div>
        <p className="hint">Estos datos los gestiona el administrador. Si algo no corresponde, avísale.</p>
        <button className="link" style={{ paddingLeft: 0 }} onClick={() => resetPassword(profile.email).then(() => alert('Te enviamos un correo para restablecer tu contraseña.'))}>
          ¿Olvidaste tu contraseña actual? Recibir enlace por correo
        </button>
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="muted small">{label}</div>
      <div className="strong">{value}</div>
    </div>
  );
}

function NameCard() {
  const { refresh } = useAuth();
  const { profile, user } = useSession();
  const [name, setName] = useState(profile.displayName);
  const [busy, setBusy] = useGlobalBusy('Guardando…');
  const [msg, setMsg] = useState<Msg>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    const clean = name.trim().replace(/\s+/g, ' ');
    if (!clean) return setMsg({ type: 'error', text: 'El nombre no puede quedar vacío.' });
    if (clean === profile.displayName) return setMsg({ type: 'ok', text: 'Sin cambios.' });
    setBusy(true);
    setMsg(null);
    try {
      await updateDoc(doc(db, 'users', profile.uid), { displayName: clean });
      await updateProfile(user, { displayName: clean }).catch(() => undefined);
      await refresh();
      setName(clean);
      setMsg({ type: 'ok', text: '✓ Nombre actualizado.' });
    } catch {
      setMsg({ type: 'error', text: 'No se pudo guardar el nombre. Inténtalo de nuevo.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={save}>
      <h2>Nombre</h2>
      <div className="field">
        <label htmlFor="pn">Nombre completo</label>
        <input id="pn" required maxLength={LIMITS.name} value={name} onChange={(e) => setName(e.target.value)} />
        <div className="hint">Es el nombre que verán tus aprobadores en tus rendiciones nuevas.</div>
      </div>
      {msg && <div className={`alert ${msg.type}`}>{msg.text}</div>}
      <div className="row modal-actions">
        <button className="primary" type="submit" disabled={busy}>{busy ? 'Guardando…' : 'Guardar nombre'}</button>
      </div>
    </form>
  );
}

function PasswordCard() {
  const { user } = useSession();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useGlobalBusy('Guardando…');
  const [msg, setMsg] = useState<Msg>(null);

  const checks = [
    { ok: next.length >= 10, label: 'Mínimo 10 caracteres' },
    { ok: /[A-Za-z]/.test(next) && /\d/.test(next), label: 'Letras y números' },
    { ok: next.length > 0 && next === repeat, label: 'Las dos coinciden' },
    { ok: next.length > 0 && next !== current, label: 'Distinta a la actual' },
  ];
  const valid = checks.every((c) => c.ok) && current.length > 0;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!valid || !user.email) return;
    setBusy(true);
    setMsg(null);
    try {
      // Por seguridad, Firebase exige confirmar la contraseña actual antes de cambiarla.
      await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, current));
      await updatePassword(user, next);
      setCurrent('');
      setNext('');
      setRepeat('');
      setMsg({ type: 'ok', text: '✓ Contraseña actualizada. Úsala la próxima vez que ingreses.' });
    } catch (err) {
      const code = (err as { code?: string }).code ?? '';
      setMsg({
        type: 'error',
        text:
          code.includes('wrong-password') || code.includes('invalid-credential')
            ? 'La contraseña actual no es correcta.'
            : code.includes('too-many-requests')
              ? 'Demasiados intentos. Espera unos minutos.'
              : code.includes('password-does-not-meet-requirements') || code.includes('weak-password')
                ? 'La nueva contraseña no cumple los requisitos (mínimo 10 caracteres).'
                : 'No se pudo cambiar la contraseña. Inténtalo de nuevo.',
      });
    } finally {
      setBusy(false);
    }
  }

  const type = show ? 'text' : 'password';
  return (
    <form className="card" onSubmit={save}>
      <h2>Cambiar contraseña</h2>
      <div className="field">
        <label htmlFor="pc">Contraseña actual</label>
        <input id="pc" type={type} autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
      </div>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="pn1">Nueva contraseña</label>
          <input id="pn1" type={type} autoComplete="new-password" required value={next} onChange={(e) => setNext(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="pn2">Repetir nueva</label>
          <input id="pn2" type={type} autoComplete="new-password" required value={repeat} onChange={(e) => setRepeat(e.target.value)} />
        </div>
      </div>
      <ul className="pw-checks">
        {checks.map((c) => (
          <li key={c.label} className={c.ok ? 'ok' : ''}>{c.ok ? '✓' : '○'} {c.label}</li>
        ))}
      </ul>
      <label className="check" style={{ marginBottom: 8 }}>
        <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />
        <span className="small">Mostrar contraseñas</span>
      </label>
      {msg && <div className={`alert ${msg.type}`}>{msg.text}</div>}
      <div className="row modal-actions">
        <button className="primary" type="submit" disabled={busy || !valid}>{busy ? 'Guardando…' : 'Cambiar contraseña'}</button>
      </div>
    </form>
  );
}

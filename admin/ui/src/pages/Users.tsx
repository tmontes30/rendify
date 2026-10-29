import { useState, type FormEvent } from 'react';
import { ROLES, ROLE_LABELS, type Role } from '@rendiciones/shared';
import { api } from '../api';
import { fmtDateTime, useCatalog, useLoad } from '../hooks';

interface UserRow {
  uid: string;
  email: string;
  displayName: string;
  role: Role | null;
  areaId: string | null;
  active: boolean;
  disabled: boolean;
  lastSignIn: string | null;
  orphan?: boolean;
  missingAuth?: boolean;
}

/** Contraseña temporal aleatoria (sin caracteres ambiguos). */
function generatePassword(len = 14) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!#$%*?';
  const buf = new Uint32Array(len);
  crypto.getRandomValues(buf);
  return Array.from(buf, (n) => chars[n % chars.length]).join('');
}

export function Users() {
  const users = useLoad<UserRow[]>('/users');
  const { areas, areaName } = useCatalog();
  const [editing, setEditing] = useState<UserRow | 'new' | null>(null);
  const [filter, setFilter] = useState('');

  const rows = (users.data ?? []).filter((u) =>
    `${u.displayName} ${u.email} ${areaName(u.areaId)}`.toLowerCase().includes(filter.toLowerCase()),
  );
  const activeAreas = areas.data?.filter((a) => a.active) ?? [];

  async function toggle(u: UserRow) {
    const action = u.disabled || !u.active ? 'enable' : 'disable';
    if (action === 'disable' && !confirm(`¿Deshabilitar a ${u.displayName || u.email}? Perderá el acceso de inmediato.`)) return;
    try {
      await api.post(`/users/${u.uid}/${action}`);
      await users.reload();
    } catch (e) {
      alert((e as Error).message);
    }
  }

  return (
    <div className="stack">
      <div className="row spread">
        <h1>Usuarios</h1>
        <div className="row">
          <input placeholder="Buscar…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 220 }} />
          <button className="primary" onClick={() => setEditing('new')} disabled={!activeAreas.length}>+ Nuevo usuario</button>
        </div>
      </div>
      {!activeAreas.length && areas.data && (
        <div className="alert warn">Primero crea al menos un área en “Áreas y categorías”.</div>
      )}
      {users.error && <div className="alert error">{users.error}</div>}

      <div className="card table-wrap">
        {!users.data ? (
          <p className="muted">Cargando…</p>
        ) : (
          <table>
            <thead>
              <tr><th>Nombre</th><th>Correo</th><th>Rol</th><th>Área</th><th className="hide-sm">Último ingreso</th><th>Estado</th><th /></tr>
            </thead>
            <tbody>
              {rows.map((u) => {
                const enabled = u.active && !u.disabled;
                return (
                  <tr key={u.uid}>
                    <td>{u.displayName || <span className="muted">—</span>}</td>
                    <td className="small">{u.email}</td>
                    <td>{u.role ? ROLE_LABELS[u.role] : <span className="badge rejected">Sin perfil</span>}</td>
                    <td>{u.areaId ? areaName(u.areaId) : '—'}</td>
                    <td className="hide-sm small">{u.lastSignIn ? fmtDateTime(new Date(u.lastSignIn).toISOString()) : 'Nunca'}</td>
                    <td><span className={`badge ${enabled ? 'approved' : 'rejected'}`}>{enabled ? 'Activo' : 'Deshabilitado'}</span></td>
                    <td className="num">
                      <button className="link" onClick={() => setEditing(u)}>{u.orphan ? 'Asignar perfil' : 'Editar'}</button>
                      {!u.missingAuth && (
                        <button className="link" onClick={() => toggle(u)}>{enabled ? 'Deshabilitar' : 'Habilitar'}</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {editing && (
        <UserModal
          user={editing === 'new' ? null : editing}
          areas={activeAreas}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void users.reload(); }}
        />
      )}
    </div>
  );
}

function UserModal({
  user, areas, onClose, onSaved,
}: {
  user: UserRow | null;
  areas: { id: string; name: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = !user;
  const [email, setEmail] = useState(user?.email ?? '');
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [role, setRole] = useState<Role>(user?.role ?? 'worker');
  const [areaId, setAreaId] = useState(user?.areaId ?? areas[0]?.id ?? '');
  const [password, setPassword] = useState(isNew ? generatePassword() : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ email: string; password: string } | null>(null);
  const [resetLink, setResetLink] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (isNew) {
        await api.post('/users', { email, displayName, role, areaId, password });
        setCreated({ email, password });
        return;
      }
      if (user?.orphan) {
        await api.post(`/users/${user!.uid}/profile`, { displayName, role, areaId });
      } else {
        await api.patch(`/users/${user!.uid}`, { displayName, role, areaId });
        if (password) await api.post(`/users/${user!.uid}/password`, { password });
      }
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function makeResetLink() {
    try {
      const { link } = await api.post<{ link: string }>(`/users/${user!.uid}/reset-link`);
      setResetLink(link);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (created) {
    const text = `Usuario: ${created.email}\nContraseña temporal: ${created.password}`;
    return (
      <div className="modal-backdrop">
        <div className="card modal">
          <h2>Usuario creado</h2>
          <p>Entrega estos datos al trabajador por un canal privado. La contraseña no se volverá a mostrar.</p>
          <pre className="card" style={{ whiteSpace: 'pre-wrap' }}>{text}</pre>
          <p className="small muted">Recomiéndale cambiarla con “¿Olvidaste tu contraseña?” en la página de ingreso.</p>
          <div className="row">
            <button onClick={() => navigator.clipboard.writeText(text)}>Copiar</button>
            <button className="primary" onClick={onSaved}>Listo</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="card modal" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h2>{isNew ? 'Nuevo usuario' : user?.orphan ? 'Asignar perfil' : 'Editar usuario'}</h2>
        <div className="field">
          <label htmlFor="email">Correo</label>
          <input id="email" type="email" required value={email} disabled={!isNew} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="name">Nombre completo</label>
          <input id="name" required maxLength={100} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </div>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="role">Rol</label>
            <select id="role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="area">Área</label>
            <select id="area" required value={areaId} onChange={(e) => setAreaId(e.target.value)}>
              {areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
        </div>
        {!user?.orphan && (
          <div className="field">
            <label htmlFor="pw">{isNew ? 'Contraseña temporal' : 'Nueva contraseña (opcional)'}</label>
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <input id="pw" minLength={10} required={isNew} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
              <button type="button" onClick={() => setPassword(generatePassword())}>Generar</button>
            </div>
          </div>
        )}
        {!isNew && !user?.orphan && (
          <div className="field">
            <button type="button" className="link" onClick={makeResetLink}>Generar enlace para que el usuario cree su contraseña</button>
            {resetLink && (
              <div className="alert ok small" style={{ wordBreak: 'break-all' }}>
                {resetLink}{' '}
                <button type="button" className="link" onClick={() => navigator.clipboard.writeText(resetLink)}>Copiar</button>
              </div>
            )}
          </div>
        )}
        {error && <div className="alert error">{error}</div>}
        <div className="row" style={{ marginTop: 12 }}>
          <button type="submit" className="primary" disabled={busy}>{busy ? 'Guardando…' : 'Guardar'}</button>
          <button type="button" onClick={onClose}>Cancelar</button>
        </div>
      </form>
    </div>
  );
}

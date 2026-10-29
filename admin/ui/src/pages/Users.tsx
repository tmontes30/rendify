import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { Modal, PageHeader } from '../components';
import { fmtDateTime, useCatalog, useCompany, useLoad } from '../hooks';

interface UserRow {
  uid: string;
  email: string;
  displayName: string;
  companyId: string | null;
  areaId?: string;
  flowId?: string | null;
  isApprover?: boolean;
  active: boolean;
  disabled: boolean;
  lastSignIn: string | null;
  orphan?: boolean;
}

/** Contraseña temporal aleatoria (sin caracteres ambiguos). */
function generatePassword(len = 14) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!#$%*?';
  const buf = new Uint32Array(len);
  crypto.getRandomValues(buf);
  return Array.from(buf, (n) => chars[n % chars.length]).join('');
}

export function Users() {
  const { companyId, companyName, companies } = useCompany();
  const users = useLoad<UserRow[]>(companyId ? `/users?companyId=${companyId}` : '/users');
  const { areaName, flowName } = useCatalog(companyId || null);
  const [editing, setEditing] = useState<UserRow | 'new' | null>(null);
  const [filter, setFilter] = useState('');

  const rows = (users.data ?? []).filter((u) =>
    `${u.displayName} ${u.email} ${companyName(u.companyId)}`.toLowerCase().includes(filter.toLowerCase()),
  );

  async function toggle(u: UserRow) {
    const enabled = u.active && !u.disabled;
    if (enabled && !confirm(`¿Deshabilitar a ${u.displayName || u.email}? Perderá el acceso de inmediato.`)) return;
    try {
      await api.post(`/users/${u.uid}/${enabled ? 'disable' : 'enable'}`);
      await users.reload();
    } catch (e) {
      alert((e as Error).message);
    }
  }

  return (
    <div className="stack">
      <PageHeader
        title="Usuarios"
        subtitle={companyId ? companyName(companyId) : 'Todas las empresas'}
        actions={
          <>
            <input className="search" placeholder="Buscar…" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <button className="primary" onClick={() => setEditing('new')} disabled={!companies.length}>
              + Nuevo usuario
            </button>
          </>
        }
      />
      {!companies.length && <div className="alert warn">Primero crea una empresa en “Empresas”.</div>}
      {users.error && <div className="alert error">{users.error}</div>}

      <div className="card table-wrap">
        {!users.data ? (
          <p className="muted">Cargando…</p>
        ) : rows.length === 0 ? (
          <p className="muted">Sin usuarios.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Nombre</th>
                {!companyId && <th>Empresa</th>}
                {companyId && <th>Área</th>}
                {companyId && <th>Flujo</th>}
                <th className="hide-sm">Último ingreso</th>
                <th>Estado</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => {
                const enabled = u.active && !u.disabled;
                return (
                  <tr key={u.uid}>
                    <td>
                      <div className="strong">{u.displayName || '—'}</div>
                      <div className="muted small">{u.email}</div>
                      {u.isApprover && <span className="badge info">Aprobador</span>}
                    </td>
                    {!companyId && <td>{u.orphan ? <span className="badge rejected">Sin empresa</span> : companyName(u.companyId)}</td>}
                    {companyId && <td>{areaName(u.areaId)}</td>}
                    {companyId && <td>{u.flowId ? flowName(u.flowId) : <span className="badge pending">Sin flujo</span>}</td>}
                    <td className="hide-sm small">{u.lastSignIn ? fmtDateTime(new Date(u.lastSignIn).toISOString()) : 'Nunca'}</td>
                    <td>
                      <span className={`badge ${enabled ? 'approved' : 'rejected'}`}>{enabled ? 'Activo' : 'Deshabilitado'}</span>
                    </td>
                    <td className="num">
                      <button className="link" onClick={() => setEditing(u)}>{u.orphan ? 'Asignar a empresa' : 'Editar'}</button>
                      <button className="link" onClick={() => toggle(u)}>{enabled ? 'Deshabilitar' : 'Habilitar'}</button>
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
          defaultCompany={companyId || companies[0]?.id || ''}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void users.reload();
          }}
        />
      )}
    </div>
  );
}

function UserModal({ user, defaultCompany, onClose, onSaved }: { user: UserRow | null; defaultCompany: string; onClose: () => void; onSaved: () => void }) {
  const { companies } = useCompany();
  const isNew = !user;
  const isOrphan = !!user?.orphan;
  const [companyId, setCompanyId] = useState(user?.companyId ?? defaultCompany);
  const { areas, flows } = useCatalog(companyId);
  const [email, setEmail] = useState(user?.email ?? '');
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [areaId, setAreaId] = useState(user?.areaId ?? '');
  const [flowId, setFlowId] = useState(user?.flowId ?? '');
  const [password, setPassword] = useState(isNew ? generatePassword() : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ email: string; password: string } | null>(null);
  const [resetLink, setResetLink] = useState<string | null>(null);

  const activeAreas = areas.data?.filter((a) => a.active) ?? [];
  const effectiveArea = areaId || activeAreas[0]?.id || '';

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!effectiveArea) return setError('La empresa no tiene áreas. Créalas en “Áreas y categorías”.');
    setBusy(true);
    setError(null);
    try {
      if (isNew) {
        await api.post('/users', { email, displayName, companyId, areaId: effectiveArea, flowId: flowId || null, password });
        setCreated({ email, password });
        return;
      }
      if (isOrphan) {
        await api.post(`/users/${user!.uid}/profile`, { displayName, companyId, areaId: effectiveArea, flowId: flowId || null });
        return onSaved();
      }
      await api.patch(`/users/${user!.uid}`, { displayName, areaId: effectiveArea, flowId: flowId || null });
      if (password) await api.post(`/users/${user!.uid}/password`, { password });
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
      <Modal title="Usuario creado" onClose={onSaved}>
        <p>Entrega estos datos por un canal privado. La contraseña no se volverá a mostrar.</p>
        <pre className="code-box">{text}</pre>
        <div className="row modal-actions">
          <button onClick={() => navigator.clipboard.writeText(text)}>Copiar</button>
          <button className="primary" onClick={onSaved}>Listo</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={isNew ? 'Nuevo usuario' : isOrphan ? 'Asignar a empresa' : 'Editar usuario'} onClose={onClose}>
      <form onSubmit={save}>
        <div className="field">
          <label htmlFor="uc">Empresa</label>
          <select id="uc" value={companyId} disabled={!isNew && !isOrphan} onChange={(e) => { setCompanyId(e.target.value); setAreaId(''); setFlowId(''); }}>
            {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="email">Correo (aquí le avisarás de aprobaciones)</label>
          <input id="email" type="email" required value={email} disabled={!isNew} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="name">Nombre completo</label>
          <input id="name" required maxLength={100} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </div>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="area">Área</label>
            <select id="area" required value={effectiveArea} onChange={(e) => setAreaId(e.target.value)}>
              {activeAreas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="flow">Flujo de aprobación</label>
            <select id="flow" value={flowId} onChange={(e) => setFlowId(e.target.value)}>
              <option value="">Sin flujo (no puede enviar)</option>
              {flows.data?.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </div>
        </div>
        <p className="hint">
          Para que alguien <b>apruebe</b>, agrégalo como aprobador dentro de un flujo (sección “Flujos de aprobación”). Puedes crear primero
          a los aprobadores y después los flujos.
        </p>
        {!isOrphan && <div className="field">
          <label htmlFor="pw">{isNew ? 'Contraseña temporal' : 'Nueva contraseña (opcional)'}</label>
          <div className="row nowrap">
            <input id="pw" minLength={10} required={isNew} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            <button type="button" onClick={() => setPassword(generatePassword())}>Generar</button>
          </div>
        </div>}
        {!isNew && !isOrphan && (
          <div className="field">
            <button type="button" className="link" onClick={makeResetLink}>Generar enlace para que cree su contraseña</button>
            {resetLink && (
              <div className="alert ok small" style={{ wordBreak: 'break-all' }}>
                {resetLink}{' '}
                <button type="button" className="link" onClick={() => navigator.clipboard.writeText(resetLink)}>Copiar</button>
              </div>
            )}
          </div>
        )}
        {error && <div className="alert error">{error}</div>}
        <div className="row modal-actions">
          <button type="submit" className="primary" disabled={busy}>{busy ? 'Guardando…' : 'Guardar'}</button>
          <button type="button" onClick={onClose}>Cancelar</button>
        </div>
      </form>
    </Modal>
  );
}

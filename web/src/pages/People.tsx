import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { LIMITS, formatRut, isValidRut, normalizeRut, type Area, type Flow } from '@rendiciones/shared';
import { useSession } from '../auth';
import { companyLink } from '../companyPath';
import { adminError, createPerson, listAreas, listFlows, listPeople, sendPasswordLink, updatePerson, type Person } from '../adminData';
import { LogoLoader, useGlobalBusy } from '@rendiciones/shared/Busy';

/** Contraseña temporal aleatoria (sin caracteres ambiguos). */
function generatePassword(len = 14) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!#$%*?';
  const buf = new Uint32Array(len);
  crypto.getRandomValues(buf);
  return Array.from(buf, (n) => chars[n % chars.length]).join('');
}

export function People() {
  const session = useSession();
  const { company, profile } = session;
  const [people, setPeople] = useState<Person[] | null>(null);
  const [areas, setAreas] = useState<Area[]>([]);
  const [flows, setFlows] = useState<Flow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Person | 'new' | null>(null);
  const [filter, setFilter] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, a, f] = await Promise.all([listPeople(company.id), listAreas(company.id), listFlows(company.id)]);
      setPeople(p);
      setAreas(a);
      setFlows(f);
    } catch (e) {
      setError(adminError(e));
    }
  }, [company.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const areaName = (id: string | null) => (id ? areas.find((a) => a.id === id)?.name ?? id : '');
  const flowName = (id: string | null) => (id ? flows.find((f) => f.id === id)?.name ?? id : null);
  const shown = (people ?? []).filter((p) =>
    `${p.displayName} ${p.email} ${areaName(p.areaId)} ${p.position ?? ''} ${p.rut ?? ''}`.toLowerCase().includes(filter.toLowerCase()),
  );

  async function toggle(p: Person) {
    if (p.active && !confirm(`¿Desactivar a ${p.displayName}? Perderá el acceso de inmediato.`)) return;
    try {
      await updatePerson(p.uid, { active: !p.active }, p);
      await load();
    } catch (e) {
      alert(adminError(e));
    }
  }

  async function resetLink(p: Person) {
    try {
      await sendPasswordLink(p.email);
      setMsg(`Se envió a ${p.email} un enlace para crear una nueva contraseña.`);
    } catch (e) {
      alert(adminError(e));
    }
  }

  return (
    <div className="stack">
      <div className="page-header">
        <div>
          <h1>Personas</h1>
          <p className="muted page-sub">Usuarios de {company.name}: crea cuentas, asigna área, flujo y usuarios de pagos.</p>
        </div>
        <div className="row">
          <input className="search" placeholder="Buscar…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button className="primary" onClick={() => setEditing('new')}>+ Nueva persona</button>
        </div>
      </div>
      {error && <div className="alert error">{error}</div>}
      {msg && <div className="alert ok">{msg}</div>}

      <div className="card table-wrap">
        {!people ? (
          <LogoLoader />
        ) : shown.length === 0 ? (
          <p className="muted">Sin resultados.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Persona</th>
                <th>Área</th>
                <th>Flujo</th>
                <th>Estado</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.uid}>
                  <td>
                    <div className="strong">{p.displayName}</div>
                    <div className="muted small">
                      {p.position ? `${p.position} · ` : ''}
                      {p.rut ? `${formatRut(p.rut)} · ` : ''}
                      {p.email}
                    </div>
                    <div className="row tight">
                      {p.isApprover && <span className="badge info">Aprobador</span>}
                      {p.paymentsUser && <span className="badge approved">💳 Pagos</span>}
                      {p.companyAdmin && <span className="badge resent">🗂 Admin. personal</span>}
                    </div>
                  </td>
                  <td>{p.areaId ? areaName(p.areaId) : <span className="muted small">Sin área</span>}</td>
                  <td>{p.paymentsUser || p.companyAdmin ? <span className="muted small">No rinde</span> : flowName(p.flowId) ?? <span className="badge pending">Sin flujo</span>}</td>
                  <td>
                    <span className={`badge ${p.active ? 'approved' : 'rejected'}`}>{p.active ? 'Activo' : 'Desactivado'}</span>
                  </td>
                  <td className="num">
                    <button className="link" onClick={() => setEditing(p)}>Editar</button>
                    <button className="link" onClick={() => resetLink(p)}>Enviar enlace de clave</button>
                    {p.uid !== profile.uid && (
                      <button className="link" onClick={() => toggle(p)}>{p.active ? 'Desactivar' : 'Activar'}</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p className="hint">
        Para que alguien <b>apruebe</b>, agrégalo como aprobador en un flujo (sección Flujos). “Usuario de pagos” permite elegirlo como
        “quién paga” en un flujo; esas personas no rinden gastos.
      </p>

      {editing && (
        <PersonModal
          person={editing === 'new' ? null : editing}
          areas={areas.filter((a) => a.active || (editing !== 'new' && a.id === editing.areaId))}
          flows={flows}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function PersonModal({
  person, areas, flows, onClose, onSaved,
}: {
  person: Person | null;
  areas: Area[];
  flows: Flow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const session = useSession();
  const isNew = !person;
  const [email, setEmail] = useState(person?.email ?? '');
  const [displayName, setDisplayName] = useState(person?.displayName ?? '');
  const [rut, setRut] = useState(person?.rut ? formatRut(person.rut) : '');
  const [position, setPosition] = useState(person?.position ?? '');
  const [areaId, setAreaId] = useState(person?.areaId ?? '');
  const [flowId, setFlowId] = useState(person?.flowId ?? '');
  const [paymentsUser, setPaymentsUser] = useState(!!person?.paymentsUser);
  const [password, setPassword] = useState(isNew ? generatePassword() : '');
  const [busy, setBusy] = useGlobalBusy('Guardando…');
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ email: string; password: string } | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!isValidRut(rut)) return setError('El RUT no es válido. Revisa el dígito verificador (ej: 12.345.678-5).');
    if (!position.trim()) return setError('Indica el cargo en la empresa.');
    setBusy(true);
    setError(null);
    try {
      const data = { displayName, rut: normalizeRut(rut)!, position, areaId: areaId || null, flowId: paymentsUser || person?.companyAdmin ? null : flowId || null, paymentsUser };
      if (isNew) {
        await createPerson(session, email, password, data);
        setCreated({ email: email.trim().toLowerCase(), password });
      } else {
        await updatePerson(person.uid, data, person);
        onSaved();
      }
    } catch (err) {
      setError(adminError(err));
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    const text = `Ingreso: ${companyLink(session.company.id)}\nUsuario: ${created.email}\nContraseña temporal: ${created.password}`;
    return (
      <div className="modal-backdrop">
        <div className="card modal">
          <h2>Persona creada</h2>
          <p>Entrega estos datos por un canal privado. La contraseña no se volverá a mostrar; puede cambiarla en “Mi perfil”.</p>
          <pre className="code-box">{text}</pre>
          <div className="row modal-actions">
            <button onClick={() => navigator.clipboard.writeText(text)}>Copiar</button>
            <button className="primary" onClick={onSaved}>Listo</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="card modal" onMouseDown={(e) => e.stopPropagation()} onSubmit={save}>
        <h2>{isNew ? 'Nueva persona' : 'Editar persona'}</h2>
        <div className="field">
          <label htmlFor="pe">Correo</label>
          <input id="pe" type="email" required disabled={!isNew} value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="pnm">Nombre completo</label>
          <input id="pnm" required maxLength={LIMITS.name} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </div>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="prut">RUT</label>
            <input id="prut" required placeholder="12.345.678-5" value={rut} onChange={(e) => setRut(e.target.value)} onBlur={() => isValidRut(rut) && setRut(formatRut(rut))} />
            {rut && !isValidRut(rut) && <div className="hint text-bad">RUT inválido</div>}
          </div>
          <div className="field">
            <label htmlFor="ppos">Cargo en la empresa</label>
            <input id="ppos" required maxLength={80} placeholder="Ej: Ejecutivo comercial" value={position} onChange={(e) => setPosition(e.target.value)} />
          </div>
        </div>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="pa">Área (opcional)</label>
            <select id="pa" value={areaId} onChange={(e) => setAreaId(e.target.value)}>
              <option value="">Sin área</option>
              {areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="pf">Flujo de aprobación</label>
            <select id="pf" value={paymentsUser || person?.companyAdmin ? '' : flowId} disabled={paymentsUser || !!person?.companyAdmin} onChange={(e) => setFlowId(e.target.value)}>
              <option value="">{paymentsUser || person?.companyAdmin ? 'No rinde gastos (perfil especial)' : 'Sin flujo (no puede enviar)'}</option>
              {flows.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </div>
        </div>
        <label className="check payments-check">
          <input type="checkbox" checked={paymentsUser} onChange={(e) => setPaymentsUser(e.target.checked)} />
          <span>
            <b>💳 Usuario de pagos</b>
            <span className="muted small"> — registra los pagos de las rendiciones aprobadas; no rinde gastos.</span>
          </span>
        </label>
        {isNew && (
          <div className="field">
            <label htmlFor="ppw">Contraseña temporal</label>
            <div className="row nowrap">
              <input id="ppw" minLength={10} required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
              <button type="button" onClick={() => setPassword(generatePassword())}>Generar</button>
            </div>
          </div>
        )}
        {error && <div className="alert error">{error}</div>}
        <div className="row modal-actions">
          <button type="submit" className="primary" disabled={busy}>{busy ? 'Guardando…' : 'Guardar'}</button>
          <button type="button" onClick={onClose}>Cancelar</button>
        </div>
      </form>
    </div>
  );
}

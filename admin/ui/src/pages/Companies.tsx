import { useState, type FormEvent } from 'react';
import { CURRENCIES, CURRENCY_CODES, STATUS_LABELS, formatTotals, type Currency, type Status, type Totals } from '@rendiciones/shared';
import { api } from '../api';
import { Modal, PageHeader } from '../components';
import { fmtDateTime, useCompany, useLoad, type CompanyRow } from '../hooks';

export function Companies() {
  const { companies, reloadCompanies, setCompanyId, companyId } = useCompany();
  const [editing, setEditing] = useState<CompanyRow | 'new' | null>(null);

  async function toggle(c: CompanyRow) {
    if (c.active && !confirm(`¿Desactivar ${c.name}? Sus usuarios seguirán existiendo; desactívalos en Usuarios si quieres cortar el acceso.`)) return;
    await api.patch(`/companies/${c.id}`, { active: !c.active }).catch((e) => alert(e.message));
    await reloadCompanies();
  }

  return (
    <div className="stack">
      <PageHeader
        title="Empresas"
        subtitle="Cada empresa tiene sus propias áreas, categorías, flujos y usuarios, aislados de las demás."
        actions={<button className="primary" onClick={() => setEditing('new')}>+ Nueva empresa</button>}
      />
      <div className="grid grid-cards">
        {companies.map((c) => (
          <div key={c.id} className={`card company-card${companyId === c.id ? ' selected' : ''}`}>
            <div className="row spread">
              <h3 style={{ margin: 0 }}>{c.name}</h3>
              <span className={`badge ${c.active ? 'approved' : 'rejected'}`}>{c.active ? 'Activa' : 'Inactiva'}</span>
            </div>
            <div className="muted small">
              Moneda base: {c.baseCurrency} · {c.activeUsers} usuario(s) activo(s)
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              <button className="primary" onClick={() => setCompanyId(c.id)} disabled={companyId === c.id}>
                {companyId === c.id ? 'Seleccionada' : 'Seleccionar'}
              </button>
              <button onClick={() => setEditing(c)}>Editar</button>
              <button className="link" onClick={() => toggle(c)}>{c.active ? 'Desactivar' : 'Activar'}</button>
            </div>
          </div>
        ))}
        {companies.length === 0 && <div className="card empty muted">Aún no hay empresas. Crea la primera.</div>}
      </div>
      {companyId && companies.some((c) => c.id === companyId) && <CompanySummary key={companyId} cid={companyId} />}
      {editing && (
        <CompanyModal
          company={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async (id) => {
            setEditing(null);
            await reloadCompanies();
            if (id) setCompanyId(id);
          }}
        />
      )}
    </div>
  );
}

function CompanyModal({ company, onClose, onSaved }: { company: CompanyRow | null; onClose: () => void; onSaved: (id?: string) => void }) {
  const [name, setName] = useState(company?.name ?? '');
  const [baseCurrency, setBase] = useState<Currency>(company?.baseCurrency ?? 'CLP');
  const [error, setError] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      if (company) {
        await api.patch(`/companies/${company.id}`, { name, baseCurrency });
        onSaved();
      } else {
        const { id } = await api.post<{ id: string }>('/companies', { name, baseCurrency });
        onSaved(id);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Modal title={company ? 'Editar empresa' : 'Nueva empresa'} onClose={onClose}>
      <form onSubmit={save}>
        <div className="field">
          <label htmlFor="cn">Nombre</label>
          <input id="cn" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="cb">Moneda base</label>
          <select id="cb" value={baseCurrency} onChange={(e) => setBase(e.target.value as Currency)}>
            {CURRENCY_CODES.map((c) => (
              <option key={c} value={c}>
                {c} — {CURRENCIES[c].name}
              </option>
            ))}
          </select>
          <div className="hint">Los montos mínimos de los flujos de aprobación se expresan en esta moneda.</div>
        </div>
        {error && <div className="alert error">{error}</div>}
        <div className="row modal-actions">
          <button type="submit" className="primary">Guardar</button>
          <button type="button" onClick={onClose}>Cancelar</button>
        </div>
      </form>
    </Modal>
  );
}

interface Summary {
  users: { total: number; active: number; approvers: number; withoutFlow: string[] };
  flows: { id: string; name: string; levels: number; users: number; hasPayer: boolean }[];
  areas: { total: number; active: number };
  categories: { total: number; active: number };
  reports: { total: number; byStatus: Partial<Record<Status, { count: number; totals: Totals }>>; waitingOwner: number };
  lastActivity: string | null;
}

function CompanySummary({ cid }: { cid: string }) {
  const { companyName, goTo } = useCompany();
  const { data, error } = useLoad<Summary>(`/companies/${cid}/summary`);
  const st = (s: Status) => data?.reports.byStatus[s];

  return (
    <div className="card summary-card">
      <div className="row spread">
        <h2 style={{ margin: 0 }}>{companyName(cid)}</h2>
        {data && <span className="muted small">Última actividad: {data.lastActivity ? fmtDateTime(data.lastActivity) : 'sin rendiciones aún'}</span>}
      </div>
      {error && <div className="alert error">{error}</div>}
      {!data ? (
        <p className="muted">Cargando resumen…</p>
      ) : (
        <>
          {(data.users.withoutFlow.length > 0 || data.reports.waitingOwner > 0 || data.flows.length === 0 || data.categories.active === 0 || data.flows.some((f) => !f.hasPayer)) && (
            <div className="stack" style={{ marginTop: 12 }}>
              {data.reports.waitingOwner > 0 && (
                <div className="alert warn">
                  {data.reports.waitingOwner} rendición(es) esperan <b>tu aprobación</b>.{' '}
                  <button className="link" onClick={() => goTo('rendiciones')}>Ver</button>
                </div>
              )}
              {data.flows.length === 0 && (
                <div className="alert warn">
                  No tiene flujos de aprobación: nadie puede enviar rendiciones.{' '}
                  <button className="link" onClick={() => goTo('flujos')}>Crear flujo</button>
                </div>
              )}
              {data.flows.some((f) => !f.hasPayer) && (
                <div className="alert warn">
                  Flujo(s) sin “quién paga”: {data.flows.filter((f) => !f.hasPayer).map((f) => f.name).join(', ')}.{' '}
                  <button className="link" onClick={() => goTo('flujos')}>Definir</button>
                </div>
              )}
              {data.users.withoutFlow.length > 0 && (
                <div className="alert warn">
                  {data.users.withoutFlow.length} persona(s) sin flujo (no pueden enviar): {data.users.withoutFlow.join(', ')}.{' '}
                  <button className="link" onClick={() => goTo('usuarios')}>Asignar</button>
                </div>
              )}
              {data.categories.active === 0 && (
                <div className="alert warn">
                  No tiene categorías de gasto activas. <button className="link" onClick={() => goTo('catalogo')}>Agregar</button>
                </div>
              )}
            </div>
          )}

          <div className="grid summary-tiles">
            <button className="sum-tile" onClick={() => goTo('usuarios')}>
              <span className="label">Personas activas</span>
              <span className="value">{data.users.active}</span>
              <span className="sub">{data.users.approvers} aprobador(es){data.users.total > data.users.active ? ` · ${data.users.total - data.users.active} deshabilitada(s)` : ''}</span>
            </button>
            <button className="sum-tile" onClick={() => goTo('flujos')}>
              <span className="label">Flujos de aprobación</span>
              <span className="value">{data.flows.length}</span>
              <span className="sub">{data.flows.map((f) => `${f.name} (${f.levels} niv. · ${f.users} pers.)`).join(' · ') || 'Ninguno'}</span>
            </button>
            <button className="sum-tile" onClick={() => goTo('catalogo')}>
              <span className="label">Áreas / Categorías</span>
              <span className="value">{data.areas.active} / {data.categories.active}</span>
              <span className="sub">activas</span>
            </button>
            <button className="sum-tile" onClick={() => goTo('rendiciones')}>
              <span className="label">Rendiciones</span>
              <span className="value">{data.reports.total}</span>
              <span className="sub">en total</span>
            </button>
          </div>

          <div className="status-strip">
            {(['pending', 'approved', 'paid', 'rejected', 'draft'] as Status[]).map((s) => (
              <div key={s} className="status-cell">
                <span className={`badge ${s}`}>{STATUS_LABELS[s]}</span>
                <span className="strong">{st(s)?.count ?? 0}</span>
                <span className="muted small">{st(s)?.count ? formatTotals(st(s)?.totals) : '—'}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

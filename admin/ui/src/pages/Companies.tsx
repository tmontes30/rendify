import { useState, type FormEvent } from 'react';
import { CURRENCIES, CURRENCY_CODES, type Currency } from '@rendiciones/shared';
import { api } from '../api';
import { Modal, PageHeader } from '../components';
import { useCompany, type CompanyRow } from '../hooks';

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

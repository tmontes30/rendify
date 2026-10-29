import type { ReactNode } from 'react';
import { useCompany } from './hooks';

/** Muestra un aviso si la página requiere una empresa seleccionada. */
export function NeedsCompany({ children }: { children: (cid: string) => ReactNode }) {
  const { companyId, companies, setCompanyId } = useCompany();
  if (companyId) return <>{children(companyId)}</>;
  return (
    <div className="card empty">
      <h3>Elige una empresa</h3>
      <p className="muted">Esta sección se gestiona por empresa.</p>
      {companies.length ? (
        <div className="row" style={{ justifyContent: 'center' }}>
          {companies.map((c) => (
            <button key={c.id} onClick={() => setCompanyId(c.id)}>
              {c.name}
            </button>
          ))}
        </div>
      ) : (
        <p className="muted">Primero crea una empresa en la sección “Empresas”.</p>
      )}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="muted page-sub">{subtitle}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className={`card modal${wide ? ' modal-wide' : ''}`} onMouseDown={(e) => e.stopPropagation()}>
        <div className="row spread modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Cerrar">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

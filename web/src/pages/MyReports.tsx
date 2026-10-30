import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { STATUS_LABELS, formatTotals, type Report, type Status } from '@rendiciones/shared';
import { useSession } from '../auth';
import { fmtDate, friendlyError, watchMyReports } from '../data';
import { ReportRow } from '../components/ReportRow';
import { LogoLoader } from '@rendiciones/shared/Busy';

const FILTERS: { key: Status | ''; label: string }[] = [
  { key: '', label: 'Todas' },
  { key: 'draft', label: STATUS_LABELS.draft },
  { key: 'pending', label: STATUS_LABELS.pending },
  { key: 'rejected', label: STATUS_LABELS.rejected },
  { key: 'approved', label: STATUS_LABELS.approved },
  { key: 'paid', label: STATUS_LABELS.paid },
];

export function MyReports() {
  const { profile, company } = useSession();
  const navigate = useNavigate();
  const [reports, setReports] = useState<Report[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Status | ''>('');
  const listRef = useRef<HTMLDivElement>(null);
  // Tocar una tarjeta filtra la lista (y vuelve a "Todas" si ya estaba elegida).
  const pick = (s: Status) => {
    setFilter((f) => (f === s ? '' : s));
    setTimeout(() => listRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  };

  useEffect(() => {
    // En vivo: los cambios de estado (aprobada, rechazada, pagada) aparecen solos.
    return watchMyReports(company.id, profile.uid, setReports, (e) => setError(friendlyError(e)));
  }, [company.id, profile.uid]);

  const count = (s: Status) => reports?.filter((r) => r.status === s).length ?? 0;
  const shown = (reports ?? []).filter((r) => !filter || r.status === filter);
  const firstName = profile.displayName.split(' ')[0];

  return (
    <div className="stack">
      <div className="page-header">
        <div>
          <h1>Hola, {firstName} 👋</h1>
          <p className="muted page-sub">Tus rendiciones de gastos en {company.name}.</p>
        </div>
        <div className="row">
          <Link to="/carga-masiva" className="btn">⇪ Carga masiva</Link>
          <Link to="/nueva" className="btn primary">+ Nueva rendición</Link>
        </div>
      </div>

      <div className="grid grid-tiles">
        <Tile label="En aprobación" value={count('pending')} tone="info" active={filter === 'pending'} onClick={() => pick('pending')} />
        <Tile label="Rechazadas (por corregir)" value={count('rejected')} tone="bad" active={filter === 'rejected'} onClick={() => pick('rejected')} />
        <Tile label="Aprobadas por pagar" value={count('approved')} tone="good" active={filter === 'approved'} onClick={() => pick('approved')} />
        <Tile label="Borradores" value={count('draft')} active={filter === 'draft'} onClick={() => pick('draft')} />
      </div>

      {error && <div className="alert error">{error}</div>}

      <div className="card" ref={listRef}>
        <nav className="tabs">
          {FILTERS.map((f) => (
            <button key={f.key || 'all'} className={filter === f.key ? 'active' : ''} onClick={() => setFilter(f.key)}>
              {f.label}
            </button>
          ))}
        </nav>
        {!reports ? (
          <LogoLoader />
        ) : shown.length === 0 ? (
          <div className="empty">
            {reports.length ? (
              <p className="muted">No hay rendiciones con ese estado.</p>
            ) : (
              <>
                <h3>Aún no tienes rendiciones</h3>
                <p className="muted">Crea la primera: agrega tus gastos y envíala en un solo paso.</p>
                <Link to="/nueva" className="btn primary">+ Nueva rendición</Link>
              </>
            )}
          </div>
        ) : (
          <div className="report-list">
            {shown.map((r) => (
              <ReportRow key={r.id} report={r} subtitle={`${r.itemCount} gasto(s) · ${r.periodFrom} → ${r.periodTo} · actualizada ${fmtDate(r.updatedAt)}`} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function Tile({
  label, value, tone, onClick, active,
}: {
  label: string;
  value: number | string;
  tone?: 'info' | 'good' | 'bad';
  onClick?: () => void;
  active?: boolean;
}) {
  if (onClick) {
    return (
      <button type="button" className={`card tile tile-btn${tone ? ` tone-${tone}` : ''}${active ? ' active' : ''}`} onClick={onClick} aria-pressed={active}>
        <div className="label">{label}</div>
        <div className="value">{value}</div>
        <div className="tile-hint">{active ? 'Mostrando · tocar para ver todas' : 'Ver'} →</div>
      </button>
    );
  }
  return (
    <div className={`card tile${tone ? ` tone-${tone}` : ''}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}

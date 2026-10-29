import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import type { Report } from '@rendiciones/shared';
import { useSession } from '../auth';
import { fmtDate, friendlyError, listApproverHistory, listPendingForMe } from '../data';
import { ReportRow } from '../components/ReportRow';

export function Approvals() {
  const { profile, company } = useSession();
  const flash = (useLocation().state as { flash?: string } | null)?.flash;
  const [tab, setTab] = useState<'pending' | 'history'>('pending');
  const [pending, setPending] = useState<Report[] | null>(null);
  const [history, setHistory] = useState<Report[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listPendingForMe(company.id, profile.uid).then(
      (rs) => setPending(rs.sort((a, b) => String(a.submittedAt).localeCompare(String(b.submittedAt)))),
      (e) => setError(friendlyError(e)),
    );
    listApproverHistory(company.id, profile.uid).then(setHistory, () => setHistory([]));
  }, [company.id, profile.uid]);

  const list = tab === 'pending' ? pending : history;

  return (
    <div className="stack">
      <div className="page-header">
        <div>
          <h1>Por aprobar</h1>
          <p className="muted page-sub">Rendiciones de tu equipo que esperan tu revisión.</p>
        </div>
      </div>
      {flash === 'approved' && <div className="alert ok">✓ Rendición aprobada.</div>}
      {flash === 'rejected' && <div className="alert ok">Rendición rechazada y devuelta al trabajador.</div>}
      {error && <div className="alert error">{error}</div>}

      <div className="card">
        <nav className="tabs">
          <button className={tab === 'pending' ? 'active' : ''} onClick={() => setTab('pending')}>
            Pendientes {pending ? `(${pending.length})` : ''}
          </button>
          <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
            Ya revisadas
          </button>
        </nav>
        {!list ? (
          <p className="muted">Cargando…</p>
        ) : list.length === 0 ? (
          <div className="empty muted">{tab === 'pending' ? 'No tienes rendiciones pendientes. 🎉' : 'Aún no has revisado rendiciones.'}</div>
        ) : (
          <div className="report-list">
            {list.map((r) => (
              <ReportRow key={r.id} report={r} subtitle={`${r.ownerName} · ${r.itemCount} gasto(s) · enviada ${fmtDate(r.submittedAt)}`} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

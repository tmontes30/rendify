import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { resubmissionInfo, type Report } from '@rendiciones/shared';
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

  const resent = (pending ?? []).filter((r) => resubmissionInfo(r).round > 1);
  const fresh = (pending ?? []).filter((r) => resubmissionInfo(r).round === 1);
  const sub = (r: Report) => `${r.ownerName} · ${r.itemCount} gasto(s) · enviada ${fmtDate(r.submittedAt)}`;

  return (
    <div className="stack">
      <div className="page-header">
        <div>
          <h1>Por aprobar</h1>
          <p className="muted page-sub">Rendiciones que esperan tu revisión. Ábrelas para ver el detalle y decidir.</p>
        </div>
        <div className="row">
          <Link to="/mis-rendiciones" className="btn">Mis rendiciones</Link>
          <Link to="/nueva" className="btn primary">+ Nueva rendición</Link>
        </div>
      </div>
      {flash === 'approved' && <div className="alert ok">✓ Rendición aprobada.</div>}
      {flash === 'rejected' && <div className="alert ok">Rendición rechazada y devuelta al trabajador con tu comentario.</div>}
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

        {tab === 'pending' &&
          (!pending ? (
            <p className="muted">Cargando…</p>
          ) : pending.length === 0 ? (
            <div className="empty muted">No tienes rendiciones pendientes. 🎉</div>
          ) : (
            <div className="stack">
              {resent.length > 0 && (
                <section>
                  <h3 className="group-title">
                    <span className="badge resent">↻ Reenviadas con corrección</span>
                    <span className="muted small">Las rechazaron antes y el trabajador las corrigió.</span>
                  </h3>
                  <div className="report-list">
                    {resent.map((r) => (
                      <ReportRow key={r.id} report={r} subtitle={sub(r)} />
                    ))}
                  </div>
                </section>
              )}
              {fresh.length > 0 && (
                <section>
                  {resent.length > 0 && (
                    <h3 className="group-title">
                      <span className="badge info">Nuevas</span>
                      <span className="muted small">Primer envío.</span>
                    </h3>
                  )}
                  <div className="report-list">
                    {fresh.map((r) => (
                      <ReportRow key={r.id} report={r} subtitle={sub(r)} />
                    ))}
                  </div>
                </section>
              )}
            </div>
          ))}

        {tab === 'history' &&
          (!history ? (
            <p className="muted">Cargando…</p>
          ) : history.length === 0 ? (
            <div className="empty muted">Aún no has revisado rendiciones.</div>
          ) : (
            <div className="report-list">
              {history.map((r) => (
                <ReportRow key={r.id} report={r} subtitle={sub(r)} />
              ))}
            </div>
          ))}
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatTotals, type Report } from '@rendiciones/shared';
import { useProfile } from '../auth';
import { fmtDate, friendlyError, listAreaReports } from '../data';
import { StatusBadge } from '../components/StatusBadge';

export function ManagerInbox() {
  const { profile, areaName } = useProfile();
  const navigate = useNavigate();
  const [reports, setReports] = useState<Report[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'pending' | 'history'>('pending');

  useEffect(() => {
    listAreaReports(profile.areaId).then(setReports, (e) => setError(friendlyError(e)));
  }, [profile.areaId]);

  // Borradores ajenos no se muestran; las rendiciones propias las revisa el owner.
  const others = (reports ?? []).filter((r) => r.ownerUid !== profile.uid && r.status !== 'draft');
  const pending = others.filter((r) => r.status === 'submitted');
  const shown = tab === 'pending' ? pending : others.filter((r) => r.status !== 'submitted');

  return (
    <div className="stack">
      <h1>Revisar equipo · {areaName}</h1>
      <nav className="nav">
        <a href="#" className={tab === 'pending' ? 'active' : ''} onClick={(e) => { e.preventDefault(); setTab('pending'); }}>
          Por revisar ({pending.length})
        </a>
        <a href="#" className={tab === 'history' ? 'active' : ''} onClick={(e) => { e.preventDefault(); setTab('history'); }}>
          Historial
        </a>
      </nav>
      {error && <div className="alert error">{error}</div>}
      <div className="card table-wrap">
        {!reports ? (
          <p className="muted">Cargando…</p>
        ) : shown.length === 0 ? (
          <p className="muted">{tab === 'pending' ? 'No hay rendiciones pendientes. 🎉' : 'Sin historial todavía.'}</p>
        ) : (
          <table>
            <thead>
              <tr><th>Trabajador</th><th>Título</th><th className="hide-sm">Período</th><th>Estado</th><th className="num">Total</th><th className="hide-sm">Enviada</th></tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => navigate(`/r/${r.id}`)}>
                  <td>{r.ownerName}</td>
                  <td>{r.title}</td>
                  <td className="hide-sm small">{r.periodFrom} → {r.periodTo}</td>
                  <td><StatusBadge status={r.status} /></td>
                  <td className="num">{formatTotals(r.totals)}</td>
                  <td className="hide-sm small muted">{fmtDate(r.submittedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

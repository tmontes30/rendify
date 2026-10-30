import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { formatTotals, type Currency, type Report, type Totals } from '@rendiciones/shared';
import { useSession } from '../auth';
import { fmtDate, friendlyError, listPayments, toDate } from '../data';
import { ReportRow } from '../components/ReportRow';
import { Tile } from './MyReports';
import { LogoLoader } from '@rendiciones/shared/Busy';

type Tab = 'topay' | 'paid' | 'all';

function addTotals(rs: Report[]): Totals {
  const t: Totals = {};
  for (const r of rs) for (const [c, v] of Object.entries(r.totals ?? {})) t[c as Currency] = (t[c as Currency] ?? 0) + (v ?? 0);
  return t;
}

export function Payments() {
  const { profile, company } = useSession();
  const flash = (useLocation().state as { flash?: string } | null)?.flash;
  const [reports, setReports] = useState<Report[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('topay');

  useEffect(() => {
    listPayments(company.id, profile.uid).then(setReports, (e) => setError(friendlyError(e)));
  }, [company.id, profile.uid]);

  const all = reports ?? [];
  const topay = all
    .filter((r) => r.status === 'approved')
    .sort((a, b) => (toDate(a.decidedAt)?.getTime() ?? 0) - (toDate(b.decidedAt)?.getTime() ?? 0));
  const paid = all
    .filter((r) => r.status === 'paid')
    .sort((a, b) => (toDate(b.paidAt)?.getTime() ?? 0) - (toDate(a.paidAt)?.getTime() ?? 0));
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
  const paidThisMonth = paid.filter((r) => (toDate(r.paidAt)?.getTime() ?? 0) >= monthStart);
  const shown = tab === 'topay' ? topay : tab === 'paid' ? paid : [...topay, ...paid];

  const sub = (r: Report) =>
    r.status === 'paid'
      ? `${r.ownerName} · pagada ${fmtDate(r.paidAt)}${r.payment?.reference ? ` · N° ${r.payment.reference}` : ''}`
      : `${r.ownerName} · ${r.itemCount} gasto(s) · aprobada ${fmtDate(r.decidedAt)}`;

  return (
    <div className="stack">
      <div className="page-header">
        <div>
          <h1>Pagos</h1>
          <p className="muted page-sub">Rendiciones con todas las aprobaciones listas en {company.name}. Ábrelas para registrar el pago.</p>
        </div>
      </div>
      {flash === 'paid' && <div className="alert ok">✓ Pago registrado.</div>}
      {error && <div className="alert error">{error}</div>}

      <div className="grid grid-tiles">
        <Tile label="Por pagar" value={topay.length} tone="info" active={tab === 'topay'} onClick={() => setTab('topay')} />
        <Tile label="Monto por pagar" value={formatTotals(addTotals(topay))} tone="bad" active={tab === 'topay'} onClick={() => setTab('topay')} />
        <Tile label="Pagadas este mes" value={paidThisMonth.length} tone="good" active={tab === 'paid'} onClick={() => setTab('paid')} />
        <Tile label="Monto pagado este mes" value={formatTotals(addTotals(paidThisMonth))} active={tab === 'paid'} onClick={() => setTab('paid')} />
      </div>

      <div className="card">
        <nav className="tabs">
          <button className={tab === 'topay' ? 'active' : ''} onClick={() => setTab('topay')}>
            Por pagar {reports ? `(${topay.length})` : ''}
          </button>
          <button className={tab === 'paid' ? 'active' : ''} onClick={() => setTab('paid')}>
            Pagadas {reports ? `(${paid.length})` : ''}
          </button>
          <button className={tab === 'all' ? 'active' : ''} onClick={() => setTab('all')}>
            Todas
          </button>
        </nav>
        {!reports ? (
          <LogoLoader />
        ) : shown.length === 0 ? (
          <div className="empty muted">{tab === 'topay' ? 'No hay rendiciones por pagar. 🎉' : 'Aún no hay pagos registrados.'}</div>
        ) : (
          <div className="report-list">
            {shown.map((r) => (
              <ReportRow key={r.id} report={r} subtitle={sub(r)} />
            ))}
          </div>
        )}
      </div>
      <p className="hint">Solo ves las rendiciones de los flujos donde eres “quién paga”.</p>
    </div>
  );
}

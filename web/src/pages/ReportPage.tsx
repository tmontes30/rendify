import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  DOC_TYPE_LABELS,
  EDITABLE_STATUSES,
  LIMITS,
  formatMoney,
  formatTotals,
  nextRequiredLevel,
  sumTotals,
  type Category,
  type Flow,
  type Item,
  type Report,
} from '@rendiciones/shared';
import { useSession } from '../auth';
import { decide, fmtDate, friendlyError, getFlow, getReport, listCategories } from '../data';
import { StatusBadge } from '../components/StatusBadge';
import { ReportEditor } from './ReportEditor';

export function ReportPage() {
  const { id = '' } = useParams();
  const session = useSession();
  const { profile, company } = session;
  const location = useLocation();
  const navigate = useNavigate();
  const flash = (location.state as { flash?: string } | null)?.flash;
  const [data, setData] = useState<{ report: Report; items: Item[] } | null>(null);
  const [flow, setFlow] = useState<Flow | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [r, cats] = await Promise.all([getReport(company.id, id), listCategories(company.id)]);
      if (!r) return setNotFound(true);
      setData(r);
      setCategories(cats);
      setFlow(r.report.flowId ? await getFlow(company.id, r.report.flowId) : null);
    } catch (e) {
      setError(friendlyError(e));
    }
  }, [company.id, id]);

  useEffect(() => {
    setEditing(false);
    void load();
  }, [load]);

  if (notFound) return <div className="card empty">Rendición no encontrada. <Link to="/">Volver</Link></div>;
  if (error && !data) return <div className="alert error">{error}</div>;
  if (!data) return <p className="muted">Cargando…</p>;

  const { report, items } = data;
  const isOwner = report.ownerUid === profile.uid;
  const editable = isOwner && EDITABLE_STATUSES.includes(report.status);
  if (editable && (report.status === 'draft' || editing)) return <ReportEditor key={report.id} existing={data} />;

  const canDecide = !isOwner && report.status === 'pending' && report.currentApprovers.includes(profile.uid);
  const catName = (cid: string) => categories.find((c) => c.id === cid)?.name ?? cid;
  const totals = sumTotals(items);
  const nameOf = (uid: string) => flow?.approverNames?.[uid] ?? 'Aprobador';

  return (
    <div className="stack">
      <Link to={isOwner ? '/' : '/aprobar'} className="back-link">← Volver</Link>

      {flash === 'sent' && <div className="alert ok">✓ Rendición enviada a aprobación.</div>}
      {flash === 'saved' && <div className="alert ok">✓ Borrador guardado.</div>}

      <div className="card hero-card">
        <div className="row spread">
          <div>
            <span className="eyebrow">{isOwner ? 'Mi rendición' : `Rendición de ${report.ownerName}`}</span>
            <h1 style={{ margin: '4px 0' }}>{report.title}</h1>
            <div className="row small muted">
              <StatusBadge status={report.status} />
              <span>{report.periodFrom} → {report.periodTo}</span>
              {report.submittedAt != null && <span>· enviada {fmtDate(report.submittedAt)}</span>}
            </div>
          </div>
          <div className="hero-total">
            <div className="muted small">Total</div>
            <div className="big-number">{formatTotals(totals)}</div>
            <div className="muted small">{items.length} gasto(s)</div>
          </div>
        </div>
        {editable && report.status === 'rejected' && (
          <div className="row" style={{ marginTop: 12 }}>
            <button className="primary" onClick={() => setEditing(true)}>Corregir y reenviar</button>
          </div>
        )}
      </div>

      <div className="grid grid-main">
        <div className="card table-wrap">
          <h2>Gastos</h2>
          <table>
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Categoría</th>
                <th>Descripción</th>
                <th className="hide-sm">Documento</th>
                <th className="num">Monto</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id}>
                  <td className="small">{it.date}</td>
                  <td>{catName(it.categoryId)}</td>
                  <td>
                    {it.description}
                    {it.vendor && <div className="muted small">{it.vendor}</div>}
                  </td>
                  <td className="hide-sm small">{DOC_TYPE_LABELS[it.docType]} {it.docNumber}</td>
                  <td className="num">{formatMoney(it.amount, it.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card">
          <h2>Aprobación</h2>
          <Timeline report={report} flow={flow} nameOf={nameOf} />
        </div>
      </div>

      {canDecide && (
        <DecisionBox
          report={report}
          items={items}
          flow={flow}
          onDone={async (decision) => {
            navigate('/aprobar', { replace: true, state: { flash: decision } });
          }}
        />
      )}
    </div>
  );

}

function DecisionBox({ report, items, flow, onDone }: { report: Report; items: Item[]; flow: Flow | null; onDone: (d: string) => void }) {
  const session = useSession();
  const { company } = session;
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const next = flow ? nextRequiredLevel(flow.levels, report.currentLevel, sumTotals(items), company.baseCurrency) : null;

  async function act(d: 'approved' | 'rejected') {
    if (d === 'rejected' && !comment.trim()) return setErr('Escribe el motivo del rechazo.');
    if (!confirm(d === 'approved' ? '¿Aprobar esta rendición?' : '¿Rechazar y devolver al trabajador?')) return;
    setBusy(true);
    setErr(null);
    try {
      await decide(session, report, items, d, comment);
      onDone(d);
    } catch (e) {
      setErr(friendlyError(e));
      setBusy(false);
    }
  }

  return (
    <div className="card decision-card">
      <h2>Tu decisión</h2>
      <p className="muted small">
        {next == null
          ? 'Si apruebas, la rendición queda aprobada y pasa a pago.'
          : `Si apruebas, pasa al siguiente nivel: ${flow?.levels[next].name}.`}
      </p>
      <div className="field">
        <label htmlFor="rc">Comentario (obligatorio si rechazas)</label>
        <textarea id="rc" maxLength={LIMITS.comment} value={comment} onChange={(e) => setComment(e.target.value)} />
      </div>
      {err && <div className="alert error">{err}</div>}
      <div className="row">
        <button className="primary" disabled={busy} onClick={() => act('approved')}>✓ Aprobar</button>
        <button className="danger" disabled={busy} onClick={() => act('rejected')}>Rechazar</button>
      </div>
    </div>
  );
}

function Timeline({ report, flow, nameOf }: { report: Report; flow: Flow | null; nameOf: (uid: string) => string }) {
  const done = report.approvals;
  return (
    <ol className="timeline">
      {report.status !== 'draft' && <li className="approved">Enviada por <b>{report.ownerName}</b> · {fmtDate(report.submittedAt)}</li>}
      {done.map((a, i) => (
        <li key={i} className={a.decision}>
          <b>{a.decision === 'approved' ? 'Aprobó' : 'Rechazó'}</b> {a.name} <span className="muted">({a.levelName})</span>
          <div className="muted small">{new Date(a.atMs).toLocaleString('es-CL')}</div>
          {a.comment && <div className="quote">“{a.comment}”</div>}
        </li>
      ))}
      {report.status === 'pending' && report.currentApprovers.length > 0 && (
        <li className="current">
          Esperando a <b>{report.currentApprovers.map(nameOf).join(' o ')}</b>
          <span className="muted"> ({flow?.levels[report.currentLevel]?.name ?? `Nivel ${report.currentLevel + 1}`})</span>
        </li>
      )}
      {report.status === 'pending' && report.currentApprovers.length === 0 && (
        <li className="current">Esperando aprobación de <b>Administración</b></li>
      )}
      {report.ownerReview && (
        <li className={report.ownerReview.decision}>
          <b>Administración {report.ownerReview.decision === 'approved' ? 'aprobó' : 'rechazó'}</b>
          {report.ownerReview.comment && <div className="quote">“{report.ownerReview.comment}”</div>}
        </li>
      )}
      {report.status === 'approved' && <li className="current">Aprobada · pendiente de pago</li>}
      {report.status === 'paid' && <li className="approved"><b>Pagada</b> · {fmtDate(report.paidAt)}</li>}
      {report.status === 'draft' && <li className="muted">Borrador, aún no se envía.</li>}
    </ol>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  DOC_TYPE_LABELS,
  EDITABLE_STATUSES,
  LIMITS,
  formatMoney,
  formatTotals,
  nextRequiredLevel,
  resubmissionInfo,
  categoryLabel,
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  type PaymentMethod,
  sumTotals,
  type Category,
  type Flow,
  type Item,
  type Report,
} from '@rendiciones/shared';
import { useSession } from '../auth';
import { decide, fmtDate, friendlyError, getFlow, getReport, listCategories, registerPayment, watchReportChanges } from '../data';
import { StatusBadge } from '../components/StatusBadge';
import { ResubmittedNotice } from '../components/ReportRow';
import { AttachmentsViewer } from '../components/Attachments';
import { ReportEditor } from './ReportEditor';
import { LogoLoader, useGlobalBusy } from '@rendiciones/shared/Busy';

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

  // Recargar también al volver a la misma rendición (p. ej. tras guardar la corrección
  // de una rechazada): cada navegación trae un location.key nuevo.
  useEffect(() => {
    setEditing(false);
    void load();
  }, [load, location.key]);

  // En vivo: si otra persona aprueba, rechaza o paga mientras la miras, se actualiza
  // (salvo que la estés editando).
  const editingRef = useRef(editing);
  editingRef.current = editing;
  useEffect(
    () =>
      watchReportChanges(company.id, id, () => {
        if (!editingRef.current) void load();
      }),
    [company.id, id, load],
  );

  if (notFound) return <div className="card empty">Rendición no encontrada. <Link to="/mis-rendiciones">Volver</Link></div>;
  if (error && !data) return <div className="alert error">{error}</div>;
  if (!data) return <LogoLoader />;

  const { report, items } = data;
  const isOwner = report.ownerUid === profile.uid;
  const editable = isOwner && EDITABLE_STATUSES.includes(report.status);
  if (editable && (report.status === 'draft' || editing)) return <ReportEditor key={report.id} existing={data} />;

  const canDecide = !isOwner && report.status === 'pending' && report.currentApprovers.includes(profile.uid);
  const isPayerHere = !isOwner && !!profile.paymentsUser && flow?.payerUid === profile.uid;
  const canPay = isPayerHere && report.status === 'approved';
  const catName = (cid: string) => categories.find((c) => c.id === cid)?.name ?? cid;
  const totals = sumTotals(items);
  const nameOf = (uid: string) => flow?.approverNames?.[uid] ?? 'Aprobador';

  return (
    <div className="stack">
      <Link to={isOwner ? '/mis-rendiciones' : isPayerHere && ['approved', 'paid'].includes(report.status) ? '/pagos' : '/aprobar'} className="back-link">
        ← Volver
      </Link>

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
                  <td>{categoryLabel(it, catName)}</td>
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
          <h2>📎 Fotos de respaldo</h2>
          <AttachmentsViewer cid={company.id} rid={report.id} paidAt={report.paidAt} deletedAt={report.photosDeletedAt} />
        </div>

        <div className="card">
          <h2>Aprobación</h2>
          <Timeline report={report} flow={flow} nameOf={nameOf} />
        </div>
      </div>

      {canPay && <PaymentBox report={report} onDone={() => navigate('/pagos', { replace: true, state: { flash: 'paid' } })} />}

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
  const [busy, setBusy] = useGlobalBusy('Guardando…');
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
      {resubmissionInfo(report).lastRejection && (
        <div style={{ marginBottom: 12 }}>
          <ResubmittedNotice info={resubmissionInfo(report)} owner={report.ownerName} />
        </div>
      )}
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
      {report.status === 'paid' && (
        <li className="approved">
          <b>Pagada</b> · {fmtDate(report.paidAt)}
          {report.payment && (
            <div className="muted small">
              {report.payment.name} · {PAYMENT_METHOD_LABELS[report.payment.method] ?? report.payment.method}
              {report.payment.reference && ` · N° ${report.payment.reference}`} · fecha de pago {report.payment.paidOn}
            </div>
          )}
          {report.payment?.comment && <div className="quote">“{report.payment.comment}”</div>}
        </li>
      )}
      {report.status === 'draft' && <li className="muted">Borrador, aún no se envía.</li>}
    </ol>
  );
}

/** Formulario para que el usuario de pagos registre el pago de una rendición aprobada. */
function PaymentBox({ report, onDone }: { report: Report; onDone: () => void }) {
  const session = useSession();
  const [method, setMethod] = useState<PaymentMethod>('transferencia');
  const [reference, setReference] = useState('');
  const [paidOn, setPaidOn] = useState(new Date().toISOString().slice(0, 10));
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useGlobalBusy('Guardando…');
  const [err, setErr] = useState<string | null>(null);

  async function pay() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) return setErr('Indica la fecha del pago.');
    if (!confirm(`¿Registrar el pago de ${formatTotals(report.totals)} a ${report.ownerName}?`)) return;
    setBusy(true);
    setErr(null);
    try {
      await registerPayment(session, report.id, { method, reference, paidOn, comment });
      onDone();
    } catch (e) {
      setErr(friendlyError(e));
      setBusy(false);
    }
  }

  return (
    <div className="card decision-card">
      <h2>💳 Registrar pago</h2>
      <p className="muted small">
        Aprobada por completo. Monto a pagar a <b>{report.ownerName}</b>: <b>{formatTotals(report.totals)}</b>.
      </p>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="pm">Método de pago</label>
          <select id="pm" value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
            {PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="pr">N° de comprobante u operación</label>
          <input id="pr" maxLength={80} placeholder="Opcional" value={reference} onChange={(e) => setReference(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="pd">Fecha de pago</label>
          <input id="pd" type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="pc2">Comentario (opcional)</label>
        <textarea id="pc2" maxLength={500} value={comment} onChange={(e) => setComment(e.target.value)} />
      </div>
      {err && <div className="alert error">{err}</div>}
      <div className="row">
        <button className="primary" disabled={busy} onClick={pay}>{busy ? 'Guardando…' : '✓ Marcar como pagada'}</button>
      </div>
    </div>
  );
}

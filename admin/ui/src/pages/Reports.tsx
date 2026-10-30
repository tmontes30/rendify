import { useState } from 'react';
import {
  DOC_TYPE_LABELS,
  STATUS_LABELS,
  formatMoney,
  formatTotals,
  resubmissionInfo,
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  type Payment,
  type PaymentMethod,
  type Approval,
  type Flow,
  type Item,
  type Status,
  type Totals,
} from '@rendiciones/shared';
import { api, qs } from '../api';
import { Modal, PageHeader } from '../components';
import { fmtDateTime, useCatalog, useCompany, useLoad } from '../hooks';

interface ReportOut {
  id: string;
  companyId: string;
  ownerUid: string;
  ownerName: string;
  areaId: string;
  flowId: string | null;
  title: string;
  periodFrom: string;
  periodTo: string;
  status: Status;
  totals: Totals;
  itemCount: number;
  currentLevel: number;
  currentApprovers: string[];
  approvals: Approval[];
  updatedAt: string | null;
  submittedAt: string | null;
  paidAt: string | null;
  ownerReview: { at: string | null; comment: string; decision: string } | null;
  payment?: Payment;
}
interface Detail {
  report: ReportOut;
  items: Item[];
  flow: Flow | null;
  computedTotals: Totals;
  totalsMismatch: boolean;
}

const TABS: { key: Status | ''; label: string }[] = [
  { key: '', label: 'Todas' },
  { key: 'pending', label: 'En aprobación' },
  { key: 'approved', label: 'Por pagar' },
  { key: 'paid', label: 'Pagadas' },
  { key: 'rejected', label: 'Rechazadas' },
  { key: 'draft', label: 'Borradores' },
];

export function Reports() {
  const { companyId, companyName } = useCompany();
  const [status, setStatus] = useState<Status | ''>('');
  const [open, setOpen] = useState<ReportOut | null>(null);
  const list = useLoad<ReportOut[]>(`/reports${qs({ status: status || undefined, companyId: companyId || undefined })}`);

  return (
    <div className="stack">
      <PageHeader title="Rendiciones" subtitle={companyId ? companyName(companyId) : 'Todas las empresas'} />
      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t.key || 'all'} className={status === t.key ? 'active' : ''} onClick={() => setStatus(t.key)}>
            {t.label}
          </button>
        ))}
      </nav>

      {list.error && <div className="alert error">{list.error}</div>}
      <div className="card table-wrap">
        {!list.data ? (
          <p className="muted">Cargando…</p>
        ) : list.data.length === 0 ? (
          <p className="muted">{status ? 'No hay rendiciones en este estado.' : 'Esta empresa aún no tiene rendiciones.'}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Rendición</th>
                {!companyId && <th>Empresa</th>}
                <th className="hide-sm">Período</th>
                <th>Estado</th>
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((r) => (
                <tr key={`${r.companyId}/${r.id}`} className="clickable" onClick={() => setOpen(r)}>
                  <td>
                    <div className="row tight">
                      <span className="strong">{r.title}</span>
                      {resubmissionInfo(r).round > 1 && <span className="badge resent">↻ {resubmissionInfo(r).round}° envío</span>}
                    </div>
                    <div className="muted small">{r.ownerName}</div>
                  </td>
                  {!companyId && <td>{companyName(r.companyId)}</td>}
                  <td className="hide-sm small">{r.periodFrom} → {r.periodTo}</td>
                  <td>
                    <span className={`badge ${r.status}`}>{STATUS_LABELS[r.status]}</span>
                    {r.status === 'pending' && (
                      <div className="muted small">{r.currentApprovers.length ? `Nivel ${r.currentLevel + 1}` : 'Te toca a ti'}</div>
                    )}
                  </td>
                  <td className="num">{formatTotals(r.totals)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {open && <ReportModal cid={open.companyId} id={open.id} onClose={() => setOpen(null)} onChanged={() => void list.reload()} />}
    </div>
  );
}

function ReportModal({ cid, id, onClose, onChanged }: { cid: string; id: string; onClose: () => void; onChanged: () => void }) {
  const { data, error, reload } = useLoad<Detail>(`/companies/${cid}/reports/${id}`);
  const { areaName, categoryName } = useCatalog(cid);
  const { companyName } = useCompany();
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'error'; text: string } | null>(null);
  const [notify, setNotify] = useState(false);
  const [method, setMethod] = useState<PaymentMethod>('transferencia');
  const [reference, setReference] = useState('');
  const [paidOn, setPaidOn] = useState(new Date().toISOString().slice(0, 10));

  async function act(action: 'approve' | 'reject' | 'pay', confirmText: string) {
    if (!confirm(confirmText)) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.post(`/companies/${cid}/reports/${id}/${action}`, action === 'pay' ? { method, reference, paidOn, comment } : { comment });
      setMsg({ type: 'ok', text: 'Listo.' });
      setComment('');
      await reload();
      onChanged();
    } catch (e) {
      setMsg({ type: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const r = data?.report;
  const levelName = (i: number) => data?.flow?.levels[i]?.name ?? `Nivel ${i + 1}`;
  const approverName = (uid: string) => data?.flow?.approverNames?.[uid] ?? uid;

  return (
    <Modal title={r?.title ?? 'Rendición'} onClose={onClose} wide>
      {error && <div className="alert error">{error}</div>}
      {!data || !r ? (
        <p className="muted">Cargando…</p>
      ) : (
        <div className="stack">
          <div className="row small">
            <span className={`badge ${r.status}`}>{STATUS_LABELS[r.status]}</span>
            <span><b>{r.ownerName}</b></span>
            <span>· {companyName(cid)} · {areaName(r.areaId)}</span>
            <span>· {r.periodFrom} → {r.periodTo}</span>
            <span className="muted">· enviada {fmtDateTime(r.submittedAt)}</span>
          </div>

          {data.totalsMismatch && (
            <div className="alert warn">
              Los totales guardados ({formatTotals(r.totals)}) no coinciden con la suma de los gastos ({formatTotals(data.computedTotals)}). Al
              aprobar o pagar se usará la suma de los gastos.
            </div>
          )}

          <div className="table-wrap">
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
                {data.items.map((it) => (
                  <tr key={it.id}>
                    <td className="small">{it.date}</td>
                    <td>{categoryName(it.categoryId)}</td>
                    <td>
                      {it.description}
                      {it.vendor && <div className="muted small">{it.vendor}</div>}
                    </td>
                    <td className="hide-sm small">{DOC_TYPE_LABELS[it.docType]} {it.docNumber}</td>
                    <td className="num">{formatMoney(it.amount, it.currency)}</td>
                  </tr>
                ))}
                <tr className="total-row">
                  <td colSpan={4}>Total</td>
                  <td className="num">{formatTotals(data.computedTotals)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div>
            <h3>Recorrido de aprobación {data.flow && <span className="muted small">· flujo “{data.flow.name}”</span>}</h3>
            <ol className="timeline">
              {r.approvals.map((a, i) => (
                <li key={i} className={a.decision}>
                  <b>{a.decision === 'approved' ? 'Aprobó' : 'Rechazó'}</b> {a.name} ({a.levelName}) · {new Date(a.atMs).toLocaleString('es-CL')}
                  {a.comment && <div className="muted">“{a.comment}”</div>}
                </li>
              ))}
              {r.status === 'pending' && r.currentApprovers.length > 0 && (
                <li className="current">
                  Esperando a <b>{r.currentApprovers.map(approverName).join(', ')}</b> ({levelName(r.currentLevel)})
                </li>
              )}
              {r.status === 'pending' && r.currentApprovers.length === 0 && (
                <li className="current">
                  Esperando <b>tu aprobación</b> (quien la envió es el último nivel de su flujo)
                </li>
              )}
              {r.ownerReview && (
                <li className={r.ownerReview.decision}>
                  <b>Owner {r.ownerReview.decision === 'approved' ? 'aprobó' : 'rechazó'}</b> · {fmtDateTime(r.ownerReview.at)}
                  {r.ownerReview.comment && <div className="muted">“{r.ownerReview.comment}”</div>}
                </li>
              )}
              {r.paidAt && (
                <li className="approved">
                  <b>Pagada</b> · {fmtDateTime(r.paidAt)}
                  {r.payment && (
                    <div className="muted">
                      {r.payment.name} · {PAYMENT_METHOD_LABELS[r.payment.method] ?? r.payment.method}
                      {r.payment.reference && ` · N° ${r.payment.reference}`} · fecha de pago {r.payment.paidOn}
                      {r.payment.comment && ` · “${r.payment.comment}”`}
                    </div>
                  )}
                </li>
              )}
              {!r.approvals.length && r.status === 'draft' && <li className="muted">Aún no se envía.</li>}
            </ol>
          </div>

          {r.status !== 'draft' && (
            <div className="row">
              <button onClick={() => setNotify(true)}>✉ Avisar por correo</button>
            </div>
          )}

          {['pending', 'approved'].includes(r.status) && (
            <div className="card soft">
              <div className="field">
                <label htmlFor="comment">Comentario (obligatorio para rechazar)</label>
                <textarea id="comment" value={comment} maxLength={500} onChange={(e) => setComment(e.target.value)} />
              </div>
              <div className="row">
                {r.status === 'pending' && (
                  <button className="primary" disabled={busy} onClick={() => act('approve', '¿Aprobar directamente, saltando los niveles pendientes?')}>
                    Aprobar (owner)
                  </button>
                )}
                {r.status === 'approved' && (
                  <>
                    <select value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)} style={{ width: 'auto' }} aria-label="Método de pago">
                      {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>)}
                    </select>
                    <input placeholder="N° comprobante" value={reference} maxLength={80} onChange={(e) => setReference(e.target.value)} style={{ width: 160 }} />
                    <input type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} style={{ width: 'auto' }} aria-label="Fecha de pago" />
                    <button className="primary" disabled={busy} onClick={() => act('pay', '¿Marcar como pagada?')}>Marcar pagada</button>
                  </>
                )}
                <button className="danger" disabled={busy || !comment.trim()} onClick={() => act('reject', '¿Rechazar y devolver al trabajador?')}>
                  Rechazar
                </button>
              </div>
            </div>
          )}
          {msg && <div className={`alert ${msg.type}`}>{msg.text}</div>}
        </div>
      )}
      {notify && <NotifyModal cid={cid} id={id} onClose={() => setNotify(false)} />}
    </Modal>
  );
}

interface NotifyData {
  to: string[];
  names: string[];
  subject: string;
  body: string;
}

/** Mensaje de correo listo para copiar y pegar (o abrir en el programa de correo). */
export function NotifyModal({
  cid, id, onClose, toPayer, markKind, onMarked, path, markPath, title,
}: {
  cid: string;
  id: string;
  onClose: () => void;
  /** Ruta alternativa para obtener el mensaje (p. ej. recordatorio de mensualidad). */
  path?: string;
  /** Ruta alternativa para "Marcar como avisado". */
  markPath?: string;
  title?: string;
  /** Mensaje para quien paga (en vez del destinatario según el estado). */
  toPayer?: boolean;
  /** Si se indica, muestra "Marcar como avisado" (saca el aviso de Notificaciones). */
  markKind?: 'payer' | 'approver' | 'paid';
  onMarked?: () => void;
}) {
  const { data, error } = useLoad<NotifyData>(path ?? `/companies/${cid}/reports/${id}/notify${toPayer ? '?to=payer' : ''}`);
  const [copied, setCopied] = useState<string | null>(null);
  const [marking, setMarking] = useState(false);

  async function mark() {
    setMarking(true);
    try {
      await api.post(markPath ?? `/companies/${cid}/reports/${id}/notified`, { kind: markKind });
      onMarked?.();
      onClose();
    } catch (e) {
      alert((e as Error).message);
      setMarking(false);
    }
  }

  const copy = async (label: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  };

  const mailto = data
    ? `mailto:${data.to.join(',')}?subject=${encodeURIComponent(data.subject)}&body=${encodeURIComponent(data.body)}`
    : '#';

  return (
    <Modal title={title ?? 'Avisar por correo'} onClose={onClose}>
      {error && <div className="alert error">{error}</div>}
      {!data ? (
        <p className="muted">Preparando mensaje…</p>
      ) : (
        <div className="stack">
          <CopyField label="Para" value={data.to.join(', ') || '(sin correo)'} hint={data.names.join(', ')} onCopy={() => copy('Para', data.to.join(', '))} copied={copied === 'Para'} />
          <CopyField label="Asunto" value={data.subject} onCopy={() => copy('Asunto', data.subject)} copied={copied === 'Asunto'} />
          <div className="field">
            <div className="row spread">
              <label>Mensaje</label>
              <button className="link" onClick={() => copy('Mensaje', data.body)}>{copied === 'Mensaje' ? '✓ Copiado' : 'Copiar'}</button>
            </div>
            <pre className="code-box">{data.body}</pre>
          </div>
          <div className="row modal-actions">
            <a className="btn primary" href={mailto}>Abrir en mi correo</a>
            <button onClick={() => copy('Todo', `Para: ${data.to.join(', ')}\nAsunto: ${data.subject}\n\n${data.body}`)}>
              {copied === 'Todo' ? '✓ Copiado' : 'Copiar todo'}
            </button>
            {(markKind || markPath) && (
              <button className="good" disabled={marking} onClick={mark}>
                ✓ Marcar como avisado
              </button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

function CopyField({ label, value, hint, onCopy, copied }: { label: string; value: string; hint?: string; onCopy: () => void; copied: boolean }) {
  return (
    <div className="field">
      <div className="row spread">
        <label>{label}</label>
        <button className="link" onClick={onCopy}>{copied ? '✓ Copiado' : 'Copiar'}</button>
      </div>
      <div className="code-box">{value}</div>
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

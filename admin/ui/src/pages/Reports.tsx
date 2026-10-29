import { useState } from 'react';
import {
  DOC_TYPE_LABELS,
  STATUS_LABELS,
  formatMoney,
  formatTotals,
  type Item,
  type Status,
  type Totals,
} from '@rendiciones/shared';
import { api, qs } from '../api';
import { fmtDateTime, useCatalog, useLoad } from '../hooks';

interface ReviewOut { uid?: string; name?: string; at: string | null; comment: string }
interface ReportOut {
  id: string;
  ownerUid: string;
  ownerName: string;
  areaId: string;
  title: string;
  periodFrom: string;
  periodTo: string;
  status: Status;
  totals: Totals;
  itemCount: number;
  updatedAt: string | null;
  submittedAt: string | null;
  paidAt: string | null;
  managerReview: ReviewOut | null;
  ownerReview: ReviewOut | null;
}
interface Detail {
  report: ReportOut;
  items: Item[];
  computedTotals: Totals;
  totalsMismatch: boolean;
  ownerRole: string | null;
}

const TABS: { key: Status | ''; label: string }[] = [
  { key: 'manager_approved', label: 'Por aprobar' },
  { key: 'submitted', label: 'Esperando jefe' },
  { key: 'approved', label: 'Por pagar' },
  { key: 'paid', label: 'Pagadas' },
  { key: 'rejected', label: 'Rechazadas' },
  { key: 'draft', label: 'Borradores' },
  { key: '', label: 'Todas' },
];

export function Reports() {
  const [status, setStatus] = useState<Status | ''>('manager_approved');
  const [areaId, setAreaId] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const { areas, areaName } = useCatalog();
  const list = useLoad<ReportOut[]>(`/reports${qs({ status: status || undefined, areaId: areaId || undefined })}`);

  return (
    <div className="stack">
      <div className="row spread">
        <h1>Rendiciones</h1>
        <div className="field" style={{ marginBottom: 0, minWidth: 200 }}>
          <select value={areaId} onChange={(e) => setAreaId(e.target.value)} aria-label="Filtrar por área">
            <option value="">Todas las áreas</option>
            {areas.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
      </div>

      <nav className="nav">
        {TABS.map((t) => (
          <a key={t.key || 'all'} href="#" className={status === t.key ? 'active' : ''} onClick={(e) => { e.preventDefault(); setStatus(t.key); }}>
            {t.label}
          </a>
        ))}
      </nav>

      {list.error && <div className="alert error">{list.error}</div>}
      <div className="card table-wrap">
        {!list.data ? (
          <p className="muted">Cargando…</p>
        ) : list.data.length === 0 ? (
          <p className="muted">No hay rendiciones en este estado.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Título</th><th>Trabajador</th><th className="hide-sm">Área</th><th className="hide-sm">Período</th>
                <th>Estado</th><th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => setOpenId(r.id)}>
                  <td>{r.title}</td>
                  <td>{r.ownerName}</td>
                  <td className="hide-sm">{areaName(r.areaId)}</td>
                  <td className="hide-sm small">{r.periodFrom} → {r.periodTo}</td>
                  <td><span className={`badge ${r.status}`}>{STATUS_LABELS[r.status]}</span></td>
                  <td className="num">{formatTotals(r.totals)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {openId && (
        <ReportModal id={openId} onClose={() => setOpenId(null)} onChanged={() => void list.reload()} />
      )}
    </div>
  );
}

function ReportModal({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { data, error, reload } = useLoad<Detail>(`/reports/${id}`);
  const { areaName, categoryName } = useCatalog();
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'error'; text: string } | null>(null);

  async function act(action: 'approve' | 'reject' | 'pay', confirmText: string) {
    if (!confirm(confirmText)) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.post(`/reports/${id}/${action}`, { comment });
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
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="card modal" style={{ maxWidth: 860 }} onClick={(e) => e.stopPropagation()}>
        <div className="row spread">
          <h2>{r?.title ?? 'Rendición'}</h2>
          <button className="link" onClick={onClose}>Cerrar ✕</button>
        </div>
        {error && <div className="alert error">{error}</div>}
        {!data || !r ? (
          <p className="muted">Cargando…</p>
        ) : (
          <div className="stack">
            <div className="row small">
              <span className={`badge ${r.status}`}>{STATUS_LABELS[r.status]}</span>
              <span><b>{r.ownerName}</b>{data.ownerRole === 'manager' ? ' (jefe de área)' : ''}</span>
              <span>· {areaName(r.areaId)}</span>
              <span>· {r.periodFrom} → {r.periodTo}</span>
              <span className="muted">· enviada {fmtDateTime(r.submittedAt)}</span>
            </div>

            {data.totalsMismatch && (
              <div className="alert warn">
                Los totales guardados ({formatTotals(r.totals)}) no coinciden con la suma de los gastos
                ({formatTotals(data.computedTotals)}). Al aprobar se usará la suma de los gastos.
              </div>
            )}

            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Fecha</th><th>Categoría</th><th>Descripción</th><th className="hide-sm">Documento</th><th className="num">Monto</th></tr>
                </thead>
                <tbody>
                  {data.items.map((it) => (
                    <tr key={it.id}>
                      <td className="small">{it.date}</td>
                      <td>{categoryName(it.categoryId)}</td>
                      <td>{it.description}{it.vendor && <div className="muted small">{it.vendor}</div>}</td>
                      <td className="hide-sm small">{DOC_TYPE_LABELS[it.docType]} {it.docNumber}</td>
                      <td className="num">{formatMoney(it.amount, it.currency)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td colSpan={4}><b>Total</b></td>
                    <td className="num"><b>{formatTotals(data.computedTotals)}</b></td>
                  </tr>
                </tbody>
              </table>
            </div>

            {r.managerReview && (
              <p className="small">
                <b>Jefe:</b> {r.managerReview.name} · {fmtDateTime(r.managerReview.at)}
                {r.managerReview.comment && <> — “{r.managerReview.comment}”</>}
              </p>
            )}
            {r.ownerReview && (
              <p className="small">
                <b>Owner:</b> {fmtDateTime(r.ownerReview.at)}
                {r.ownerReview.comment && <> — “{r.ownerReview.comment}”</>}
              </p>
            )}
            {r.paidAt && <p className="small"><b>Pagada:</b> {fmtDateTime(r.paidAt)}</p>}

            {['submitted', 'manager_approved', 'approved'].includes(r.status) && (
              <div className="card" style={{ background: 'var(--surface-2)' }}>
                {r.status === 'submitted' && data.ownerRole !== 'manager' && (
                  <p className="alert warn small">Aún no la revisa el jefe de área. Puedes aprobarla igualmente.</p>
                )}
                <div className="field">
                  <label htmlFor="comment">Comentario (obligatorio para rechazar)</label>
                  <textarea id="comment" value={comment} maxLength={500} onChange={(e) => setComment(e.target.value)} />
                </div>
                <div className="row">
                  {r.status !== 'approved' && (
                    <button className="primary" disabled={busy} onClick={() => act('approve', '¿Aprobar esta rendición?')}>Aprobar</button>
                  )}
                  {r.status === 'approved' && (
                    <button className="primary" disabled={busy} onClick={() => act('pay', '¿Marcar como pagada?')}>Marcar pagada</button>
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
      </div>
    </div>
  );
}

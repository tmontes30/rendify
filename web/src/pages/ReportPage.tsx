import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  CURRENCIES,
  CURRENCY_CODES,
  DOC_TYPES,
  DOC_TYPE_LABELS,
  EDITABLE_STATUSES,
  LIMITS,
  formatMoney,
  formatTotals,
  sumTotals,
  toMinor,
  type Category,
  type Currency,
  type DocType,
  type Item,
  type Report,
} from '@rendiciones/shared';
import { useProfile } from '../auth';
import {
  deleteDraft,
  deleteItem,
  fmtDate,
  friendlyError,
  getReport,
  listCategories,
  managerDecision,
  saveItem,
  submitReport,
  updateReportHeader,
} from '../data';
import { StatusBadge } from '../components/StatusBadge';

const LAST_CURRENCY = 'last-currency';

export function ReportPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { profile } = useProfile();
  const [report, setReport] = useState<Report | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [editingItem, setEditingItem] = useState<Item | 'new' | null>(null);
  const [editingHeader, setEditingHeader] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [r, cats] = await Promise.all([getReport(id), listCategories()]);
      if (!r) return setNotFound(true);
      setReport(r.report);
      setItems(r.items);
      setCategories(cats);
    } catch (e) {
      setError(friendlyError(e));
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  if (notFound) return <div className="card">Rendición no encontrada. <Link to="/">Volver</Link></div>;
  if (error && !report) return <div className="alert error">{error}</div>;
  if (!report) return <p className="muted">Cargando…</p>;

  const isOwner = report.ownerUid === profile.uid;
  const editable = isOwner && EDITABLE_STATUSES.includes(report.status);
  const canReview = !isOwner && profile.role === 'manager' && report.areaId === profile.areaId && report.status === 'submitted';
  const catName = (cid: string) => categories.find((c) => c.id === cid)?.name ?? cid;
  const totals = sumTotals(items);
  // Motivo del rechazo: el comentario de la revisión más reciente.
  const reviewTime = (r?: { at: unknown }) => (r?.at as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0;
  const rejectComment =
    reviewTime(report.ownerReview) >= reviewTime(report.managerReview)
      ? report.ownerReview?.comment || report.managerReview?.comment
      : report.managerReview?.comment || report.ownerReview?.comment;

  async function run(fn: () => Promise<unknown>, after?: () => void) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      after?.();
      await load();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <Link to={isOwner ? '/' : '/equipo'} className="small">← Volver</Link>

      <div className="card">
        <div className="row spread">
          <div>
            <h1 style={{ marginBottom: 4 }}>{report.title}</h1>
            <div className="row small muted">
              <StatusBadge status={report.status} />
              {!isOwner && <span>{report.ownerName} ·</span>}
              <span>{report.periodFrom} → {report.periodTo}</span>
              {report.submittedAt != null && <span>· enviada {fmtDate(report.submittedAt)}</span>}
            </div>
          </div>
          <div className="num">
            <div className="muted small">Total</div>
            <div style={{ fontSize: 20, fontWeight: 650 }}>{formatTotals(totals)}</div>
          </div>
        </div>

        {report.status === 'rejected' && rejectComment && (
          <div className="alert error" style={{ marginTop: 12 }}>
            <b>Rechazada:</b> {rejectComment}
            {isOwner && <div className="small">Corrige lo indicado y vuelve a enviarla.</div>}
          </div>
        )}
        {report.managerReview && report.status !== 'rejected' && (
          <p className="small muted" style={{ marginBottom: 0 }}>
            Revisada por {report.managerReview.name} el {fmtDate(report.managerReview.at)}
            {report.managerReview.comment && <> — “{report.managerReview.comment}”</>}
          </p>
        )}

        {editable && (
          <div className="row" style={{ marginTop: 12 }}>
            <button onClick={() => setEditingHeader(true)}>Editar datos</button>
            {report.status === 'draft' && (
              <button
                className="danger"
                disabled={busy}
                onClick={() => confirm('¿Eliminar este borrador y todos sus gastos?') && run(() => deleteDraft(report.id, items), () => navigate('/'))}
              >
                Eliminar borrador
              </button>
            )}
          </div>
        )}
      </div>

      {editingHeader && (
        <HeaderForm
          report={report}
          onCancel={() => setEditingHeader(false)}
          onSave={(d) => run(() => updateReportHeader(report.id, d), () => setEditingHeader(false))}
        />
      )}

      {error && <div className="alert error">{error}</div>}

      <div className="card">
        <div className="row spread" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>Gastos ({items.length})</h2>
          {editable && items.length < LIMITS.maxItems && (
            <button className="primary" onClick={() => setEditingItem('new')}>+ Agregar gasto</button>
          )}
        </div>
        {items.length === 0 ? (
          <p className="muted">Sin gastos todavía.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Fecha</th><th>Categoría</th><th>Descripción</th><th className="hide-sm">Documento</th><th className="num">Monto</th>{editable && <th />}</tr>
              </thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.id}>
                    <td className="small">{it.date}</td>
                    <td>{catName(it.categoryId)}</td>
                    <td>{it.description}{it.vendor && <div className="muted small">{it.vendor}</div>}</td>
                    <td className="hide-sm small">{DOC_TYPE_LABELS[it.docType]} {it.docNumber}</td>
                    <td className="num">{formatMoney(it.amount, it.currency)}</td>
                    {editable && (
                      <td className="num">
                        <button className="link" onClick={() => setEditingItem(it)}>Editar</button>
                        <button
                          className="link"
                          disabled={busy}
                          onClick={() => confirm('¿Eliminar este gasto?') && run(() => deleteItem(report.id, items, it.id))}
                        >
                          Eliminar
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {editable && (
          <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
            <button
              className="primary"
              disabled={busy || items.length === 0}
              onClick={() => confirm('¿Enviar la rendición a tu jefe de área? Ya no podrás editarla.') && run(() => submitReport(report.id, items))}
            >
              Enviar a aprobación
            </button>
          </div>
        )}
      </div>

      {editingItem && (
        <ItemForm
          item={editingItem === 'new' ? null : editingItem}
          categories={categories.filter((c) => c.active || (editingItem !== 'new' && c.id === editingItem.categoryId))}
          report={report}
          onCancel={() => setEditingItem(null)}
          onSave={(data) =>
            run(() => saveItem(report.id, items, editingItem === 'new' ? null : editingItem.id, data), () => setEditingItem(null))
          }
        />
      )}

      {canReview && <ReviewBox busy={busy} onDecide={(d, c) => run(() => managerDecision(report.id, profile, d, c))} />}
    </div>
  );
}

function HeaderForm({
  report, onCancel, onSave,
}: {
  report: Report;
  onCancel: () => void;
  onSave: (d: { title: string; periodFrom: string; periodTo: string }) => void;
}) {
  const [title, setTitle] = useState(report.title);
  const [periodFrom, setFrom] = useState(report.periodFrom);
  const [periodTo, setTo] = useState(report.periodTo);
  const [err, setErr] = useState<string | null>(null);
  return (
    <form
      className="card"
      onSubmit={(e) => {
        e.preventDefault();
        if (periodFrom > periodTo) return setErr('La fecha de inicio debe ser anterior a la de término.');
        onSave({ title, periodFrom, periodTo });
      }}
    >
      <div className="form-grid">
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label htmlFor="t">Título</label>
          <input id="t" required maxLength={LIMITS.title} value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="field"><label htmlFor="f">Desde</label><input id="f" type="date" required value={periodFrom} onChange={(e) => setFrom(e.target.value)} /></div>
        <div className="field"><label htmlFor="h">Hasta</label><input id="h" type="date" required value={periodTo} onChange={(e) => setTo(e.target.value)} /></div>
      </div>
      {err && <div className="alert error">{err}</div>}
      <div className="row"><button className="primary" type="submit">Guardar</button><button type="button" onClick={onCancel}>Cancelar</button></div>
    </form>
  );
}

function ItemForm({
  item, categories, report, onCancel, onSave,
}: {
  item: Item | null;
  categories: Category[];
  report: Report;
  onCancel: () => void;
  onSave: (d: Omit<Item, 'id'>) => void;
}) {
  const initialCurrency = (() => {
    if (item) return item.currency;
    try {
      const c = localStorage.getItem(LAST_CURRENCY) as Currency | null;
      if (c && c in CURRENCIES) return c;
    } catch { /* sin almacenamiento */ }
    return 'CLP' as Currency;
  })();
  const [date, setDate] = useState(item?.date ?? new Date().toISOString().slice(0, 10));
  const [categoryId, setCategoryId] = useState(item?.categoryId ?? categories[0]?.id ?? '');
  const [description, setDescription] = useState(item?.description ?? '');
  const [vendor, setVendor] = useState(item?.vendor ?? '');
  const [docType, setDocType] = useState<DocType>(item?.docType ?? 'boleta');
  const [docNumber, setDocNumber] = useState(item?.docNumber ?? '');
  const [currency, setCurrency] = useState<Currency>(initialCurrency);
  const [amountText, setAmountText] = useState(
    item ? (item.amount / 10 ** CURRENCIES[item.currency].decimals).toString().replace('.', ',') : '',
  );
  const [err, setErr] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    const amount = toMinor(amountText, currency);
    if (amount == null) return setErr('Monto inválido.');
    if (!categoryId) return setErr('Elige una categoría.');
    if (date < report.periodFrom || date > report.periodTo) {
      if (!confirm('La fecha del gasto está fuera del período de la rendición. ¿Guardar igual?')) return;
    }
    try { localStorage.setItem(LAST_CURRENCY, currency); } catch { /* sin almacenamiento */ }
    onSave({
      date, categoryId, description: description.trim(), vendor: vendor.trim(),
      docType, docNumber: docNumber.trim(), amount, currency,
    });
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <form className="card modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>{item ? 'Editar gasto' : 'Nuevo gasto'}</h2>
        {categories.length === 0 && <div className="alert warn">No hay categorías disponibles. Contacta al administrador.</div>}
        <div className="form-grid">
          <div className="field"><label htmlFor="d">Fecha</label><input id="d" type="date" required value={date} onChange={(e) => setDate(e.target.value)} /></div>
          <div className="field">
            <label htmlFor="c">Categoría</label>
            <select id="c" required value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="desc">Descripción</label>
          <input id="desc" required maxLength={LIMITS.description} placeholder="Ej: Almuerzo con cliente" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="v">Proveedor (opcional)</label>
          <input id="v" maxLength={LIMITS.vendor} placeholder="Nombre o RUT del comercio" value={vendor} onChange={(e) => setVendor(e.target.value)} />
        </div>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="dt">Tipo de documento</label>
            <select id="dt" value={docType} onChange={(e) => setDocType(e.target.value as DocType)}>
              {DOC_TYPES.map((t) => <option key={t} value={t}>{DOC_TYPE_LABELS[t]}</option>)}
            </select>
          </div>
          <div className="field"><label htmlFor="dn">N° documento</label><input id="dn" maxLength={LIMITS.docNumber} value={docNumber} onChange={(e) => setDocNumber(e.target.value)} /></div>
        </div>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="cur">Moneda</label>
            <select id="cur" value={currency} onChange={(e) => setCurrency(e.target.value as Currency)}>
              {CURRENCY_CODES.map((c) => <option key={c} value={c}>{c} — {CURRENCIES[c].name}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="amt">Monto</label>
            <input id="amt" required inputMode="decimal" placeholder={CURRENCIES[currency].decimals ? '0,00' : '0'} value={amountText} onChange={(e) => setAmountText(e.target.value)} />
          </div>
        </div>
        {err && <div className="alert error">{err}</div>}
        <div className="row" style={{ marginTop: 8 }}>
          <button className="primary" type="submit" disabled={!categories.length}>Guardar</button>
          <button type="button" onClick={onCancel}>Cancelar</button>
        </div>
      </form>
    </div>
  );
}

function ReviewBox({ busy, onDecide }: { busy: boolean; onDecide: (d: 'manager_approved' | 'rejected', comment: string) => void }) {
  const [comment, setComment] = useState('');
  return (
    <div className="card">
      <h2>Tu revisión</h2>
      <div className="field">
        <label htmlFor="rc">Comentario (obligatorio para rechazar)</label>
        <textarea id="rc" maxLength={LIMITS.comment} value={comment} onChange={(e) => setComment(e.target.value)} />
      </div>
      <div className="row">
        <button className="primary" disabled={busy} onClick={() => confirm('¿Aprobar y enviar al owner?') && onDecide('manager_approved', comment)}>
          Aprobar
        </button>
        <button className="danger" disabled={busy || !comment.trim()} onClick={() => confirm('¿Rechazar y devolver al trabajador?') && onDecide('rejected', comment)}>
          Rechazar
        </button>
      </div>
    </div>
  );
}

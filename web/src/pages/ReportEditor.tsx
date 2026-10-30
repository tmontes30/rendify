import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  CURRENCIES,
  CURRENCY_CODES,
  DOC_TYPES,
  DOC_TYPE_LABELS,
  LIMITS,
  formatTotals,
  fromMinor,
  startLevel,
  sumTotals,
  toMinor,
  type Attachment,
  type Category,
  type Currency,
  type DocType,
  type Item,
  type Report,
} from '@rendiciones/shared';
import { useSession } from '../auth';
import { deleteDraft, friendlyError, listAttachments, listCategories, saveReport, type ItemDraft, type NewAttachment } from '../data';
import { AttachmentsEditor } from '../components/Attachments';
import { StatusBadge } from '../components/StatusBadge';
import { useGlobalBusy } from '@rendiciones/shared/Busy';

export interface RowState {
  key: string;
  id?: string;
  date: string;
  categoryId: string;
  description: string;
  vendor: string;
  docType: DocType;
  docNumber: string;
  currency: Currency;
  amountText: string;
}

const LAST_CURRENCY = 'last-currency';
let keySeq = 0;
const newKey = () => `r${++keySeq}`;
const today = () => new Date().toISOString().slice(0, 10);

function defaultCurrency(base: Currency): Currency {
  try {
    const c = localStorage.getItem(LAST_CURRENCY) as Currency | null;
    if (c && c in CURRENCIES) return c;
  } catch {
    /* sin almacenamiento */
  }
  return base;
}

export function emptyRow(currency: Currency, categoryId = ''): RowState {
  return { key: newKey(), date: today(), categoryId, description: '', vendor: '', docType: 'boleta', docNumber: '', currency, amountText: '' };
}

export function rowFromItem(it: Item): RowState {
  return { key: newKey(), ...it, amountText: fromMinor(it.amount, it.currency) };
}

function defaultTitle() {
  const m = new Date().toLocaleDateString('es-CL', { month: 'long', year: 'numeric' });
  return `Rendición ${m}`;
}

/** Valida una fila; devuelve el gasto listo o el mensaje de error. */
function validateRow(r: RowState, cats: Category[]): { item?: ItemDraft; error?: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) return { error: 'Fecha inválida' };
  if (!cats.some((c) => c.id === r.categoryId)) return { error: 'Elige una categoría' };
  if (!r.description.trim()) return { error: 'Falta la descripción' };
  const amount = toMinor(r.amountText, r.currency);
  if (amount == null) return { error: 'Monto inválido' };
  return {
    item: {
      id: r.id,
      date: r.date,
      categoryId: r.categoryId,
      description: r.description.slice(0, LIMITS.description),
      vendor: r.vendor.slice(0, LIMITS.vendor),
      docType: r.docType,
      docNumber: r.docNumber.slice(0, LIMITS.docNumber),
      amount,
      currency: r.currency,
    },
  };
}

export function ReportEditor({
  existing,
  initialRows,
  initialTitle,
}: {
  existing?: { report: Report; items: Item[] };
  initialRows?: RowState[];
  initialTitle?: string;
}) {
  const session = useSession();
  const { company, flow } = session;
  const navigate = useNavigate();
  const [categories, setCategories] = useState<Category[]>([]);
  const [title, setTitle] = useState(existing?.report.title ?? initialTitle ?? defaultTitle());
  const [rows, setRows] = useState<RowState[]>(
    existing ? existing.items.map(rowFromItem) : initialRows?.length ? initialRows : [emptyRow(defaultCurrency(company.baseCurrency))],
  );
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useGlobalBusy('Guardando…');
  const [error, setError] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [existingAtt, setExistingAtt] = useState<Attachment[]>([]);
  const [pendingAtt, setPendingAtt] = useState<(NewAttachment & { key: string })[]>([]);
  const [removedAtt, setRemovedAtt] = useState<string[]>([]);

  useEffect(() => {
    if (existing) listAttachments(company.id, existing.report.id).then(setExistingAtt, () => undefined);
  }, [company.id, existing]);

  useEffect(() => {
    listCategories(company.id).then(setCategories, (e) => setError(friendlyError(e)));
  }, [company.id]);

  const activeCats = useMemo(
    () => categories.filter((c) => c.active || rows.some((r) => r.categoryId === c.id)),
    [categories, rows],
  );

  // Fija la primera categoría en filas que aún no tienen.
  useEffect(() => {
    const first = activeCats.find((c) => c.active)?.id;
    if (first) setRows((rs) => (rs.some((r) => !r.categoryId) ? rs.map((r) => (r.categoryId ? r : { ...r, categoryId: first })) : rs));
  }, [activeCats]);

  const results = rows.map((r) => validateRow(r, categories));
  const valid = results.map((r) => r.item).filter((x): x is ItemDraft => !!x);
  const errorsCount = results.filter((r) => r.error).length;
  const totals = sumTotals(valid);
  const dates = valid.map((v) => v.date).sort();
  const period = dates.length ? { from: dates[0], to: dates[dates.length - 1] } : { from: today(), to: today() };
  const start = flow ? startLevel(flow.levels, session.profile.uid) : 0;
  const firstApprovers = flow?.levels[start]?.approvers.map((u) => flow.approverNames?.[u] ?? '').filter(Boolean) ?? [];
  const toOwner = !!flow && start >= flow.levels.length;

  const update = (key: string, patch: Partial<RowState>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const addRow = () => {
    const last = rows[rows.length - 1];
    setRows((rs) => [...rs, emptyRow(last?.currency ?? company.baseCurrency, last?.categoryId ?? activeCats[0]?.id ?? '')]);
  };
  const removeRow = (key: string) => setRows((rs) => (rs.length > 1 ? rs.filter((r) => r.key !== key) : rs));

  async function save(submit: boolean) {
    setShowErrors(true);
    setError(null);
    if (!title.trim()) return setError('Ponle un título a la rendición.');
    if (errorsCount) return setError(`Hay ${errorsCount} gasto(s) con datos incompletos. Revisa las filas marcadas en rojo.`);
    if (!valid.length) return setError('Agrega al menos un gasto.');
    if (valid.length > LIMITS.maxItems) return setError(`Máximo ${LIMITS.maxItems} gastos por rendición.`);
    if (submit && !confirmed) return setError('Marca la casilla de confirmación para enviar.');
    setBusy(true);
    try {
      const last = valid[valid.length - 1];
      try {
        localStorage.setItem(LAST_CURRENCY, last.currency);
      } catch {
        /* sin almacenamiento */
      }
      const id = await saveReport(session, existing ?? null, { title, periodFrom: period.from, periodTo: period.to }, valid, submit, {
        add: pendingAtt.map(({ key: _k, ...a }) => a),
        remove: removedAtt,
      });
      setBusy(false);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      navigate(`/r/${id}`, { replace: true, state: { flash: submit ? 'sent' : 'saved' } });
    } catch (e) {
      setError(friendlyError(e));
      setBusy(false);
    }
  }

  async function remove() {
    if (!existing || !confirm('¿Eliminar este borrador?')) return;
    setBusy(true);
    try {
      await deleteDraft(company.id, existing.report.id, existing.items);
      navigate('/mis-rendiciones', { replace: true });
    } catch (e) {
      setError(friendlyError(e));
      setBusy(false);
    }
  }

  const rejection =
    existing?.report.status === 'rejected'
      ? existing.report.ownerReview?.decision === 'rejected'
        ? existing.report.ownerReview.comment
        : existing.report.approvals[existing.report.approvals.length - 1]?.comment
      : null;

  return (
    <div className="stack editor">
      <Link to="/mis-rendiciones" className="back-link">← Mis rendiciones</Link>

      {rejection && (
        <div className="alert error">
          <b>Rechazada:</b> {rejection}
          <div className="small">Corrige lo indicado y vuelve a enviarla.</div>
        </div>
      )}

      <div className="card hero-card">
        <div className="row spread">
          <span className="eyebrow">{existing ? 'Editar rendición' : 'Nueva rendición'}</span>
          {existing && <StatusBadge status={existing.report.status} />}
        </div>
        <input
          className="title-input"
          aria-label="Título de la rendición"
          maxLength={LIMITS.title}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Ej: Viaje a Concepción"
        />
        <div className="row small muted">
          <span>Período: {period.from} → {period.to} (según las fechas de los gastos)</span>
        </div>
      </div>

      <div className="card">
        <div className="row spread" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>Gastos</h2>
          <Link to="/carga-masiva" className="small">¿Muchos gastos? Usa la carga masiva con Excel</Link>
        </div>

        <div className="expense-list">
          <div className="expense-head" aria-hidden="true">
            <span>Fecha</span>
            <span>Categoría</span>
            <span>Descripción</span>
            <span>Proveedor</span>
            <span>Documento</span>
            <span>Moneda</span>
            <span>Monto</span>
            <span />
          </div>
          {rows.map((r, i) => {
            const err = showErrors ? results[i].error : undefined;
            return (
              <div key={r.key} className={`expense-row${err ? ' has-error' : ''}`}>
                <label className="cell">
                  <span className="cell-label">Fecha</span>
                  <input type="date" value={r.date} onChange={(e) => update(r.key, { date: e.target.value })} />
                </label>
                <label className="cell">
                  <span className="cell-label">Categoría</span>
                  <select value={r.categoryId} onChange={(e) => update(r.key, { categoryId: e.target.value })}>
                    {!r.categoryId && <option value="">Elegir…</option>}
                    {activeCats.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </label>
                <label className="cell grow">
                  <span className="cell-label">Descripción</span>
                  <input maxLength={LIMITS.description} placeholder="Ej: Taxi al aeropuerto" value={r.description} onChange={(e) => update(r.key, { description: e.target.value })} />
                </label>
                <label className="cell">
                  <span className="cell-label">Proveedor</span>
                  <input maxLength={LIMITS.vendor} placeholder="Opcional" value={r.vendor} onChange={(e) => update(r.key, { vendor: e.target.value })} />
                </label>
                <div className="cell doc-cell">
                  <span className="cell-label">Documento</span>
                  <div className="row nowrap tight">
                    <select aria-label="Tipo de documento" value={r.docType} onChange={(e) => update(r.key, { docType: e.target.value as DocType })}>
                      {DOC_TYPES.map((t) => (
                        <option key={t} value={t}>{DOC_TYPE_LABELS[t]}</option>
                      ))}
                    </select>
                    <input aria-label="N° documento" maxLength={LIMITS.docNumber} placeholder="N°" value={r.docNumber} onChange={(e) => update(r.key, { docNumber: e.target.value })} />
                  </div>
                </div>
                <label className="cell">
                  <span className="cell-label">Moneda</span>
                  <select value={r.currency} onChange={(e) => update(r.key, { currency: e.target.value as Currency })}>
                    {CURRENCY_CODES.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </label>
                <label className="cell">
                  <span className="cell-label">Monto</span>
                  <input
                    className="num-input"
                    inputMode="decimal"
                    placeholder={CURRENCIES[r.currency].decimals ? '0,00' : '0'}
                    value={r.amountText}
                    onChange={(e) => update(r.key, { amountText: e.target.value })}
                  />
                </label>
                <div className="cell actions-cell">
                  <button type="button" className="icon-btn" onClick={() => removeRow(r.key)} disabled={rows.length === 1} aria-label="Quitar gasto" title="Quitar gasto">
                    ✕
                  </button>
                </div>
                {err && <div className="row-error">{err}</div>}
              </div>
            );
          })}
        </div>
        <div className="row spread" style={{ marginTop: 12 }}>
          <button type="button" onClick={addRow} disabled={rows.length >= LIMITS.maxItems}>
            + Agregar gasto
          </button>
          <div className="total-pill">
            <span className="muted small">Total</span> <b>{formatTotals(totals)}</b>
            <span className="muted small"> · {valid.length} gasto(s)</span>
          </div>
        </div>
      </div>

      <AttachmentsEditor
        existing={existingAtt}
        pending={pendingAtt}
        removed={removedAtt}
        onAdd={(a) => setPendingAtt((xs) => [...xs, { ...a, key: `p${Date.now()}${Math.random()}` }])}
        onRemovePending={(k) => setPendingAtt((xs) => xs.filter((x) => x.key !== k))}
        onRemoveExisting={(id) => setRemovedAtt((xs) => [...xs, id])}
        onCaption={(k, c) => setPendingAtt((xs) => xs.map((x) => (x.key === k ? { ...x, caption: c } : x)))}
      />

      <div className="card submit-bar">
        {flow ? (
          <label className="confirm-check">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            <span>
              Confirmo que los gastos son correctos y quiero enviar esta rendición a aprobación
              {toOwner ? <> de <b>Administración</b></> : firstApprovers.length ? <> de <b>{firstApprovers.join(' o ')}</b></> : null}.
            </span>
          </label>
        ) : (
          <div className="alert warn">Aún no tienes un flujo de aprobación asignado: puedes guardar como borrador, pero no enviarla. Avísale al administrador.</div>
        )}
        {error && <div className="alert error">{error}</div>}
        <div className="row submit-actions">
          {existing?.report.status === 'draft' && (
            <button type="button" className="link danger-link" disabled={busy} onClick={remove}>Eliminar borrador</button>
          )}
          <span className="spacer" />
          <button type="button" disabled={busy} onClick={() => save(false)}>Guardar borrador</button>
          <button type="button" className="primary" disabled={busy || !flow || !confirmed} onClick={() => save(true)}>
            {busy ? 'Guardando…' : 'Enviar a aprobación'}
          </button>
        </div>
      </div>
    </div>
  );
}

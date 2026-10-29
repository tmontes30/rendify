import { useState, type FormEvent } from 'react';
import { CURRENCIES, CURRENCY_CODES, STATUS_LABELS, formatMoney, formatTotals, fromMinor, toMinor, type Currency, type Status, type Totals } from '@rendiciones/shared';
import { api } from '../api';
import { Modal, PageHeader } from '../components';
import { fmtDateTime, useCompany, useLoad, type CompanyRow } from '../hooks';

export interface Billing {
  dueDate: string | null;
  billingDay: number | null;
  amount: number | null;
  currency: Currency;
  contactName: string;
  contactEmail: string;
  notes: string;
  lastPaidAt: string | null;
  lastPaidFor: string | null;
  lastReminderAt: string | null;
  state: 'ok' | 'soon' | 'overdue' | 'none';
  daysLeft: number | null;
}

export const fmtDay = (iso: string | null) => (iso ? `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}` : '—');

/** Texto y color del estado de la mensualidad. */
export function billingLabel(b: Billing | null | undefined) {
  if (!b || b.state === 'none' || b.daysLeft == null) return { text: 'Sin fecha de facturación', cls: 'bill-none' };
  if (b.state === 'overdue') return { text: `Vencida hace ${-b.daysLeft} día(s) · ${fmtDay(b.dueDate)}`, cls: 'bill-overdue' };
  if (b.state === 'soon') return { text: b.daysLeft === 0 ? `Vence HOY · ${fmtDay(b.dueDate)}` : `Vence en ${b.daysLeft} día(s) · ${fmtDay(b.dueDate)}`, cls: 'bill-soon' };
  return { text: `Próximo vencimiento ${fmtDay(b.dueDate)} (en ${b.daysLeft} días)`, cls: 'bill-ok' };
}

type CompanyFilter = 'all' | 'soon' | 'overdue' | 'alert' | 'suspended' | 'none';
const COMPANY_FILTERS: { key: CompanyFilter; label: string }[] = [
  { key: 'all', label: 'Todas' },
  { key: 'soon', label: '🟡 Por vencer' },
  { key: 'overdue', label: '🔴 Vencidas' },
  { key: 'alert', label: '🟡+🔴 Por vencer o vencidas' },
  { key: 'suspended', label: '⏸ Suspendidas' },
  { key: 'none', label: 'Sin fecha' },
];

export function Companies() {
  const { companies, reloadCompanies, setCompanyId, companyId } = useCompany();
  const [editing, setEditing] = useState<CompanyRow | 'new' | null>(null);
  const billing = useLoad<Record<string, Billing | null>>('/billing');
  const [filter, setFilter] = useState<CompanyFilter>(() => {
    try {
      return (localStorage.getItem('company-filter') as CompanyFilter) || 'all';
    } catch {
      return 'all';
    }
  });
  const chooseFilter = (f: CompanyFilter) => {
    setFilter(f);
    try {
      localStorage.setItem('company-filter', f);
    } catch {
      /* ignorar */
    }
  };
  const stateOf = (c: CompanyRow) => billing.data?.[c.id]?.state ?? 'none';
  const matches = (c: CompanyRow, f: CompanyFilter) =>
    f === 'all' ||
    (f === 'soon' && stateOf(c) === 'soon') ||
    (f === 'overdue' && stateOf(c) === 'overdue') ||
    (f === 'alert' && (stateOf(c) === 'soon' || stateOf(c) === 'overdue')) ||
    (f === 'suspended' && !c.active) ||
    (f === 'none' && stateOf(c) === 'none');
  const shown = companies
    .filter((c) => matches(c, filter))
    // Las más urgentes primero: vencidas, por vencer, luego el resto.
    .sort((a, b) => (billing.data?.[a.id]?.daysLeft ?? 9999) - (billing.data?.[b.id]?.daysLeft ?? 9999));

  async function markPaid(c: CompanyRow) {
    const b = billing.data?.[c.id];
    if (!confirm(`¿Registrar que ${c.name} pagó la mensualidad${b?.dueDate ? ` del ${fmtDay(b.dueDate)}` : ''}? El vencimiento pasará al mes siguiente.`)) return;
    await api.post(`/companies/${c.id}/billing/paid`).catch((e) => alert(e.message));
    await billing.reload();
  }

  async function suspend(c: CompanyRow) {
    const reason = prompt(
      `Suspender el servicio de ${c.name}.

Sus usuarios no podrán entrar ni ver nada hasta que lo reactives. Los datos no se borran.

Motivo (solo lo ves tú):`,
      'Mensualidad pendiente de pago',
    );
    if (reason === null) return;
    await api.post(`/companies/${c.id}/suspend`, { reason }).catch((e) => alert(e.message));
    await reloadCompanies();
  }

  async function resume(c: CompanyRow) {
    if (!confirm(`¿Reactivar el servicio de ${c.name}? Sus usuarios vuelven a tener acceso de inmediato.`)) return;
    await api.post(`/companies/${c.id}/resume`).catch((e) => alert(e.message));
    await reloadCompanies();
  }

  return (
    <div className="stack">
      <PageHeader
        title="Empresas"
        subtitle="Cada empresa tiene sus propias áreas, categorías, flujos y usuarios, aislados de las demás."
        actions={<button className="primary" onClick={() => setEditing('new')}>+ Nueva empresa</button>}
      />
      <nav className="tabs">
        {COMPANY_FILTERS.map((f) => (
          <button key={f.key} className={filter === f.key ? 'active' : ''} onClick={() => chooseFilter(f.key)}>
            {f.label} <span className="count-pill">{companies.filter((c) => matches(c, f.key)).length}</span>
          </button>
        ))}
      </nav>
      <div className="grid grid-cards">
        {shown.map((c) => (
          <div key={c.id} className={`card company-card${companyId === c.id ? ' selected' : ''}${c.active ? '' : ' suspended'} ${billingLabel(billing.data?.[c.id]).cls}-card`}>
            <div className="row spread">
              <h3 style={{ margin: 0 }}>{c.name}</h3>
              <span className={`badge ${c.active ? 'approved' : 'rejected'}`}>{c.active ? 'Activa' : '⏸ Suspendida'}</span>
            </div>
            <div className="muted small">
              Moneda base: {c.baseCurrency} · {c.activeUsers} usuario(s) activo(s)
            </div>
            {(() => {
              const b = billing.data?.[c.id];
              const l = billingLabel(b);
              return (
                <div className={`bill-chip ${l.cls}`}>
                  <span>🧾 {l.text}</span>
                  {b?.amount != null && <span className="muted"> · {formatMoney(b.amount, b.currency)}</span>}
                  {b?.dueDate && (
                    <button className="link" onClick={() => markPaid(c)}>
                      ✓ Pago recibido
                    </button>
                  )}
                </div>
              );
            })()}
            {!c.active && (
              <div className="alert error small" style={{ marginTop: 8 }}>
                Servicio suspendido{c.suspendedAt ? ` desde ${fmtDateTime(c.suspendedAt)}` : ''}
                {c.suspendedReason ? ` · ${c.suspendedReason}` : ''}. Sus usuarios no tienen acceso.
              </div>
            )}
            <div className="row" style={{ marginTop: 12 }}>
              <button className="primary" onClick={() => setCompanyId(c.id)} disabled={companyId === c.id}>
                {companyId === c.id ? 'Seleccionada' : 'Seleccionar'}
              </button>
              <button onClick={() => setEditing(c)}>Editar</button>
              {c.active ? (
                <button className="link danger-link" onClick={() => suspend(c)}>⏸ Suspender servicio</button>
              ) : (
                <button className="good" onClick={() => resume(c)}>▶ Reactivar servicio</button>
              )}
            </div>
          </div>
        ))}
        {companies.length === 0 && <div className="card empty muted">Aún no hay empresas. Crea la primera.</div>}
        {companies.length > 0 && shown.length === 0 && <div className="card empty muted">Ninguna empresa en este filtro. 🎉</div>}
      </div>
      {companyId && companies.some((c) => c.id === companyId) && <CompanySummary key={companyId} cid={companyId} />}
      {editing && (
        <CompanyModal
          company={editing === 'new' ? null : editing}
          billing={editing === 'new' ? null : billing.data?.[editing.id] ?? null}
          onClose={() => setEditing(null)}
          onSaved={async (id) => {
            setEditing(null);
            await Promise.all([reloadCompanies(), billing.reload()]);
            if (id) setCompanyId(id);
          }}
        />
      )}
    </div>
  );
}

function CompanyModal({
  company, billing, onClose, onSaved,
}: {
  company: CompanyRow | null;
  billing: Billing | null;
  onClose: () => void;
  onSaved: (id?: string) => void;
}) {
  const [name, setName] = useState(company?.name ?? '');
  const [baseCurrency, setBase] = useState<Currency>(company?.baseCurrency ?? 'CLP');
  const [dueDate, setDueDate] = useState(billing?.dueDate ?? '');
  const [billCurrency, setBillCurrency] = useState<Currency>(billing?.currency ?? 'CLP');
  const [amountText, setAmountText] = useState(billing?.amount != null ? fromMinor(billing.amount, billing.currency) : '');
  const [contactName, setContactName] = useState(billing?.contactName ?? '');
  const [contactEmail, setContactEmail] = useState(billing?.contactEmail ?? '');
  const [error, setError] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const amount = amountText.trim() ? toMinor(amountText, billCurrency) : null;
    if (amountText.trim() && amount == null) return setError('Monto de la mensualidad inválido.');
    try {
      let id = company?.id;
      if (company) {
        await api.patch(`/companies/${company.id}`, { name, baseCurrency });
      } else {
        id = (await api.post<{ id: string }>('/companies', { name, baseCurrency })).id;
      }
      await api.put(`/companies/${id}/billing`, { dueDate, amount, currency: billCurrency, contactName, contactEmail });
      onSaved(company ? undefined : id);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Modal title={company ? 'Editar empresa' : 'Nueva empresa'} onClose={onClose}>
      <form onSubmit={save}>
        <div className="field">
          <label htmlFor="cn">Nombre</label>
          <input id="cn" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="cb">Moneda base</label>
          <select id="cb" value={baseCurrency} onChange={(e) => setBase(e.target.value as Currency)}>
            {CURRENCY_CODES.map((c) => (
              <option key={c} value={c}>
                {c} — {CURRENCIES[c].name}
              </option>
            ))}
          </select>
          <div className="hint">Los montos mínimos de los flujos de aprobación se expresan en esta moneda.</div>
        </div>
        <div className="card soft">
          <h3>🧾 Facturación de tu servicio</h3>
          <p className="hint" style={{ marginTop: -6 }}>Solo tú ves estos datos. 5 días antes del vencimiento la empresa se marca en amarillo y aparece en Notificaciones.</p>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="bd">Próximo vencimiento</label>
              <input id="bd" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
              <div className="hint">Se repite cada mes el mismo día.</div>
            </div>
            <div className="field">
              <label htmlFor="ba">Mensualidad (opcional)</label>
              <div className="row nowrap tight">
                <select aria-label="Moneda" value={billCurrency} onChange={(e) => setBillCurrency(e.target.value as Currency)} style={{ width: 90 }}>
                  {CURRENCY_CODES.map((c) => <option key={c}>{c}</option>)}
                </select>
                <input id="ba" inputMode="decimal" placeholder="Ej: 50000" value={amountText} onChange={(e) => setAmountText(e.target.value)} />
              </div>
            </div>
            <div className="field">
              <label htmlFor="bn">Contacto de cobro (opcional)</label>
              <input id="bn" maxLength={100} placeholder="Nombre" value={contactName} onChange={(e) => setContactName(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="be">Correo de cobro (opcional)</label>
              <input id="be" type="email" placeholder="pagos@empresa.cl" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} />
            </div>
          </div>
          {billing?.lastPaidAt && (
            <div className="hint">Último pago registrado: {fmtDateTime(billing.lastPaidAt)} (mensualidad del {fmtDay(billing.lastPaidFor)}).</div>
          )}
        </div>
        {error && <div className="alert error">{error}</div>}
        <div className="row modal-actions">
          <button type="submit" className="primary">Guardar</button>
          <button type="button" onClick={onClose}>Cancelar</button>
        </div>
      </form>
    </Modal>
  );
}

interface Summary {
  users: { total: number; active: number; approvers: number; withoutFlow: string[] };
  flows: { id: string; name: string; levels: number; users: number; hasPayer: boolean }[];
  areas: { total: number; active: number };
  categories: { total: number; active: number };
  reports: { total: number; byStatus: Partial<Record<Status, { count: number; totals: Totals }>>; waitingOwner: number };
  lastActivity: string | null;
}

function CompanySummary({ cid }: { cid: string }) {
  const { companyName, goTo } = useCompany();
  const { data, error } = useLoad<Summary>(`/companies/${cid}/summary`);
  const st = (s: Status) => data?.reports.byStatus[s];

  return (
    <div className="card summary-card">
      <div className="row spread">
        <h2 style={{ margin: 0 }}>{companyName(cid)}</h2>
        {data && <span className="muted small">Última actividad: {data.lastActivity ? fmtDateTime(data.lastActivity) : 'sin rendiciones aún'}</span>}
      </div>
      {error && <div className="alert error">{error}</div>}
      {!data ? (
        <p className="muted">Cargando resumen…</p>
      ) : (
        <>
          {(data.users.withoutFlow.length > 0 || data.reports.waitingOwner > 0 || data.flows.length === 0 || data.categories.active === 0 || data.flows.some((f) => !f.hasPayer)) && (
            <div className="stack" style={{ marginTop: 12 }}>
              {data.reports.waitingOwner > 0 && (
                <div className="alert warn">
                  {data.reports.waitingOwner} rendición(es) esperan <b>tu aprobación</b>.{' '}
                  <button className="link" onClick={() => goTo('rendiciones')}>Ver</button>
                </div>
              )}
              {data.flows.length === 0 && (
                <div className="alert warn">
                  No tiene flujos de aprobación: nadie puede enviar rendiciones.{' '}
                  <button className="link" onClick={() => goTo('flujos')}>Crear flujo</button>
                </div>
              )}
              {data.flows.some((f) => !f.hasPayer) && (
                <div className="alert warn">
                  Flujo(s) sin “quién paga”: {data.flows.filter((f) => !f.hasPayer).map((f) => f.name).join(', ')}.{' '}
                  <button className="link" onClick={() => goTo('flujos')}>Definir</button>
                </div>
              )}
              {data.users.withoutFlow.length > 0 && (
                <div className="alert warn">
                  {data.users.withoutFlow.length} persona(s) sin flujo (no pueden enviar): {data.users.withoutFlow.join(', ')}.{' '}
                  <button className="link" onClick={() => goTo('usuarios')}>Asignar</button>
                </div>
              )}
              {data.categories.active === 0 && (
                <div className="alert warn">
                  No tiene categorías de gasto activas. <button className="link" onClick={() => goTo('catalogo')}>Agregar</button>
                </div>
              )}
            </div>
          )}

          <div className="grid summary-tiles">
            <button className="sum-tile" onClick={() => goTo('usuarios')}>
              <span className="label">Personas activas</span>
              <span className="value">{data.users.active}</span>
              <span className="sub">{data.users.approvers} aprobador(es){data.users.total > data.users.active ? ` · ${data.users.total - data.users.active} deshabilitada(s)` : ''}</span>
            </button>
            <button className="sum-tile" onClick={() => goTo('flujos')}>
              <span className="label">Flujos de aprobación</span>
              <span className="value">{data.flows.length}</span>
              <span className="sub">{data.flows.map((f) => `${f.name} (${f.levels} niv. · ${f.users} pers.)`).join(' · ') || 'Ninguno'}</span>
            </button>
            <button className="sum-tile" onClick={() => goTo('catalogo')}>
              <span className="label">Áreas / Categorías</span>
              <span className="value">{data.areas.active} / {data.categories.active}</span>
              <span className="sub">activas</span>
            </button>
            <button className="sum-tile" onClick={() => goTo('rendiciones')}>
              <span className="label">Rendiciones</span>
              <span className="value">{data.reports.total}</span>
              <span className="sub">en total</span>
            </button>
          </div>

          <div className="status-strip">
            {(['pending', 'approved', 'paid', 'rejected', 'draft'] as Status[]).map((s) => (
              <div key={s} className="status-cell">
                <span className={`badge ${s}`}>{STATUS_LABELS[s]}</span>
                <span className="strong">{st(s)?.count ?? 0}</span>
                <span className="muted small">{st(s)?.count ? formatTotals(st(s)?.totals) : '—'}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

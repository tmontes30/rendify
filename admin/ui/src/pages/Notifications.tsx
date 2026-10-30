import { useState, type ReactNode } from 'react';
import { REMINDER_HOURS } from '@rendiciones/shared';
import { PageHeader } from '../components';
import { useCompany, useLoad } from '../hooks';
import { api, qs } from '../api';
import { billingLabel, type Billing } from './Companies';
import { formatMoney } from '@rendiciones/shared';
import { NotifyModal } from './Reports';
import { LogoLoader } from '@rendiciones/shared/Busy';

interface NoticeItem {
  companyId: string;
  companyName: string;
  id: string;
  title: string;
  ownerName: string;
  total: string;
  levelName: string;
  to: string[];
  waitingHours: number;
  isReminder: boolean;
  missingPayer?: boolean;
}

type BillNotice = Billing & { companyId: string; companyName: string; active: boolean };

interface Notices {
  payer: NoticeItem[];
  approvers: NoticeItem[];
  paid: NoticeItem[];
  ownerTurn: NoticeItem[];
}

function duration(h: number) {
  if (h < 1) return 'menos de 1 h';
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} días`;
}

export function Notifications({ onChanged }: { onChanged: () => void }) {
  const { companyId, companyName, goTo } = useCompany();
  const { data, error, loading, reload } = useLoad<Notices>(`/notifications${qs({ companyId: companyId || undefined })}`);
  const [open, setOpen] = useState<{ item: NoticeItem; kind: 'payer' | 'approver' | 'paid' } | null>(null);
  const bills = useLoad<BillNotice[]>(`/notifications/billing${qs({ companyId: companyId || undefined })}`);
  const [billOpen, setBillOpen] = useState<BillNotice | null>(null);

  const refresh = async () => {
    await Promise.all([reload(), bills.reload()]);
    onChanged();
  };

  async function billPaid(b: BillNotice) {
    if (!confirm(`¿Registrar que ${b.companyName} pagó la mensualidad? El vencimiento pasará al mes siguiente.`)) return;
    await api.post(`/companies/${b.companyId}/billing/paid`).catch((e) => alert(e.message));
    await refresh();
  }

  async function suspend(b: BillNotice) {
    const reason = prompt(`Suspender el servicio de ${b.companyName}. Sus usuarios pierden el acceso hasta que lo reactives.\n\nMotivo:`, 'Mensualidad pendiente de pago');
    if (reason === null) return;
    await api.post(`/companies/${b.companyId}/suspend`, { reason }).catch((e) => alert(e.message));
    await refresh();
  }

  return (
    <div className="stack">
      <PageHeader
        title="Notificaciones"
        subtitle={`${companyId ? companyName(companyId) : 'Todas las empresas'} · Avisos por correo que debes enviar: prepara el mensaje, envíalo y márcalo como avisado.`}
        actions={
          <button onClick={() => void refresh()} disabled={loading}>
            {loading ? 'Actualizando…' : 'Actualizar'}
          </button>
        }
      />
      {error && <div className="alert error">{error}</div>}
      {bills.data && bills.data.length > 0 && (
        <div className="card bill-section">
          <h2 className="row tight">
            <span aria-hidden="true">🧾</span> Mensualidades por vencer o vencidas <span className="count-pill">{bills.data.length}</span>
          </h2>
          <div className="report-list">
            {bills.data.map((b) => {
              const l = billingLabel(b);
              return (
                <div key={b.companyId} className={`notice-row ${l.cls}-row`}>
                  <div className="notice-main">
                    <div className="row tight">
                      <span className="strong">{b.companyName}</span>
                      {!b.active && <span className="badge rejected">⏸ Suspendida</span>}
                    </div>
                    <div className={`small bill-text ${l.cls}`}>{l.text}</div>
                  </div>
                  <div className="notice-to small">
                    {b.contactEmail ? <>Para: <b>{b.contactName || b.contactEmail}</b></> : <span className="muted">Sin correo de cobro</span>}
                    {b.lastReminderAt && <div className="muted">Recordado {new Date(b.lastReminderAt).toLocaleDateString('es-CL')}</div>}
                  </div>
                  <div className="report-amount">{b.amount != null ? formatMoney(b.amount, b.currency) : '—'}</div>
                  <div className="row tight">
                    <button className="primary" onClick={() => setBillOpen(b)}>✉ Recordatorio</button>
                    <button className="good" onClick={() => billPaid(b)}>✓ Pago recibido</button>
                    {b.active && b.state === 'overdue' && (
                      <button className="danger" onClick={() => suspend(b)}>⏸ Suspender</button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {!data ? (
        <LogoLoader variant="admin" />
      ) : (
        <>
          <Section
            icon="💳"
            title="Aprobadas por completo: avisar a quien paga"
            empty="No hay rendiciones aprobadas pendientes de aviso."
            items={data.payer}
            render={(it) => (
              <>
                <div className="notice-main">
                  <div className="strong">{it.title}</div>
                  <div className="muted small">
                    {it.companyName} · {it.ownerName} · aprobada hace {duration(it.waitingHours)}
                  </div>
                </div>
                <div className="notice-to small">
                  {it.missingPayer ? (
                    <span className="text-bad">El flujo no tiene “quién paga”</span>
                  ) : (
                    <>
                      Para: <b>{it.to.join(', ')}</b>
                    </>
                  )}
                </div>
                <div className="report-amount">{it.total}</div>
                {it.missingPayer ? (
                  <button onClick={() => goTo('flujos')}>Definir quién paga</button>
                ) : (
                  <button className="primary" onClick={() => setOpen({ item: it, kind: 'payer' })}>
                    ✉ Preparar aviso
                  </button>
                )}
              </>
            )}
          />

          <Section
            icon="⏰"
            title={`Más de ${REMINDER_HOURS} h esperando: avisar al aprobador`}
            empty={`Ninguna rendición lleva más de ${REMINDER_HOURS} h esperando en su nivel.`}
            items={data.approvers}
            render={(it) => (
              <>
                <div className="notice-main">
                  <div className="row tight">
                    <span className="strong">{it.title}</span>
                    {it.isReminder && <span className="badge resent">Recordatorio</span>}
                  </div>
                  <div className="muted small">
                    {it.companyName} · {it.ownerName} · lleva {duration(it.waitingHours)} en “{it.levelName}”
                  </div>
                </div>
                <div className="notice-to small">
                  Para: <b>{it.to.join(' o ')}</b>
                </div>
                <div className="report-amount">{it.total}</div>
                <button className="primary" onClick={() => setOpen({ item: it, kind: 'approver' })}>
                  ✉ Preparar aviso
                </button>
              </>
            )}
          />

          <Section
            icon="✅"
            title="Pagadas: avisar al trabajador"
            empty="No hay pagos recientes pendientes de aviso."
            items={data.paid}
            render={(it) => (
              <>
                <div className="notice-main">
                  <div className="strong">{it.title}</div>
                  <div className="muted small">
                    {it.companyName} · {it.levelName} · hace {duration(it.waitingHours)}
                  </div>
                </div>
                <div className="notice-to small">
                  Para: <b>{it.to.join(', ')}</b>
                </div>
                <div className="report-amount">{it.total}</div>
                <button className="primary" onClick={() => setOpen({ item: it, kind: 'paid' })}>
                  ✉ Preparar aviso
                </button>
              </>
            )}
          />

          {data.ownerTurn.length > 0 && (
            <Section
              icon="👤"
              title="Esperan tu aprobación"
              empty=""
              items={data.ownerTurn}
              render={(it) => (
                <>
                  <div className="notice-main">
                    <div className="strong">{it.title}</div>
                    <div className="muted small">
                      {it.companyName} · {it.ownerName} · lleva {duration(it.waitingHours)}
                    </div>
                  </div>
                  <div className="notice-to muted small">La envió el último nivel de su flujo</div>
                  <div className="report-amount">{it.total}</div>
                  <button onClick={() => goTo('rendiciones')}>Ir a aprobar</button>
                </>
              )}
            />
          )}
        </>
      )}

      {billOpen && (
        <NotifyModal
          cid={billOpen.companyId}
          id=""
          title="Recordatorio de pago de mensualidad"
          path={`/companies/${billOpen.companyId}/billing/notify`}
          markPath={`/companies/${billOpen.companyId}/billing/reminded`}
          onClose={() => setBillOpen(null)}
          onMarked={() => void refresh()}
        />
      )}

      {open && (
        <NotifyModal
          cid={open.item.companyId}
          id={open.item.id}
          toPayer={open.kind === 'payer'}
          markKind={open.kind}
          onClose={() => setOpen(null)}
          onMarked={() => void refresh()}
        />
      )}
    </div>
  );
}

function Section({
  icon, title, empty, items, render,
}: {
  icon: string;
  title: string;
  empty: string;
  items: NoticeItem[];
  render: (it: NoticeItem) => ReactNode;
}) {
  return (
    <div className="card">
      <h2 className="row tight">
        <span aria-hidden="true">{icon}</span> {title} <span className="count-pill">{items.length}</span>
      </h2>
      {items.length === 0 ? (
        <p className="muted small" style={{ margin: 0 }}>{empty}</p>
      ) : (
        <div className="report-list">
          {items.map((it) => (
            <div key={`${it.companyId}/${it.id}`} className="notice-row">
              {render(it)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

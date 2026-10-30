import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  EDITABLE_STATUSES,
  formatMoney,
  formatTotals,
  resubmissionInfo,
  PAYMENT_METHOD_LABELS,
  type Approval,
  type Category,
  type Flow,
  type Item,
  type Report,
} from '@rendiciones/shared';
import { useSession } from '../auth';
import { fmtDate, friendlyError, getFlow, getReport, listCategories } from '../data';
import { StatusBadge } from './StatusBadge';
import { AttachmentsViewer } from './Attachments';
import { LogoLoader } from '@rendiciones/shared/Busy';

interface Loaded {
  items: Item[];
  flow: Flow | null;
  categories: Category[];
}

// Caché por empresa para no recargar categorías en cada fila.
const catCache = new Map<string, Promise<Category[]>>();

/** Fila de rendición que se despliega en el mismo lugar mostrando su avance y sus gastos. */
export function ReportRow({ report, subtitle }: { report: Report; subtitle: string }) {
  const { company, profile } = useSession();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !data) {
      try {
        if (!catCache.has(company.id)) catCache.set(company.id, listCategories(company.id));
        const [r, flow, categories] = await Promise.all([
          getReport(company.id, report.id),
          report.flowId ? getFlow(company.id, report.flowId) : Promise.resolve(null),
          catCache.get(company.id)!,
        ]);
        setData({ items: r?.items ?? [], flow, categories });
      } catch (e) {
        setError(friendlyError(e));
      }
    }
  }

  const isOwner = report.ownerUid === profile.uid;
  const canEdit = isOwner && EDITABLE_STATUSES.includes(report.status);
  const canDecide = !isOwner && report.status === 'pending' && report.currentApprovers.includes(profile.uid);
  const resub = resubmissionInfo(report);

  return (
    <div className={`report-card${open ? ' open' : ''}`}>
      <button className="report-item" onClick={toggle} aria-expanded={open}>
        <div className="report-main">
          <div className="row tight">
            <span className="strong report-title">{report.title}</span>
            {resub.round > 1 && <span className="badge resent">↻ {resub.round}° envío</span>}
          </div>
          <div className="muted small">{subtitle}</div>
        </div>
        <StatusBadge status={report.status} />
        <div className="report-amount">{formatTotals(report.totals)}</div>
        <span className="chevron" aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className="report-detail">
          {error && <div className="alert error">{error}</div>}
          {!data && !error && <LogoLoader />}
          {data && (
            <>
              {resub.lastRejection && report.status !== 'rejected' && <ResubmittedNotice info={resub} owner={report.ownerName} />}
              <Progress report={report} flow={data.flow} />
              <ItemsMini items={data.items} categories={data.categories} />
              <AttachmentsViewer cid={company.id} rid={report.id} compact />
              <div className="row detail-actions">
                {canEdit && (
                  <Link to={`/r/${report.id}`} className="btn primary">
                    {report.status === 'rejected' ? 'Corregir y reenviar' : 'Continuar editando'}
                  </Link>
                )}
                {canDecide && (
                  <Link to={`/r/${report.id}`} className="btn primary">Revisar y decidir</Link>
                )}
                {!isOwner && profile.paymentsUser && report.status === 'approved' && data.flow?.payerUid === profile.uid && (
                  <Link to={`/r/${report.id}`} className="btn primary">💳 Registrar pago</Link>
                )}
                <Link to={`/r/${report.id}`} className="btn">Ver detalle completo</Link>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Aviso de que la rendición fue rechazada antes y se reenvió corregida. */
export function ResubmittedNotice({ info, owner }: { info: ReturnType<typeof resubmissionInfo>; owner: string }) {
  if (!info.lastRejection) return null;
  const r = info.lastRejection;
  return (
    <div className="resent-notice">
      <div className="strong">↻ Reenviada con corrección ({info.round}° envío)</div>
      <div className="small">
        La rechazó <b>{r.by}</b> ({r.levelName}){r.comment ? <> por: <i>“{r.comment}”</i></> : null}. {owner} la corrigió y la volvió a enviar.
      </div>
    </div>
  );
}

type StepState = 'done' | 'current' | 'rejected' | 'skipped' | 'todo';

/** Avance por niveles del flujo, considerando solo la ronda actual (tras el último reenvío). */
function Progress({ report, flow }: { report: Report; flow: Flow | null }) {
  if (report.status === 'draft') {
    return <div className="alert warn small">Borrador: aún no se envía a aprobación.</div>;
  }
  const round = currentRound(report);
  const levels = flow?.levels ?? [];
  const nameOf = (uid: string) => flow?.approverNames?.[uid] ?? 'Aprobador';
  const toOwner = report.status === 'pending' && report.currentApprovers.length === 0;

  const steps: { title: string; who: string; state: StepState; note?: string }[] = [
    { title: 'Enviada', who: report.ownerName, state: 'done', note: fmtDate(report.submittedAt) },
  ];
  levels.forEach((l, i) => {
    const decision = round.find((a) => a.level === i);
    let state: StepState = 'todo';
    if (decision) state = decision.decision === 'approved' ? 'done' : 'rejected';
    else if (report.status === 'pending' && !toOwner && report.currentLevel === i) state = 'current';
    else if (i < report.currentLevel || ['approved', 'paid'].includes(report.status)) state = 'skipped';
    steps.push({
      title: l.name,
      // En el nivel actual se muestra a quién espera realmente la rendición.
      who: decision ? decision.name : state === 'current' ? report.currentApprovers.map(nameOf).join(' o ') : l.approvers.map(nameOf).join(' o '),
      state,
      note: decision ? (decision.comment ? `“${decision.comment}”` : new Date(decision.atMs).toLocaleDateString('es-CL')) : state === 'skipped' ? 'No requerido' : undefined,
    });
  });
  if (toOwner || report.ownerReview) {
    const rev = report.ownerReview;
    steps.push({
      title: 'Administración',
      who: 'Aprobación final',
      state: toOwner ? 'current' : rev?.decision === 'rejected' ? 'rejected' : 'done',
      note: rev?.comment ? `“${rev.comment}”` : undefined,
    });
  }
  const pay = report.payment;
  steps.push({
    title: report.status === 'paid' ? 'Pagada' : 'Aprobada',
    who:
      report.status === 'paid'
        ? `${fmtDate(report.paidAt)}${pay ? ` · ${PAYMENT_METHOD_LABELS[pay.method] ?? pay.method}` : ''}`
        : flow?.payerUid
          ? `Paga: ${nameOf(flow.payerUid)}`
          : 'Pasa a pago',
    note: report.status === 'paid' && pay ? `${pay.name}${pay.reference ? ` · N° ${pay.reference}` : ''}` : report.status === 'approved' ? 'Pendiente de pago' : undefined,
    state: ['approved', 'paid'].includes(report.status) ? 'done' : report.status === 'rejected' ? 'todo' : 'todo',
  });

  const outdated =
    report.status === 'pending' &&
    !!flow &&
    report.currentApprovers.length > 0 &&
    JSON.stringify(flow.levels[report.currentLevel]?.approvers ?? []) !== JSON.stringify(report.currentApprovers);

  return (
    <div>
      {outdated && (
        <div className="alert warn small" style={{ marginBottom: 10 }}>
          El flujo se modificó después del envío. Hoy espera a <b>{report.currentApprovers.map(nameOf).join(' o ')}</b>; al guardar el flujo de nuevo se reacomoda.
        </div>
      )}
      {report.status === 'rejected' && (
        <div className="alert error small" style={{ marginBottom: 10 }}>
          Rechazada{rejectComment(report) ? `: ${rejectComment(report)}` : ''}. Corrígela y vuelve a enviarla.
        </div>
      )}
      <ol className="stepper">
        {steps.map((s, i) => (
          <li key={i} className={`step ${s.state}`}>
            <span className="step-dot" aria-hidden="true">
              {s.state === 'done' ? '✓' : s.state === 'rejected' ? '✕' : s.state === 'skipped' ? '–' : i}
            </span>
            <div className="step-body">
              <div className="step-title">{s.title}</div>
              <div className="step-who">{s.who}</div>
              {s.state === 'current' && <div className="step-note current-note">Esperando aprobación</div>}
              {s.note && <div className="step-note">{s.note}</div>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ItemsMini({ items, categories }: { items: Item[]; categories: Category[] }) {
  const cat = (id: string) => categories.find((c) => c.id === id)?.name ?? id;
  if (!items.length) return null;
  return (
    <div className="items-mini">
      {items.map((it) => (
        <div key={it.id} className="items-mini-row">
          <span className="muted small">{it.date}</span>
          <span className="small">{cat(it.categoryId)}</span>
          <span className="items-mini-desc">{it.description}</span>
          <span className="num strong">{formatMoney(it.amount, it.currency)}</span>
        </div>
      ))}
    </div>
  );
}

function lastIndex(arr: Approval[], pred: (a: Approval) => boolean, before = arr.length) {
  for (let i = before - 1; i >= 0; i--) if (pred(arr[i])) return i;
  return -1;
}

/**
 * Decisiones de la ronda actual. Cada rechazo cierra una ronda; si la rendición
 * está rechazada por un aprobador, la ronda incluye ese rechazo.
 */
function currentRound(r: Report): Approval[] {
  const a = r.approvals;
  const isRej = (x: Approval) => x.decision === 'rejected';
  if (r.status === 'rejected' && a.length && isRej(a[a.length - 1])) {
    return a.slice(lastIndex(a, isRej, a.length - 1) + 1);
  }
  return a.slice(lastIndex(a, isRej) + 1);
}

function rejectComment(r: Report) {
  if (r.ownerReview?.decision === 'rejected') return r.ownerReview.comment;
  return r.approvals[r.approvals.length - 1]?.comment ?? '';
}

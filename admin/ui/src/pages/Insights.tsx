import { useState } from 'react';
import { qs } from '../api';
import { fmtDateTime, useCompany, useLoad } from '../hooks';

interface Alert {
  id: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail: string;
  count: number;
  page: string;
  items?: string[];
}

interface InsightsData {
  alerts: Alert[];
  kpis: {
    users: number;
    active7: number;
    active30: number;
    companies: number;
    companiesActive: number;
    sent30: number;
    sentTotal: number;
    avgApprovalHours: number | null;
    avgPaymentHours: number | null;
  };
  weeks: { week: string; sent: number }[];
  byCompany: {
    companyId: string;
    name: string;
    active: boolean;
    users: number;
    active30: number;
    reports30: number;
    reportsTotal: number;
    pending: number;
    toPay: number;
    lastUse: string | null;
  }[];
  byUser: {
    uid: string;
    name: string;
    company: string;
    role: string;
    reports: number;
    reports30: number;
    decisions: number;
    paid: number;
    lastSignIn: string | null;
  }[];
  approverSpeed: { uid: string; name: string; decisions: number; avgHours: number }[];
}

const SEV = {
  critical: { icon: '⛔', label: 'Urgente' },
  warning: { icon: '⚠', label: 'Atención' },
  info: { icon: 'ℹ', label: 'Por revisar' },
} as const;

export function hours(h: number | null) {
  if (h == null) return '—';
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${h.toFixed(h < 10 ? 1 : 0)} h`;
  return `${(h / 24).toFixed(1)} días`;
}

function ago(iso: string | null) {
  if (!iso) return 'Nunca';
  const d = (Date.now() - Date.parse(iso)) / 86_400_000;
  if (d < 1) return 'Hoy';
  if (d < 2) return 'Ayer';
  if (d < 30) return `Hace ${Math.floor(d)} días`;
  return fmtDateTime(iso);
}

/** Tablero de uso y pendientes del owner (arriba del Panel). */
export function Insights() {
  const { companyId, goTo } = useCompany();
  const { data, error } = useLoad<InsightsData>(`/insights${qs({ companyId: companyId || undefined })}`);

  if (error) return <div className="alert error">{error}</div>;
  if (!data) return <p className="muted">Calculando indicadores…</p>;
  const k = data.kpis;

  return (
    <div className="stack">
      <AlertsCard alerts={data.alerts} goTo={goTo} />

      <div className="grid grid-tiles">
        <Kpi label="Personas activas (7 días)" value={`${k.active7} / ${k.users}`} sub={`${pct(k.active7, k.users)} entró esta semana · ${k.active30} en 30 días`} />
        <Kpi label="Rendiciones enviadas (30 días)" value={String(k.sent30)} sub={`${k.sentTotal} desde el inicio`} />
        <Kpi label="Tiempo promedio de aprobación" value={hours(k.avgApprovalHours)} sub="Desde que se envía hasta la aprobación final" />
        <Kpi label="Tiempo promedio de pago" value={hours(k.avgPaymentHours)} sub="Desde la aprobación hasta el pago" />
        {!companyId && <Kpi label="Empresas con servicio activo" value={`${k.companiesActive} / ${k.companies}`} sub={k.companies - k.companiesActive ? `${k.companies - k.companiesActive} suspendida(s)` : 'Ninguna suspendida'} />}
      </div>

      <div className="card">
        <h3>Rendiciones enviadas por semana <span className="muted small">(últimas 12 semanas)</span></h3>
        <WeeklyChart weeks={data.weeks} />
      </div>

      <div className="grid grid-2">
        {!companyId && <CompanyUsage rows={data.byCompany} />}
        <UserUsage rows={data.byUser} />
        <ApproverSpeed rows={data.approverSpeed} />
      </div>
    </div>
  );
}

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '0%');

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card tile">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

function AlertsCard({ alerts, goTo }: { alerts: Alert[]; goTo: (p: string) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!alerts.length) {
    return (
      <div className="card alerts-card ok">
        <h2 style={{ margin: 0 }}>✓ No tienes pendientes</h2>
        <p className="muted small" style={{ margin: '4px 0 0' }}>Todo al día: avisos enviados, flujos completos y mensualidades en orden.</p>
      </div>
    );
  }
  const critical = alerts.filter((a) => a.severity === 'critical').length;
  return (
    <div className="card alerts-card">
      <div className="row spread">
        <h2 style={{ margin: 0 }}>Pendientes para accionar</h2>
        <span className="muted small">{alerts.length} tema(s){critical ? ` · ${critical} urgente(s)` : ''}</span>
      </div>
      <div className="alert-list">
        {alerts.map((a) => (
          <div key={a.id} className={`alert-item ${a.severity}`}>
            <div className="alert-icon" aria-hidden="true">{SEV[a.severity].icon}</div>
            <div className="alert-body">
              <div className="row tight">
                <span className="strong">{a.title}</span>
                <span className="count-pill">{a.count}</span>
                <span className={`sev-tag ${a.severity}`}>{SEV[a.severity].label}</span>
              </div>
              <div className="muted small">{a.detail}</div>
              {open === a.id && a.items && (
                <ul className="alert-items">
                  {a.items.slice(0, 12).map((it, i) => (
                    <li key={i}>{it}</li>
                  ))}
                  {a.items.length > 12 && <li className="muted">… y {a.items.length - 12} más</li>}
                </ul>
              )}
            </div>
            <div className="row tight alert-actions">
              {a.items && a.items.length > 0 && (
                <button className="link" onClick={() => setOpen(open === a.id ? null : a.id)}>{open === a.id ? 'Ocultar' : 'Ver cuáles'}</button>
              )}
              <button className={a.severity === 'critical' ? 'primary' : ''} onClick={() => goTo(a.page)}>Resolver →</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Columnas de una sola serie con tooltip al pasar el mouse. */
function WeeklyChart({ weeks }: { weeks: { week: string; sent: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720;
  const H = 200;
  const pad = { l: 34, r: 10, t: 14, b: 28 };
  const max = Math.max(4, ...weeks.map((w) => w.sent));
  const step = Math.ceil(max / 4);
  const top = step * 4;
  const cw = (W - pad.l - pad.r) / weeks.length;
  const bw = Math.min(34, cw * 0.62);
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / top);
  const label = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
  const total = weeks.reduce((a, w) => a + w.sent, 0);
  if (!total) return <p className="muted small">Aún no hay rendiciones enviadas en las últimas 12 semanas.</p>;

  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Rendiciones enviadas por semana">
        {[0, 1, 2, 3, 4].map((i) => (
          <g key={i}>
            <line x1={pad.l} x2={W - pad.r} y1={y(i * step)} y2={y(i * step)} className="grid-line" />
            <text x={pad.l - 6} y={y(i * step) + 4} className="axis-label" textAnchor="end">{i * step}</text>
          </g>
        ))}
        {weeks.map((w, i) => {
          const x = pad.l + i * cw + (cw - bw) / 2;
          const h = Math.max(0, y(0) - y(w.sent));
          return (
            <g key={w.week} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={pad.l + i * cw} y={pad.t} width={cw} height={H - pad.t - pad.b} fill="transparent" />
              {w.sent > 0 && (
                <path
                  className={`bar${hover === i ? ' hover' : ''}`}
                  d={`M${x},${y(0)} V${y(0) - h + Math.min(4, h)} Q${x},${y(0) - h} ${x + Math.min(4, bw / 2)},${y(0) - h} H${x + bw - Math.min(4, bw / 2)} Q${x + bw},${y(0) - h} ${x + bw},${y(0) - h + Math.min(4, h)} V${y(0)} Z`}
                />
              )}
              {(i % 2 === 1 || weeks.length <= 8) && (
                <text x={x + bw / 2} y={H - 8} className="axis-label" textAnchor="middle">{label(w.week)}</text>
              )}
              {i === weeks.length - 1 && w.sent > 0 && (
                <text x={x + bw / 2} y={y(w.sent) - 6} className="value-label" textAnchor="middle">{w.sent}</text>
              )}
            </g>
          );
        })}
        <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} className="base-line" />
      </svg>
      {hover != null && (
        <div className="chart-tip" style={{ left: `${((pad.l + hover * cw + cw / 2) / W) * 100}%` }}>
          <div className="muted small">Semana del {label(weeks[hover].week)}</div>
          <div className="strong">{weeks[hover].sent} rendición(es)</div>
        </div>
      )}
    </div>
  );
}

function Bar({ value, max }: { value: number; max: number }) {
  return (
    <div className="bar-track" title={String(value)}>
      <div className="bar-fill" style={{ width: `${max ? (value / max) * 100 : 0}%` }} />
    </div>
  );
}

function CompanyUsage({ rows }: { rows: InsightsData['byCompany'] }) {
  const max = Math.max(1, ...rows.map((r) => r.reports30));
  return (
    <div className="card">
      <h3>Uso por empresa <span className="muted small">(últimos 30 días)</span></h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Empresa</th>
              <th>Activos</th>
              <th>Rendiciones</th>
              <th className="num">Pend. / Por pagar</th>
              <th className="hide-sm">Último uso</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.companyId}>
                <td>
                  <span className="strong">{r.name}</span> {!r.active && <span className="badge rejected">⏸</span>}
                </td>
                <td className="small">
                  {r.active30}/{r.users} <span className="muted">({pct(r.active30, r.users)})</span>
                </td>
                <td style={{ minWidth: 130 }}>
                  <div className="row nowrap tight">
                    <Bar value={r.reports30} max={max} />
                    <span className="small strong">{r.reports30}</span>
                  </div>
                </td>
                <td className="num small">
                  {r.pending} / {r.toPay}
                </td>
                <td className="hide-sm small muted">{ago(r.lastUse)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function UserUsage({ rows }: { rows: InsightsData['byUser'] }) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? rows : rows.slice(0, 10);
  const max = Math.max(1, ...rows.map((r) => r.reports + r.decisions + r.paid));
  return (
    <div className="card">
      <h3>Uso por persona</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Persona</th>
              <th>Actividad</th>
              <th className="num">Rend. · Decisiones · Pagos</th>
              <th className="hide-sm">Último ingreso</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.uid}>
                <td>
                  <div className="strong small">{r.name}</div>
                  <div className="muted small">{r.company} · {r.role}</div>
                </td>
                <td style={{ minWidth: 100 }}>
                  <Bar value={r.reports + r.decisions + r.paid} max={max} />
                </td>
                <td className="num small">
                  {r.reports} · {r.decisions} · {r.paid}
                </td>
                <td className={`hide-sm small ${r.lastSignIn ? 'muted' : 'text-bad'}`}>{ago(r.lastSignIn)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > 10 && (
        <button className="link" onClick={() => setShowAll(!showAll)}>{showAll ? 'Ver menos' : `Ver las ${rows.length} personas`}</button>
      )}
    </div>
  );
}

function ApproverSpeed({ rows }: { rows: InsightsData['approverSpeed'] }) {
  const max = Math.max(1, ...rows.map((r) => r.avgHours));
  return (
    <div className="card">
      <h3>Velocidad de aprobadores <span className="muted small">(tiempo promedio en decidir)</span></h3>
      {rows.length === 0 ? (
        <p className="muted small">Aún no hay decisiones registradas.</p>
      ) : (
        <table>
          <tbody>
            {rows.map((r) => (
              <tr key={r.uid}>
                <td className="small">
                  <span className="strong">{r.name}</span>
                  <div className="muted">{r.decisions} decisión(es)</div>
                </td>
                <td style={{ width: '45%' }}>
                  <Bar value={r.avgHours} max={max} />
                </td>
                <td className={`num small strong ${r.avgHours > 24 ? 'text-bad' : ''}`}>{hours(r.avgHours)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

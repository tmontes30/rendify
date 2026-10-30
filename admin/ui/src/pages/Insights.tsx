import { useState } from 'react';
import { qs } from '../api';
import { fmtDateTime, useCompany, useLoad } from '../hooks';
import { LogoLoader } from '@rendiciones/shared/Busy';

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
  approverSpeed: { uid: string; name: string; company: string; decisions: number; avgHours: number; maxHours: number }[];
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
  if (!data) return <LogoLoader text="Calculando indicadores…" variant="admin" />;
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

      <UsageTabs data={data} showCompanies={!companyId} />
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

type UsageTab = 'companies' | 'people' | 'approvers';

/** Uso de la plataforma a todo el ancho, en pestañas (empresas, personas, aprobadores). */
function UsageTabs({ data, showCompanies }: { data: InsightsData; showCompanies: boolean }) {
  const [tab, setTab] = useState<UsageTab>(showCompanies ? 'companies' : 'people');
  const current = !showCompanies && tab === 'companies' ? 'people' : tab;
  return (
    <div className="card">
      <div className="row spread">
        <h2 style={{ margin: 0 }}>Uso de la plataforma</h2>
      </div>
      <nav className="tabs" style={{ marginTop: 10 }}>
        {showCompanies && (
          <button className={current === 'companies' ? 'active' : ''} onClick={() => setTab('companies')}>
            Por empresa <span className="count-pill">{data.byCompany.length}</span>
          </button>
        )}
        <button className={current === 'people' ? 'active' : ''} onClick={() => setTab('people')}>
          Por persona <span className="count-pill">{data.byUser.length}</span>
        </button>
        <button className={current === 'approvers' ? 'active' : ''} onClick={() => setTab('approvers')}>
          Aprobadores <span className="count-pill">{data.approverSpeed.length}</span>
        </button>
      </nav>
      {current === 'companies' && <CompanyUsage rows={data.byCompany} />}
      {current === 'people' && <UserUsage rows={data.byUser} />}
      {current === 'approvers' && <ApproverSpeed rows={data.approverSpeed} />}
    </div>
  );
}

function Metric({ label, value, sub, tone }: { label: string; value: string | number; sub?: string; tone?: 'bad' | 'warn' }) {
  return (
    <div className="metric">
      <div className="metric-label">{label}</div>
      <div className={`metric-value${tone ? ` text-${tone}` : ''}`}>{value}</div>
      {sub && <div className="metric-sub">{sub}</div>}
    </div>
  );
}

function CompanyUsage({ rows }: { rows: InsightsData['byCompany'] }) {
  const max = Math.max(1, ...rows.map((r) => r.reports30));
  const sorted = [...rows].sort((a, b) => b.reports30 - a.reports30 || a.name.localeCompare(b.name));
  if (!rows.length) return <p className="muted small">Sin empresas.</p>;
  return (
    <div className="usage-list">
      {sorted.map((r) => {
        const adoption = r.users ? Math.round((r.active30 / r.users) * 100) : 0;
        return (
          <div key={r.companyId} className="usage-row">
            <div className="usage-name">
              <div className="strong">{r.name}</div>
              <div className="muted small">{r.active ? `Último uso: ${ago(r.lastUse)}` : '⏸ Servicio suspendido'}</div>
              <div className="usage-bar" title={`${r.reports30} rendiciones en 30 días`}>
                <div className="bar-track"><div className="bar-fill" style={{ width: `${(r.reports30 / max) * 100}%` }} /></div>
              </div>
            </div>
            <Metric label="Personas activas" value={`${r.active30}/${r.users}`} sub={`${adoption}% entró en 30 días`} tone={adoption < 50 ? 'warn' : undefined} />
            <Metric label="Rendiciones (30 días)" value={r.reports30} sub={`${r.reportsTotal} en total`} />
            <Metric label="En aprobación" value={r.pending} />
            <Metric label="Por pagar" value={r.toPay} tone={r.toPay ? 'warn' : undefined} />
          </div>
        );
      })}
    </div>
  );
}

type PersonSort = 'name' | 'company' | 'reports' | 'decisions' | 'paid' | 'lastSignIn';

function UserUsage({ rows }: { rows: InsightsData['byUser'] }) {
  const [q, setQ] = useState('');
  const [role, setRole] = useState('');
  const [sort, setSort] = useState<{ key: PersonSort; dir: 1 | -1 }>({ key: 'lastSignIn', dir: -1 });
  const roles = [...new Set(rows.map((r) => r.role))];
  const val = (r: InsightsData['byUser'][number], k: PersonSort): string | number =>
    k === 'lastSignIn' ? (r.lastSignIn ? Date.parse(r.lastSignIn) : 0) : k === 'name' || k === 'company' ? r[k].toLowerCase() : r[k];
  const shown = rows
    .filter((r) => (!role || r.role === role) && `${r.name} ${r.company}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => {
      const x = val(a, sort.key);
      const y = val(b, sort.key);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    });
  const head = (k: PersonSort, label: string, num?: boolean) => (
    <th className={num ? 'num' : ''}>
      <button className="sort-btn" onClick={() => setSort((s) => ({ key: k, dir: s.key === k ? ((-s.dir) as 1 | -1) : k === 'name' || k === 'company' ? 1 : -1 }))}>
        {label} {sort.key === k ? (sort.dir === 1 ? '▲' : '▼') : ''}
      </button>
    </th>
  );
  return (
    <div>
      <div className="row" style={{ marginBottom: 10 }}>
        <input className="search" placeholder="Buscar persona o empresa…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={role} onChange={(e) => setRole(e.target.value)} style={{ width: 'auto' }} aria-label="Filtrar por rol">
          <option value="">Todos los roles</option>
          {roles.map((r) => <option key={r}>{r}</option>)}
        </select>
        <span className="muted small">{shown.length} persona(s)</span>
      </div>
      <div className="table-wrap">
        <table className="usage-table">
          <thead>
            <tr>
              {head('name', 'Persona')}
              {head('company', 'Empresa')}
              <th>Rol</th>
              {head('reports', 'Rendiciones', true)}
              {head('decisions', 'Decisiones', true)}
              {head('paid', 'Pagos', true)}
              {head('lastSignIn', 'Último ingreso')}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.uid}>
                <td className="strong">{r.name}</td>
                <td>{r.company}</td>
                <td><span className={`badge ${r.role === 'Aprobador' ? 'info' : r.role === 'Pagos' ? 'approved' : ''}`}>{r.role}</span></td>
                <td className="num">{r.reports}{r.reports30 ? <span className="muted small"> ({r.reports30} este mes)</span> : null}</td>
                <td className="num">{r.decisions || <span className="muted">—</span>}</td>
                <td className="num">{r.paid || <span className="muted">—</span>}</td>
                <td className={r.lastSignIn ? '' : 'text-bad strong'}>{ago(r.lastSignIn)}</td>
              </tr>
            ))}
            {!shown.length && (
              <tr>
                <td colSpan={7} className="muted">Sin resultados.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ApproverSpeed({ rows }: { rows: InsightsData['approverSpeed'] }) {
  if (!rows.length) return <p className="muted small">Aún no hay decisiones registradas.</p>;
  const max = Math.max(1, ...rows.map((r) => r.avgHours));
  return (
    <div>
      <p className="muted small" style={{ marginTop: 0 }}>
        Tiempo promedio desde que una rendición llega a su nivel hasta que la aprueban o rechazan. Los más lentos primero; en rojo si pasan de 24 h.
      </p>
      <div className="usage-list">
        {rows.map((r) => (
          <div key={r.uid} className="speed-row">
            <div>
              <div className="strong">{r.name}</div>
              <div className="muted small">{r.company} · {r.decisions} decisión(es)</div>
            </div>
            <div className="bar-track speed-track" title={`Promedio ${hours(r.avgHours)}`}>
              <div className={`bar-fill${r.avgHours > 24 ? ' bar-bad' : ''}`} style={{ width: `${Math.max(2, (r.avgHours / max) * 100)}%` }} />
            </div>
            <Metric label="Promedio" value={hours(r.avgHours)} tone={r.avgHours > 24 ? 'bad' : undefined} />
            <Metric label="Más lento" value={hours(r.maxHours)} />
          </div>
        ))}
      </div>
    </div>
  );
}

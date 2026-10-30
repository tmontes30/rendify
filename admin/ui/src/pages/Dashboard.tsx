import { useMemo, useState } from 'react';
import { CURRENCY_CODES, formatMoney, formatTotals, type Currency, type Status, type Totals } from '@rendiciones/shared';
import { api, qs } from '../api';
import { useCompany, useLoad } from '../hooks';
import { PageHeader } from '../components';
import { Insights } from './Insights';
import { LogoLoader } from '@rendiciones/shared/Busy';

interface Row { key: string; totals: Totals }
interface DashboardData {
  total: Totals;
  itemCount: number;
  statusSummary: Record<Status, { count: number; totals: Totals }>;
  byCompany: Row[];
  byArea: Row[];
  byMonth: Row[];
  byCategory: Row[];
  byUser: Row[];
  names: { companies: Record<string, string>; areas: Record<string, string>; categories: Record<string, string>; users: Record<string, string> };
  usersCount: { total: number; active: number };
}

function yearStart() {
  return `${new Date().getFullYear()}-01-01`;
}

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const monthLabel = (k: string) => `${MONTHS[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}`;

export function Dashboard() {
  const [from, setFrom] = useState(yearStart());
  const [to, setTo] = useState('');
  const { companyId, companyName } = useCompany();
  const { data, error, loading, reload } = useLoad<DashboardData>(`/dashboard${qs({ from, to, companyId: companyId || undefined })}`);

  // Monedas presentes, ordenadas por cantidad de movimientos; la principal se usa para las barras.
  const currencies = useMemo(
    () => CURRENCY_CODES.filter((c) => (data?.total[c] ?? 0) > 0),
    [data],
  );
  const [chosen, setChosen] = useState<Currency | ''>('');
  const currency: Currency | undefined = chosen || currencies[0];

  if (error) return <div className="alert error">{error}</div>;

  const s = data?.statusSummary;
  return (
    <div className="stack">
      <PageHeader title="Panel" subtitle={companyId ? companyName(companyId) : 'Todas las empresas'} />
      <Insights />
      <h2 className="section-title">Gasto rendido</h2>
      <div className="card toolbar">
        <div className="row">
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="from">Desde</label>
            <input id="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="to">Hasta</label>
            <input id="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          {currencies.length > 1 && (
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="cur">Moneda gráficos</label>
              <select id="cur" value={currency} onChange={(e) => setChosen(e.target.value as Currency)}>
                {currencies.map((c) => <option key={c}>{c}</option>)}
              </select>
            </div>
          )}
          <button onClick={() => void reload()} disabled={loading} style={{ alignSelf: 'flex-end' }}>
            {loading ? 'Actualizando…' : 'Actualizar'}
          </button>
          <button
            style={{ alignSelf: 'flex-end' }}
            onClick={() => api.download(`/export.csv${qs({ from, to, companyId: companyId || undefined })}`, `rendiciones_${from || 'todo'}_${to || 'hoy'}.csv`).catch((e) => alert(e.message))}
          >
            Exportar CSV
          </button>
        </div>
      </div>

      {!data ? (
        <LogoLoader variant="admin" />
      ) : (
        <>
          <div className="grid grid-tiles">
            <Tile label="Gasto rendido en el período" value={formatTotals(data.total)} sub={`${data.itemCount} gastos (sin borradores ni rechazados)`} />
            <Tile label="En aprobación" value={String(s?.pending.count ?? 0)} sub={formatTotals(s?.pending.totals)} />
            <Tile label="Aprobado por pagar" value={formatTotals(s?.approved.totals)} sub={`${s?.approved.count ?? 0} rendiciones`} />
            <Tile label="Usuarios activos" value={`${data.usersCount.active}`} sub={`de ${data.usersCount.total} registrados`} />
          </div>

          {!currency ? (
            <div className="card muted">Aún no hay gastos rendidos en este período.</div>
          ) : (
            <div className="grid grid-2">
              {!companyId && <BreakdownCard title="Por empresa" rows={data.byCompany} names={data.names.companies} currency={currency} />}
              <BreakdownCard title="Por área" rows={data.byArea} names={data.names.areas} currency={currency} />
              <BreakdownCard title="Por mes" rows={data.byMonth} label={monthLabel} currency={currency} keepOrder />
              <BreakdownCard title="Por categoría" rows={data.byCategory} names={data.names.categories} currency={currency} />
              <BreakdownCard title="Por trabajador" rows={data.byUser} names={data.names.users} currency={currency} limit={15} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card tile">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

function BreakdownCard({
  title, rows, names, label, currency, keepOrder, limit,
}: {
  title: string;
  rows: Row[];
  names?: Record<string, string>;
  label?: (k: string) => string;
  currency: Currency;
  keepOrder?: boolean;
  limit?: number;
}) {
  const sorted = keepOrder ? rows : [...rows].sort((a, b) => (b.totals[currency] ?? 0) - (a.totals[currency] ?? 0));
  const shown = limit ? sorted.slice(0, limit) : sorted;
  const max = Math.max(1, ...shown.map((r) => r.totals[currency] ?? 0));
  const others = (t: Totals) => formatTotals(Object.fromEntries(Object.entries(t).filter(([c]) => c !== currency)));
  return (
    <div className="card">
      <h3>{title} <span className="muted small">({currency})</span></h3>
      <div className="table-wrap">
        <table>
          <tbody>
            {shown.map((r) => {
              const v = r.totals[currency] ?? 0;
              const name = label ? label(r.key) : names?.[r.key] ?? r.key;
              const rest = others(r.totals);
              return (
                <tr key={r.key} title={`${name}: ${formatTotals(r.totals)}`}>
                  <td style={{ width: '35%' }}>{name}</td>
                  <td style={{ width: '35%' }}>
                    <div className="bar-track"><div className="bar-fill" style={{ width: `${(v / max) * 100}%` }} /></div>
                  </td>
                  <td className="num">
                    {formatMoney(v, currency)}
                    {rest !== '—' && <div className="muted small">+ {rest}</div>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

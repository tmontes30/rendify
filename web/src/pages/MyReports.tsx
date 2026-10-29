import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { LIMITS, STATUSES, STATUS_LABELS, formatTotals, type Report, type Status } from '@rendiciones/shared';
import { useProfile } from '../auth';
import { createReport, fmtDate, friendlyError, listMyReports } from '../data';
import { StatusBadge } from '../components/StatusBadge';

function monthRange() {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const last = new Date(y, m, 0).getDate();
  return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(last)}` };
}

export function MyReports() {
  const { profile } = useProfile();
  const navigate = useNavigate();
  const [reports, setReports] = useState<Report[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Status | ''>('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    listMyReports(profile.uid).then(setReports, (e) => setError(friendlyError(e)));
  }, [profile.uid]);

  const shown = (reports ?? []).filter((r) => !filter || r.status === filter);

  return (
    <div className="stack">
      <div className="row spread">
        <h1>Mis rendiciones</h1>
        <div className="row">
          <select value={filter} onChange={(e) => setFilter(e.target.value as Status | '')} aria-label="Filtrar por estado" style={{ width: 'auto' }}>
            <option value="">Todos los estados</option>
            {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
          </select>
          <button className="primary" onClick={() => setCreating(true)}>+ Nueva rendición</button>
        </div>
      </div>

      {error && <div className="alert error">{error}</div>}
      {creating && <NewReportForm onCancel={() => setCreating(false)} onCreated={(id) => navigate(`/r/${id}`)} />}

      <div className="card table-wrap">
        {!reports ? (
          <p className="muted">Cargando…</p>
        ) : shown.length === 0 ? (
          <p className="muted">{reports.length ? 'No hay rendiciones con ese estado.' : 'Aún no tienes rendiciones. Crea la primera con “Nueva rendición”.'}</p>
        ) : (
          <table>
            <thead>
              <tr><th>Título</th><th className="hide-sm">Período</th><th>Estado</th><th className="num">Total</th><th className="hide-sm">Actualizada</th></tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => navigate(`/r/${r.id}`)}>
                  <td>{r.title}<div className="muted small">{r.itemCount} gasto(s)</div></td>
                  <td className="hide-sm small">{r.periodFrom} → {r.periodTo}</td>
                  <td><StatusBadge status={r.status} /></td>
                  <td className="num">{formatTotals(r.totals)}</td>
                  <td className="hide-sm small muted">{fmtDate(r.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );

}

function NewReportForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: (id: string) => void }) {
  const { profile } = useProfile();
  const def = monthRange();
  const [title, setTitle] = useState('');
  const [from, setFrom] = useState(def.from);
  const [to, setTo] = useState(def.to);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (from > to) return setErr('La fecha de inicio debe ser anterior a la de término.');
    setBusy(true);
    setErr(null);
    try {
      onCreated(await createReport(profile, { title, periodFrom: from, periodTo: to }));
    } catch (e2) {
      setErr(friendlyError(e2));
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>Nueva rendición</h2>
      <div className="form-grid">
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label htmlFor="title">Título</label>
          <input id="title" required maxLength={LIMITS.title} placeholder="Ej: Gastos octubre / Viaje a Concepción" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="from">Desde</label>
          <input id="from" type="date" required value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="to">Hasta</label>
          <input id="to" type="date" required value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>
      {err && <div className="alert error">{err}</div>}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="primary" type="submit" disabled={busy}>{busy ? 'Creando…' : 'Crear y agregar gastos'}</button>
        <button type="button" onClick={onCancel}>Cancelar</button>
      </div>
    </form>
  );
}

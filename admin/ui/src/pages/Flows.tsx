import { useState, type FormEvent } from 'react';
import { LIMITS, formatMoney, fromMinor, toMinor, type Currency, type Flow } from '@rendiciones/shared';
import { api } from '../api';
import { Modal, NeedsCompany, PageHeader } from '../components';
import { useCatalog, useCompany, useLoad } from '../hooks';

interface UserLite {
  uid: string;
  displayName: string;
  email: string;
  active: boolean;
  areaId: string;
  flowId: string | null;
}

export function Flows() {
  const { companyName, companyId } = useCompany();
  if (!companyId) {
    return (
      <div className="stack">
        <PageHeader title="Flujos de aprobación" />
        <NeedsCompany>{() => null}</NeedsCompany>
      </div>
    );
  }
  return (
    <div className="stack">
      <FlowsFor key={companyId} cid={companyId} title={companyName(companyId)} />
    </div>
  );
}

function FlowsFor({ cid, title }: { cid: string; title: string }) {
  const { companies } = useCompany();
  const base = (companies.find((c) => c.id === cid)?.baseCurrency ?? 'CLP') as Currency;
  const { flows, areaName } = useCatalog(cid);
  const users = useLoad<UserLite[]>(`/users?companyId=${cid}`);
  const [editing, setEditing] = useState<Flow | 'new' | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const nameOf = (f: Flow, uid: string) => f.approverNames?.[uid] ?? users.data?.find((u) => u.uid === uid)?.displayName ?? uid;
  const usersIn = (fid: string) => users.data?.filter((u) => u.flowId === fid).length ?? 0;

  async function remove(f: Flow) {
    if (!confirm(`¿Eliminar el flujo "${f.name}"?`)) return;
    await api.del(`/companies/${cid}/flows/${f.id}`).catch((e) => alert(e.message));
    await flows.reload();
  }

  return (
    <>
      <PageHeader
        title="Flujos de aprobación"
        subtitle={`${title} · Define quién aprueba y en qué orden. Luego asigna el flujo a cada usuario.`}
        actions={
          <button className="primary" onClick={() => setEditing('new')} disabled={!users.data?.length}>
            + Nuevo flujo
          </button>
        }
      />
      {users.data && users.data.length === 0 && (
        <div className="alert warn">Primero crea los usuarios de la empresa (los aprobadores también son usuarios).</div>
      )}
      {flows.error && <div className="alert error">{flows.error}</div>}
      {flash && <div className="alert ok">{flash}</div>}

      <div className="stack">
        {flows.data?.map((f) => (
          <div key={f.id} className="card">
            <div className="row spread">
              <div>
                <h3 style={{ margin: 0 }}>{f.name}</h3>
                <div className="muted small">{usersIn(f.id)} usuario(s) usan este flujo</div>
              </div>
              <div className="row">
                <button onClick={() => setEditing(f)}>Editar</button>
                <button className="link danger-link" onClick={() => remove(f)}>Eliminar</button>
              </div>
            </div>
            <div className="flow-chain">
              <div className="flow-node start">
                <div className="flow-node-title">Trabajador</div>
                <div className="small muted">Envía la rendición</div>
              </div>
              {f.levels.map((l, i) => (
                <div key={i} className="flow-step">
                  <div className="flow-arrow" aria-hidden="true">→</div>
                  <div className="flow-node">
                    <div className="flow-level">Nivel {i + 1}</div>
                    <div className="flow-node-title">{l.name}</div>
                    <div className="small">
                      {l.approvers.map((u) => (
                        <div key={u}>👤 {nameOf(f, u)}</div>
                      ))}
                    </div>
                    <div className="flow-cond">{i === 0 || l.minAmount <= 0 ? 'Siempre' : `Si el total ≥ ${formatMoney(l.minAmount, base)}`}</div>
                  </div>
                </div>
              ))}
              <div className="flow-step">
                <div className="flow-arrow" aria-hidden="true">→</div>
                <div className="flow-node end">
                  <div className="flow-node-title">Aprobada</div>
                  <div className="small muted">Pasa a pago</div>
                </div>
              </div>
            </div>
          </div>
        ))}
        {flows.data?.length === 0 && <div className="card empty muted">Esta empresa aún no tiene flujos de aprobación.</div>}
      </div>

      {editing && users.data && (
        <FlowModal
          cid={cid}
          base={base}
          flow={editing === 'new' ? null : editing}
          users={users.data.filter((u) => u.active)}
          areaName={areaName}
          onClose={() => setEditing(null)}
          onSaved={(assigned) => {
            setEditing(null);
            setFlash(
              assigned
                ? `Flujo guardado. Se asignó a ${assigned} aprobador(es) que no tenían flujo; sus rendiciones partirán en el nivel siguiente al suyo.`
                : 'Flujo guardado.',
            );
            void flows.reload();
            void users.reload();
          }}
        />
      )}
    </>
  );
}

interface LevelDraft {
  name: string;
  minText: string;
  approvers: string[];
}

function FlowModal({
  cid, base, flow, users, areaName, onClose, onSaved,
}: {
  cid: string;
  base: Currency;
  flow: Flow | null;
  users: UserLite[];
  areaName: (id: string) => string;
  onClose: () => void;
  onSaved: (assigned: number) => void;
}) {
  const [name, setName] = useState(flow?.name ?? '');
  const [levels, setLevels] = useState<LevelDraft[]>(
    flow?.levels.map((l) => ({ name: l.name, minText: l.minAmount ? fromMinor(l.minAmount, base) : '', approvers: l.approvers })) ?? [
      { name: 'Jefe directo', minText: '', approvers: [] },
    ],
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const update = (i: number, patch: Partial<LevelDraft>) => setLevels((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const move = (i: number, d: -1 | 1) =>
    setLevels((ls) => {
      const n = [...ls];
      [n[i], n[i + d]] = [n[i + d], n[i]];
      return n;
    });

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const out = [];
    for (const [i, l] of levels.entries()) {
      if (!l.approvers.length) return setError(`El nivel ${i + 1} no tiene aprobadores.`);
      let minAmount = 0;
      if (i > 0 && l.minText.trim()) {
        const v = toMinor(l.minText, base);
        if (v == null) return setError(`Monto mínimo inválido en el nivel ${i + 1}.`);
        minAmount = v;
      }
      out.push({ name: l.name, minAmount, approvers: l.approvers });
    }
    setBusy(true);
    try {
      const r = flow
        ? await api.put<{ assigned: number }>(`/companies/${cid}/flows/${flow.id}`, { name, levels: out })
        : await api.post<{ assigned: number }>(`/companies/${cid}/flows`, { name, levels: out });
      onSaved(r.assigned ?? 0);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={flow ? 'Editar flujo' : 'Nuevo flujo de aprobación'} onClose={onClose} wide>
      <form onSubmit={save}>
        <div className="field">
          <label htmlFor="fn">Nombre del flujo</label>
          <input id="fn" required maxLength={100} placeholder="Ej: Ventas estándar" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <p className="hint">
          Las personas que agregues como aprobadores y no tengan flujo quedan asignadas a este; sus propias rendiciones parten en el nivel
          siguiente al suyo (las del último nivel las apruebas tú). La rendición pasa por los niveles en orden. En cada nivel basta con que <b>uno</b> de los aprobadores apruebe. Los niveles con
          monto mínimo solo se activan si el total de la rendición lo alcanza (en {base}); si tiene gastos en otras monedas, se activan
          siempre.
        </p>
        <div className="stack">
          {levels.map((l, i) => (
            <div key={i} className="card level-card">
              <div className="row spread">
                <strong>Nivel {i + 1}</strong>
                <div className="row">
                  <button type="button" className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Subir">↑</button>
                  <button type="button" className="icon-btn" disabled={i === levels.length - 1} onClick={() => move(i, 1)} aria-label="Bajar">↓</button>
                  <button type="button" className="icon-btn" disabled={levels.length === 1} onClick={() => setLevels((ls) => ls.filter((_, j) => j !== i))} aria-label="Quitar nivel">✕</button>
                </div>
              </div>
              <div className="form-grid">
                <div className="field">
                  <label>Nombre del nivel</label>
                  <input required maxLength={100} value={l.name} onChange={(e) => update(i, { name: e.target.value })} placeholder="Ej: Gerente de área" />
                </div>
                <div className="field">
                  <label>Activar si el total es ≥ ({base})</label>
                  <input
                    disabled={i === 0}
                    inputMode="decimal"
                    placeholder={i === 0 ? 'Siempre (primer nivel)' : 'Vacío = siempre'}
                    value={i === 0 ? '' : l.minText}
                    onChange={(e) => update(i, { minText: e.target.value })}
                  />
                </div>
              </div>
              <ApproverPicker users={users} areaName={areaName} selected={l.approvers} onChange={(approvers) => update(i, { approvers })} />
            </div>
          ))}
        </div>
        {levels.length < LIMITS.maxLevels && (
          <button type="button" style={{ marginTop: 12 }} onClick={() => setLevels((ls) => [...ls, { name: '', minText: '', approvers: [] }])}>
            + Agregar nivel
          </button>
        )}
        {error && <div className="alert error" style={{ marginTop: 12 }}>{error}</div>}
        <div className="row modal-actions">
          <button type="submit" className="primary" disabled={busy}>{busy ? 'Guardando…' : 'Guardar flujo'}</button>
          <button type="button" onClick={onClose}>Cancelar</button>
        </div>
      </form>
    </Modal>
  );
}

function ApproverPicker({
  users, areaName, selected, onChange,
}: {
  users: UserLite[];
  areaName: (id: string) => string;
  selected: string[];
  onChange: (uids: string[]) => void;
}) {
  const [q, setQ] = useState('');
  const shown = users.filter((u) => `${u.displayName} ${u.email} ${areaName(u.areaId)}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="field">
      <label>Aprobadores ({selected.length})</label>
      <input placeholder="Buscar persona…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="picker">
        {shown.map((u) => (
          <label key={u.uid} className="check">
            <input
              type="checkbox"
              checked={selected.includes(u.uid)}
              onChange={(e) => onChange(e.target.checked ? [...selected, u.uid] : selected.filter((x) => x !== u.uid))}
            />
            <span>
              {u.displayName} <span className="muted small">· {areaName(u.areaId)} · {u.email}</span>
            </span>
          </label>
        ))}
        {shown.length === 0 && <div className="muted small">Sin resultados.</div>}
      </div>
    </div>
  );
}

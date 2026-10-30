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
  paymentsUser?: boolean;
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
                <div className="flow-node-title">Trabajadores ({usersIn(f.id)})</div>
                <WorkerNames names={(users.data ?? []).filter((u) => u.flowId === f.id).map((u) => u.displayName)} />
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
                  <div className="small">
                    {f.payerUid ? <>💳 Paga: {nameOf(f, f.payerUid)}</> : <span className="text-bad">Sin “quién paga”</span>}
                  </div>
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
          flowName={(id) => flows.data?.find((x) => x.id === id)?.name ?? ''}
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

let keySeq = 0;
const newKey = () => `lvl${++keySeq}`;

interface LevelDraft {
  key: string;
  name: string;
  minText: string;
  approvers: string[];
}

function FlowModal({
  cid, base, flow, users, flowName, areaName, onClose, onSaved,
}: {
  cid: string;
  base: Currency;
  flow: Flow | null;
  users: UserLite[];
  flowName: (id: string) => string;
  areaName: (id: string) => string;
  onClose: () => void;
  onSaved: (assigned: number) => void;
}) {
  const [name, setName] = useState(flow?.name ?? '');
  // Se guardan en orden de la cadena (índice 0 = primero en revisar), pero se
  // muestran al revés: arriba el más importante (aprobación final).
  const [levels, setLevels] = useState<LevelDraft[]>(
    flow?.levels.map((l) => ({ key: newKey(), name: l.name, minText: l.minAmount ? fromMinor(l.minAmount, base) : '', approvers: l.approvers })) ?? [
      { key: newKey(), name: '', minText: '', approvers: [] },
    ],
  );
  const [payerUid, setPayerUid] = useState<string>(flow?.payerUid ?? '');
  const [members, setMembers] = useState<string[]>(flow ? users.filter((u) => u.flowId === flow.id).map((u) => u.uid) : []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const update = (i: number, patch: Partial<LevelDraft>) => setLevels((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  /** d = +1 sube en pantalla (más importante, más tarde en la cadena). */
  const move = (i: number, d: -1 | 1) =>
    setLevels((ls) => {
      const n = [...ls];
      [n[i], n[i + d]] = [n[i + d], n[i]];
      return n;
    });
  // Agregar nivel = uno menos importante, que revisa antes (va al inicio de la cadena).
  const addLower = () => setLevels((ls) => [{ key: newKey(), name: '', minText: '', approvers: [] }, ...ls]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const out = [];
    for (const [i, l] of levels.entries()) {
      const label = l.name || `Nivel ${i + 1}`;
      if (!l.approvers.length) return setError(`"${label}" no tiene aprobadores.`);
      let minAmount = 0;
      if (i > 0 && l.minText.trim()) {
        const v = toMinor(l.minText, base);
        if (v == null) return setError(`Monto mínimo inválido en "${label}".`);
        minAmount = v;
      }
      out.push({ name: l.name, minAmount, approvers: l.approvers });
    }
    if (!payerUid && !confirm('No elegiste quién paga. No podrás avisarle cuando una rendición quede aprobada. ¿Guardar igual?')) return;
    setBusy(true);
    try {
      const body = { name, levels: out, payerUid: payerUid || null, members };
      const r = flow
        ? await api.put<{ assigned: number }>(`/companies/${cid}/flows/${flow.id}`, body)
        : await api.post<{ assigned: number }>(`/companies/${cid}/flows`, body);
      onSaved(r.assigned ?? 0);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const display = levels.map((l, i) => ({ l, i })).reverse();
  const last = levels.length - 1;

  return (
    <Modal title={flow ? 'Editar flujo' : 'Nuevo flujo de aprobación'} onClose={onClose} wide>
      <form onSubmit={save}>
        <div className="field">
          <label htmlFor="fn">Nombre del flujo</label>
          <input id="fn" required maxLength={100} placeholder="Ej: Ventas estándar" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <p className="hint">
          Arma el flujo <b>de arriba hacia abajo, del más importante al menos importante</b>: el de arriba da la aprobación final y cada
          “Agregar nivel” suma uno debajo que revisa antes. En cada nivel basta con que <b>uno</b> de los aprobadores apruebe. Los niveles con
          monto mínimo solo se activan si el total alcanza ese monto (en {base}); con gastos en otras monedas se activan siempre. Los
          aprobadores sin flujo quedan asignados a este, y sus propias rendiciones parten en el nivel de arriba del suyo (las del nivel
          final las apruebas tú).
        </p>
        <div className="card level-card payer-card">
          <div className="row tight">
            <strong>💳 Quién paga</strong>
            <span className="muted small">Recibe el aviso cuando la rendición queda aprobada por completo.</span>
          </div>
          <div className="field" style={{ marginTop: 10, marginBottom: 0 }}>
            <select value={payerUid} onChange={(e) => setPayerUid(e.target.value)} aria-label="Quién paga">
              <option value="">— Elegir persona —</option>
              {users.filter((u) => u.paymentsUser || u.uid === payerUid).map((u) => (
                <option key={u.uid} value={u.uid}>
                  {u.displayName} · {areaName(u.areaId)} · {u.email}
                </option>
              ))}
            </select>
            {!users.some((u) => u.paymentsUser) && (
              <div className="hint">Nadie tiene marcada la casilla “Usuario de pagos”. Márcala en Usuarios → Editar.</div>
            )}
          </div>
        </div>
        <div className="level-link" aria-hidden="true">↑ cuando todos aprueban, pasa a pago</div>
        <div className="stack">
          {display.map(({ l, i }, pos) => (
            <div key={l.key}>
              {pos > 0 && <div className="level-link" aria-hidden="true">↑ luego pasa a</div>}
              <div className="card level-card">
                <div className="row spread">
                  <div className="row tight">
                    <strong>Nivel {i + 1} de {levels.length}</strong>
                    {i === last && <span className="badge approved">Aprobación final</span>}
                    {i === 0 && levels.length > 1 && <span className="badge info">Primero en revisar</span>}
                  </div>
                  <div className="row">
                    <button type="button" className="icon-btn" disabled={i === last} onClick={() => move(i, 1)} aria-label="Subir (más importante)" title="Más importante">↑</button>
                    <button type="button" className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Bajar (menos importante)" title="Menos importante">↓</button>
                    <button type="button" className="icon-btn" disabled={levels.length === 1} onClick={() => setLevels((ls) => ls.filter((_, j) => j !== i))} aria-label="Quitar nivel">✕</button>
                  </div>
                </div>
                <div className="form-grid">
                  <div className="field">
                    <label>Nombre del nivel</label>
                    <input required maxLength={100} value={l.name} onChange={(e) => update(i, { name: e.target.value })} placeholder={i === last ? 'Ej: Gerente general' : 'Ej: Jefe de área'} />
                  </div>
                  <div className="field">
                    <label>Activar si el total es ≥ ({base})</label>
                    <input
                      disabled={i === 0}
                      inputMode="decimal"
                      placeholder={i === 0 ? 'Siempre (es el primero en revisar)' : 'Vacío = siempre'}
                      value={i === 0 ? '' : l.minText}
                      onChange={(e) => update(i, { minText: e.target.value })}
                    />
                  </div>
                </div>
                <ApproverPicker users={users} areaName={areaName} selected={l.approvers} onChange={(approvers) => update(i, { approvers })} />
              </div>
            </div>
          ))}
        </div>
        {levels.length < LIMITS.maxLevels && (
          <button type="button" style={{ marginTop: 12 }} onClick={addLower}>
            + Agregar nivel debajo (revisa antes)
          </button>
        )}
        <div className="level-link" aria-hidden="true">↑ envían su rendición a este flujo</div>
        <div className="card level-card workers-card">
          <div className="row tight">
            <strong>👥 Trabajadores de este flujo</strong>
            <span className="muted small">Quienes rinden gastos por este flujo. Cada persona usa un solo flujo.</span>
          </div>
          <MemberPicker
            users={users.filter((u) => !u.paymentsUser)}
            currentFlowId={flow?.id ?? null}
            flowName={flowName}
            areaName={areaName}
            selected={members}
            onChange={setMembers}
          />
        </div>
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

function WorkerNames({ names }: { names: string[] }) {
  if (!names.length) return <div className="small text-bad">Nadie asignado</div>;
  return (
    <div className="small">
      {names.slice(0, 4).map((n) => (
        <div key={n}>👤 {n}</div>
      ))}
      {names.length > 4 && <div className="muted">+ {names.length - 4} más</div>}
    </div>
  );
}

function MemberPicker({
  users, currentFlowId, flowName, areaName, selected, onChange,
}: {
  users: UserLite[];
  currentFlowId: string | null;
  flowName: (id: string) => string;
  areaName: (id: string) => string;
  selected: string[];
  onChange: (uids: string[]) => void;
}) {
  const [q, setQ] = useState('');
  const shown = users.filter((u) => `${u.displayName} ${u.email} ${areaName(u.areaId)}`.toLowerCase().includes(q.toLowerCase()));
  const allShown = shown.length > 0 && shown.every((u) => selected.includes(u.uid));
  return (
    <div className="field" style={{ marginTop: 10, marginBottom: 0 }}>
      <div className="row spread">
        <label>Seleccionados ({selected.length})</label>
        <button
          type="button"
          className="link"
          onClick={() => onChange(allShown ? selected.filter((x) => !shown.some((u) => u.uid === x)) : [...new Set([...selected, ...shown.map((u) => u.uid)])])}
        >
          {allShown ? 'Quitar los mostrados' : 'Seleccionar los mostrados'}
        </button>
      </div>
      <input placeholder="Buscar persona o área…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="picker">
        {shown.map((u) => {
          const other = u.flowId && u.flowId !== currentFlowId ? flowName(u.flowId) : '';
          return (
            <label key={u.uid} className="check">
              <input
                type="checkbox"
                checked={selected.includes(u.uid)}
                onChange={(e) => onChange(e.target.checked ? [...selected, u.uid] : selected.filter((x) => x !== u.uid))}
              />
              <span>
                {u.displayName} <span className="muted small">· {areaName(u.areaId)}</span>
                {other && <span className="badge pending" style={{ marginLeft: 6 }}>hoy en: {other}</span>}
              </span>
            </label>
          );
        })}
        {shown.length === 0 && <div className="muted small">Sin resultados.</div>}
      </div>
    </div>
  );
}

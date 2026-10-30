import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { LIMITS, formatMoney, fromMinor, isSpecialProfile, toMinor, type Area, type Flow } from '@rendiciones/shared';
import { useSession } from '../auth';
import { adminError, deleteFlow, listAreas, listFlows, listPeople, saveFlow, type Person } from '../adminData';
import { LogoLoader, useGlobalBusy } from '@rendiciones/shared/Busy';

export function AdminFlows() {
  const session = useSession();
  const { company } = session;
  const [flows, setFlows] = useState<Flow[] | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [areas, setAreas] = useState<Area[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [editing, setEditing] = useState<Flow | 'new' | null>(null);

  const load = useCallback(async () => {
    try {
      const [f, p, a] = await Promise.all([listFlows(company.id), listPeople(company.id), listAreas(company.id)]);
      setFlows(f);
      setPeople(p);
      setAreas(a);
    } catch (e) {
      setError(adminError(e));
    }
  }, [company.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const nameOf = (f: Flow, uid: string) => f.approverNames?.[uid] || people.find((p) => p.uid === uid)?.displayName || 'Persona';
  // Usuarios de pagos y administradores de personal no rinden ni aprueban.
  const workersOf = (fid: string) => people.filter((p) => p.flowId === fid && !isSpecialProfile(p));
  const usersIn = (fid: string) => workersOf(fid).length;

  async function remove(f: Flow) {
    if (!confirm(`¿Eliminar el flujo "${f.name}"?`)) return;
    try {
      await deleteFlow(session, f, people, flows ?? []);
      await load();
    } catch (e) {
      alert(adminError(e));
    }
  }

  return (
    <div className="stack">
      <div className="page-header">
        <div>
          <h1>Flujos de aprobación</h1>
          <p className="muted page-sub">Define quién aprueba y en qué orden en {company.name}. Luego asigna el flujo a cada persona.</p>
        </div>
        <button className="primary" onClick={() => setEditing('new')} disabled={!people.length}>+ Nuevo flujo</button>
      </div>
      {error && <div className="alert error">{error}</div>}
      {flash && <div className="alert ok">{flash}</div>}

      {!flows ? (
        <LogoLoader />
      ) : flows.length === 0 ? (
        <div className="card empty muted">Aún no hay flujos. Crea el primero: arriba el más importante.</div>
      ) : (
        flows.map((f) => (
          <div key={f.id} className="card">
            <div className="row spread">
              <div>
                <h3 style={{ margin: 0 }}>{f.name}</h3>
                <div className="muted small">{usersIn(f.id)} persona(s) usan este flujo</div>
              </div>
              <div className="row">
                <button onClick={() => setEditing(f)}>Editar</button>
                <button className="link danger-link" onClick={() => remove(f)}>Eliminar</button>
              </div>
            </div>
            <div className="flow-chain">
              <div className="flow-node start">
                <div className="flow-node-title">Trabajadores ({usersIn(f.id)})</div>
                <WorkerNames names={workersOf(f.id).map((p) => p.displayName)} />
              </div>
              {f.levels.map((l, i) => (
                <div key={i} className="flow-step">
                  <div className="flow-arrow" aria-hidden="true">→</div>
                  <div className="flow-node">
                    <div className="flow-level">Nivel {i + 1}</div>
                    <div className="flow-node-title">{l.name}</div>
                    <div className="small">{l.approvers.map((u) => <div key={u}>👤 {nameOf(f, u)}</div>)}</div>
                    <div className="flow-cond">{i === 0 || l.minAmount <= 0 ? 'Siempre' : `Si el total ≥ ${formatMoney(l.minAmount, company.baseCurrency)}`}</div>
                  </div>
                </div>
              ))}
              <div className="flow-step">
                <div className="flow-arrow" aria-hidden="true">→</div>
                <div className="flow-node end">
                  <div className="flow-node-title">Aprobada</div>
                  <div className="small">{f.payerUid ? <>💳 Paga: {nameOf(f, f.payerUid)}</> : <span className="text-bad">Sin “quién paga”</span>}</div>
                </div>
              </div>
            </div>
          </div>
        ))
      )}

      {editing && (
        <FlowEditor
          flow={editing === 'new' ? null : editing}
          people={people.filter((p) => p.active)}
          flowName={(id) => flows?.find((x) => x.id === id)?.name ?? ''}
          areaName={(id) => (id ? areas.find((a) => a.id === id)?.name ?? id : 'Sin área')}
          onClose={() => setEditing(null)}
          onSave={async (name, levels, payerUid, members) => {
            const r = await saveFlow(session, editing === 'new' ? null : editing.id, name, levels, payerUid, people, flows ?? [], members);
            setEditing(null);
            setFlash(r.assigned ? `Flujo guardado. Se asignó a ${r.assigned} aprobador(es) que no tenían flujo.` : 'Flujo guardado.');
            await load();
          }}
        />
      )}
    </div>
  );
}

interface LevelDraft {
  key: string;
  name: string;
  minText: string;
  approvers: string[];
}
let seq = 0;
const newKey = () => `l${++seq}`;

function FlowEditor({
  flow, people, flowName, areaName, onClose, onSave,
}: {
  flow: Flow | null;
  people: Person[];
  flowName: (id: string) => string;
  areaName: (id: string | null) => string;
  onClose: () => void;
  onSave: (name: string, levels: { name: string; minAmount: number; approvers: string[] }[], payerUid: string | null, members: string[]) => Promise<void>;
}) {
  const { company } = useSession();
  const base = company.baseCurrency;
  const [name, setName] = useState(flow?.name ?? '');
  const [payerUid, setPayerUid] = useState(flow?.payerUid ?? '');
  const [members, setMembers] = useState<string[]>(flow ? people.filter((p) => p.flowId === flow.id && !isSpecialProfile(p)).map((p) => p.uid) : []);
  // Orden de la cadena (0 = primero en revisar); se muestra al revés (arriba el más importante).
  const [levels, setLevels] = useState<LevelDraft[]>(
    flow?.levels.map((l) => ({ key: newKey(), name: l.name, minText: l.minAmount ? fromMinor(l.minAmount, base) : '', approvers: l.approvers })) ?? [
      { key: newKey(), name: '', minText: '', approvers: [] },
    ],
  );
  const [busy, setBusy] = useGlobalBusy('Guardando…');
  const [error, setError] = useState<string | null>(null);
  const last = levels.length - 1;
  const approverPool = people.filter((p) => !isSpecialProfile(p));
  const payers = people.filter((p) => p.paymentsUser || p.uid === payerUid);

  const update = (i: number, patch: Partial<LevelDraft>) => setLevels((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const move = (i: number, d: -1 | 1) =>
    setLevels((ls) => {
      const n = [...ls];
      [n[i], n[i + d]] = [n[i + d], n[i]];
      return n;
    });

  async function submit(e: FormEvent) {
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
      out.push({ name: l.name.trim(), minAmount, approvers: l.approvers });
    }
    if (!payerUid && !confirm('No elegiste quién paga. ¿Guardar igual?')) return;
    setBusy(true);
    try {
      await onSave(name, out, payerUid || null, members);
    } catch (err) {
      setError(adminError(err));
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="card modal modal-wide" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>{flow ? 'Editar flujo' : 'Nuevo flujo de aprobación'}</h2>
        <div className="field">
          <label htmlFor="fn">Nombre del flujo</label>
          <input id="fn" required maxLength={100} placeholder="Ej: Ventas estándar" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <p className="hint">
          Arma el flujo <b>de arriba hacia abajo, del más importante al menos importante</b>. En cada nivel basta con que <b>uno</b> apruebe.
          Los niveles con monto mínimo solo se activan si el total lo alcanza (en {base}).
        </p>

        <div className="card level-card payer-card">
          <div className="row tight">
            <strong>💳 Quién paga</strong>
            <span className="muted small">Recibe las rendiciones aprobadas por completo para pagarlas.</span>
          </div>
          <div className="field" style={{ marginTop: 10, marginBottom: 0 }}>
            <select value={payerUid} onChange={(e) => setPayerUid(e.target.value)} aria-label="Quién paga">
              <option value="">— Elegir persona —</option>
              {payers.map((p) => (
                <option key={p.uid} value={p.uid}>{p.displayName} · {areaName(p.areaId)}</option>
              ))}
            </select>
            {!payers.length && <div className="hint">Nadie es “usuario de pagos”. Márcalo en Personas → Editar.</div>}
          </div>
        </div>
        <div className="level-link" aria-hidden="true">↑ cuando todos aprueban, pasa a pago</div>

        <div className="stack">
          {levels
            .map((l, i) => ({ l, i }))
            .reverse()
            .map(({ l, i }, pos) => (
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
                      <button type="button" className="icon-btn" disabled={i === last} onClick={() => move(i, 1)} title="Más importante">↑</button>
                      <button type="button" className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} title="Menos importante">↓</button>
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
                  <Picker people={people} areaName={areaName} selected={l.approvers} onChange={(approvers) => update(i, { approvers })} />
                </div>
              </div>
            ))}
        </div>
        {levels.length < LIMITS.maxLevels && (
          <button type="button" style={{ marginTop: 12 }} onClick={() => setLevels((ls) => [{ key: newKey(), name: '', minText: '', approvers: [] }, ...ls])}>
            + Agregar nivel debajo (revisa antes)
          </button>
        )}
        <div className="level-link" aria-hidden="true">↑ envían su rendición a este flujo</div>
        <div className="card level-card workers-card">
          <div className="row tight">
            <strong>👥 Trabajadores de este flujo</strong>
            <span className="muted small">Quienes rinden gastos por este flujo. Cada persona usa un solo flujo.</span>
          </div>
          <MemberPicker people={approverPool} currentFlowId={flow?.id ?? null} flowName={flowName} areaName={areaName} selected={members} onChange={setMembers} />
        </div>
        {error && <div className="alert error" style={{ marginTop: 12 }}>{error}</div>}
        <div className="row modal-actions">
          <button type="submit" className="primary" disabled={busy}>{busy ? 'Guardando…' : 'Guardar flujo'}</button>
          <button type="button" onClick={onClose}>Cancelar</button>
        </div>
      </form>
    </div>
  );
}

function Picker({ people, areaName, selected, onChange }: { people: Person[]; areaName: (id: string | null) => string; selected: string[]; onChange: (u: string[]) => void }) {
  const [q, setQ] = useState('');
  // Perfiles especiales no pueden aprobar: solo se muestran si quedaron marcados, para poder quitarlos.
  const shown = people.filter(
    (p) => (!isSpecialProfile(p) || selected.includes(p.uid)) && `${p.displayName} ${p.email} ${areaName(p.areaId)}`.toLowerCase().includes(q.toLowerCase()),
  );
  return (
    <div className="field">
      <label>Aprobadores ({selected.length})</label>
      <input placeholder="Buscar persona…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="picker">
        {shown.map((p) => (
          <label key={p.uid} className="check">
            <input type="checkbox" checked={selected.includes(p.uid)} onChange={(e) => onChange(e.target.checked ? [...selected, p.uid] : selected.filter((x) => x !== p.uid))} />
            <span>
              {p.displayName} <span className="muted small">· {areaName(p.areaId)} · {p.email}</span>
              {isSpecialProfile(p) && (
                <span className="badge rejected" style={{ marginLeft: 6 }}>
                  {p.paymentsUser ? 'Usuario de pagos' : 'Admin. personal'}: no puede aprobar, desmárcalo
                </span>
              )}
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
  people, currentFlowId, flowName, areaName, selected, onChange,
}: {
  people: Person[];
  currentFlowId: string | null;
  flowName: (id: string) => string;
  areaName: (id: string | null) => string;
  selected: string[];
  onChange: (uids: string[]) => void;
}) {
  const [q, setQ] = useState('');
  const shown = people.filter((p) => `${p.displayName} ${p.email} ${areaName(p.areaId)}`.toLowerCase().includes(q.toLowerCase()));
  const allShown = shown.length > 0 && shown.every((p) => selected.includes(p.uid));
  return (
    <div className="field" style={{ marginTop: 10, marginBottom: 0 }}>
      <div className="row spread">
        <label>Seleccionados ({selected.length})</label>
        <button
          type="button"
          className="link"
          onClick={() => onChange(allShown ? selected.filter((x) => !shown.some((p) => p.uid === x)) : [...new Set([...selected, ...shown.map((p) => p.uid)])])}
        >
          {allShown ? 'Quitar los mostrados' : 'Seleccionar los mostrados'}
        </button>
      </div>
      <input placeholder="Buscar persona o área…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="picker">
        {shown.map((p) => {
          const other = p.flowId && p.flowId !== currentFlowId ? flowName(p.flowId) : '';
          return (
            <label key={p.uid} className="check">
              <input type="checkbox" checked={selected.includes(p.uid)} onChange={(e) => onChange(e.target.checked ? [...selected, p.uid] : selected.filter((x) => x !== p.uid))} />
              <span>
                {p.displayName} <span className="muted small">· {areaName(p.areaId)}</span>
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

import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { NeedsCompany, PageHeader } from '../components';
import { useCompany, useLoad } from '../hooks';

interface Entity {
  id: string;
  name: string;
  active: boolean;
}

export function Catalog() {
  const { companyName, companyId } = useCompany();
  return (
    <div className="stack">
      <PageHeader title="Áreas y categorías" subtitle={companyId ? companyName(companyId) : undefined} />
      <NeedsCompany>{(cid) => <CatalogFor key={cid} cid={cid} />}</NeedsCompany>
    </div>
  );
}

function CatalogFor({ cid }: { cid: string }) {
  const [version, setVersion] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);

  async function seed() {
    setMsg(null);
    try {
      const { added } = await api.post<{ added: number }>(`/companies/${cid}/seed-defaults`);
      setMsg(added ? `Se agregaron ${added} áreas/categorías base.` : 'Ya estaban todas las listas base.');
      setVersion((v) => v + 1);
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  return (
    <>
      <div className="row spread">
        <p className="muted small" style={{ margin: 0 }}>Las empresas nuevas parten con listas base. Puedes renombrar, desactivar o agregar las que quieras.</p>
        <button onClick={seed}>Cargar listas base</button>
      </div>
      {msg && <div className="alert ok">{msg}</div>}
      <div className="grid grid-2">
        <EntityList key={`a-${cid}-${version}`} path={`/companies/${cid}/areas`} title="Áreas" placeholder="Ej: Ventas" />
        <EntityList key={`c-${cid}-${version}`} path={`/companies/${cid}/categories`} title="Categorías de gasto" placeholder="Ej: Transporte" />
      </div>
    </>
  );
}

function EntityList({ path, title, placeholder }: { path: string; title: string; placeholder: string }) {
  const { data, error, reload } = useLoad<Entity[]>(path);
  const [name, setName] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  async function add(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      await api.post(path, { name });
      setName('');
      await reload();
    } catch (err) {
      setMsg((err as Error).message);
    }
  }

  async function rename(it: Entity) {
    const n = prompt('Nuevo nombre', it.name)?.trim();
    if (!n || n === it.name) return;
    await api.patch(`${path}/${it.id}`, { name: n }).catch((err) => setMsg(err.message));
    await reload();
  }

  async function toggle(it: Entity) {
    await api.patch(`${path}/${it.id}`, { active: !it.active }).catch((err) => setMsg(err.message));
    await reload();
  }

  return (
    <div className="card">
      <h2>{title}</h2>
      <form className="row nowrap" onSubmit={add} style={{ marginBottom: 12 }}>
        <input required maxLength={100} placeholder={placeholder} value={name} onChange={(e) => setName(e.target.value)} />
        <button className="primary" type="submit">Agregar</button>
      </form>
      {(error || msg) && <div className="alert error">{error || msg}</div>}
      <table>
        <tbody>
          {data?.map((it) => (
            <tr key={it.id}>
              <td>
                {it.name} {!it.active && <span className="badge rejected">Inactiva</span>}
              </td>
              <td className="num">
                <button className="link" onClick={() => rename(it)}>Renombrar</button>
                <button className="link" onClick={() => toggle(it)}>{it.active ? 'Desactivar' : 'Activar'}</button>
              </td>
            </tr>
          ))}
          {data?.length === 0 && (
            <tr>
              <td className="muted">Sin registros.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

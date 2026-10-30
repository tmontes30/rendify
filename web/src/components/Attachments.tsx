import { useEffect, useRef, useState } from 'react';
import { MAX_ATTACHMENTS, type Attachment } from '@rendiciones/shared';
import { compressImage, friendlyError, listAttachments, type NewAttachment } from '../data';

type Shown = { key: string; name: string; caption: string; dataUrl: string };

/** Ventana para ver una foto en grande, con anterior/siguiente y descarga. */
function Lightbox({ photos, index, onClose }: { photos: Shown[]; index: number; onClose: () => void }) {
  const [i, setI] = useState(index);
  const p = photos[i];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') setI((x) => Math.min(photos.length - 1, x + 1));
      if (e.key === 'ArrowLeft') setI((x) => Math.max(0, x - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [photos.length, onClose]);
  return (
    <div className="lightbox" onClick={onClose} role="dialog" aria-label="Foto de respaldo">
      <div className="lightbox-inner" onClick={(e) => e.stopPropagation()}>
        <img src={p.dataUrl} alt={p.caption || p.name} />
        <div className="row spread lightbox-bar">
          <span className="small">
            {p.caption || p.name} <span className="muted">· {i + 1} de {photos.length}</span>
          </span>
          <div className="row tight">
            <button disabled={i === 0} onClick={() => setI(i - 1)} aria-label="Anterior">‹</button>
            <button disabled={i === photos.length - 1} onClick={() => setI(i + 1)} aria-label="Siguiente">›</button>
            <a className="btn" href={p.dataUrl} download={p.name.replace(/\.[^.]+$/, '') + '.jpg'}>Descargar</a>
            <button onClick={onClose}>Cerrar ✕</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Grid({ photos, onRemove }: { photos: Shown[]; onRemove?: (key: string) => void }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <>
      <div className="thumb-grid">
        {photos.map((p, i) => (
          <figure key={p.key} className="thumb">
            <button type="button" className="thumb-img" onClick={() => setOpen(i)} title="Ver en grande">
              <img src={p.dataUrl} alt={p.caption || p.name} loading="lazy" />
            </button>
            <figcaption className="small">{p.caption || p.name}</figcaption>
            {onRemove && (
              <button type="button" className="thumb-remove" onClick={() => onRemove(p.key)} aria-label="Quitar foto" title="Quitar foto">
                ✕
              </button>
            )}
          </figure>
        ))}
      </div>
      {open != null && <Lightbox photos={photos} index={open} onClose={() => setOpen(null)} />}
    </>
  );
}

/** Fotos de una rendición (solo lectura): para aprobadores, pagos y el dueño. */
export function AttachmentsViewer({ cid, rid, compact }: { cid: string; rid: string; compact?: boolean }) {
  const [list, setList] = useState<Attachment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    listAttachments(cid, rid).then(setList, (e) => setError(friendlyError(e)));
  }, [cid, rid]);
  if (error) return <div className="alert error small">{error}</div>;
  if (!list) return <p className="muted small">Cargando fotos…</p>;
  if (!list.length) return compact ? null : <p className="muted small">Sin fotos de respaldo.</p>;
  return (
    <div>
      {compact && <div className="small strong" style={{ marginBottom: 6 }}>📎 Fotos de respaldo ({list.length})</div>}
      <Grid photos={list.map((a) => ({ key: a.id, name: a.name, caption: a.caption, dataUrl: a.dataUrl }))} />
    </div>
  );
}

/** Editor de fotos dentro de la rendición: agregar (cámara o archivos), nombrar y quitar. */
export function AttachmentsEditor({
  existing, pending, removed, onAdd, onRemovePending, onRemoveExisting, onCaption,
}: {
  existing: Attachment[];
  pending: (NewAttachment & { key: string })[];
  removed: string[];
  onAdd: (a: NewAttachment) => void;
  onRemovePending: (key: string) => void;
  onRemoveExisting: (id: string) => void;
  onCaption: (key: string, caption: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kept = existing.filter((a) => !removed.includes(a.id));
  const total = kept.length + pending.length;

  async function addFiles(files: FileList | null) {
    if (!files?.length) return;
    setError(null);
    setBusy(true);
    try {
      const room = MAX_ATTACHMENTS - total;
      const list = Array.from(files).slice(0, Math.max(0, room));
      if (files.length > room) setError(`Máximo ${MAX_ATTACHMENTS} fotos por rendición.`);
      for (const f of list) onAdd(await compressImage(f));
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
      if (camera.current) camera.current.value = '';
    }
  }

  return (
    <div className="card">
      <div className="row spread">
        <h2 style={{ margin: 0 }}>📎 Fotos de respaldo</h2>
        <span className="muted small">{total} de {MAX_ATTACHMENTS}</span>
      </div>
      <p className="muted small">Boletas, facturas o comprobantes. Los aprobadores y quien paga podrán verlas. Opcional.</p>
      {kept.length > 0 && <Grid photos={kept.map((a) => ({ key: a.id, name: a.name, caption: a.caption, dataUrl: a.dataUrl }))} onRemove={onRemoveExisting} />}
      {pending.length > 0 && (
        <div className="pending-photos">
          {pending.map((p) => (
            <div key={p.key} className="pending-photo">
              <img src={p.dataUrl} alt="" />
              <input
                placeholder="Descripción (ej: Boleta taxi)"
                maxLength={120}
                value={p.caption}
                onChange={(e) => onCaption(p.key, e.target.value)}
              />
              <button type="button" className="icon-btn" onClick={() => onRemovePending(p.key)} aria-label="Quitar foto">✕</button>
            </div>
          ))}
          <div className="hint">Las fotos nuevas se guardan al presionar “Guardar borrador” o “Enviar a aprobación”.</div>
        </div>
      )}
      {error && <div className="alert error small">{error}</div>}
      {total < MAX_ATTACHMENTS && (
        <div className="row" style={{ marginTop: 10 }}>
          <button type="button" onClick={() => camera.current?.click()} disabled={busy}>📷 Tomar foto</button>
          <button type="button" onClick={() => input.current?.click()} disabled={busy}>{busy ? 'Procesando…' : '⇪ Subir fotos'}</button>
        </div>
      )}
      <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={(e) => void addFiles(e.target.files)} />
      <input ref={input} type="file" accept="image/*" multiple hidden onChange={(e) => void addFiles(e.target.files)} />
    </div>
  );
}

import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
  Timestamp,
} from 'firebase/firestore';
import {
  nextRequiredLevel,
  startLevel,
  sumTotals,
  type Approval,
  type Attachment,
  type Category,
  type Flow,
  type Item,
  type PaymentMethod,
  type Report,
} from '@rendiciones/shared';
import { db } from './firebase';
import type { Session } from './auth';

export type ItemInput = Omit<Item, 'id'>;
export type ItemDraft = ItemInput & { id?: string };

const reportsCol = (cid: string) => collection(db, 'companies', cid, 'reports');
const itemsCol = (cid: string, rid: string) => collection(db, 'companies', cid, 'reports', rid, 'items');

export function toDate(v: unknown): Date | null {
  return v instanceof Timestamp ? v.toDate() : null;
}

export function fmtDate(v: unknown) {
  const d = toDate(v);
  return d ? d.toLocaleDateString('es-CL', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
}

export async function listCategories(cid: string): Promise<Category[]> {
  const snap = await getDocs(collection(db, 'companies', cid, 'categories'));
  return snap.docs
    .map((d) => ({ id: d.id, ...(d.data() as Omit<Category, 'id'>) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

export async function getFlow(cid: string, fid: string): Promise<Flow | null> {
  const s = await getDoc(doc(db, 'companies', cid, 'flows', fid));
  return s.exists() ? ({ id: s.id, ...s.data() } as Flow) : null;
}

const asReports = (docs: { id: string; data: () => unknown }[]) => docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Report, 'id'>) }));

export async function listMyReports(cid: string, uid: string): Promise<Report[]> {
  const snap = await getDocs(query(reportsCol(cid), where('ownerUid', '==', uid), orderBy('updatedAt', 'desc')));
  return asReports(snap.docs);
}

/** Rendiciones que esperan mi aprobación. */
export async function listPendingForMe(cid: string, uid: string): Promise<Report[]> {
  const snap = await getDocs(query(reportsCol(cid), where('currentApprovers', 'array-contains', uid)));
  return asReports(snap.docs).filter((r) => r.status === 'pending' && r.ownerUid !== uid);
}

/** Rendiciones de flujos donde soy aprobador (historial). */
export async function listApproverHistory(cid: string, uid: string): Promise<Report[]> {
  const snap = await getDocs(query(reportsCol(cid), where('approverUids', 'array-contains', uid)));
  return asReports(snap.docs).filter((r) => r.ownerUid !== uid && r.approvals.some((a) => a.uid === uid));
}

export async function getReport(cid: string, id: string): Promise<{ report: Report; items: Item[] } | null> {
  const snap = await getDoc(doc(db, 'companies', cid, 'reports', id));
  if (!snap.exists()) return null;
  const items = await getDocs(query(itemsCol(cid, id), orderBy('date')));
  return {
    report: { id: snap.id, ...(snap.data() as Omit<Report, 'id'>) },
    items: items.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Item, 'id'>) })),
  };
}

export interface ReportHeader {
  title: string;
  periodFrom: string;
  periodTo: string;
}

/**
 * Guarda una rendición completa (cabecera + gastos) en una sola operación,
 * y opcionalmente la envía a aprobación.
 */
export async function saveReport(
  s: Session,
  existing: { report: Report; items: Item[] } | null,
  header: ReportHeader,
  rows: ItemDraft[],
  submit: boolean,
  attachments: { add: NewAttachment[]; remove: string[] } = { add: [], remove: [] },
): Promise<string> {
  const cid = s.company.id;
  const batch = writeBatch(db);
  const ref = existing ? doc(db, 'companies', cid, 'reports', existing.report.id) : doc(reportsCol(cid));
  const clean = (r: ItemDraft): ItemInput => ({
    date: r.date,
    categoryId: r.categoryId,
    ...(r.categoryId === 'custom' && r.customCategory ? { customCategory: r.customCategory.trim().slice(0, 60) } : {}),
    description: r.description.trim(),
    vendor: r.vendor.trim(),
    docType: r.docType,
    docNumber: r.docNumber.trim(),
    amount: r.amount,
    currency: r.currency,
  });

  // Gastos: actualizar existentes, crear nuevos, borrar los quitados.
  const keep = new Set<string>();
  for (const r of rows) {
    const itemRef = r.id ? doc(itemsCol(cid, ref.id), r.id) : doc(itemsCol(cid, ref.id));
    keep.add(itemRef.id);
    batch.set(itemRef, clean(r));
  }
  for (const old of existing?.items ?? []) if (!keep.has(old.id)) batch.delete(doc(itemsCol(cid, ref.id), old.id));

  // Fotos de respaldo en el mismo lote (así también se pueden adjuntar al enviar).
  const attCol = collection(db, 'companies', cid, 'reports', ref.id, 'attachments');
  for (const a of attachments.add) {
    batch.set(doc(attCol), { name: a.name, caption: a.caption.trim().slice(0, 120), dataUrl: a.dataUrl, size: a.size, uploadedBy: s.profile.uid, createdAt: serverTimestamp() });
  }
  for (const id of attachments.remove) batch.delete(doc(attCol, id));

  const totals = sumTotals(rows);
  const base = { title: header.title.trim(), periodFrom: header.periodFrom, periodTo: header.periodTo, totals, itemCount: rows.length, updatedAt: serverTimestamp() };
  // Al enviar se lee el flujo vigente (el owner pudo haberlo cambiado).
  const flow = submit && s.profile.flowId ? await getFlow(cid, s.profile.flowId) : null;
  const start = flow ? startLevel(flow.levels, s.profile.uid) : 0;
  const flowFields =
    submit && flow
      ? {
          status: 'pending',
          flowId: flow.id,
          currentLevel: start,
          currentApprovers: flow.levels[start]?.approvers ?? [], // vacío = la aprueba el owner
          approverUids: flow.allApprovers,
          submittedAt: serverTimestamp(),
        }
      : null;
  if (submit && !flowFields) throw new Error('NO_FLOW');

  if (!existing) {
    batch.set(ref, {
      ownerUid: s.profile.uid,
      ownerName: s.profile.displayName,
      areaId: s.profile.areaId,
      flowId: s.profile.flowId ?? null,
      status: 'draft',
      currentLevel: 0,
      currentApprovers: [],
      approverUids: [],
      approvals: [],
      createdAt: serverTimestamp(),
      ...base,
      ...(flowFields ?? {}),
    });
  } else {
    batch.update(ref, { ...base, ...(flowFields ?? {}) });
  }
  await batch.commit();
  return ref.id;
}

export async function deleteDraft(cid: string, reportId: string, items: Item[]) {
  for (const it of items) await deleteDoc(doc(itemsCol(cid, reportId), it.id));
  await deleteDoc(doc(db, 'companies', cid, 'reports', reportId));
}

/** El aprobador del nivel actual aprueba (avanza al siguiente nivel requerido) o rechaza. */
export async function decide(s: Session, report: Report, items: Item[], decision: 'approved' | 'rejected', comment: string) {
  const cid = s.company.id;
  const flow = report.flowId ? await getFlow(cid, report.flowId) : null;
  if (!flow) throw new Error('NO_FLOW');
  const entry: Approval = {
    level: report.currentLevel,
    levelName: flow.levels[report.currentLevel]?.name ?? `Nivel ${report.currentLevel + 1}`,
    uid: s.profile.uid,
    name: s.profile.displayName,
    decision,
    comment: comment.trim(),
    atMs: Date.now(),
  };
  let next: Record<string, unknown>;
  if (decision === 'rejected') {
    next = { status: 'rejected', currentApprovers: [] };
  } else {
    // Los montos se calculan desde los gastos reales, no desde el total guardado.
    const lvl = nextRequiredLevel(flow.levels, report.currentLevel, sumTotals(items), s.company.baseCurrency);
    next = lvl == null ? { status: 'approved', currentApprovers: [] } : { status: 'pending', currentLevel: lvl, currentApprovers: flow.levels[lvl].approvers };
  }
  await updateDoc(doc(db, 'companies', cid, 'reports', report.id), {
    ...next,
    approvals: [...report.approvals, entry],
    updatedAt: serverTimestamp(),
    decidedAt: serverTimestamp(),
  });
}

export function friendlyError(e: unknown): string {
  const msg = (e as Error)?.message ?? '';
  if (msg === 'NOT_IMAGE') return 'Solo se pueden adjuntar fotos (JPG, PNG, HEIC…).';
  if (msg === 'BAD_IMAGE') return 'No se pudo leer la foto. Prueba con otra o sácale una captura.';
  if (msg === 'IMAGE_TOO_BIG') return 'La foto es demasiado grande para comprimirla. Prueba con otra.';
  if (msg === 'NO_FLOW') return 'No tienes un flujo de aprobación asignado. Pídele al administrador que te asigne uno.';
  const code = (e as { code?: string })?.code ?? '';
  if (code.includes('permission-denied')) return 'No tienes permiso para esta acción (o la rendición ya cambió de estado). Recarga la página.';
  if (code.includes('unavailable')) return 'Sin conexión. Revisa tu internet e inténtalo de nuevo.';
  if (code.includes('failed-precondition')) return 'La base de datos está terminando de prepararse. Inténtalo en unos minutos.';
  return 'Ocurrió un error inesperado. Inténtalo de nuevo.';
}

// ---------- Pagos (usuario de pagos) ----------

/** Flujos de la empresa donde este usuario es "quién paga". */
export async function flowsIPay(cid: string, uid: string): Promise<Flow[]> {
  const snap = await getDocs(query(collection(db, 'companies', cid, 'flows'), where('payerUid', '==', uid)));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Flow);
}

/** Rendiciones aprobadas o pagadas de los flujos que paga este usuario (sin las propias). */
export async function listPayments(cid: string, uid: string): Promise<Report[]> {
  const [flows, snap] = await Promise.all([
    flowsIPay(cid, uid),
    getDocs(query(reportsCol(cid), where('approverUids', 'array-contains', uid))),
  ]);
  const mine = new Set(flows.map((f) => f.id));
  return asReports(snap.docs).filter(
    (r) => r.flowId && mine.has(r.flowId) && r.ownerUid !== uid && (r.status === 'approved' || r.status === 'paid'),
  );
}

export async function registerPayment(
  s: Session,
  reportId: string,
  data: { method: PaymentMethod; reference: string; paidOn: string; comment: string },
) {
  await updateDoc(doc(db, 'companies', s.company.id, 'reports', reportId), {
    status: 'paid',
    paidAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    payment: {
      uid: s.profile.uid,
      name: s.profile.displayName,
      method: data.method,
      reference: data.reference.trim().slice(0, 80),
      paidOn: data.paidOn,
      comment: data.comment.trim().slice(0, 500),
    },
  });
}

// ---------- Fotos de respaldo ----------
export type NewAttachment = Omit<Attachment, 'id' | 'uploadedBy' | 'createdAt'>;

export async function listAttachments(cid: string, rid: string): Promise<Attachment[]> {
  const snap = await getDocs(collection(db, 'companies', cid, 'reports', rid, 'attachments'));
  return snap.docs
    .map((d) => ({ id: d.id, ...(d.data() as Omit<Attachment, 'id'>) }))
    .sort((a, b) => (toDate(a.createdAt)?.getTime() ?? 0) - (toDate(b.createdAt)?.getTime() ?? 0));
}

const MAX_DATAURL = 450_000; // ~330 KB por foto (el límite de un documento es 1 MB)

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('BAD_IMAGE'));
    };
    img.src = url;
  });
}

/** Reduce y comprime una foto a JPEG legible de ~300 KB como máximo. */
export async function compressImage(file: File): Promise<NewAttachment> {
  if (!file.type.startsWith('image/')) throw new Error('NOT_IMAGE');
  const img = await loadImage(file);
  let maxSide = 1600;
  for (let attempt = 0; attempt < 6; attempt++) {
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    for (const q of [0.8, 0.7, 0.6, 0.5]) {
      const dataUrl = canvas.toDataURL('image/jpeg', q);
      if (dataUrl.length <= MAX_DATAURL) {
        return { name: file.name.slice(0, 120) || 'foto.jpg', caption: '', dataUrl, size: Math.round((dataUrl.length * 3) / 4) };
      }
    }
    maxSide = Math.round(maxSide * 0.75);
  }
  throw new Error('IMAGE_TOO_BIG');
}

// ---------- Tiempo real: la página se actualiza sola cuando cambian los datos ----------
type Unsub = () => void;
const errHandler = (onError?: (e: unknown) => void) => (e: unknown) => onError?.(e);

export function watchMyReports(cid: string, uid: string, cb: (r: Report[]) => void, onError?: (e: unknown) => void): Unsub {
  return onSnapshot(query(reportsCol(cid), where('ownerUid', '==', uid), orderBy('updatedAt', 'desc')), (snap) => cb(asReports(snap.docs)), errHandler(onError));
}

export function watchPendingForMe(cid: string, uid: string, cb: (r: Report[]) => void, onError?: (e: unknown) => void): Unsub {
  return onSnapshot(
    query(reportsCol(cid), where('currentApprovers', 'array-contains', uid)),
    (snap) => cb(asReports(snap.docs).filter((r) => r.status === 'pending' && r.ownerUid !== uid)),
    errHandler(onError),
  );
}

export function watchApproverHistory(cid: string, uid: string, cb: (r: Report[]) => void, onError?: (e: unknown) => void): Unsub {
  return onSnapshot(
    query(reportsCol(cid), where('approverUids', 'array-contains', uid)),
    (snap) => cb(asReports(snap.docs).filter((r) => r.ownerUid !== uid && r.approvals.some((a) => a.uid === uid))),
    errHandler(onError),
  );
}

/** Pagos en vivo: rendiciones aprobadas/pagadas de los flujos que paga el usuario. */
export function watchPayments(cid: string, uid: string, cb: (r: Report[]) => void, onError?: (e: unknown) => void): Unsub {
  let mine = new Set<string>();
  let last: Report[] = [];
  const emit = () => cb(last.filter((r) => r.flowId && mine.has(r.flowId) && r.ownerUid !== uid && (r.status === 'approved' || r.status === 'paid')));
  const u1 = onSnapshot(
    query(collection(db, 'companies', cid, 'flows'), where('payerUid', '==', uid)),
    (snap) => {
      mine = new Set(snap.docs.map((d) => d.id));
      emit();
    },
    errHandler(onError),
  );
  const u2 = onSnapshot(
    query(reportsCol(cid), where('approverUids', 'array-contains', uid)),
    (snap) => {
      last = asReports(snap.docs);
      emit();
    },
    errHandler(onError),
  );
  return () => {
    u1();
    u2();
  };
}

/** Avisa cada vez que cambia una rendición (para recargar su detalle). */
export function watchReportChanges(cid: string, id: string, onChange: () => void): Unsub {
  let first = true;
  let lastStamp = '';
  return onSnapshot(
    doc(db, 'companies', cid, 'reports', id),
    (snap) => {
      const d = snap.data();
      const stamp = `${d?.status}|${d?.currentLevel}|${(d?.approvals ?? []).length}|${toDate(d?.updatedAt)?.getTime() ?? ''}`;
      if (first) {
        first = false;
        lastStamp = stamp;
        return;
      }
      if (stamp !== lastStamp && !snap.metadata.hasPendingWrites) {
        lastStamp = stamp;
        onChange();
      }
    },
    () => undefined,
  );
}

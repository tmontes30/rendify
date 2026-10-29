import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
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
  sumTotals,
  type Approval,
  type Category,
  type Flow,
  type Item,
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
): Promise<string> {
  const cid = s.company.id;
  const batch = writeBatch(db);
  const ref = existing ? doc(db, 'companies', cid, 'reports', existing.report.id) : doc(reportsCol(cid));
  const clean = (r: ItemDraft): ItemInput => ({
    date: r.date,
    categoryId: r.categoryId,
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

  const totals = sumTotals(rows);
  const base = { title: header.title.trim(), periodFrom: header.periodFrom, periodTo: header.periodTo, totals, itemCount: rows.length, updatedAt: serverTimestamp() };
  // Al enviar se lee el flujo vigente (el owner pudo haberlo cambiado).
  const flow = submit && s.profile.flowId ? await getFlow(cid, s.profile.flowId) : null;
  const flowFields =
    submit && flow
      ? {
          status: 'pending',
          flowId: flow.id,
          currentLevel: 0,
          currentApprovers: flow.levels[0].approvers,
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
  if (msg === 'NO_FLOW') return 'No tienes un flujo de aprobación asignado. Pídele al administrador que te asigne uno.';
  const code = (e as { code?: string })?.code ?? '';
  if (code.includes('permission-denied')) return 'No tienes permiso para esta acción (o la rendición ya cambió de estado). Recarga la página.';
  if (code.includes('unavailable')) return 'Sin conexión. Revisa tu internet e inténtalo de nuevo.';
  if (code.includes('failed-precondition')) return 'La base de datos está terminando de prepararse. Inténtalo en unos minutos.';
  return 'Ocurrió un error inesperado. Inténtalo de nuevo.';
}

import {
  addDoc,
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
import { sumTotals, type Category, type Item, type Report, type UserProfile } from '@rendiciones/shared';
import { db } from './firebase';

export type ItemInput = Omit<Item, 'id'>;

const reportsCol = () => collection(db, 'reports');
const itemsCol = (reportId: string) => collection(db, 'reports', reportId, 'items');

export function toDate(v: unknown): Date | null {
  return v instanceof Timestamp ? v.toDate() : null;
}

export function fmtDate(v: unknown) {
  const d = toDate(v);
  return d ? d.toLocaleDateString('es-CL', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
}

export async function listCategories(): Promise<Category[]> {
  const snap = await getDocs(collection(db, 'categories'));
  return snap.docs
    .map((d) => ({ id: d.id, ...(d.data() as Omit<Category, 'id'>) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

export async function listMyReports(uid: string): Promise<Report[]> {
  const snap = await getDocs(query(reportsCol(), where('ownerUid', '==', uid), orderBy('updatedAt', 'desc')));
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Report, 'id'>) }));
}

export async function listAreaReports(areaId: string): Promise<Report[]> {
  const snap = await getDocs(query(reportsCol(), where('areaId', '==', areaId), orderBy('updatedAt', 'desc')));
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Report, 'id'>) }));
}

export async function getReport(id: string): Promise<{ report: Report; items: Item[] } | null> {
  const snap = await getDoc(doc(db, 'reports', id));
  if (!snap.exists()) return null;
  const items = await getDocs(query(itemsCol(id), orderBy('date')));
  return {
    report: { id: snap.id, ...(snap.data() as Omit<Report, 'id'>) },
    items: items.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Item, 'id'>) })),
  };
}

export async function createReport(profile: UserProfile, data: { title: string; periodFrom: string; periodTo: string }) {
  const ref = await addDoc(reportsCol(), {
    ownerUid: profile.uid,
    ownerName: profile.displayName,
    areaId: profile.areaId,
    title: data.title.trim(),
    periodFrom: data.periodFrom,
    periodTo: data.periodTo,
    status: 'draft',
    totals: {},
    itemCount: 0,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return ref.id;
}

export async function updateReportHeader(id: string, data: { title: string; periodFrom: string; periodTo: string }) {
  await updateDoc(doc(db, 'reports', id), { ...data, title: data.title.trim(), updatedAt: serverTimestamp() });
}

/** Guarda (crea o edita) un gasto y actualiza los totales de la rendición en una sola operación. */
export async function saveItem(reportId: string, currentItems: Item[], itemId: string | null, data: ItemInput) {
  const batch = writeBatch(db);
  const ref = itemId ? doc(itemsCol(reportId), itemId) : doc(itemsCol(reportId));
  batch.set(ref, data);
  const next = [...currentItems.filter((i) => i.id !== ref.id), { ...data, id: ref.id }];
  batch.update(doc(db, 'reports', reportId), {
    totals: sumTotals(next),
    itemCount: next.length,
    updatedAt: serverTimestamp(),
  });
  await batch.commit();
}

export async function deleteItem(reportId: string, currentItems: Item[], itemId: string) {
  const batch = writeBatch(db);
  batch.delete(doc(itemsCol(reportId), itemId));
  const next = currentItems.filter((i) => i.id !== itemId);
  batch.update(doc(db, 'reports', reportId), {
    totals: sumTotals(next),
    itemCount: next.length,
    updatedAt: serverTimestamp(),
  });
  await batch.commit();
}

export async function submitReport(reportId: string, items: Item[]) {
  await updateDoc(doc(db, 'reports', reportId), {
    status: 'submitted',
    totals: sumTotals(items),
    itemCount: items.length,
    submittedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

export async function deleteDraft(reportId: string, items: Item[]) {
  for (const it of items) await deleteDoc(doc(itemsCol(reportId), it.id));
  await deleteDoc(doc(db, 'reports', reportId));
}

export async function managerDecision(
  reportId: string,
  manager: UserProfile,
  decision: 'manager_approved' | 'rejected',
  comment: string,
) {
  await updateDoc(doc(db, 'reports', reportId), {
    status: decision,
    managerReview: { uid: manager.uid, name: manager.displayName, at: serverTimestamp(), comment: comment.trim() },
    updatedAt: serverTimestamp(),
  });
}

export function friendlyError(e: unknown): string {
  const code = (e as { code?: string })?.code ?? '';
  if (code.includes('permission-denied')) return 'No tienes permiso para esta acción (o la rendición ya cambió de estado). Recarga la página.';
  if (code.includes('unavailable')) return 'Sin conexión. Revisa tu internet e inténtalo de nuevo.';
  if (code.includes('failed-precondition')) return 'Falta configurar un índice en Firestore (ver README).';
  return 'Ocurrió un error inesperado. Inténtalo de nuevo.';
}

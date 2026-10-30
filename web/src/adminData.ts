// Operaciones del administrador de personal (personas y flujos de su empresa).
// Las reglas de Firestore limitan todo a la empresa del administrador.
import { collection, deleteDoc, doc, getDocs, query, serverTimestamp, setDoc, updateDoc, where, writeBatch } from 'firebase/firestore';
import { sendPasswordResetEmail } from 'firebase/auth';
import { flowDerived, isSpecialProfile, rerouteToFlow, type Approval, type Area, type Flow, type FlowLevel, type UserProfile } from '@rendiciones/shared';
import { auth, createAccount, db } from './firebase';
import type { Session } from './auth';

export type Person = UserProfile & { createdAt?: unknown };

export async function listPeople(cid: string): Promise<Person[]> {
  const snap = await getDocs(query(collection(db, 'users'), where('companyId', '==', cid)));
  return snap.docs
    .map((d) => ({ uid: d.id, ...(d.data() as Omit<Person, 'uid'>) }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName, 'es'));
}

export async function listAreas(cid: string): Promise<Area[]> {
  const snap = await getDocs(collection(db, 'companies', cid, 'areas'));
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Area, 'id'>) })).sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

export async function listFlows(cid: string): Promise<Flow[]> {
  const snap = await getDocs(collection(db, 'companies', cid, 'flows'));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Flow).sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

export interface PersonInput {
  displayName: string;
  rut: string; // ya normalizado (12345678-9)
  position: string;
  areaId: string | null;
  flowId: string | null;
  paymentsUser: boolean;
}

/** El RUT no se puede repetir dentro de la empresa. */
async function assertRutFree(cid: string, rut: string, exceptUid?: string) {
  const dup = await getDocs(query(collection(db, 'users'), where('companyId', '==', cid), where('rut', '==', rut)));
  if (dup.docs.some((d) => d.id !== exceptUid)) throw new Error('RUT_TAKEN');
}

/** Crea la cuenta de acceso y el perfil en la empresa del administrador. */
export async function createPerson(s: Session, email: string, password: string, data: PersonInput) {
  await assertRutFree(s.company.id, data.rut);
  return createAccount(email, password, async (uid) => {
    await setDoc(doc(db, 'users', uid), {
      email: email.trim().toLowerCase(),
      displayName: data.displayName.trim().replace(/\s+/g, ' '),
      rut: data.rut,
      position: data.position.trim(),
      companyId: s.company.id,
      areaId: data.areaId || null,
      flowId: data.paymentsUser ? null : data.flowId,
      isApprover: false,
      paymentsUser: data.paymentsUser,
      active: true,
      createdAt: serverTimestamp(),
      createdBy: s.profile.uid,
    });
  });
}

export async function updatePerson(uid: string, data: Partial<PersonInput> & { active?: boolean }, current: Person) {
  if (data.rut && data.rut !== current.rut) await assertRutFree(current.companyId, data.rut, uid);
  await updateDoc(doc(db, 'users', uid), {
    ...data,
    ...(data.displayName ? { displayName: data.displayName.trim().replace(/\s+/g, ' ') } : {}),
    // Campos que las reglas exigen presentes y válidos (perfiles antiguos pueden no tenerlos).
    paymentsUser: data.paymentsUser ?? !!current.paymentsUser,
    isApprover: !!current.isApprover,
  });
}

export const sendPasswordLink = (email: string) => sendPasswordResetEmail(auth, email);

/**
 * Guarda un flujo y mantiene consistentes los perfiles y rendiciones:
 *  - aprobadores sin flujo quedan asignados a este,
 *  - isApprover de cada persona según todos los flujos,
 *  - si cambia quién paga, puede ver las rendiciones ya enviadas del flujo.
 */
export async function saveFlow(
  s: Session,
  flowId: string | null,
  name: string,
  levels: FlowLevel[],
  payerUid: string | null,
  people: Person[],
  allFlows: Flow[],
  members?: string[],
) {
  const cid = s.company.id;
  const names = Object.fromEntries(people.map((p) => [p.uid, p.displayName]));
  const derived = flowDerived(levels, payerUid, names);
  const ref = flowId ? doc(db, 'companies', cid, 'flows', flowId) : doc(collection(db, 'companies', cid, 'flows'));
  const previous = allFlows.find((f) => f.id === ref.id);

  const batch = writeBatch(db);
  batch.set(ref, { name: name.trim(), ...derived, updatedAt: serverTimestamp(), updatedBy: s.profile.uid });

  const levelApprovers = new Set(derived.levels.flatMap((l) => l.approvers));
  const flowsAfter = [...allFlows.filter((f) => f.id !== ref.id), { ...derived, id: ref.id, name } as Flow];
  const approversAll = new Set(flowsAfter.flatMap((f) => f.levels.flatMap((l) => l.approvers)));
  let assigned = 0;
  const want = members ? new Set(members) : null;
  for (const p of people) {
    // Trabajadores elegidos para este flujo; quienes lo tenían y ya no están, quedan sin flujo.
    let flowIdNew = p.flowId ?? null;
    // Perfiles especiales (pagos, administrador de personal) nunca quedan en un flujo.
    if (isSpecialProfile(p)) flowIdNew = null;
    else if (want) {
      if (want.has(p.uid)) flowIdNew = ref.id;
      else if (flowIdNew === ref.id) flowIdNew = null;
    }
    // Aprobadores sin flujo quedan en este (para sus propias rendiciones).
    // (solo si no se eligieron trabajadores explícitamente: esa elección se respeta tal cual).
    if (!want && !flowIdNew && !isSpecialProfile(p) && levelApprovers.has(p.uid)) flowIdNew = ref.id;
    const isApprover = approversAll.has(p.uid);
    if (flowIdNew !== (p.flowId ?? null) || isApprover !== !!p.isApprover || p.paymentsUser === undefined) {
      if (flowIdNew !== (p.flowId ?? null)) assigned++;
      batch.update(doc(db, 'users', p.uid), { flowId: flowIdNew, isApprover, paymentsUser: !!p.paymentsUser });
    }
  }
  await batch.commit();

  // Quién paga: actualizar quién puede ver las rendiciones ya enviadas de este flujo.
  if (flowId && (previous?.payerUid ?? null) !== payerUid) {
    const reports = await getDocs(query(collection(db, 'companies', cid, 'reports'), where('flowId', '==', ref.id)));
    for (const r of reports.docs) {
      if (r.data().status === 'draft') continue;
      const viewers = new Set<string>((r.data().approverUids as string[]) ?? []);
      const old = previous?.payerUid;
      if (old && !derived.allApprovers.includes(old)) viewers.delete(old);
      if (payerUid) viewers.add(payerUid);
      await updateDoc(r.ref, { approverUids: [...viewers] });
    }
  }
  // Rendiciones en aprobación con este flujo: reacomodarlas al flujo vigente.
  let rerouted = 0;
  if (flowId) {
    const pending = await getDocs(query(collection(db, 'companies', cid, 'reports'), where('flowId', '==', ref.id), where('status', '==', 'pending')));
    for (const r of pending.docs) {
      const d = r.data();
      const next = rerouteToFlow(derived.levels, d.ownerUid as string, (d.approvals ?? []) as Approval[]);
      if (next.currentLevel === d.currentLevel && JSON.stringify(next.currentApprovers) === JSON.stringify(d.currentApprovers ?? [])) continue;
      const viewers = [...new Set([...((d.approverUids as string[]) ?? []), ...derived.allApprovers])];
      await updateDoc(r.ref, { ...next, approverUids: viewers });
      rerouted++;
    }
  }
  return { id: ref.id, assigned, rerouted };
}

export async function deleteFlow(s: Session, flow: Flow, people: Person[], allFlows: Flow[]) {
  const cid = s.company.id;
  if (people.some((p) => p.flowId === flow.id)) throw new Error('FLOW_IN_USE');
  const pending = await getDocs(query(collection(db, 'companies', cid, 'reports'), where('flowId', '==', flow.id), where('status', '==', 'pending')));
  if (!pending.empty) throw new Error('FLOW_PENDING');
  await deleteDoc(doc(db, 'companies', cid, 'flows', flow.id));
  const approversAll = new Set(allFlows.filter((f) => f.id !== flow.id).flatMap((f) => f.levels.flatMap((l) => l.approvers)));
  const batch = writeBatch(db);
  let n = 0;
  for (const p of people) {
    const isApprover = approversAll.has(p.uid);
    if (isApprover !== !!p.isApprover) {
      batch.update(doc(db, 'users', p.uid), { isApprover, paymentsUser: !!p.paymentsUser });
      n++;
    }
  }
  if (n) await batch.commit();
}

export function adminError(e: unknown): string {
  const msg = (e as Error)?.message ?? '';
  const code = (e as { code?: string })?.code ?? '';
  if (msg === 'RUT_TAKEN') return 'Ya existe una persona con ese RUT en tu empresa.';
  if (msg === 'FLOW_IN_USE') return 'Hay personas asignadas a este flujo. Cámbialas de flujo antes de eliminarlo.';
  if (msg === 'FLOW_PENDING') return 'Hay rendiciones en aprobación con este flujo.';
  if (code.includes('email-already-in-use')) return 'Ya existe una cuenta con ese correo. Pídele al administrador del servicio que la asigne a tu empresa.';
  if (code.includes('invalid-email')) return 'Correo inválido.';
  if (code.includes('weak-password') || code.includes('password-does-not-meet-requirements')) return 'La contraseña debe tener al menos 10 caracteres.';
  if (code.includes('permission-denied')) return 'No tienes permiso para esta acción.';
  if (code.includes('too-many-requests')) return 'Demasiados intentos. Espera unos minutos.';
  return 'Ocurrió un error. Inténtalo de nuevo.';
}

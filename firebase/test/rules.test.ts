import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { collection, deleteDoc, doc, getDoc, getDocs, query, serverTimestamp, setDoc, updateDoc, where, writeBatch } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

let env: RulesTestEnvironment;

const A = 'empresa-a';
const B = 'empresa-b';
type U = { uid: string; companyId: string; name: string; flowId: string | null; active?: boolean };
const u = {
  worker: { uid: 'w1', companyId: A, name: 'Ana Trabajadora', flowId: 'f1' },
  worker2: { uid: 'w2', companyId: A, name: 'Beto Trabajador', flowId: 'f1' },
  boss: { uid: 'b1', companyId: A, name: 'Carla Jefa', flowId: null },
  cfo: { uid: 'c1', companyId: A, name: 'Diego Finanzas', flowId: null },
  other: { uid: 'o1', companyId: B, name: 'Eva OtraEmpresa', flowId: null },
  disabled: { uid: 'd1', companyId: A, name: 'Fede Inactivo', flowId: 'f1', active: false },
} satisfies Record<string, U>;

const FLOW = {
  name: 'Estándar',
  levels: [
    { name: 'Jefe', minAmount: 0, approvers: ['b1'] },
    { name: 'Finanzas', minAmount: 500000, approvers: ['c1'] },
  ],
  allApprovers: ['b1', 'c1'],
  approverNames: { b1: 'Carla Jefa', c1: 'Diego Finanzas' },
};

const fs = (x: U) => env.authenticatedContext(x.uid, { companyId: x.companyId }).firestore();
const reportsOf = (x: U) => collection(fs(x), 'companies', A, 'reports');

const item = { date: '2026-10-10', categoryId: 'transporte', description: 'Taxi', vendor: '', docType: 'boleta', docNumber: '1', amount: 15000, currency: 'CLP' };

function draft(x: U, extra: Record<string, unknown> = {}) {
  return {
    ownerUid: x.uid, ownerName: x.name, areaId: 'ventas', flowId: x.flowId, title: 'Gastos', periodFrom: '2026-10-01', periodTo: '2026-10-31',
    status: 'draft', totals: {}, itemCount: 0, currentLevel: 0, currentApprovers: [], approverUids: [], approvals: [],
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(), ...extra,
  };
}

function pendingFields() {
  return { status: 'pending', flowId: 'f1', currentLevel: 0, currentApprovers: ['b1'], approverUids: ['b1', 'c1'], submittedAt: serverTimestamp(), totals: { CLP: 15000 }, itemCount: 1 };
}

async function seed(id: string, owner: U, data: Record<string, unknown>) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'companies', A, 'reports', id), {
      ownerUid: owner.uid, ownerName: owner.name, areaId: 'ventas', flowId: 'f1', title: 'Seed', periodFrom: '2026-10-01', periodTo: '2026-10-31',
      status: 'draft', totals: { CLP: 15000 }, itemCount: 1, currentLevel: 0, currentApprovers: [], approverUids: [], approvals: [], ...data,
    });
    await setDoc(doc(db, 'companies', A, 'reports', id, 'items', 'i1'), item);
  });
}

const entry = (x: U, decision: string, level = 0, comment = '') => ({ level, levelName: FLOW.levels[level].name, uid: x.uid, name: x.name, decision, comment, atMs: Date.now() });

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-rendiciones',
    firestore: { rules: readFileSync(fileURLToPath(new URL('../firestore.rules', import.meta.url)), 'utf8') },
  });
});
afterAll(async () => env.cleanup());

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const c of [A, B]) {
      await setDoc(doc(db, 'companies', c), { name: c, baseCurrency: 'CLP', active: true });
      await setDoc(doc(db, 'companies', c, 'categories', 'transporte'), { name: 'Transporte', active: true });
    }
    await setDoc(doc(db, 'companies', A, 'flows', 'f1'), FLOW);
    for (const x of Object.values(u) as U[]) {
      await setDoc(doc(db, 'users', x.uid), { email: `${x.uid}@x.cl`, displayName: x.name, companyId: x.companyId, areaId: 'ventas', flowId: x.flowId, isApprover: false, active: x.active ?? true });
    }
  });
});

describe('aislamiento', () => {
  it('sin sesión o sin claims no se lee nada', async () => {
    await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'companies', A)));
    await assertFails(getDoc(doc(env.authenticatedContext('intruso').firestore(), 'companies', A)));
  });
  it('un usuario no ve otra empresa, aunque falsifique el claim', async () => {
    await assertSucceeds(getDoc(doc(fs(u.worker), 'companies', A)));
    await assertFails(getDoc(doc(fs(u.other), 'companies', A)));
    const fake = env.authenticatedContext(u.other.uid, { companyId: A }).firestore();
    await assertFails(getDoc(doc(fake, 'companies', A, 'flows', 'f1')));
  });
  it('usuario deshabilitado no accede', async () => {
    await assertFails(getDoc(doc(fs(u.disabled), 'companies', A)));
  });
  it('nadie escribe catálogos, flujos ni datos sensibles del perfil', async () => {
    await assertFails(setDoc(doc(fs(u.boss), 'companies', A, 'flows', 'f2'), FLOW));
    await assertFails(updateDoc(doc(fs(u.worker), 'users', u.worker.uid), { flowId: 'x' }));
    await assertFails(updateDoc(doc(fs(u.worker), 'users', u.worker.uid), { companyId: B }));
    await assertFails(updateDoc(doc(fs(u.worker), 'users', u.worker.uid), { isApprover: true }));
    await assertFails(updateDoc(doc(fs(u.worker), 'users', u.worker.uid), { displayName: 'Ana', active: true, areaId: 'x' }));
    await assertFails(getDoc(doc(fs(u.worker), 'users', u.boss.uid)));
  });

  it('cada uno cambia solo su propio nombre', async () => {
    await assertSucceeds(updateDoc(doc(fs(u.worker), 'users', u.worker.uid), { displayName: 'Ana María Trabajadora' }));
    await assertFails(updateDoc(doc(fs(u.worker), 'users', u.worker2.uid), { displayName: 'Hack' }));
    await assertFails(updateDoc(doc(fs(u.worker), 'users', u.worker.uid), { displayName: '' }));
    await assertFails(updateDoc(doc(fs(u.disabled), 'users', u.disabled.uid), { displayName: 'Volví' }));
  });
});

describe('crear y enviar', () => {
  it('crea borrador propio', async () => {
    await assertSucceeds(setDoc(doc(reportsOf(u.worker), 'r1'), draft(u.worker)));
  });
  it('crea y envía en un solo lote con gastos', async () => {
    const db = fs(u.worker);
    const b = writeBatch(db);
    const ref = doc(collection(db, 'companies', A, 'reports'));
    b.set(ref, draft(u.worker, pendingFields()));
    b.set(doc(collection(db, 'companies', A, 'reports', ref.id, 'items')), item);
    await assertSucceeds(b.commit());
  });
  it('no puede inventar aprobadores ni usar otro flujo', async () => {
    await assertFails(setDoc(doc(reportsOf(u.worker), 'r1'), draft(u.worker, { ...pendingFields(), currentApprovers: ['w2'] })));
    await assertFails(setDoc(doc(reportsOf(u.worker), 'r2'), draft(u.worker, { ...pendingFields(), currentLevel: 1, currentApprovers: ['c1'] })));
    await assertFails(setDoc(doc(reportsOf(u.worker), 'r3'), draft(u.worker, { status: 'approved' })));
    await assertFails(setDoc(doc(reportsOf(u.worker), 'r4'), draft(u.worker, { ownerUid: 'w2' })));
    await assertFails(setDoc(doc(reportsOf(u.worker), 'r5'), draft(u.worker, { approvals: [entry(u.boss, 'approved')] })));
  });
  it('envía un borrador existente; no edita una enviada', async () => {
    await seed('r1', u.worker, {});
    await assertSucceeds(updateDoc(doc(reportsOf(u.worker), 'r1'), { ...pendingFields(), updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(reportsOf(u.worker), 'r1'), { title: 'Cambio', updatedAt: serverTimestamp() }));
    await assertFails(setDoc(doc(fs(u.worker), 'companies', A, 'reports', 'r1', 'items', 'i9'), item));
  });
  it('gastos inválidos se rechazan', async () => {
    await seed('r1', u.worker, {});
    const ref = doc(fs(u.worker), 'companies', A, 'reports', 'r1', 'items', 'x');
    await assertSucceeds(setDoc(ref, item));
    await assertFails(setDoc(ref, { ...item, amount: -1 }));
    await assertFails(setDoc(ref, { ...item, amount: 1.5 }));
    await assertFails(setDoc(ref, { ...item, currency: 'XXX' }));
    await assertFails(setDoc(ref, { ...item, hack: true }));
  });
  it('otro trabajador no ve ni edita', async () => {
    await seed('r1', u.worker, {});
    await assertFails(getDoc(doc(reportsOf(u.worker2), 'r1')));
    await assertFails(setDoc(doc(fs(u.worker2), 'companies', A, 'reports', 'r1', 'items', 'i9'), item));
    await assertFails(getDocs(collection(fs(u.worker2), 'companies', A, 'reports')));
  });
  it('solo borra borradores propios', async () => {
    await seed('r1', u.worker, {});
    await assertFails(deleteDoc(doc(reportsOf(u.worker2), 'r1')));
    await assertSucceeds(deleteDoc(doc(reportsOf(u.worker), 'r1')));
  });
});

describe('aprobación por niveles', () => {
  beforeEach(async () => {
    await seed('r1', u.worker, { status: 'pending', currentLevel: 0, currentApprovers: ['b1'], approverUids: ['b1', 'c1'] });
  });

  it('aprobadores leen con sus consultas', async () => {
    await assertSucceeds(getDocs(query(collection(fs(u.boss), 'companies', A, 'reports'), where('currentApprovers', 'array-contains', 'b1'))));
    await assertSucceeds(getDocs(query(collection(fs(u.cfo), 'companies', A, 'reports'), where('approverUids', 'array-contains', 'c1'))));
    await assertSucceeds(getDocs(collection(fs(u.boss), 'companies', A, 'reports', 'r1', 'items')));
  });

  it('jefe aprueba y pasa a Finanzas', async () => {
    await assertSucceeds(
      updateDoc(doc(reportsOf(u.boss), 'r1'), {
        status: 'pending', currentLevel: 1, currentApprovers: ['c1'], approvals: [entry(u.boss, 'approved')],
        updatedAt: serverTimestamp(), decidedAt: serverTimestamp(),
      }),
    );
  });

  it('jefe aprueba y termina', async () => {
    await assertSucceeds(
      updateDoc(doc(reportsOf(u.boss), 'r1'), {
        status: 'approved', currentApprovers: [], approvals: [entry(u.boss, 'approved')], updatedAt: serverTimestamp(), decidedAt: serverTimestamp(),
      }),
    );
  });

  it('rechazo exige comentario', async () => {
    const base = { status: 'rejected', currentApprovers: [], updatedAt: serverTimestamp(), decidedAt: serverTimestamp() };
    await assertFails(updateDoc(doc(reportsOf(u.boss), 'r1'), { ...base, approvals: [entry(u.boss, 'rejected')] }));
    await assertSucceeds(updateDoc(doc(reportsOf(u.boss), 'r1'), { ...base, approvals: [entry(u.boss, 'rejected', 0, 'Falta boleta')] }));
  });

  it('no aprueba quien no está en el nivel actual, ni se falsifica el avance', async () => {
    const ok = { status: 'approved', currentApprovers: [], updatedAt: serverTimestamp(), decidedAt: serverTimestamp() };
    await assertFails(updateDoc(doc(reportsOf(u.cfo), 'r1'), { ...ok, approvals: [entry(u.cfo, 'approved')] }));
    await assertFails(updateDoc(doc(reportsOf(u.worker), 'r1'), { ...ok, approvals: [entry(u.worker, 'approved')] }));
    await assertFails(updateDoc(doc(reportsOf(u.boss), 'r1'), { ...ok, approvals: [entry(u.cfo, 'approved')] }));
    await assertFails(
      updateDoc(doc(reportsOf(u.boss), 'r1'), {
        status: 'pending', currentLevel: 1, currentApprovers: ['w2'], approvals: [entry(u.boss, 'approved')], updatedAt: serverTimestamp(), decidedAt: serverTimestamp(),
      }),
    );
    await assertFails(updateDoc(doc(reportsOf(u.boss), 'r1'), { ...ok, totals: { CLP: 1 }, approvals: [entry(u.boss, 'approved')] }));
    await assertFails(updateDoc(doc(reportsOf(u.boss), 'r1'), { status: 'paid', currentApprovers: [], approvals: [entry(u.boss, 'approved')], updatedAt: serverTimestamp(), decidedAt: serverTimestamp() }));
  });

  it('no se puede borrar el historial de aprobaciones', async () => {
    await seed('r2', u.worker, {
      status: 'pending', currentLevel: 1, currentApprovers: ['c1'], approverUids: ['b1', 'c1'], approvals: [entry(u.boss, 'approved')],
    });
    await assertFails(
      updateDoc(doc(reportsOf(u.cfo), 'r2'), {
        status: 'approved', currentApprovers: [], approvals: [entry(u.cfo, 'approved', 1)], updatedAt: serverTimestamp(), decidedAt: serverTimestamp(),
      }),
    );
  });

  it('aprobador que rinde: parte en el nivel siguiente al suyo, o va al owner si es el último', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), 'users', 'b1'), { flowId: 'f1' });
      await updateDoc(doc(ctx.firestore(), 'users', 'c1'), { flowId: 'f1' });
    });
    const sub = (x: U, level: number, approvers: string[]) =>
      draft(x, { ...pendingFields(), currentLevel: level, currentApprovers: approvers });
    // Jefe (nivel 1): debe partir en Finanzas, no en su propio nivel ni saltarse el siguiente
    await assertFails(setDoc(doc(reportsOf(u.boss), 'b-a'), sub(u.boss, 0, ['b1'])));
    await assertFails(setDoc(doc(reportsOf(u.boss), 'b-b'), sub(u.boss, 2, [])));
    await assertSucceeds(setDoc(doc(reportsOf(u.boss), 'b-ok'), sub(u.boss, 1, ['c1'])));
    // Finanzas (último nivel): queda sin aprobadores para el owner
    await assertFails(setDoc(doc(reportsOf(u.cfo), 'c-a'), sub(u.cfo, 1, ['c1'])));
    await assertSucceeds(setDoc(doc(reportsOf(u.cfo), 'c-ok'), sub(u.cfo, 2, [])));
    // Un trabajador normal no puede usar estos atajos
    await assertFails(setDoc(doc(reportsOf(u.worker), 'w-a'), sub(u.worker, 2, [])));
    await assertFails(setDoc(doc(reportsOf(u.worker), 'w-b'), sub(u.worker, 1, ['c1'])));
  });

  it('un aprobador no aprueba su propia rendición', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), 'users', 'b1'), { flowId: 'f1' });
    });
    await seed('own', u.boss, { status: 'pending', currentApprovers: ['b1'], approverUids: ['b1', 'c1'] });
    await assertFails(
      updateDoc(doc(reportsOf(u.boss), 'own'), {
        status: 'approved', currentApprovers: [], approvals: [entry(u.boss, 'approved')], updatedAt: serverTimestamp(), decidedAt: serverTimestamp(),
      }),
    );
  });
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

let env: RulesTestEnvironment;

const AREA_A = 'ventas';
const AREA_B = 'operaciones';

const users = {
  worker: { uid: 'worker1', role: 'worker', areaId: AREA_A, name: 'Ana Trabajadora' },
  worker2: { uid: 'worker2', role: 'worker', areaId: AREA_A, name: 'Beto Trabajador' },
  manager: { uid: 'manager1', role: 'manager', areaId: AREA_A, name: 'Carla Jefa' },
  managerB: { uid: 'manager2', role: 'manager', areaId: AREA_B, name: 'Diego Jefe' },
  disabled: { uid: 'disabled1', role: 'worker', areaId: AREA_A, name: 'Eva Deshabilitada' },
};

function db(u: (typeof users)[keyof typeof users]) {
  return env.authenticatedContext(u.uid, { role: u.role, areaId: u.areaId }).firestore();
}

function newReport(u: (typeof users)[keyof typeof users], extra: Record<string, unknown> = {}) {
  return {
    ownerUid: u.uid,
    ownerName: u.name,
    areaId: u.areaId,
    title: 'Viaje a Santiago',
    periodFrom: '2026-10-01',
    periodTo: '2026-10-31',
    status: 'draft',
    totals: {},
    itemCount: 0,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...extra,
  };
}

const validItem = {
  date: '2026-10-10',
  categoryId: 'transporte',
  description: 'Taxi aeropuerto',
  vendor: 'Taxi SpA',
  docType: 'boleta',
  docNumber: '12345',
  amount: 15000,
  currency: 'CLP',
};

/** Crea un report directamente (saltando reglas) con el estado indicado. */
async function seedReport(id: string, owner: (typeof users)[keyof typeof users], status: string, itemCount = 1) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const fs = ctx.firestore();
    await setDoc(doc(fs, 'reports', id), {
      ownerUid: owner.uid,
      ownerName: owner.name,
      areaId: owner.areaId,
      title: 'Seed',
      periodFrom: '2026-10-01',
      periodTo: '2026-10-31',
      status,
      totals: { CLP: 15000 },
      itemCount,
    });
    await setDoc(doc(fs, 'reports', id, 'items', 'i1'), validItem);
  });
}

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-rendiciones',
    firestore: { rules: readFileSync(fileURLToPath(new URL('../firestore.rules', import.meta.url)), 'utf8') },
  });
});

afterAll(async () => {
  await env.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const fs = ctx.firestore();
    await setDoc(doc(fs, 'areas', AREA_A), { name: 'Ventas', active: true });
    await setDoc(doc(fs, 'areas', AREA_B), { name: 'Operaciones', active: true });
    await setDoc(doc(fs, 'categories', 'transporte'), { name: 'Transporte', active: true });
    for (const u of Object.values(users)) {
      await setDoc(doc(fs, 'users', u.uid), {
        email: `${u.uid}@empresa.cl`,
        displayName: u.name,
        role: u.role,
        areaId: u.areaId,
        active: u.uid !== users.disabled.uid,
      });
    }
  });
});

describe('acceso básico', () => {
  it('usuario no autenticado no lee nada', async () => {
    const fs = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(fs, 'areas', AREA_A)));
    await assertFails(getDoc(doc(fs, 'users', users.worker.uid)));
  });

  it('usuario autorregistrado sin claims no lee nada', async () => {
    const fs = env.authenticatedContext('intruso').firestore();
    await assertFails(getDoc(doc(fs, 'areas', AREA_A)));
    await assertFails(getDocs(collection(fs, 'categories')));
    await assertFails(addDoc(collection(fs, 'reports'), newReport({ ...users.worker, uid: 'intruso' })));
  });

  it('usuario con claims falsos pero sin perfil activo no accede', async () => {
    await assertFails(getDoc(doc(db(users.disabled), 'areas', AREA_A)));
    const fake = env.authenticatedContext('fake', { role: 'manager', areaId: AREA_A }).firestore();
    await assertFails(getDoc(doc(fake, 'areas', AREA_A)));
  });

  it('trabajador lee catálogos y su propio perfil, pero no el de otros', async () => {
    const fs = db(users.worker);
    await assertSucceeds(getDoc(doc(fs, 'areas', AREA_A)));
    await assertSucceeds(getDocs(collection(fs, 'categories')));
    await assertSucceeds(getDoc(doc(fs, 'users', users.worker.uid)));
    await assertFails(getDoc(doc(fs, 'users', users.worker2.uid)));
  });

  it('nadie escribe catálogos ni perfiles desde la web', async () => {
    const fs = db(users.manager);
    await assertFails(setDoc(doc(fs, 'areas', 'nueva'), { name: 'X', active: true }));
    await assertFails(setDoc(doc(fs, 'categories', 'x'), { name: 'X', active: true }));
    await assertFails(updateDoc(doc(fs, 'users', users.manager.uid), { role: 'manager', areaId: AREA_B }));
  });

  it('jefe lee perfiles de su área, no de otra', async () => {
    await assertSucceeds(getDoc(doc(db(users.manager), 'users', users.worker.uid)));
    await assertFails(getDoc(doc(db(users.managerB), 'users', users.worker.uid)));
  });
});

describe('crear rendición', () => {
  it('trabajador crea su borrador', async () => {
    await assertSucceeds(addDoc(collection(db(users.worker), 'reports'), newReport(users.worker)));
  });

  it('no puede crear a nombre de otro, en otra área, o en otro estado', async () => {
    const fs = db(users.worker);
    await assertFails(addDoc(collection(fs, 'reports'), newReport(users.worker, { ownerUid: users.worker2.uid })));
    await assertFails(addDoc(collection(fs, 'reports'), newReport(users.worker, { areaId: AREA_B })));
    await assertFails(addDoc(collection(fs, 'reports'), newReport(users.worker, { status: 'approved' })));
    await assertFails(addDoc(collection(fs, 'reports'), newReport(users.worker, { ownerName: 'Otro Nombre' })));
    await assertFails(addDoc(collection(fs, 'reports'), newReport(users.worker, { totals: { CLP: 1 } })));
    await assertFails(addDoc(collection(fs, 'reports'), newReport(users.worker, { extra: true })));
    await assertFails(addDoc(collection(fs, 'reports'), newReport(users.worker, { periodFrom: '2026-12-01' })));
  });
});

describe('lectura de rendiciones', () => {
  beforeEach(async () => {
    await seedReport('r1', users.worker, 'submitted');
  });

  it('dueño y jefe del área leen; otro trabajador y jefe de otra área no', async () => {
    await assertSucceeds(getDoc(doc(db(users.worker), 'reports', 'r1')));
    await assertSucceeds(getDoc(doc(db(users.manager), 'reports', 'r1')));
    await assertSucceeds(getDocs(collection(db(users.manager), 'reports', 'r1', 'items')));
    await assertFails(getDoc(doc(db(users.worker2), 'reports', 'r1')));
    await assertFails(getDoc(doc(db(users.managerB), 'reports', 'r1')));
    await assertFails(getDocs(collection(db(users.worker2), 'reports', 'r1', 'items')));
  });

  it('consultas: solo propias o del área', async () => {
    await assertSucceeds(getDocs(query(collection(db(users.worker), 'reports'), where('ownerUid', '==', users.worker.uid))));
    await assertSucceeds(getDocs(query(collection(db(users.manager), 'reports'), where('areaId', '==', AREA_A))));
    await assertFails(getDocs(collection(db(users.worker), 'reports')));
    await assertFails(getDocs(query(collection(db(users.managerB), 'reports'), where('areaId', '==', AREA_A))));
  });
});

describe('editar y enviar', () => {
  it('dueño agrega ítems y envía su borrador', async () => {
    await seedReport('r1', users.worker, 'draft', 0);
    const fs = db(users.worker);
    await assertSucceeds(setDoc(doc(fs, 'reports', 'r1', 'items', 'i2'), validItem));
    await assertSucceeds(
      updateDoc(doc(fs, 'reports', 'r1'), {
        status: 'submitted',
        itemCount: 2,
        totals: { CLP: 30000 },
        submittedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }),
    );
  });

  it('no envía rendición vacía', async () => {
    await seedReport('r1', users.worker, 'draft', 0);
    await assertFails(
      updateDoc(doc(db(users.worker), 'reports', 'r1'), {
        status: 'submitted',
        submittedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }),
    );
  });

  it('ítems inválidos son rechazados', async () => {
    await seedReport('r1', users.worker, 'draft');
    const ref = doc(db(users.worker), 'reports', 'r1', 'items', 'x');
    await assertFails(setDoc(ref, { ...validItem, amount: -5 }));
    await assertFails(setDoc(ref, { ...validItem, amount: 10.5 }));
    await assertFails(setDoc(ref, { ...validItem, currency: 'XXX' }));
    await assertFails(setDoc(ref, { ...validItem, categoryId: 'no-existe' }));
    await assertFails(setDoc(ref, { ...validItem, description: '' }));
    await assertFails(setDoc(ref, { ...validItem, hack: 1 }));
  });

  it('no puede editar una rendición enviada ni cambiar estados prohibidos', async () => {
    await seedReport('r1', users.worker, 'submitted');
    const fs = db(users.worker);
    await assertFails(updateDoc(doc(fs, 'reports', 'r1'), { title: 'Cambio', updatedAt: serverTimestamp() }));
    await assertFails(setDoc(doc(fs, 'reports', 'r1', 'items', 'i9'), validItem));
    await assertFails(deleteDoc(doc(fs, 'reports', 'r1', 'items', 'i1')));

    await seedReport('r2', users.worker, 'draft');
    await assertFails(updateDoc(doc(fs, 'reports', 'r2'), { status: 'approved', updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(fs, 'reports', 'r2'), { status: 'paid', updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(fs, 'reports', 'r2'), { ownerUid: users.worker2.uid, updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(fs, 'reports', 'r2'), { areaId: AREA_B, updatedAt: serverTimestamp() }));
  });

  it('otro trabajador no edita ni agrega ítems', async () => {
    await seedReport('r1', users.worker, 'draft');
    const fs = db(users.worker2);
    await assertFails(updateDoc(doc(fs, 'reports', 'r1'), { title: 'Hack', updatedAt: serverTimestamp() }));
    await assertFails(setDoc(doc(fs, 'reports', 'r1', 'items', 'i9'), validItem));
  });

  it('rendición rechazada vuelve a ser editable', async () => {
    await seedReport('r1', users.worker, 'rejected');
    const fs = db(users.worker);
    await assertSucceeds(updateDoc(doc(fs, 'reports', 'r1'), { title: 'Corregida', updatedAt: serverTimestamp() }));
    await assertSucceeds(setDoc(doc(fs, 'reports', 'r1', 'items', 'i2'), validItem));
  });

  it('solo borra borradores propios', async () => {
    await seedReport('r1', users.worker, 'draft');
    await seedReport('r2', users.worker, 'submitted');
    await assertFails(deleteDoc(doc(db(users.worker2), 'reports', 'r1')));
    await assertFails(deleteDoc(doc(db(users.worker), 'reports', 'r2')));
    await assertSucceeds(deleteDoc(doc(db(users.worker), 'reports', 'r1')));
  });
});

describe('aprobación del jefe', () => {
  const review = (u: (typeof users)[keyof typeof users], comment = '') => ({
    uid: u.uid,
    name: u.name,
    at: serverTimestamp(),
    comment,
  });

  it('jefe aprueba y rechaza (con comentario) en su área', async () => {
    await seedReport('r1', users.worker, 'submitted');
    await seedReport('r2', users.worker, 'submitted');
    const fs = db(users.manager);
    await assertSucceeds(
      updateDoc(doc(fs, 'reports', 'r1'), { status: 'manager_approved', managerReview: review(users.manager), updatedAt: serverTimestamp() }),
    );
    await assertFails(
      updateDoc(doc(fs, 'reports', 'r2'), { status: 'rejected', managerReview: review(users.manager), updatedAt: serverTimestamp() }),
    );
    await assertSucceeds(
      updateDoc(doc(fs, 'reports', 'r2'), { status: 'rejected', managerReview: review(users.manager, 'Falta boleta'), updatedAt: serverTimestamp() }),
    );
  });

  it('jefe no puede: aprobar lo propio, otra área, dar aprobación final, ni tocar montos', async () => {
    await seedReport('own', users.manager, 'submitted');
    await seedReport('r1', users.worker, 'submitted');
    await assertFails(
      updateDoc(doc(db(users.manager), 'reports', 'own'), { status: 'manager_approved', managerReview: review(users.manager), updatedAt: serverTimestamp() }),
    );
    await assertFails(
      updateDoc(doc(db(users.managerB), 'reports', 'r1'), { status: 'manager_approved', managerReview: review(users.managerB), updatedAt: serverTimestamp() }),
    );
    await assertFails(
      updateDoc(doc(db(users.manager), 'reports', 'r1'), { status: 'approved', managerReview: review(users.manager), updatedAt: serverTimestamp() }),
    );
    await assertFails(
      updateDoc(doc(db(users.manager), 'reports', 'r1'), {
        status: 'manager_approved',
        totals: { CLP: 1 },
        managerReview: review(users.manager),
        updatedAt: serverTimestamp(),
      }),
    );
    await assertFails(
      updateDoc(doc(db(users.manager), 'reports', 'r1'), {
        status: 'manager_approved',
        managerReview: review(users.worker),
        updatedAt: serverTimestamp(),
      }),
    );
  });

  it('jefe no aprueba rendiciones que no están enviadas', async () => {
    await seedReport('r1', users.worker, 'draft');
    await seedReport('r2', users.worker, 'approved');
    for (const id of ['r1', 'r2']) {
      await assertFails(
        updateDoc(doc(db(users.manager), 'reports', id), { status: 'manager_approved', managerReview: review(users.manager), updatedAt: serverTimestamp() }),
      );
    }
  });
});

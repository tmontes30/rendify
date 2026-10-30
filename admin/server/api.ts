import { Router, type NextFunction, type Request, type Response } from 'express';
import { FieldValue, Timestamp, type DocumentData } from 'firebase-admin/firestore';
import type { z } from 'zod';
import {
  CURRENCIES,
  CURRENCY_CODES,
  DEFAULT_AREAS,
  DEFAULT_CATEGORIES,
  isSpecialProfile,
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  type PaymentMethod,
  REMINDER_HOURS,
  DOC_TYPE_LABELS,
  STATUS_LABELS,
  companySchema,
  createUserSchema,
  decisionSchema,
  flowSchema,
  formatMoney,
  formatTotals,
  namedEntitySchema,
  reportFilterSchema,
  setPasswordSchema,
  sumTotals,
  updateUserSchema,
  type Currency,
  type Item,
  type Report,
  type Status,
  type Totals,
} from '@rendiciones/shared';
import { auth, config, db } from './firebase.js';

export const api = Router();

// ---------- Utilidades ----------
type Handler = (req: Request, res: Response) => Promise<unknown>;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join('.') || 'dato'}: ${i.message}`).join('; ');
    throw new HttpError(400, `Datos inválidos — ${msg}`);
  }
  return r.data;
}

function slugify(name: string) {
  return (
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50) || 'item'
  );
}

async function uniqueId(coll: FirebaseFirestore.CollectionReference, name: string) {
  const base = slugify(name);
  let id = base;
  for (let i = 2; (await coll.doc(id).get()).exists; i++) id = `${base}-${i}`;
  return id;
}

function tsToIso(v: unknown): string | null {
  return v instanceof Timestamp ? v.toDate().toISOString() : null;
}

function serializeReport(id: string, companyId: string, data: DocumentData) {
  const d = data as Omit<Report, 'id'>;
  return {
    ...d,
    id,
    companyId,
    createdAt: tsToIso(d.createdAt),
    updatedAt: tsToIso(d.updatedAt),
    submittedAt: tsToIso(d.submittedAt),
    decidedAt: tsToIso(d.decidedAt),
    paidAt: tsToIso(d.paidAt),
    ownerReview: d.ownerReview ? { ...d.ownerReview, at: tsToIso(d.ownerReview.at) } : null,
  };
}
type ReportOut = ReturnType<typeof serializeReport>;

const company = (cid: string) => db.collection('companies').doc(cid);

async function assertCompany(cid: string) {
  const c = await company(cid).get();
  if (!c.exists) throw new HttpError(404, 'Empresa no encontrada.');
  return c.data()!;
}

// Caché corta para no gastar lecturas de Firestore en cada recarga del panel.
const cache = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}
const invalidate = () => cache.clear();

const qCompany = (req: Request) =>
  typeof req.query.companyId === 'string' && req.query.companyId ? req.query.companyId : undefined;

// ---------- Sesión ----------
api.get('/session', (_req, res) => {
  res.json({ ok: true, emulator: !!process.env.FIRESTORE_EMULATOR_HOST, webUrl: config.webUrl });
});

// ---------- Empresas ----------
api.get(
  '/companies',
  h(async (_req, res) => {
    const [snap, users] = await Promise.all([db.collection('companies').orderBy('name').get(), db.collection('users').get()]);
    const counts = new Map<string, number>();
    for (const u of users.docs) if (u.data().active) counts.set(u.data().companyId, (counts.get(u.data().companyId) ?? 0) + 1);
    res.json(snap.docs.map((d) => ({ id: d.id, ...d.data(), createdAt: tsToIso(d.data().createdAt), suspendedAt: tsToIso(d.data().suspendedAt), resumedAt: tsToIso(d.data().resumedAt), activeUsers: counts.get(d.id) ?? 0 })));
  }),
);

api.post(
  '/companies',
  h(async (req, res) => {
    const body = parse(companySchema, req.body);
    const id = await uniqueId(db.collection('companies'), body.name);
    await company(id).set({ name: body.name, baseCurrency: body.baseCurrency, active: true, createdAt: FieldValue.serverTimestamp() });
    await seedDefaults(id);
    invalidate();
    res.status(201).json({ id });
  }),
);

api.patch(
  '/companies/:cid',
  h(async (req, res) => {
    const body = parse(companySchema.partial(), req.body);
    await assertCompany(req.params.cid);
    await company(req.params.cid).update({ ...body });
    invalidate();
    res.json({ ok: true });
  }),
);

/** Suspende el servicio de una empresa (p. ej. mensualidad impaga): sus usuarios pierden el acceso al instante. */
api.post(
  '/companies/:cid/suspend',
  h(async (req, res) => {
    await assertCompany(req.params.cid);
    const reason = String(req.body?.reason ?? '').trim().slice(0, 200);
    await company(req.params.cid).update({ active: false, suspendedAt: FieldValue.serverTimestamp(), suspendedReason: reason });
    invalidate();
    res.json({ ok: true });
  }),
);

/** Reactiva el servicio: todo vuelve a funcionar tal como estaba. */
api.post(
  '/companies/:cid/resume',
  h(async (req, res) => {
    await assertCompany(req.params.cid);
    await company(req.params.cid).update({ active: true, suspendedAt: FieldValue.delete(), suspendedReason: FieldValue.delete(), resumedAt: FieldValue.serverTimestamp() });
    invalidate();
    res.json({ ok: true });
  }),
);

/** Resumen de una empresa: personas, flujos, catálogos y rendiciones por estado. */
api.get(
  '/companies/:cid/summary',
  h(async (req, res) => {
    const cid = req.params.cid;
    await assertCompany(cid);
    const [users, flows, areas, categories, reports] = await Promise.all([
      db.collection('users').where('companyId', '==', cid).get(),
      company(cid).collection('flows').get(),
      company(cid).collection('areas').get(),
      company(cid).collection('categories').get(),
      company(cid).collection('reports').select('status', 'totals', 'updatedAt', 'currentApprovers').get(),
    ]);
    const active = users.docs.filter((u) => u.data().active);
    const byStatus: Record<string, { count: number; totals: Totals }> = {};
    let lastActivity: string | null = null;
    let waitingOwner = 0;
    for (const r of reports.docs) {
      const d = r.data();
      const s = (byStatus[d.status] ??= { count: 0, totals: {} });
      s.count++;
      for (const [c, v] of Object.entries((d.totals ?? {}) as Totals)) s.totals[c as Currency] = (s.totals[c as Currency] ?? 0) + (v ?? 0);
      const at = tsToIso(d.updatedAt);
      if (at && (!lastActivity || at > lastActivity)) lastActivity = at;
      if (d.status === 'pending' && !(d.currentApprovers ?? []).length) waitingOwner++;
    }
    res.json({
      users: {
        total: users.size,
        active: active.length,
        approvers: active.filter((u) => u.data().isApprover).length,
        withoutFlow: active.filter((u) => !u.data().flowId && !isSpecialProfile(u.data())).map((u) => u.data().displayName as string),
      },
      flows: flows.docs.map((f) => ({
        id: f.id,
        name: f.data().name as string,
        levels: (f.data().levels ?? []).length as number,
        users: active.filter((u) => u.data().flowId === f.id).length,
        hasPayer: !!f.data().payerUid,
      })),
      areas: { total: areas.size, active: areas.docs.filter((a) => a.data().active !== false).length },
      categories: { total: categories.size, active: categories.docs.filter((c) => c.data().active !== false).length },
      reports: { total: reports.size, byStatus, waitingOwner },
      lastActivity,
    });
  }),
);

/** Agrega las áreas y categorías base que falten (no toca las existentes). */
async function seedDefaults(cid: string) {
  let added = 0;
  for (const [coll, names] of [['areas', DEFAULT_AREAS], ['categories', DEFAULT_CATEGORIES]] as const) {
    const col = company(cid).collection(coll);
    const existing = new Set((await col.get()).docs.map((d) => slugify(d.data().name as string)));
    const batch = db.batch();
    for (const name of names) {
      const id = slugify(name);
      if (existing.has(id)) continue;
      batch.set(col.doc(id), { name, active: true }, { merge: true });
      added++;
    }
    await batch.commit();
  }
  return added;
}

api.post(
  '/companies/:cid/seed-defaults',
  h(async (req, res) => {
    await assertCompany(req.params.cid);
    const added = await seedDefaults(req.params.cid);
    invalidate();
    res.json({ added });
  }),
);

// ---------- Áreas y categorías (por empresa) ----------
for (const coll of ['areas', 'categories'] as const) {
  api.get(
    `/companies/:cid/${coll}`,
    h(async (req, res) => {
      const snap = await company(req.params.cid).collection(coll).orderBy('name').get();
      res.json(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    }),
  );

  api.post(
    `/companies/:cid/${coll}`,
    h(async (req, res) => {
      const body = parse(namedEntitySchema, req.body);
      await assertCompany(req.params.cid);
      const col = company(req.params.cid).collection(coll);
      const id = await uniqueId(col, body.name);
      await col.doc(id).set({ name: body.name, active: body.active ?? true });
      invalidate();
      res.status(201).json({ id });
    }),
  );

  api.patch(
    `/companies/:cid/${coll}/:id`,
    h(async (req, res) => {
      const body = parse(namedEntitySchema.partial(), req.body);
      const ref = company(req.params.cid).collection(coll).doc(req.params.id);
      if (!(await ref.get()).exists) throw new HttpError(404, 'No existe.');
      await ref.update({ ...body });
      invalidate();
      res.json({ ok: true });
    }),
  );
}

// ---------- Flujos de aprobación ----------
api.get(
  '/companies/:cid/flows',
  h(async (req, res) => {
    const snap = await company(req.params.cid).collection('flows').orderBy('name').get();
    res.json(snap.docs.map((d) => ({ id: d.id, ...d.data(), updatedAt: tsToIso(d.data().updatedAt) })));
  }),
);

async function buildFlow(cid: string, raw: unknown) {
  const body = parse(flowSchema, raw);
  const approverUids = [...new Set(body.levels.flatMap((l) => l.approvers))];
  // allApprovers = quienes pueden ver las rendiciones del flujo (aprobadores + quien paga).
  const uids = [...new Set([...approverUids, ...(body.payerUid ? [body.payerUid] : [])])];
  const snaps = await Promise.all(uids.map((u) => db.collection('users').doc(u).get()));
  const names: Record<string, string> = {};
  for (const s of snaps) {
    const d = s.data();
    if (!d || d.companyId !== cid) throw new HttpError(400, 'Los aprobadores y quien paga deben ser usuarios de esta empresa.');
    names[s.id] = d.displayName;
  }
  for (const s of snaps) {
    if (approverUids.includes(s.id) && isSpecialProfile(s.data())) {
      throw new HttpError(400, `${s.data()!.displayName} es usuario de pagos o administrador de personal: no puede ser aprobador.`);
    }
  }
  if (body.payerUid) {
    const p = snaps.find((x) => x.id === body.payerUid)?.data();
    if (!p?.paymentsUser) throw new HttpError(400, 'Quien paga debe tener marcada la casilla “Usuario de pagos”.');
  }
  return {
    name: body.name,
    // El primer nivel siempre se activa.
    levels: body.levels.map((l, i) => ({ name: l.name, minAmount: i === 0 ? 0 : l.minAmount, approvers: [...new Set(l.approvers)] })),
    payerUid: body.payerUid,
    allApprovers: uids,
    approverNames: names,
    updatedAt: FieldValue.serverTimestamp(),
  };
}

/**
 * Deja exactamente a `members` usando este flujo: los elegidos pasan a este flujo (aunque
 * estuvieran en otro) y quienes lo tenían y ya no están elegidos quedan sin flujo.
 */
async function applyMembers(cid: string, fid: string, members: string[] | undefined) {
  if (!members) return;
  const want = new Set(members);
  const users = await db.collection('users').where('companyId', '==', cid).get();
  const batch = db.batch();
  for (const u of users.docs) {
    const d = u.data();
    if (isSpecialProfile(d)) {
      if (d.flowId) batch.update(u.ref, { flowId: null });
    } else if (want.has(u.id) && d.flowId !== fid) batch.update(u.ref, { flowId: fid });
    else if (!want.has(u.id) && d.flowId === fid) batch.update(u.ref, { flowId: null });
  }
  await batch.commit();
}

/** Asigna este flujo a sus aprobadores que aún no tienen flujo. Devuelve cuántos. */
async function assignFlowToApprovers(cid: string, fid: string, approvers: string[]) {
  const snaps = await Promise.all(approvers.map((u) => db.collection('users').doc(u).get()));
  const batch = db.batch();
  let n = 0;
  for (const s of snaps) {
    if (s.exists && s.data()!.companyId === cid && !s.data()!.flowId && !isSpecialProfile(s.data())) {
      batch.update(s.ref, { flowId: fid });
      n++;
    }
  }
  await batch.commit();
  return n;
}

/**
 * Asegura que quien paga pueda ver las rendiciones ya enviadas del flujo (approverUids):
 * agrega al payer actual y quita a un payer anterior que ya no participa en el flujo.
 * Se ejecuta en cada guardado del flujo (idempotente).
 */
async function syncReportViewers(cid: string, fid: string, oldPayer: string | null, flow: { payerUid: string | null; allApprovers: string[] }) {
  const reports = await company(cid).collection('reports').where('flowId', '==', fid).get();
  let batch = db.batch();
  let n = 0;
  for (const r of reports.docs) {
    if (r.data().status === 'draft') continue;
    const before = (r.data().approverUids as string[]) ?? [];
    const viewers = new Set(before);
    if (oldPayer && oldPayer !== flow.payerUid && !flow.allApprovers.includes(oldPayer)) viewers.delete(oldPayer);
    if (flow.payerUid) viewers.add(flow.payerUid);
    if (viewers.size === before.length && before.every((u) => viewers.has(u))) continue;
    batch.update(r.ref, { approverUids: [...viewers] });
    if (++n % 400 === 0) {
      await batch.commit();
      batch = db.batch();
    }
  }
  await batch.commit();
  return n;
}

/** Marca isApprover en los usuarios de la empresa según los flujos vigentes. */
async function syncApprovers(cid: string) {
  const [flows, users] = await Promise.all([
    company(cid).collection('flows').get(),
    db.collection('users').where('companyId', '==', cid).get(),
  ]);
  const approvers = new Set(flows.docs.flatMap((f) => ((f.data().levels ?? []) as { approvers: string[] }[]).flatMap((l) => l.approvers)));
  const payers = new Set(flows.docs.map((f) => f.data().payerUid as string | null).filter(Boolean));
  const batch = db.batch();
  for (const u of users.docs) {
    const is = approvers.has(u.id);
    const pays = payers.has(u.id);
    if (u.data().isApprover !== is || !!u.data().isPayer !== pays) batch.update(u.ref, { isApprover: is, isPayer: pays });
  }
  await batch.commit();
}

api.post(
  '/companies/:cid/flows',
  h(async (req, res) => {
    await assertCompany(req.params.cid);
    const flow = await buildFlow(req.params.cid, req.body);
    const col = company(req.params.cid).collection('flows');
    const id = await uniqueId(col, flow.name);
    await col.doc(id).set(flow);
    const members = (req.body as { members?: string[] })?.members;
    await applyMembers(req.params.cid, id, members);
    // Si se eligieron los trabajadores explícitamente, se respeta esa elección tal cual.
    const assigned = members ? 0 : await assignFlowToApprovers(req.params.cid, id, flow.levels.flatMap((l) => l.approvers));
    await syncApprovers(req.params.cid);
    invalidate();
    res.status(201).json({ id, assigned });
  }),
);

api.put(
  '/companies/:cid/flows/:fid',
  h(async (req, res) => {
    const ref = company(req.params.cid).collection('flows').doc(req.params.fid);
    if (!(await ref.get()).exists) throw new HttpError(404, 'Flujo no encontrado.');
    const previous = (await ref.get()).data();
    const flow = await buildFlow(req.params.cid, req.body);
    await ref.set(flow);
    await syncReportViewers(req.params.cid, req.params.fid, previous?.payerUid ?? null, flow);
    const members = (req.body as { members?: string[] })?.members;
    await applyMembers(req.params.cid, req.params.fid, members);
    // Si se eligieron los trabajadores explícitamente, se respeta esa elección tal cual.
    const assigned = members ? 0 : await assignFlowToApprovers(req.params.cid, req.params.fid, flow.levels.flatMap((l) => l.approvers));
    await syncApprovers(req.params.cid);
    invalidate();
    res.json({ ok: true, assigned });
  }),
);

api.delete(
  '/companies/:cid/flows/:fid',
  h(async (req, res) => {
    const { cid, fid } = req.params;
    const inUse = await db.collection('users').where('companyId', '==', cid).where('flowId', '==', fid).limit(1).get();
    if (!inUse.empty) throw new HttpError(409, 'Hay usuarios asignados a este flujo. Cámbialos de flujo antes de eliminarlo.');
    const pending = await company(cid).collection('reports').where('flowId', '==', fid).where('status', '==', 'pending').limit(1).get();
    if (!pending.empty) throw new HttpError(409, 'Hay rendiciones en aprobación con este flujo.');
    await company(cid).collection('flows').doc(fid).delete();
    await syncApprovers(cid);
    invalidate();
    res.json({ ok: true });
  }),
);

// ---------- Usuarios ----------
async function assertRefs(cid: string, areaId?: string, flowId?: string | null) {
  if (areaId) {
    const a = await company(cid).collection('areas').doc(areaId).get();
    if (!a.exists || a.data()?.active === false) throw new HttpError(400, 'El área no existe o está inactiva.');
  }
  if (flowId) {
    const f = await company(cid).collection('flows').doc(flowId).get();
    if (!f.exists) throw new HttpError(400, 'El flujo no existe.');
  }
}

async function listAllAuthUsers() {
  const all = [];
  let pageToken: string | undefined;
  do {
    const page = await auth.listUsers(1000, pageToken);
    all.push(...page.users);
    pageToken = page.pageToken;
  } while (pageToken);
  return all;
}

api.get(
  '/users',
  h(async (req, res) => {
    const cid = qCompany(req);
    let q: FirebaseFirestore.Query = db.collection('users');
    if (cid) q = q.where('companyId', '==', cid);
    const [snap, authUsers] = await Promise.all([q.get(), listAllAuthUsers()]);
    const byUid = new Map(authUsers.map((u) => [u.uid, u]));
    const all = cid ? null : new Set(snap.docs.map((d) => d.id));
    const profiles = snap.docs.map((d) => {
      const a = byUid.get(d.id);
      return {
        uid: d.id,
        ...d.data(),
        createdAt: tsToIso(d.data().createdAt),
        disabled: a?.disabled ?? true,
        lastSignIn: a?.metadata.lastSignInTime ?? null,
      };
    });
    // Cuentas en Auth sin perfil (no tienen acceso): se muestran para poder deshabilitarlas.
    const orphans = all
      ? authUsers
          .filter((a) => !all.has(a.uid))
          .map((a) => ({ uid: a.uid, email: a.email ?? '', displayName: a.displayName ?? '', companyId: null, orphan: true, active: false, disabled: a.disabled, lastSignIn: a.metadata.lastSignInTime ?? null }))
      : [];
    res.json([...profiles, ...orphans]);
  }),
);

api.post(
  '/users',
  h(async (req, res) => {
    const body = parse(createUserSchema, req.body);
    await assertCompany(body.companyId);
    await assertRefs(body.companyId, body.areaId, body.flowId);
    const user = await auth.createUser({ email: body.email, password: body.password, displayName: body.displayName });
    try {
      await auth.setCustomUserClaims(user.uid, { companyId: body.companyId });
      await db.collection('users').doc(user.uid).set({
        email: body.email,
        displayName: body.displayName,
        companyId: body.companyId,
        areaId: body.areaId,
        flowId: body.paymentsUser || body.companyAdmin ? null : body.flowId,
        isApprover: false,
        paymentsUser: body.paymentsUser,
        companyAdmin: body.companyAdmin,
        active: true,
        createdAt: FieldValue.serverTimestamp(),
      });
    } catch (e) {
      await auth.deleteUser(user.uid).catch(() => undefined); // revertir
      throw e;
    }
    invalidate();
    res.status(201).json({ uid: user.uid });
  }),
);

/** Asigna empresa, área y flujo a una cuenta existente que no tiene perfil. */
api.post(
  '/users/:uid/profile',
  h(async (req, res) => {
    const body = parse(createUserSchema.omit({ email: true, password: true }), req.body);
    if ((await db.collection('users').doc(req.params.uid).get()).exists) throw new HttpError(409, 'Esta cuenta ya tiene perfil.');
    await assertCompany(body.companyId);
    await assertRefs(body.companyId, body.areaId, body.flowId);
    const user = await auth.getUser(req.params.uid);
    await auth.updateUser(user.uid, { displayName: body.displayName });
    await auth.setCustomUserClaims(user.uid, { companyId: body.companyId });
    await db.collection('users').doc(user.uid).set({
      email: user.email ?? '',
      displayName: body.displayName,
      companyId: body.companyId,
      areaId: body.areaId,
      flowId: body.flowId,
      isApprover: false,
      active: !user.disabled,
      createdAt: FieldValue.serverTimestamp(),
    });
    await auth.revokeRefreshTokens(user.uid); // fuerza a tomar la empresa nueva
    invalidate();
    res.json({ ok: true });
  }),
);

api.patch(
  '/users/:uid',
  h(async (req, res) => {
    const body = parse(updateUserSchema, req.body);
    const ref = db.collection('users').doc(req.params.uid);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpError(404, 'Usuario no encontrado.');
    const cid = snap.data()!.companyId as string;
    await assertRefs(cid, body.areaId, body.flowId);
    if (body.displayName) await auth.updateUser(req.params.uid, { displayName: body.displayName });
    const becomesSpecial = isSpecialProfile({ ...(snap.data() as { paymentsUser?: boolean; companyAdmin?: boolean }), ...body });
    await ref.update({ ...body, ...(becomesSpecial ? { flowId: null } : {}) });
    // Si cambió el nombre, actualizarlo en los flujos donde aprueba.
    if (body.displayName && snap.data()!.isApprover) {
      const flows = await company(cid).collection('flows').where('allApprovers', 'array-contains', req.params.uid).get();
      await Promise.all(flows.docs.map((f) => f.ref.update({ [`approverNames.${req.params.uid}`]: body.displayName })));
    }
    invalidate();
    res.json({ ok: true });
  }),
);

api.post(
  '/users/:uid/disable',
  h(async (req, res) => {
    const uid = req.params.uid;
    await auth.updateUser(uid, { disabled: true });
    await auth.revokeRefreshTokens(uid);
    const ref = db.collection('users').doc(uid);
    if ((await ref.get()).exists) await ref.update({ active: false });
    invalidate();
    res.json({ ok: true });
  }),
);

api.post(
  '/users/:uid/enable',
  h(async (req, res) => {
    const ref = db.collection('users').doc(req.params.uid);
    if (!(await ref.get()).exists) throw new HttpError(400, 'Esta cuenta no tiene perfil en ninguna empresa.');
    await auth.updateUser(req.params.uid, { disabled: false });
    await ref.update({ active: true });
    invalidate();
    res.json({ ok: true });
  }),
);

api.post(
  '/users/:uid/password',
  h(async (req, res) => {
    const body = parse(setPasswordSchema, req.body);
    await auth.updateUser(req.params.uid, { password: body.password });
    await auth.revokeRefreshTokens(req.params.uid);
    res.json({ ok: true });
  }),
);

api.post(
  '/users/:uid/reset-link',
  h(async (req, res) => {
    const user = await auth.getUser(req.params.uid);
    if (!user.email) throw new HttpError(400, 'El usuario no tiene correo.');
    res.json({ link: await auth.generatePasswordResetLink(user.email) });
  }),
);

// ---------- Rendiciones ----------
async function loadReports(cid: string | undefined, filter: z.infer<typeof reportFilterSchema>): Promise<ReportOut[]> {
  let q: FirebaseFirestore.Query = cid ? company(cid).collection('reports') : db.collectionGroup('reports');
  if (filter.status) q = q.where('status', '==', filter.status);
  if (filter.areaId) q = q.where('areaId', '==', filter.areaId);
  const snap = await q.get();
  return snap.docs
    .map((d) => serializeReport(d.id, d.ref.parent.parent!.id, d.data()))
    .filter((r) => (!filter.from || r.periodTo >= filter.from) && (!filter.to || r.periodFrom <= filter.to))
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}

api.get(
  '/reports',
  h(async (req, res) => {
    const filter = parse(reportFilterSchema, req.query);
    res.json(await loadReports(qCompany(req), filter));
  }),
);

const reportRef = (cid: string, id: string) => company(cid).collection('reports').doc(id);

async function loadItems(cid: string, reportId: string): Promise<Item[]> {
  const snap = await reportRef(cid, reportId).collection('items').orderBy('date').get();
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Item, 'id'>) }));
}

function totalsEqual(a: Totals, b: Totals) {
  return CURRENCY_CODES.every((c) => (a[c] ?? 0) === (b[c] ?? 0));
}

api.get(
  '/companies/:cid/reports/:id',
  h(async (req, res) => {
    const { cid, id } = req.params;
    const snap = await reportRef(cid, id).get();
    if (!snap.exists) throw new HttpError(404, 'Rendición no encontrada.');
    const report = serializeReport(snap.id, cid, snap.data()!);
    const [items, flow, attSnap] = await Promise.all([
      loadItems(cid, id),
      report.flowId ? company(cid).collection('flows').doc(report.flowId).get() : null,
      reportRef(cid, id).collection('attachments').get(),
    ]);
    const computed = sumTotals(items);
    const attachments = attSnap.docs
      .map((d) => ({ id: d.id, name: d.data().name as string, caption: (d.data().caption as string) ?? '', dataUrl: d.data().dataUrl as string, at: tsToIso(d.data().createdAt) }))
      .sort((x, y) => (x.at ?? '').localeCompare(y.at ?? ''));
    res.json({
      report,
      items,
      attachments,
      flow: flow?.exists ? { id: flow.id, ...flow.data() } : null,
      computedTotals: computed,
      totalsMismatch: !totalsEqual(computed, report.totals ?? {}),
    });
  }),
);

/** Mensaje predeterminado para avisar por correo (el owner lo copia y lo envía). */
api.get(
  '/companies/:cid/reports/:id/notify',
  h(async (req, res) => {
    const { cid, id } = req.params;
    const [snap, comp] = await Promise.all([reportRef(cid, id).get(), assertCompany(cid)]);
    if (!snap.exists) throw new HttpError(404, 'Rendición no encontrada.');
    const r = snap.data() as Report;
    const link = `${config.webUrl}#/r/${id}`;
    const total = formatTotals(r.totals);
    const flowData = r.flowId ? (await company(cid).collection('flows').doc(r.flowId).get()).data() : undefined;
    let toUids: string[];
    let subject: string;
    let lines: string[];
    if (req.query.to === 'payer') {
      if (!flowData?.payerUid) throw new HttpError(400, 'El flujo de esta rendición no tiene definido quién paga.');
      toUids = [flowData.payerUid as string];
      subject = `[${comp.name}] Rendición aprobada, pendiente de pago: ${r.title}`;
      lines = [
        'Hola,',
        '',
        `La rendición de ${r.ownerName} fue aprobada por completo y está lista para pago.`,
        '',
        `• Rendición: ${r.title}`,
        `• Período: ${r.periodFrom} al ${r.periodTo}`,
        `• Total a pagar: ${total} (${r.itemCount} gastos)`,
        ...((r.approvals ?? []).filter((a) => a.decision === 'approved').length
          ? [`• Aprobada por: ${[...new Set((r.approvals ?? []).filter((a) => a.decision === 'approved').map((a) => a.name))].join(', ')}`]
          : []),
        '',
        `Ver detalle: ${link}`,
        '',
        'Saludos.',
      ];
    } else if (r.status === 'pending') {
      const flow = flowData;
      const toOwner = !r.currentApprovers.length;
      const levelName = toOwner ? 'aprobación final de Administración' : flow?.levels?.[r.currentLevel]?.name ?? `Nivel ${r.currentLevel + 1}`;
      toUids = r.currentApprovers;
      subject = `[${comp.name}] Rendición pendiente de tu aprobación: ${r.title}`;
      lines = [
        'Hola,',
        '',
        `${r.ownerName} envió una rendición de gastos que requiere tu aprobación (${levelName}).`,
        '',
        `• Rendición: ${r.title}`,
        `• Período: ${r.periodFrom} al ${r.periodTo}`,
        `• Total: ${total} (${r.itemCount} gastos)`,
        '',
        `Revísala y apruébala o recházala aquí: ${link}`,
        '',
        'Saludos.',
      ];
    } else {
      toUids = [r.ownerUid];
      const lastComment = r.ownerReview?.comment || r.approvals?.[r.approvals.length - 1]?.comment || '';
      const what =
        r.status === 'rejected' ? 'fue rechazada' : r.status === 'approved' ? 'fue aprobada' : r.status === 'paid' ? 'fue pagada' : `está en estado "${STATUS_LABELS[r.status]}"`;
      subject = `[${comp.name}] Tu rendición ${what}: ${r.title}`;
      lines = [
        `Hola ${r.ownerName},`,
        '',
        `Tu rendición "${r.title}" (${total}) ${what}.`,
        ...(r.status === 'paid' && r.payment
          ? [
              '',
              `• Pago: ${PAYMENT_METHOD_LABELS[r.payment.method] ?? r.payment.method}${r.payment.reference ? ` · N° ${r.payment.reference}` : ''}`,
              `• Fecha de pago: ${r.payment.paidOn}`,
              ...(r.payment.comment ? [`• Comentario: ${r.payment.comment}`] : []),
            ]
          : []),
        ...(r.status === 'rejected' && lastComment ? ['', `Motivo: ${lastComment}`, '', 'Corrígela y vuelve a enviarla desde la plataforma.'] : []),
        '',
        `Ver rendición: ${link}`,
        '',
        'Saludos.',
      ];
    }
    const users = await Promise.all(toUids.map((u) => db.collection('users').doc(u).get()));
    const to = users.map((u) => u.data()?.email as string | undefined).filter((e): e is string => !!e);
    const names = users.map((u) => u.data()?.displayName as string | undefined).filter((n): n is string => !!n);
    res.json({ to, names, subject, body: lines.join('\n') });
  }),
);

/** Cambia el estado de una rendición dentro de una transacción (acciones del owner). */
async function transition(cid: string, id: string, allowedFrom: Status[], to: Status, extra: (items: Item[]) => Record<string, unknown>) {
  const ref = reportRef(cid, id);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpError(404, 'Rendición no encontrada.');
    const status = snap.data()!.status as Status;
    if (!allowedFrom.includes(status)) {
      throw new HttpError(409, `No se puede pasar de "${STATUS_LABELS[status]}" a "${STATUS_LABELS[to]}".`);
    }
    const itemsSnap = await tx.get(ref.collection('items'));
    const items = itemsSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Item, 'id'>) }));
    tx.update(ref, { ...extra(items), status: to, updatedAt: FieldValue.serverTimestamp() });
  });
  invalidate();
}

api.post(
  '/companies/:cid/reports/:id/approve',
  h(async (req, res) => {
    const { comment } = parse(decisionSchema, req.body ?? {});
    await transition(req.params.cid, req.params.id, ['pending'], 'approved', (items) => ({
      totals: sumTotals(items), // totales oficiales desde los gastos
      itemCount: items.length,
      currentApprovers: [],
      ownerReview: { at: FieldValue.serverTimestamp(), comment, decision: 'approved' },
    }));
    res.json({ ok: true });
  }),
);

api.post(
  '/companies/:cid/reports/:id/reject',
  h(async (req, res) => {
    const { comment } = parse(decisionSchema, req.body ?? {});
    if (!comment) throw new HttpError(400, 'Indica el motivo del rechazo.');
    await transition(req.params.cid, req.params.id, ['pending', 'approved'], 'rejected', () => ({
      currentApprovers: [],
      ownerReview: { at: FieldValue.serverTimestamp(), comment, decision: 'rejected' },
    }));
    res.json({ ok: true });
  }),
);

api.post(
  '/companies/:cid/reports/:id/pay',
  h(async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const method = PAYMENT_METHODS.includes(b.method as PaymentMethod) ? (b.method as PaymentMethod) : 'otro';
    await transition(req.params.cid, req.params.id, ['approved'], 'paid', (items) => ({
      totals: sumTotals(items),
      paidAt: FieldValue.serverTimestamp(),
      payment: {
        uid: 'owner',
        name: 'Administración',
        method,
        reference: String(b.reference ?? '').slice(0, 80),
        paidOn: /^\d{4}-\d{2}-\d{2}$/.test(String(b.paidOn)) ? String(b.paidOn) : new Date().toISOString().slice(0, 10),
        comment: String(b.comment ?? '').slice(0, 500),
      },
    }));
    res.json({ ok: true });
  }),
);

// ---------- Panel / estadísticas ----------
const COUNTED: Status[] = ['pending', 'approved', 'paid'];
const STATUS_ORDER: Status[] = ['pending', 'approved', 'paid', 'rejected', 'draft'];

interface ItemRow extends Item {
  companyId: string;
  reportId: string;
  report: Report;
}

async function loadAllItemRows(): Promise<ItemRow[]> {
  return cached('items', 60_000, async () => {
    const [reportsSnap, itemsSnap] = await Promise.all([db.collectionGroup('reports').get(), db.collectionGroup('items').get()]);
    const reports = new Map(reportsSnap.docs.map((d) => [d.ref.path, { id: d.id, ...d.data() } as Report]));
    const rows: ItemRow[] = [];
    for (const d of itemsSnap.docs) {
      const rRef = d.ref.parent.parent;
      const report = rRef ? reports.get(rRef.path) : undefined;
      if (!rRef || !report) continue;
      rows.push({ id: d.id, ...(d.data() as Omit<Item, 'id'>), companyId: rRef.parent.parent!.id, reportId: rRef.id, report });
    }
    return rows;
  });
}

function addTo(map: Map<string, Totals>, key: string, currency: Currency, amount: number) {
  const t = map.get(key) ?? {};
  t[currency] = (t[currency] ?? 0) + amount;
  map.set(key, t);
}

const toList = (m: Map<string, Totals>) => [...m.entries()].map(([key, totals]) => ({ key, totals }));

async function namesFor(sub: 'areas' | 'categories') {
  return cached(`names-${sub}`, 60_000, async () => {
    const snap = await db.collectionGroup(sub).get();
    return Object.fromEntries(snap.docs.map((d) => [`${d.ref.parent.parent!.id}/${d.id}`, d.data().name as string]));
  });
}

api.get(
  '/dashboard',
  h(async (req, res) => {
    const filter = parse(reportFilterSchema.pick({ from: true, to: true }), req.query);
    const cid = qCompany(req);
    const [rows, reportsAll, areaNames, catNames, companies, users] = await Promise.all([
      loadAllItemRows(),
      cached(`reports-${cid ?? 'all'}`, 60_000, () => loadReports(cid, {})),
      namesFor('areas'),
      namesFor('categories'),
      cached('companies', 60_000, async () => (await db.collection('companies').get()).docs.map((d) => ({ id: d.id, name: d.data().name as string }))),
      cached('usersLite', 60_000, async () =>
        (await db.collection('users').get()).docs.map((d) => ({
          id: d.id,
          name: d.data().displayName as string,
          active: !!d.data().active,
          companyId: d.data().companyId as string,
        })),
      ),
    ]);

    const inRange = rows.filter(
      (r) =>
        (!cid || r.companyId === cid) &&
        COUNTED.includes(r.report.status) &&
        (!filter.from || r.date >= filter.from) &&
        (!filter.to || r.date <= filter.to),
    );

    const byCompany = new Map<string, Totals>();
    const byArea = new Map<string, Totals>();
    const byMonth = new Map<string, Totals>();
    const byCategory = new Map<string, Totals>();
    const byUser = new Map<string, Totals>();
    const total: Totals = {};
    for (const r of inRange) {
      addTo(byCompany, r.companyId, r.currency, r.amount);
      addTo(byArea, `${r.companyId}/${r.report.areaId}`, r.currency, r.amount);
      addTo(byMonth, r.date.slice(0, 7), r.currency, r.amount);
      addTo(byCategory, `${r.companyId}/${r.categoryId}`, r.currency, r.amount);
      addTo(byUser, r.report.ownerUid, r.currency, r.amount);
      total[r.currency] = (total[r.currency] ?? 0) + r.amount;
    }

    const statusSummary = Object.fromEntries(
      STATUS_ORDER.map((s) => {
        const rs = reportsAll.filter((r) => r.status === s);
        const totals: Totals = {};
        for (const r of rs) for (const [c, v] of Object.entries(r.totals ?? {})) totals[c as Currency] = (totals[c as Currency] ?? 0) + (v as number);
        return [s, { count: rs.length, totals }];
      }),
    );

    const scopedUsers = users.filter((u) => !cid || u.companyId === cid);
    res.json({
      total,
      itemCount: inRange.length,
      statusSummary,
      byCompany: cid ? [] : toList(byCompany),
      byArea: toList(byArea),
      byMonth: toList(byMonth).sort((a, b) => a.key.localeCompare(b.key)),
      byCategory: toList(byCategory),
      byUser: toList(byUser),
      names: {
        companies: Object.fromEntries(companies.map((c) => [c.id, c.name])),
        areas: areaNames,
        categories: catNames,
        users: Object.fromEntries(users.map((u) => [u.id, u.name])),
      },
      usersCount: { total: scopedUsers.length, active: scopedUsers.filter((u) => u.active).length },
    });
  }),
);

// ---------- Exportar CSV ----------
function csvCell(v: unknown): string {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // evita inyección de fórmulas en Excel
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

api.get(
  '/export.csv',
  h(async (req, res) => {
    const filter = parse(reportFilterSchema, req.query);
    const cid = qCompany(req);
    const [rows, areaNames, catNames, companies] = await Promise.all([
      loadAllItemRows(),
      namesFor('areas'),
      namesFor('categories'),
      db.collection('companies').get(),
    ]);
    const compName = new Map(companies.docs.map((d) => [d.id, d.data().name as string]));
    const filtered = rows.filter(
      (r) =>
        (!cid || r.companyId === cid) &&
        (!filter.status || r.report.status === filter.status) &&
        (!filter.from || r.date >= filter.from) &&
        (!filter.to || r.date <= filter.to),
    );
    const header = ['Empresa', 'Rendición', 'Título', 'Estado', 'Trabajador', 'Área', 'Fecha gasto', 'Categoría', 'Descripción', 'Proveedor', 'Tipo doc.', 'N° doc.', 'Moneda', 'Monto'];
    const out = [header.map(csvCell).join(';')];
    for (const r of filtered.sort((a, b) => a.date.localeCompare(b.date))) {
      const dec = CURRENCIES[r.currency]?.decimals ?? 2;
      out.push(
        [
          compName.get(r.companyId) ?? r.companyId,
          r.reportId,
          r.report.title,
          STATUS_LABELS[r.report.status],
          r.report.ownerName,
          areaNames[`${r.companyId}/${r.report.areaId}`] ?? r.report.areaId,
          r.date,
          catNames[`${r.companyId}/${r.categoryId}`] ?? r.categoryId,
          r.description,
          r.vendor,
          DOC_TYPE_LABELS[r.docType] ?? r.docType,
          r.docNumber,
          r.currency,
          (r.amount / 10 ** dec).toFixed(dec).replace('.', ','),
        ]
          .map(csvCell)
          .join(';'),
      );
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="rendiciones.csv"');
    res.send('﻿' + out.join('\r\n'));
  }),
);

// ---------- Notificaciones (avisos por correo que el owner envía a mano) ----------
const HOUR = 3_600_000;
const ms = (v: unknown) => (v instanceof Timestamp ? v.toMillis() : 0);

interface NoticeItem {
  companyId: string;
  companyName: string;
  id: string;
  title: string;
  ownerName: string;
  total: string;
  levelName: string;
  to: string[];
  waitingHours: number;
  isReminder: boolean;
  missingPayer?: boolean;
}

/**
 * Calcula qué avisos están pendientes:
 *  - payer: rendición aprobada por completo y aún no se avisa a quien paga.
 *  - approvers: lleva más de REMINDER_HOURS en el nivel actual sin decisión
 *    (desde que llegó al nivel o desde el último aviso de ese nivel).
 *  - ownerTurn: rendiciones que esperan la aprobación del owner.
 */
async function computeNotices(onlyCid?: string) {
  // Las empresas suspendidas no generan avisos.
  const companies = (await db.collection('companies').get()).docs.filter((c) => (!onlyCid || c.id === onlyCid) && c.data().active !== false);
  const now = Date.now();
  const payer: NoticeItem[] = [];
  const paid: NoticeItem[] = [];
  const approvers: NoticeItem[] = [];
  const ownerTurn: NoticeItem[] = [];
  const userCache = new Map<string, string>();
  const nameOf = async (uid: string) => {
    if (!userCache.has(uid)) userCache.set(uid, ((await db.collection('users').doc(uid).get()).data()?.displayName as string) ?? uid);
    return userCache.get(uid)!;
  };

  for (const c of companies) {
    const [reports, flows] = await Promise.all([
      company(c.id).collection('reports').where('status', 'in', ['pending', 'approved', 'paid']).get(),
      company(c.id).collection('flows').get(),
    ]);
    const flowMap = new Map(flows.docs.map((f) => [f.id, f.data()]));
    for (const d of reports.docs) {
      const r = d.data() as Report;
      const flow = r.flowId ? flowMap.get(r.flowId) : undefined;
      const base = { companyId: c.id, companyName: c.data().name as string, id: d.id, title: r.title, ownerName: r.ownerName, total: formatTotals(r.totals) };
      const notice = r.lastNotice;

      if (r.status === 'paid') {
        // Pagada: avisar al trabajador (solo pagos de los últimos 30 días sin aviso posterior).
        const paidAt = ms(r.paidAt);
        if (now - paidAt > 30 * 24 * HOUR) continue;
        if (notice?.kind === 'paid' && ms(notice.at) >= paidAt) continue;
        const p = r.payment;
        paid.push({
          ...base,
          levelName: p ? `Pagó ${p.name}${p.reference ? ` · N° ${p.reference}` : ''}` : 'Pagada',
          to: [r.ownerName],
          waitingHours: Math.floor((now - paidAt) / HOUR),
          isReminder: false,
        });
        continue;
      }

      if (r.status === 'approved') {
        const approvedAt = Math.max(ms(r.decidedAt), ms(r.ownerReview?.at));
        const done = notice?.kind === 'payer' && ms(notice.at) >= approvedAt;
        if (done) continue;
        const payerUid = flow?.payerUid as string | undefined;
        payer.push({
          ...base,
          levelName: 'Aprobada por completo',
          to: payerUid ? [await nameOf(payerUid)] : [],
          waitingHours: Math.floor((now - approvedAt) / HOUR),
          isReminder: false,
          missingPayer: !payerUid,
        });
        continue;
      }

      // pending
      const since = Math.max(ms(r.submittedAt), ms(r.decidedAt));
      if (!r.currentApprovers.length) {
        ownerTurn.push({ ...base, levelName: 'Aprobación final (tú)', to: [], waitingHours: Math.floor((now - since) / HOUR), isReminder: false });
        continue;
      }
      const notifiedThisLevel = notice?.kind === 'approver' && notice.level === r.currentLevel && ms(notice.at) > since;
      const from = notifiedThisLevel ? ms(notice!.at) : since;
      if (now - from < REMINDER_HOURS * HOUR) continue;
      approvers.push({
        ...base,
        levelName: (flow?.levels?.[r.currentLevel]?.name as string) ?? `Nivel ${r.currentLevel + 1}`,
        to: await Promise.all(r.currentApprovers.map(nameOf)),
        waitingHours: Math.floor((now - since) / HOUR),
        isReminder: notifiedThisLevel,
      });
    }
  }
  const byWait = (a: NoticeItem, b: NoticeItem) => b.waitingHours - a.waitingHours;
  return { payer: payer.sort(byWait), approvers: approvers.sort(byWait), paid: paid.sort((a, b) => a.waitingHours - b.waitingHours), ownerTurn: ownerTurn.sort(byWait) };
}

api.get(
  '/notifications',
  h(async (req, res) => {
    res.json(await computeNotices(qCompany(req)));
  }),
);

api.get(
  '/notifications/count',
  h(async (req, res) => {
    const n = await cached(`notices-${qCompany(req) ?? 'all'}`, 30_000, () => computeNotices(qCompany(req)));
    const bill = await billingNotices(qCompany(req));
    res.json({ count: n.payer.length + n.approvers.length + n.paid.length + n.ownerTurn.length + bill.length });
  }),
);

/** El owner marca que ya envió el aviso (para que salga de la lista). */
api.post(
  '/companies/:cid/reports/:id/notified',
  h(async (req, res) => {
    const kind = req.body?.kind === 'payer' ? 'payer' : req.body?.kind === 'paid' ? 'paid' : 'approver';
    const ref = reportRef(req.params.cid, req.params.id);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpError(404, 'Rendición no encontrada.');
    await ref.update({ lastNotice: { kind, level: snap.data()!.currentLevel ?? 0, at: FieldValue.serverTimestamp() } });
    invalidate();
    res.json({ ok: true });
  }),
);

// ---------- Facturación del servicio (mensualidad de cada empresa) ----------
// Se guarda en billing/{cid}: colección sin reglas de acceso → solo el panel (Admin SDK) la lee.
const BILLING_WARN_DAYS = 5;
const billingRef = (cid: string) => db.collection('billing').doc(cid);

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysBetween(fromIso: string, toIso: string) {
  const a = Date.UTC(+fromIso.slice(0, 4), +fromIso.slice(5, 7) - 1, +fromIso.slice(8, 10));
  const b = Date.UTC(+toIso.slice(0, 4), +toIso.slice(5, 7) - 1, +toIso.slice(8, 10));
  return Math.round((b - a) / 86_400_000);
}

/** Mismo día del mes siguiente (si no existe, el último día de ese mes). */
function nextMonth(iso: string, day: number) {
  let y = +iso.slice(0, 4);
  let m = +iso.slice(5, 7) + 1;
  if (m > 12) {
    m = 1;
    y++;
  }
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
}

type BillingState = 'ok' | 'soon' | 'overdue' | 'none';

function billingStatus(b: DocumentData | undefined) {
  if (!b?.dueDate) return { state: 'none' as BillingState, daysLeft: null as number | null };
  const daysLeft = daysBetween(todayIso(), b.dueDate);
  const state: BillingState = daysLeft < 0 ? 'overdue' : daysLeft <= BILLING_WARN_DAYS ? 'soon' : 'ok';
  return { state, daysLeft };
}

function serializeBilling(b: DocumentData | undefined) {
  if (!b) return null;
  return {
    dueDate: (b.dueDate as string) ?? null,
    billingDay: (b.billingDay as number) ?? null,
    amount: (b.amount as number) ?? null,
    currency: (b.currency as string) ?? 'CLP',
    contactName: (b.contactName as string) ?? '',
    contactEmail: (b.contactEmail as string) ?? '',
    notes: (b.notes as string) ?? '',
    lastPaidAt: tsToIso(b.lastPaidAt),
    lastPaidFor: (b.lastPaidFor as string) ?? null,
    lastReminderAt: tsToIso(b.lastReminderAt),
    ...billingStatus(b),
  };
}

async function allBilling() {
  const snap = await db.collection('billing').get();
  return new Map(snap.docs.map((d) => [d.id, d.data()]));
}

api.get(
  '/billing',
  h(async (_req, res) => {
    const map = await allBilling();
    res.json(Object.fromEntries([...map.entries()].map(([cid, b]) => [cid, serializeBilling(b)])));
  }),
);

api.put(
  '/companies/:cid/billing',
  h(async (req, res) => {
    await assertCompany(req.params.cid);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const dueDate = String(b.dueDate ?? '');
    if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) throw new HttpError(400, 'Fecha de vencimiento inválida.');
    const email = String(b.contactEmail ?? '').trim().toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Correo de contacto inválido.');
    const amount = b.amount == null || b.amount === '' ? null : Number(b.amount);
    if (amount != null && (!Number.isInteger(amount) || amount < 0)) throw new HttpError(400, 'Monto inválido.');
    const currency = CURRENCY_CODES.includes(b.currency as Currency) ? (b.currency as Currency) : 'CLP';
    await billingRef(req.params.cid).set(
      {
        dueDate: dueDate || null,
        billingDay: dueDate ? +dueDate.slice(8, 10) : null,
        amount,
        currency,
        contactName: String(b.contactName ?? '').trim().slice(0, 100),
        contactEmail: email.slice(0, 200),
        notes: String(b.notes ?? '').trim().slice(0, 300),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    invalidate();
    res.json({ ok: true });
  }),
);

/** Registra que la empresa pagó la mensualidad: el vencimiento pasa al mes siguiente. */
api.post(
  '/companies/:cid/billing/paid',
  h(async (req, res) => {
    const ref = billingRef(req.params.cid);
    const b = (await ref.get()).data();
    if (!b?.dueDate) throw new HttpError(400, 'Primero define la fecha de vencimiento de la empresa.');
    const next = nextMonth(b.dueDate, b.billingDay ?? +String(b.dueDate).slice(8, 10));
    await ref.update({ lastPaidAt: FieldValue.serverTimestamp(), lastPaidFor: b.dueDate, dueDate: next, lastReminderAt: FieldValue.delete() });
    invalidate();
    res.json({ ok: true, dueDate: next });
  }),
);

api.post(
  '/companies/:cid/billing/reminded',
  h(async (req, res) => {
    await billingRef(req.params.cid).set({ lastReminderAt: FieldValue.serverTimestamp() }, { merge: true });
    invalidate();
    res.json({ ok: true });
  }),
);

/** Mensaje de recordatorio de pago para el contacto de la empresa. */
api.get(
  '/companies/:cid/billing/notify',
  h(async (req, res) => {
    const comp = await assertCompany(req.params.cid);
    const b = (await billingRef(req.params.cid).get()).data();
    if (!b?.dueDate) throw new HttpError(400, 'La empresa no tiene fecha de vencimiento.');
    const { daysLeft } = billingStatus(b);
    const due = String(b.dueDate);
    const fecha = `${due.slice(8, 10)}-${due.slice(5, 7)}-${due.slice(0, 4)}`;
    const monto = b.amount != null ? formatMoney(b.amount, b.currency ?? 'CLP') : null;
    const overdue = (daysLeft ?? 0) < 0;
    const subject = overdue
      ? `Mensualidad vencida — servicio de rendiciones (${comp.name})`
      : `Recordatorio: tu mensualidad vence el ${fecha} — servicio de rendiciones (${comp.name})`;
    const lines = [
      `Hola${b.contactName ? ` ${b.contactName}` : ''},`,
      '',
      overdue
        ? `Te recordamos que la mensualidad del servicio de rendición de gastos de ${comp.name} venció el ${fecha} (hace ${Math.abs(daysLeft ?? 0)} día(s)).`
        : `Te recordamos que la mensualidad del servicio de rendición de gastos de ${comp.name} vence el ${fecha} (${daysLeft === 0 ? 'hoy' : `en ${daysLeft} día(s)`}).`,
      ...(monto ? ['', `• Monto: ${monto}`] : []),
      '',
      overdue
        ? 'Para evitar la suspensión del servicio, por favor regulariza el pago a la brevedad.'
        : 'Por favor realiza el pago antes de esa fecha para mantener el servicio activo.',
      '',
      'Si ya realizaste el pago, ignora este mensaje.',
      '',
      'Saludos,',
      'Tomás Montes',
    ];
    res.json({ to: b.contactEmail ? [b.contactEmail] : [], names: b.contactName ? [b.contactName] : [], subject, body: lines.join('\n') });
  }),
);

/** Empresas con mensualidad por vencer (≤ 5 días) o vencida, para Notificaciones. */
async function billingNotices(onlyCid?: string) {
  const [companies, map] = await Promise.all([db.collection('companies').get(), allBilling()]);
  return companies.docs
    .filter((c) => !onlyCid || c.id === onlyCid)
    .map((c) => ({ c, b: serializeBilling(map.get(c.id)) }))
    .filter(({ b }) => b && (b.state === 'soon' || b.state === 'overdue'))
    .map(({ c, b }) => ({ companyId: c.id, companyName: c.data().name as string, active: c.data().active !== false, ...b! }))
    .sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0));
}

api.get(
  '/notifications/billing',
  h(async (req, res) => {
    res.json(await billingNotices(qCompany(req)));
  }),
);

// ---------- Insights: uso de la plataforma y pendientes críticos del owner ----------
const DAY = 86_400_000;

interface Alert {
  id: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail: string;
  count: number;
  page: string; // sección del panel donde se resuelve
  items?: string[];
}

/** Lunes (UTC) de la semana de un instante, como YYYY-MM-DD. */
function weekKey(t: number) {
  const d = new Date(t);
  const day = (d.getUTCDay() + 6) % 7;
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  return monday.toISOString().slice(0, 10);
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

api.get(
  '/insights',
  h(async (req, res) => {
    const onlyCid = qCompany(req);
    const now = Date.now();
    const [companiesSnap, usersSnap, authUsers, flowsSnap, reportsSnap, billingMap, notices, bills] = await Promise.all([
      db.collection('companies').get(),
      db.collection('users').get(),
      listAllAuthUsers(),
      db.collectionGroup('flows').get(),
      db.collectionGroup('reports').get(),
      allBilling(),
      computeNotices(onlyCid),
      billingNotices(onlyCid),
    ]);
    const companies = companiesSnap.docs.filter((c) => !onlyCid || c.id === onlyCid);
    const cids = new Set(companies.map((c) => c.id));
    const companyName = new Map(companiesSnap.docs.map((c) => [c.id, c.data().name as string]));
    const lastSignIn = new Map(authUsers.map((a) => [a.uid, a.metadata.lastSignInTime ? Date.parse(a.metadata.lastSignInTime) : 0]));
    const createdAtAuth = new Map(authUsers.map((a) => [a.uid, a.metadata.creationTime ? Date.parse(a.metadata.creationTime) : 0]));
    const users = usersSnap.docs.map((d) => ({ uid: d.id, ...(d.data() as Record<string, unknown>) }) as Record<string, any> & { uid: string });
    const scopedUsers = users.filter((u) => cids.has(u.companyId));
    const activeUsers = scopedUsers.filter((u) => u.active);
    const flows = flowsSnap.docs
      .map((f) => ({ id: f.id, cid: f.ref.parent.parent!.id, ...(f.data() as Record<string, any>) }) as Record<string, any> & { id: string; cid: string })
      .filter((f) => cids.has(f.cid));
    const reports = reportsSnap.docs
      .map((d) => ({ id: d.id, cid: d.ref.parent.parent!.id, ...(d.data() as Record<string, any>) }) as Record<string, any> & { id: string; cid: string })
      .filter((r) => cids.has(r.cid));
    const nameOf = (uid: string) => (users.find((u) => u.uid === uid)?.displayName as string) ?? uid;

    // ---- Pendientes críticos ----
    const alerts: Alert[] = [];
    const push = (a: Alert) => a.count > 0 && alerts.push(a);

    push({
      id: 'notices',
      severity: 'critical',
      title: 'Rendiciones: avisos por correo sin enviar',
      detail: `Sobre los gastos de los trabajadores: ${notices.payer.length} a quien paga · ${notices.approvers.length} a aprobadores (+24 h) · ${notices.paid.length} de pago a trabajadores`,
      count: notices.payer.length + notices.approvers.length + notices.paid.length,
      page: 'notificaciones',
      items: [
        ...notices.payer.map((n) => `💳 Avisar a ${n.to.join(', ') || 'quien paga (sin definir)'}: ${n.companyName} · ${n.title} de ${n.ownerName}`),
        ...notices.approvers.map((n) => `⏰ Avisar a ${n.to.join(' o ')}: ${n.companyName} · ${n.title} de ${n.ownerName}`),
        ...notices.paid.map((n) => `✅ Avisar a ${n.ownerName} que se pagó: ${n.companyName} · ${n.title}`),
      ],
    });
    push({
      id: 'ownerTurn',
      severity: 'critical',
      title: 'Rendiciones esperando TU aprobación',
      detail: 'Las envió el último nivel de su flujo.',
      count: notices.ownerTurn.length,
      page: 'rendiciones',
      items: notices.ownerTurn.map((n) => `${n.companyName}: ${n.title} (${n.ownerName})`),
    });
    const overdueBills = bills.filter((b) => b.state === 'overdue');
    push({
      id: 'billOverdue',
      severity: 'critical',
      title: 'Tu servicio: mensualidades vencidas',
      detail: 'Empresas clientes que no te han pagado. Cobra, registra el pago o suspende el servicio.',
      count: overdueBills.length,
      page: 'empresas',
      items: overdueBills.map((b) => `${b.companyName}: vencida hace ${-(b.daysLeft ?? 0)} día(s)${b.active ? '' : ' (suspendida)'}`),
    });
    const soonBills = bills.filter((b) => b.state === 'soon');
    push({
      id: 'billSoon',
      severity: 'warning',
      title: 'Tu servicio: mensualidades por vencer (≤ 5 días)',
      detail: 'Empresas clientes que deben pagarte pronto. Envía el recordatorio de cobro.',
      count: soonBills.length,
      page: 'notificaciones',
      items: soonBills.map((b) => `${b.companyName}: vence en ${b.daysLeft} día(s)`),
    });
    const specialUids = new Set(scopedUsers.filter((u) => u.paymentsUser || u.companyAdmin).map((u) => u.uid));
    const flowsSpecial = flows.flatMap((f) =>
      ((f.levels ?? []) as { name: string; approvers: string[] }[]).flatMap((l) =>
        l.approvers.filter((a) => specialUids.has(a)).map((a) => `${companyName.get(f.cid)}: “${f.name}” › ${l.name} → ${nameOf(a)}`),
      ),
    );
    push({
      id: 'flowSpecialApprover',
      severity: 'warning',
      title: 'Perfiles especiales como aprobadores',
      detail: 'Un usuario de pagos o administrador de personal figura como aprobador. Reemplázalo en el flujo o quítale ese perfil.',
      count: flowsSpecial.length,
      page: 'flujos',
      items: flowsSpecial,
    });
    const flowsNoPayer = flows.filter((f) => !f.payerUid);
    push({
      id: 'flowNoPayer',
      severity: 'warning',
      title: 'Flujos sin “quién paga”',
      detail: 'Nadie recibirá las rendiciones aprobadas para pagarlas.',
      count: flowsNoPayer.length,
      page: 'flujos',
      items: flowsNoPayer.map((f) => `${companyName.get(f.cid)}: ${f.name}`),
    });
    const payerUids = new Set(flows.map((f) => f.payerUid).filter(Boolean));
    const payUsersUnassigned = activeUsers.filter((u) => u.paymentsUser && !payerUids.has(u.uid));
    push({
      id: 'payUserUnassigned',
      severity: 'warning',
      title: 'Usuarios de pagos sin flujo asignado',
      detail: 'Tienen la casilla de pagos pero no son “quién paga” en ningún flujo: no verán nada.',
      count: payUsersUnassigned.length,
      page: 'flujos',
      items: payUsersUnassigned.map((u) => `${companyName.get(u.companyId)}: ${u.displayName}`),
    });
    const noFlow = activeUsers.filter((u) => !u.flowId && !u.paymentsUser && !u.companyAdmin);
    push({
      id: 'usersNoFlow',
      severity: 'warning',
      title: 'Personas sin flujo de aprobación',
      detail: 'No pueden enviar rendiciones.',
      count: noFlow.length,
      page: 'usuarios',
      items: noFlow.map((u) => `${companyName.get(u.companyId)}: ${u.displayName}`),
    });
    const companiesNoFlow = companies.filter((c) => c.data().active !== false && !flows.some((f) => f.cid === c.id));
    push({
      id: 'companyNoFlow',
      severity: 'warning',
      title: 'Empresas sin flujos de aprobación',
      detail: 'Nadie de la empresa puede enviar rendiciones.',
      count: companiesNoFlow.length,
      page: 'flujos',
      items: companiesNoFlow.map((c) => c.data().name as string),
    });
    const stuck = reports.filter((r) => r.status === 'pending' && now - Math.max(ms(r.submittedAt), ms(r.decidedAt)) > 3 * DAY);
    push({
      id: 'stuck',
      severity: 'warning',
      title: 'Rendiciones atascadas (+3 días en el mismo nivel)',
      detail: 'Considera escribir directamente al aprobador o aprobar tú.',
      count: stuck.length,
      page: 'rendiciones',
      items: stuck.map((r) => `${companyName.get(r.cid)}: ${r.title} (${r.ownerName}) · ${Math.floor((now - Math.max(ms(r.submittedAt), ms(r.decidedAt))) / DAY)} días`),
    });
    const unpaid = reports.filter((r) => r.status === 'approved' && now - Math.max(ms(r.decidedAt), ms(r.ownerReview?.at)) > 7 * DAY);
    push({
      id: 'unpaid',
      severity: 'warning',
      title: 'Aprobadas sin pagar hace más de 7 días',
      detail: 'Revisa con quien paga.',
      count: unpaid.length,
      page: 'rendiciones',
      items: unpaid.map((r) => `${companyName.get(r.cid)}: ${r.title} (${r.ownerName})`),
    });
    const noBilling = companies.filter((c) => !billingMap.get(c.id)?.dueDate);
    push({
      id: 'noBilling',
      severity: 'info',
      title: 'Tu servicio: empresas sin fecha de facturación',
      detail: 'Define el vencimiento de la mensualidad para recibir alertas de cobro.',
      count: noBilling.length,
      page: 'empresas',
      items: noBilling.map((c) => c.data().name as string),
    });
    const neverIn = activeUsers.filter((u) => !lastSignIn.get(u.uid) && now - (createdAtAuth.get(u.uid) ?? now) > 3 * DAY);
    push({
      id: 'neverIn',
      severity: 'info',
      title: 'Personas que nunca han ingresado (creadas hace +3 días)',
      detail: 'Puede que no recibieran su usuario y clave.',
      count: neverIn.length,
      page: 'usuarios',
      items: neverIn.map((u) => `${companyName.get(u.companyId)}: ${u.displayName} (${u.email})`),
    });
    if (!onlyCid) {
      const orphans = authUsers.filter((a) => !users.some((u) => u.uid === a.uid));
      push({
        id: 'orphans',
        severity: 'info',
        title: 'Cuentas sin empresa',
        detail: 'Existen en el login pero no tienen acceso. Asígnalas o deshabilítalas.',
        count: orphans.length,
        page: 'usuarios',
        items: orphans.map((a) => a.email ?? a.uid),
      });
    }
    const sevOrder = { critical: 0, warning: 1, info: 2 };
    alerts.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]);

    // ---- Uso ----
    const active7 = activeUsers.filter((u) => now - (lastSignIn.get(u.uid) ?? 0) < 7 * DAY).length;
    const active30 = activeUsers.filter((u) => now - (lastSignIn.get(u.uid) ?? 0) < 30 * DAY).length;
    const sent = reports.filter((r) => r.status !== 'draft');
    const sent30 = sent.filter((r) => now - ms(r.submittedAt) < 30 * DAY).length;

    // Tiempos: de envío a aprobación final, y de aprobación a pago (ronda actual).
    const approvalHours: number[] = [];
    const paymentHours: number[] = [];
    const perApprover = new Map<string, number[]>();
    for (const r of sent) {
      const sub = ms(r.submittedAt);
      const done = Math.max(ms(r.decidedAt), ms(r.ownerReview?.at));
      if (['approved', 'paid'].includes(r.status) && sub && done > sub) approvalHours.push((done - sub) / 3_600_000);
      if (r.status === 'paid' && ms(r.paidAt) && done) paymentHours.push((ms(r.paidAt) - done) / 3_600_000);
      // Tiempo de cada aprobador en la ronda actual (desde el evento anterior).
      const appr = (r.approvals ?? []) as { uid: string; decision: string; atMs: number }[];
      const rejIdx = appr.flatMap((a, i) => (a.decision === 'rejected' ? [i] : []));
      if (r.status === 'rejected') rejIdx.pop(); // el rechazo actual pertenece a esta ronda
      const start = rejIdx.length ? rejIdx[rejIdx.length - 1] + 1 : 0;
      let prev = sub;
      for (const a of appr.slice(start)) {
        if (prev && a.atMs > prev) {
          const arr = perApprover.get(a.uid) ?? [];
          arr.push((a.atMs - prev) / 3_600_000);
          perApprover.set(a.uid, arr);
        }
        prev = a.atMs;
      }
    }

    // Serie semanal (últimas 12 semanas) de rendiciones enviadas.
    const weeks: { week: string; sent: number }[] = [];
    for (let i = 11; i >= 0; i--) weeks.push({ week: weekKey(now - i * 7 * DAY), sent: 0 });
    for (const r of sent) {
      const k = weekKey(ms(r.submittedAt) || ms(r.createdAt));
      const w = weeks.find((x) => x.week === k);
      if (w) w.sent++;
    }

    // Por empresa
    const byCompany = companies.map((c) => {
      const us = activeUsers.filter((u) => u.companyId === c.id);
      const rs = reports.filter((r) => r.cid === c.id);
      const lastUse = Math.max(0, ...rs.map((r) => ms(r.updatedAt)), ...us.map((u) => lastSignIn.get(u.uid) ?? 0));
      return {
        companyId: c.id,
        name: c.data().name as string,
        active: c.data().active !== false,
        users: us.length,
        active30: us.filter((u) => now - (lastSignIn.get(u.uid) ?? 0) < 30 * DAY).length,
        reports30: rs.filter((r) => r.status !== 'draft' && now - ms(r.submittedAt) < 30 * DAY).length,
        reportsTotal: rs.filter((r) => r.status !== 'draft').length,
        pending: rs.filter((r) => r.status === 'pending').length,
        toPay: rs.filter((r) => r.status === 'approved').length,
        lastUse: lastUse ? new Date(lastUse).toISOString() : null,
      };
    });

    // Por usuario (los que más rinden y su actividad)
    const byUser = activeUsers
      .map((u) => {
        const rs = reports.filter((r) => r.ownerUid === u.uid && r.status !== 'draft');
        const decisions = reports.reduce((n, r) => n + ((r.approvals ?? []) as { uid: string }[]).filter((a) => a.uid === u.uid).length, 0);
        const paid = reports.filter((r) => r.payment?.uid === u.uid).length;
        const ls = lastSignIn.get(u.uid) ?? 0;
        return {
          uid: u.uid,
          name: u.displayName as string,
          company: companyName.get(u.companyId) ?? '',
          role: u.paymentsUser ? 'Pagos' : u.isApprover ? 'Aprobador' : 'Trabajador',
          reports: rs.length,
          reports30: rs.filter((r) => now - ms(r.submittedAt) < 30 * DAY).length,
          decisions,
          paid,
          lastSignIn: ls ? new Date(ls).toISOString() : null,
        };
      })
      .sort((a, b) => b.reports + b.decisions + b.paid - (a.reports + a.decisions + a.paid));

    const approverSpeed = [...perApprover.entries()]
      .map(([uid, hs]) => ({ uid, name: nameOf(uid), decisions: hs.length, avgHours: avg(hs)! }))
      .sort((a, b) => b.avgHours - a.avgHours);

    res.json({
      alerts,
      kpis: {
        users: activeUsers.length,
        active7,
        active30,
        companies: companies.length,
        companiesActive: companies.filter((c) => c.data().active !== false).length,
        sent30,
        sentTotal: sent.length,
        avgApprovalHours: avg(approvalHours),
        avgPaymentHours: avg(paymentHours),
      },
      weeks,
      byCompany,
      byUser,
      approverSpeed,
    });
  }),
);

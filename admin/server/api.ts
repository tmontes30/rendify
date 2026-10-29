import { Router, type NextFunction, type Request, type Response } from 'express';
import { FieldValue, Timestamp, type DocumentData } from 'firebase-admin/firestore';
import type { z } from 'zod';
import {
  CURRENCIES,
  CURRENCY_CODES,
  DEFAULT_AREAS,
  DEFAULT_CATEGORIES,
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
        withoutFlow: active.filter((u) => !u.data().flowId).map((u) => u.data().displayName as string),
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

/** Asigna este flujo a sus aprobadores que aún no tienen flujo. Devuelve cuántos. */
async function assignFlowToApprovers(cid: string, fid: string, approvers: string[]) {
  const snaps = await Promise.all(approvers.map((u) => db.collection('users').doc(u).get()));
  const batch = db.batch();
  let n = 0;
  for (const s of snaps) {
    if (s.exists && s.data()!.companyId === cid && !s.data()!.flowId) {
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
    const assigned = await assignFlowToApprovers(req.params.cid, id, flow.levels.flatMap((l) => l.approvers));
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
    const assigned = await assignFlowToApprovers(req.params.cid, req.params.fid, flow.levels.flatMap((l) => l.approvers));
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
        flowId: body.flowId,
        isApprover: false,
        paymentsUser: body.paymentsUser,
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
    await ref.update({ ...body });
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
    const [items, flow] = await Promise.all([
      loadItems(cid, id),
      report.flowId ? company(cid).collection('flows').doc(report.flowId).get() : null,
    ]);
    const computed = sumTotals(items);
    res.json({
      report,
      items,
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
    res.json({ count: n.payer.length + n.approvers.length + n.paid.length + n.ownerTurn.length });
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

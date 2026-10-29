import { Router, type NextFunction, type Request, type Response } from 'express';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import type { z } from 'zod';
import {
  CURRENCIES,
  CURRENCY_CODES,
  DOC_TYPE_LABELS,
  STATUS_LABELS,
  createUserSchema,
  decisionSchema,
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
import { auth, db } from './firebase.js';

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

function tsToIso(v: unknown): string | null {
  return v instanceof Timestamp ? v.toDate().toISOString() : null;
}

function serializeReport(id: string, data: FirebaseFirestore.DocumentData) {
  const d = data as Omit<Report, "id">;
  return {
    ...d,
    id,
    createdAt: tsToIso(d.createdAt),
    updatedAt: tsToIso(d.updatedAt),
    submittedAt: tsToIso(d.submittedAt),
    paidAt: tsToIso(d.paidAt),
    managerReview: d.managerReview ? { ...d.managerReview, at: tsToIso(d.managerReview.at) } : null,
    ownerReview: d.ownerReview ? { ...d.ownerReview, at: tsToIso(d.ownerReview.at) } : null,
  };
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

// ---------- Sesión ----------
api.get('/session', (_req, res) => {
  res.json({ ok: true, emulator: !!process.env.FIRESTORE_EMULATOR_HOST });
});

// ---------- Áreas y categorías ----------
for (const coll of ['areas', 'categories'] as const) {
  api.get(
    `/${coll}`,
    h(async (_req, res) => {
      const snap = await db.collection(coll).orderBy('name').get();
      res.json(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    }),
  );

  api.post(
    `/${coll}`,
    h(async (req, res) => {
      const body = parse(namedEntitySchema, req.body);
      const base = slugify(body.name);
      let id = base;
      for (let i = 2; (await db.collection(coll).doc(id).get()).exists; i++) id = `${base}-${i}`;
      await db.collection(coll).doc(id).set({ name: body.name, active: body.active ?? true });
      invalidate();
      res.status(201).json({ id });
    }),
  );

  api.patch(
    `/${coll}/:id`,
    h(async (req, res) => {
      const body = parse(namedEntitySchema.partial(), req.body);
      const ref = db.collection(coll).doc(req.params.id);
      if (!(await ref.get()).exists) throw new HttpError(404, 'No existe.');
      await ref.update({ ...body });
      invalidate();
      res.json({ ok: true });
    }),
  );
}

// ---------- Usuarios ----------
async function assertArea(areaId: string) {
  const a = await db.collection('areas').doc(areaId).get();
  if (!a.exists || a.data()?.active === false) throw new HttpError(400, 'El área no existe o está inactiva.');
}

api.get(
  '/users',
  h(async (_req, res) => {
    const [snap, authUsers] = await Promise.all([db.collection('users').get(), listAllAuthUsers()]);
    const byUid = new Map(authUsers.map((u) => [u.uid, u]));
    const profiles = snap.docs.map((d) => {
      const a = byUid.get(d.id);
      byUid.delete(d.id);
      return {
        uid: d.id,
        ...d.data(),
        createdAt: tsToIso(d.data().createdAt),
        disabled: a?.disabled ?? true,
        lastSignIn: a?.metadata.lastSignInTime ?? null,
        missingAuth: !a,
      };
    });
    // Cuentas que existen en Auth pero no tienen perfil (p.ej. alguien se autorregistró):
    // no tienen acceso, pero se muestran para que el owner pueda deshabilitarlas.
    const orphans = [...byUid.values()].map((a) => ({
      uid: a.uid,
      email: a.email ?? '',
      displayName: a.displayName ?? '',
      role: null,
      areaId: null,
      active: false,
      disabled: a.disabled,
      lastSignIn: a.metadata.lastSignInTime ?? null,
      orphan: true,
    }));
    res.json([...profiles, ...orphans]);
  }),
);

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

api.post(
  '/users',
  h(async (req, res) => {
    const body = parse(createUserSchema, req.body);
    await assertArea(body.areaId);
    const user = await auth.createUser({
      email: body.email,
      password: body.password,
      displayName: body.displayName,
      emailVerified: false,
      disabled: false,
    });
    try {
      await auth.setCustomUserClaims(user.uid, { role: body.role, areaId: body.areaId });
      await db.collection('users').doc(user.uid).set({
        email: body.email,
        displayName: body.displayName,
        role: body.role,
        areaId: body.areaId,
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

api.patch(
  '/users/:uid',
  h(async (req, res) => {
    const body = parse(updateUserSchema, req.body);
    const ref = db.collection('users').doc(req.params.uid);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpError(404, 'Usuario no encontrado.');
    const current = snap.data()!;
    if (body.areaId) await assertArea(body.areaId);
    const role = body.role ?? current.role;
    const areaId = body.areaId ?? current.areaId;
    await auth.setCustomUserClaims(req.params.uid, { role, areaId });
    if (body.displayName) await auth.updateUser(req.params.uid, { displayName: body.displayName });
    await ref.update({ ...body });
    invalidate();
    res.json({ ok: true });
  }),
);

/** Asigna un perfil a una cuenta de Auth que no lo tiene. */
api.post(
  '/users/:uid/profile',
  h(async (req, res) => {
    const body = parse(createUserSchema.omit({ password: true, email: true }), req.body);
    await assertArea(body.areaId);
    const user = await auth.getUser(req.params.uid);
    await auth.setCustomUserClaims(user.uid, { role: body.role, areaId: body.areaId });
    await db.collection('users').doc(user.uid).set({
      email: user.email ?? '',
      displayName: body.displayName,
      role: body.role,
      areaId: body.areaId,
      active: !user.disabled,
      createdAt: FieldValue.serverTimestamp(),
    });
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
    const uid = req.params.uid;
    const ref = db.collection('users').doc(uid);
    if (!(await ref.get()).exists) throw new HttpError(400, 'Asigna primero un rol y área a esta cuenta.');
    await auth.updateUser(uid, { disabled: false });
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
    const link = await auth.generatePasswordResetLink(user.email);
    res.json({ link });
  }),
);

// ---------- Rendiciones ----------
async function loadReports(filter: z.infer<typeof reportFilterSchema>) {
  let q: FirebaseFirestore.Query = db.collection('reports');
  if (filter.status) q = q.where('status', '==', filter.status);
  if (filter.areaId) q = q.where('areaId', '==', filter.areaId);
  const snap = await q.get();
  return snap.docs
    .map((d) => serializeReport(d.id, d.data()))
    .filter((r) => (!filter.from || r.periodTo >= filter.from) && (!filter.to || r.periodFrom <= filter.to))
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}

api.get(
  '/reports',
  h(async (req, res) => {
    const filter = parse(reportFilterSchema, req.query);
    res.json(await loadReports(filter));
  }),
);

async function loadItems(reportId: string): Promise<Item[]> {
  const snap = await db.collection('reports').doc(reportId).collection('items').orderBy('date').get();
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Item, 'id'>) }));
}

function totalsEqual(a: Totals, b: Totals) {
  return CURRENCY_CODES.every((c) => (a[c] ?? 0) === (b[c] ?? 0));
}

api.get(
  '/reports/:id',
  h(async (req, res) => {
    const snap = await db.collection('reports').doc(req.params.id).get();
    if (!snap.exists) throw new HttpError(404, 'Rendición no encontrada.');
    const report = serializeReport(snap.id, snap.data()!);
    const items = await loadItems(snap.id);
    const computed = sumTotals(items);
    const owner = await db.collection('users').doc(report.ownerUid).get();
    res.json({
      report,
      items,
      computedTotals: computed,
      totalsMismatch: !totalsEqual(computed, report.totals ?? {}),
      ownerRole: owner.data()?.role ?? null,
    });
  }),
);

/** Cambia el estado de una rendición dentro de una transacción. */
async function transition(
  id: string,
  allowedFrom: Status[],
  to: Status,
  extra: (items: Item[]) => Record<string, unknown>,
) {
  const ref = db.collection('reports').doc(id);
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
  '/reports/:id/approve',
  h(async (req, res) => {
    const { comment } = parse(decisionSchema, req.body ?? {});
    await transition(req.params.id, ['submitted', 'manager_approved'], 'approved', (items) => ({
      // Los totales oficiales se recalculan desde los ítems al aprobar.
      totals: sumTotals(items),
      itemCount: items.length,
      ownerReview: { at: FieldValue.serverTimestamp(), comment },
    }));
    res.json({ ok: true });
  }),
);

api.post(
  '/reports/:id/reject',
  h(async (req, res) => {
    const { comment } = parse(decisionSchema, req.body ?? {});
    if (!comment) throw new HttpError(400, 'Indica el motivo del rechazo.');
    await transition(req.params.id, ['submitted', 'manager_approved', 'approved'], 'rejected', () => ({
      ownerReview: { at: FieldValue.serverTimestamp(), comment },
    }));
    res.json({ ok: true });
  }),
);

api.post(
  '/reports/:id/pay',
  h(async (req, res) => {
    await transition(req.params.id, ['approved'], 'paid', () => ({ paidAt: FieldValue.serverTimestamp() }));
    res.json({ ok: true });
  }),
);

// ---------- Panel / estadísticas ----------
const COUNTED: Status[] = ['submitted', 'manager_approved', 'approved', 'paid'];

interface ItemRow extends Item {
  reportId: string;
  report: Report;
}

async function loadAllItemRows(): Promise<ItemRow[]> {
  return cached('items', 60_000, async () => {
    const [reportsSnap, itemsSnap] = await Promise.all([
      db.collection('reports').get(),
      db.collectionGroup('items').get(),
    ]);
    const reports = new Map(reportsSnap.docs.map((d) => [d.id, { id: d.id, ...d.data() } as Report]));
    const rows: ItemRow[] = [];
    for (const d of itemsSnap.docs) {
      const reportId = d.ref.parent.parent?.id;
      const report = reportId ? reports.get(reportId) : undefined;
      if (!reportId || !report) continue;
      rows.push({ id: d.id, ...(d.data() as Omit<Item, 'id'>), reportId, report });
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

api.get(
  '/dashboard',
  h(async (req, res) => {
    const filter = parse(reportFilterSchema.pick({ from: true, to: true }), req.query);
    const [rows, reportsAll, areas, categories, users] = await Promise.all([
      loadAllItemRows(),
      cached('reports', 60_000, () => loadReports({})),
      cached('areas', 60_000, async () => (await db.collection('areas').get()).docs.map((d) => ({ id: d.id, name: d.data().name as string }))),
      cached('categories', 60_000, async () =>
        (await db.collection('categories').get()).docs.map((d) => ({ id: d.id, name: d.data().name as string })),
      ),
      cached('usersLite', 60_000, async () =>
        (await db.collection('users').get()).docs.map((d) => ({ id: d.id, name: d.data().displayName as string, active: d.data().active as boolean })),
      ),
    ]);

    const inRange = rows.filter(
      (r) => COUNTED.includes(r.report.status) && (!filter.from || r.date >= filter.from) && (!filter.to || r.date <= filter.to),
    );

    const byArea = new Map<string, Totals>();
    const byMonth = new Map<string, Totals>();
    const byCategory = new Map<string, Totals>();
    const byUser = new Map<string, Totals>();
    const total: Totals = {};
    for (const r of inRange) {
      addTo(byArea, r.report.areaId, r.currency, r.amount);
      addTo(byMonth, r.date.slice(0, 7), r.currency, r.amount);
      addTo(byCategory, r.categoryId, r.currency, r.amount);
      addTo(byUser, r.report.ownerUid, r.currency, r.amount);
      total[r.currency] = (total[r.currency] ?? 0) + r.amount;
    }

    const statusSummary = Object.fromEntries(
      (['submitted', 'manager_approved', 'approved', 'paid', 'rejected', 'draft'] as Status[]).map((s) => {
        const rs = reportsAll.filter((r) => r.status === s);
        const totals: Totals = {};
        for (const r of rs) for (const [c, v] of Object.entries(r.totals ?? {})) totals[c as Currency] = (totals[c as Currency] ?? 0) + (v as number);
        return [s, { count: rs.length, totals }];
      }),
    );

    res.json({
      total,
      itemCount: inRange.length,
      statusSummary,
      byArea: toList(byArea),
      byMonth: toList(byMonth).sort((a, b) => a.key.localeCompare(b.key)),
      byCategory: toList(byCategory),
      byUser: toList(byUser),
      names: {
        areas: Object.fromEntries(areas.map((a) => [a.id, a.name])),
        categories: Object.fromEntries(categories.map((c) => [c.id, c.name])),
        users: Object.fromEntries(users.map((u) => [u.id, u.name])),
      },
      usersCount: { total: users.length, active: users.filter((u) => u.active).length },
    });
  }),
);

// ---------- Exportar CSV ----------
function csvCell(v: unknown): string {
  let s = v == null ? '' : String(v);
  // Evita inyección de fórmulas al abrir en Excel.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

api.get(
  '/export.csv',
  h(async (req, res) => {
    const filter = parse(reportFilterSchema, req.query);
    const [rows, areas, categories] = await Promise.all([
      loadAllItemRows(),
      db.collection('areas').get(),
      db.collection('categories').get(),
    ]);
    const areaName = new Map(areas.docs.map((d) => [d.id, d.data().name as string]));
    const catName = new Map(categories.docs.map((d) => [d.id, d.data().name as string]));
    const filtered = rows.filter(
      (r) =>
        (!filter.status || r.report.status === filter.status) &&
        (!filter.areaId || r.report.areaId === filter.areaId) &&
        (!filter.from || r.date >= filter.from) &&
        (!filter.to || r.date <= filter.to),
    );
    const header = [
      'Rendición', 'Título', 'Estado', 'Trabajador', 'Área', 'Fecha gasto', 'Categoría',
      'Descripción', 'Proveedor', 'Tipo doc.', 'N° doc.', 'Moneda', 'Monto',
    ];
    const lines = [header.map(csvCell).join(';')];
    for (const r of filtered.sort((a, b) => a.date.localeCompare(b.date))) {
      const dec = CURRENCIES[r.currency]?.decimals ?? 2;
      lines.push(
        [
          r.reportId, r.report.title, STATUS_LABELS[r.report.status], r.report.ownerName,
          areaName.get(r.report.areaId) ?? r.report.areaId, r.date, catName.get(r.categoryId) ?? r.categoryId,
          r.description, r.vendor, DOC_TYPE_LABELS[r.docType] ?? r.docType, r.docNumber, r.currency,
          (r.amount / 10 ** dec).toFixed(dec).replace('.', ','),
        ]
          .map(csvCell)
          .join(';'),
      );
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="rendiciones.csv"');
    res.send('﻿' + lines.join('\r\n'));
  }),
);

import { z } from 'zod';

// ---------- Roles ----------
export const ROLES = ['worker', 'manager'] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_LABELS: Record<Role, string> = {
  worker: 'Trabajador',
  manager: 'Jefe de área',
};

// ---------- Monedas ----------
// Si agregas una moneda aquí, agrégala también en firebase/firestore.rules (función currencies()).
export const CURRENCIES = {
  CLP: { name: 'Peso chileno', decimals: 0 },
  USD: { name: 'Dólar estadounidense', decimals: 2 },
  EUR: { name: 'Euro', decimals: 2 },
  ARS: { name: 'Peso argentino', decimals: 2 },
  PEN: { name: 'Sol peruano', decimals: 2 },
  BRL: { name: 'Real brasileño', decimals: 2 },
  MXN: { name: 'Peso mexicano', decimals: 2 },
  COP: { name: 'Peso colombiano', decimals: 2 },
} as const;
export type Currency = keyof typeof CURRENCIES;
export const CURRENCY_CODES = Object.keys(CURRENCIES) as Currency[];

/** Convierte texto ingresado por el usuario ("12.345,67" o "12345.67") a unidad mínima (entero). */
export function toMinor(input: string, currency: Currency): number | null {
  const decimals = CURRENCIES[currency].decimals;
  let s = input.trim().replace(/\s/g, '');
  if (!s) return null;
  // Acepta coma o punto como separador decimal: el último separador es el decimal
  // solo si le siguen exactamente 1..decimals dígitos.
  const lastSep = Math.max(s.lastIndexOf(','), s.lastIndexOf('.'));
  let intPart = s;
  let fracPart = '';
  if (lastSep >= 0) {
    const tail = s.slice(lastSep + 1);
    if (decimals > 0 && tail.length >= 1 && tail.length <= decimals) {
      intPart = s.slice(0, lastSep);
      fracPart = tail;
    }
  }
  intPart = intPart.replace(/[.,]/g, '');
  if (!/^\d+$/.test(intPart) || (fracPart && !/^\d+$/.test(fracPart))) return null;
  const value = Number(intPart) * 10 ** decimals + Number(fracPart.padEnd(decimals, '0') || 0);
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  return value;
}

export function formatMoney(minor: number, currency: Currency | string): string {
  const info = CURRENCIES[currency as Currency];
  const decimals = info?.decimals ?? 2;
  const amount = minor / 10 ** decimals;
  try {
    return new Intl.NumberFormat('es-CL', {
      style: 'currency',
      currency,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(decimals)}`;
  }
}

export type Totals = Partial<Record<Currency, number>>;

export function sumTotals(items: { amount: number; currency: Currency }[]): Totals {
  const totals: Totals = {};
  for (const it of items) totals[it.currency] = (totals[it.currency] ?? 0) + it.amount;
  return totals;
}

export function formatTotals(totals: Totals | undefined): string {
  const entries = Object.entries(totals ?? {}).filter(([, v]) => (v ?? 0) > 0);
  if (!entries.length) return '—';
  return entries.map(([c, v]) => formatMoney(v as number, c)).join(' · ');
}

// ---------- Estados de una rendición ----------
export const STATUSES = ['draft', 'submitted', 'manager_approved', 'approved', 'paid', 'rejected'] as const;
export type Status = (typeof STATUSES)[number];
export const STATUS_LABELS: Record<Status, string> = {
  draft: 'Borrador',
  submitted: 'Enviada al jefe',
  manager_approved: 'Aprobada por jefe',
  approved: 'Aprobada',
  paid: 'Pagada',
  rejected: 'Rechazada',
};
/** Estados en que el trabajador puede editar la rendición. */
export const EDITABLE_STATUSES: Status[] = ['draft', 'rejected'];

// ---------- Tipos de documento ----------
export const DOC_TYPES = ['boleta', 'factura', 'otro'] as const;
export type DocType = (typeof DOC_TYPES)[number];
export const DOC_TYPE_LABELS: Record<DocType, string> = {
  boleta: 'Boleta',
  factura: 'Factura',
  otro: 'Otro',
};

// ---------- Límites (deben coincidir con firestore.rules) ----------
export const LIMITS = {
  title: 120,
  name: 100,
  description: 500,
  vendor: 120,
  docNumber: 40,
  comment: 500,
  maxItems: 200,
} as const;

// ---------- Modelos ----------
export interface Area {
  id: string;
  name: string;
  active: boolean;
}

export interface Category {
  id: string;
  name: string;
  active: boolean;
}

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  role: Role;
  areaId: string;
  active: boolean;
}

export interface Review {
  uid?: string;
  name?: string;
  at: unknown; // Timestamp
  comment: string;
}

export interface Report {
  id: string;
  ownerUid: string;
  ownerName: string;
  areaId: string;
  title: string;
  periodFrom: string; // YYYY-MM-DD
  periodTo: string;
  status: Status;
  totals: Totals;
  itemCount: number;
  createdAt?: unknown;
  updatedAt?: unknown;
  submittedAt?: unknown;
  managerReview?: Review;
  ownerReview?: Review;
  paidAt?: unknown;
}

export interface Item {
  id: string;
  date: string; // YYYY-MM-DD
  categoryId: string;
  description: string;
  vendor: string;
  docType: DocType;
  docNumber: string;
  amount: number; // unidad mínima (entero)
  currency: Currency;
}

// ---------- Validaciones para la app de administración ----------
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const createUserSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  displayName: z.string().trim().min(1).max(LIMITS.name),
  role: z.enum(ROLES),
  areaId: z.string().min(1).max(64),
  password: z.string().min(10).max(100),
});

export const updateUserSchema = z.object({
  displayName: z.string().trim().min(1).max(LIMITS.name).optional(),
  role: z.enum(ROLES).optional(),
  areaId: z.string().min(1).max(64).optional(),
});

export const setPasswordSchema = z.object({ password: z.string().min(10).max(100) });

export const namedEntitySchema = z.object({
  name: z.string().trim().min(1).max(LIMITS.name),
  active: z.boolean().optional(),
});

export const decisionSchema = z.object({
  comment: z.string().trim().max(LIMITS.comment).default(''),
});

export const reportFilterSchema = z.object({
  status: z.enum(STATUSES).optional(),
  areaId: z.string().max(64).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

import { z } from 'zod';

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
  const s = input.trim().replace(/\s/g, '').replace(/^\$/, '');
  if (!s) return null;
  // El último separador es decimal solo si le siguen 1..decimals dígitos.
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

/** Unidad mínima → texto editable ("12345,5"). */
export function fromMinor(minor: number, currency: Currency): string {
  const d = CURRENCIES[currency].decimals;
  return (minor / 10 ** d).toString().replace('.', ',');
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

// ---------- Estados ----------
export const STATUSES = ['draft', 'pending', 'approved', 'paid', 'rejected'] as const;
export type Status = (typeof STATUSES)[number];
export const STATUS_LABELS: Record<Status, string> = {
  draft: 'Borrador',
  pending: 'En aprobación',
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
  maxLevels: 8,
  maxApproversPerLevel: 20,
} as const;

// ---------- Modelos ----------
export interface Company {
  id: string;
  name: string;
  active: boolean;
  baseCurrency: Currency;
}

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

export interface FlowLevel {
  name: string;
  /** Monto mínimo (unidad mínima, moneda base de la empresa) para que el nivel se active. 0 = siempre. */
  minAmount: number;
  approvers: string[]; // uids
}

export interface Flow {
  id: string;
  name: string;
  levels: FlowLevel[];
  allApprovers: string[];
  approverNames: Record<string, string>;
}

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  companyId: string;
  areaId: string;
  flowId: string | null;
  isApprover: boolean;
  active: boolean;
}

export interface Approval {
  level: number;
  levelName: string;
  uid: string;
  name: string;
  decision: 'approved' | 'rejected';
  comment: string;
  atMs: number;
}

export interface Report {
  id: string;
  ownerUid: string;
  ownerName: string;
  areaId: string;
  flowId: string | null;
  title: string;
  periodFrom: string; // YYYY-MM-DD
  periodTo: string;
  status: Status;
  totals: Totals;
  itemCount: number;
  currentLevel: number;
  currentApprovers: string[];
  approverUids: string[];
  approvals: Approval[];
  createdAt?: unknown;
  updatedAt?: unknown;
  submittedAt?: unknown;
  decidedAt?: unknown;
  ownerReview?: { at: unknown; comment: string; decision: string };
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

/**
 * Nivel siguiente que debe aprobar, o null si la rendición queda aprobada.
 * Un nivel con monto mínimo se activa si el total en moneda base lo alcanza,
 * o si la rendición tiene gastos en otras monedas (criterio conservador).
 */
export function nextRequiredLevel(
  levels: FlowLevel[],
  afterLevel: number,
  totals: Totals,
  baseCurrency: Currency,
): number | null {
  const hasForeign = Object.entries(totals).some(([c, v]) => c !== baseCurrency && (v ?? 0) > 0);
  const base = totals[baseCurrency] ?? 0;
  for (let i = afterLevel + 1; i < levels.length; i++) {
    const l = levels[i];
    if (!l.approvers.length) continue;
    if (l.minAmount <= 0 || hasForeign || base >= l.minAmount) return i;
  }
  return null;
}

// ---------- Validaciones para la app de administración ----------
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const id = z.string().min(1).max(64);

export const companySchema = z.object({
  name: z.string().trim().min(1).max(LIMITS.name),
  baseCurrency: z.enum(CURRENCY_CODES as [Currency, ...Currency[]]).default('CLP'),
  active: z.boolean().optional(),
});

export const createUserSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  displayName: z.string().trim().min(1).max(LIMITS.name),
  companyId: id,
  areaId: id,
  flowId: id.nullable().default(null),
  password: z.string().min(10).max(100),
});

export const updateUserSchema = z.object({
  displayName: z.string().trim().min(1).max(LIMITS.name).optional(),
  areaId: id.optional(),
  flowId: id.nullable().optional(),
});

export const setPasswordSchema = z.object({ password: z.string().min(10).max(100) });

export const namedEntitySchema = z.object({
  name: z.string().trim().min(1).max(LIMITS.name),
  active: z.boolean().optional(),
});

export const flowSchema = z.object({
  name: z.string().trim().min(1).max(LIMITS.name),
  levels: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(LIMITS.name),
        minAmount: z.number().int().min(0).max(1e13),
        approvers: z.array(id).min(1).max(LIMITS.maxApproversPerLevel),
      }),
    )
    .min(1)
    .max(LIMITS.maxLevels),
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

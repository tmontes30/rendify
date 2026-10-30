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

// ---------- Listas base para empresas nuevas ----------
export const DEFAULT_AREAS = [
  'Administración', 'Comercial', 'Finanzas', 'Gerencia', 'Logística', 'Marketing',
  'Operaciones', 'Proveedores', 'Recursos Humanos', 'TI', 'Ventas',
];

export const DEFAULT_CATEGORIES = [
  'Almuerzo', 'Alojamiento', 'Atención a clientes', 'Bencina', 'Capacitación', 'Courier y envíos',
  'Estacionamiento', 'Insumos', 'Materiales de oficina', 'Peajes', 'Software y suscripciones',
  'Telefonía e internet', 'Transporte', 'Viaje Trabajo', 'Otros',
];

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
  /** Quién paga las rendiciones aprobadas de este flujo (usuario de la empresa). */
  payerUid?: string | null;
  /**
   * Todas las personas con acceso de lectura a las rendiciones del flujo:
   * aprobadores de todos los niveles + quien paga. Se copia a report.approverUids.
   */
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
  /** Usuario de pagos: puede ser "quién paga" en un flujo y registrar pagos en la web. Lo marca el owner. */
  paymentsUser?: boolean;
  /** Administrador de personal: gestiona personas y flujos de su empresa desde la web. Lo marca el owner. */
  companyAdmin?: boolean;
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
  /** Datos del pago registrado por el usuario de pagos (o por el owner). */
  payment?: Payment;
  /** Último aviso por correo marcado por el owner (solo lo escribe el panel). */
  lastNotice?: { kind: 'approver' | 'payer' | 'paid'; level: number; at: unknown };
}

export const PAYMENT_METHODS = ['transferencia', 'efectivo', 'cheque', 'otro'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  transferencia: 'Transferencia',
  efectivo: 'Efectivo',
  cheque: 'Cheque',
  otro: 'Otro',
};

export interface Payment {
  uid: string;
  name: string;
  method: PaymentMethod;
  reference: string; // N° de comprobante / operación
  paidOn: string; // YYYY-MM-DD
  comment: string;
}

/** Foto de respaldo (imagen JPEG comprimida guardada en el documento). */
export interface Attachment {
  id: string;
  name: string;
  caption: string;
  dataUrl: string;
  size: number;
  uploadedBy: string;
  createdAt?: unknown;
}

export const MAX_ATTACHMENTS = 10;

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

/**
 * Nivel en que parte una rendición al enviarla. Si quien envía es aprobador
 * dentro de su propio flujo, parte en el nivel siguiente al más alto donde aparece
 * (nadie aprueba lo propio). Si es el último nivel, parte en levels.length:
 * sin aprobadores, la aprueba el owner.
 */
export function startLevel(levels: FlowLevel[], uid: string): number {
  for (let i = levels.length - 1; i >= 0; i--) if (levels[i].approvers.includes(uid)) return i + 1;
  return 0;
}

export interface Resubmission {
  /** Número de envío actual (1 = primer envío). */
  round: number;
  /** Último rechazo previo (por un aprobador o por administración). */
  lastRejection: { by: string; levelName: string; comment: string } | null;
}

/** Indica si la rendición fue rechazada antes y reenviada con corrección. */
export function resubmissionInfo(r: {
  approvals: Approval[];
  status: Status;
  ownerReview?: { comment: string; decision: string } | null;
}): Resubmission {
  const rejections = r.approvals.filter((a) => a.decision === 'rejected');
  const ownerRejected = r.ownerReview?.decision === 'rejected';
  const count = rejections.length + (ownerRejected ? 1 : 0);
  // Si está rechazada ahora, ese rechazo no cuenta como "previo".
  const previous = r.status === 'rejected' ? count - 1 : count;
  const last = rejections[rejections.length - 1];
  return {
    round: Math.max(previous, 0) + 1,
    lastRejection:
      previous <= 0
        ? null
        : ownerRejected && !last
          ? { by: 'Administración', levelName: 'Aprobación final', comment: r.ownerReview!.comment }
          : last
            ? { by: last.name, levelName: last.levelName, comment: last.comment }
            : null,
  };
}

/**
 * Arma los campos derivados de un flujo (lo usan el panel del owner y el administrador de personal):
 * allApprovers = aprobadores de todos los niveles + quien paga; approverNames = nombres para mostrar.
 */
export function flowDerived(levels: FlowLevel[], payerUid: string | null, names: Record<string, string>) {
  const approvers = [...new Set(levels.flatMap((l) => l.approvers))];
  const allApprovers = [...new Set([...approvers, ...(payerUid ? [payerUid] : [])])];
  const approverNames = Object.fromEntries(allApprovers.map((u) => [u, names[u] ?? '']));
  return {
    levels: levels.map((l, i) => ({ name: l.name, minAmount: i === 0 ? 0 : l.minAmount, approvers: [...new Set(l.approvers)] })),
    payerUid,
    allApprovers,
    approverNames,
  };
}

/** Horas que puede esperar una rendición en un nivel antes de avisar al aprobador. */
export const REMINDER_HOURS = 24;

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
  paymentsUser: z.boolean().default(false),
  companyAdmin: z.boolean().default(false),
  password: z.string().min(10).max(100),
});

export const updateUserSchema = z.object({
  displayName: z.string().trim().min(1).max(LIMITS.name).optional(),
  areaId: id.optional(),
  flowId: id.nullable().optional(),
  paymentsUser: z.boolean().optional(),
  companyAdmin: z.boolean().optional(),
});

export const setPasswordSchema = z.object({ password: z.string().min(10).max(100) });

export const namedEntitySchema = z.object({
  name: z.string().trim().min(1).max(LIMITS.name),
  active: z.boolean().optional(),
});

export const flowSchema = z.object({
  name: z.string().trim().min(1).max(LIMITS.name),
  payerUid: id.nullable().default(null),
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

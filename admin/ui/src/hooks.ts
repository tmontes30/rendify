import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from './api';
import type { Area, Category, Company, Flow } from '@rendiciones/shared';

export function useLoad<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const reload = useCallback(async () => {
    if (!path) {
      setData(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setData(await api.get<T>(path));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload };
}

export type CompanyRow = Company & { activeUsers: number };

interface CompanyCtx {
  companies: CompanyRow[];
  companyId: string; // '' = todas
  setCompanyId: (id: string) => void;
  reloadCompanies: () => Promise<void>;
  companyName: (id: string | null | undefined) => string;
  webUrl: string;
  /** Navega a otra sección del panel. */
  goTo: (page: string) => void;
}

export const CompanyContext = createContext<CompanyCtx | null>(null);

export function useCompany() {
  const c = useContext(CompanyContext);
  if (!c) throw new Error('Sin CompanyContext');
  return c;
}

/** Catálogos de una empresa (áreas, categorías, flujos). */
export function useCatalog(companyId: string | null | undefined) {
  const base = companyId ? `/companies/${companyId}` : null;
  const areas = useLoad<Area[]>(base && `${base}/areas`);
  const categories = useLoad<Category[]>(base && `${base}/categories`);
  const flows = useLoad<Flow[]>(base && `${base}/flows`);
  const areaName = (id: string | null | undefined) => areas.data?.find((a) => a.id === id)?.name ?? id ?? '—';
  const categoryName = (id: string) => categories.data?.find((c) => c.id === id)?.name ?? id;
  const flowName = (id: string | null | undefined) => (id ? flows.data?.find((f) => f.id === id)?.name ?? id : 'Sin flujo');
  return { areas, categories, flows, areaName, categoryName, flowName };
}

export function fmtDateTime(iso: string | null | undefined) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-CL', { dateStyle: 'short', timeStyle: 'short' });
}

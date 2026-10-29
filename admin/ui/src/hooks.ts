import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { Area, Category } from '@rendiciones/shared';

export function useLoad<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const reload = useCallback(async () => {
    if (!path) return;
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
  useEffect(() => { void reload(); }, [reload]);
  return { data, error, loading, reload };
}

export function useCatalog() {
  const areas = useLoad<Area[]>('/areas');
  const categories = useLoad<Category[]>('/categories');
  const areaName = (id: string | null | undefined) => areas.data?.find((a) => a.id === id)?.name ?? id ?? '—';
  const categoryName = (id: string) => categories.data?.find((c) => c.id === id)?.name ?? id;
  return { areas, categories, areaName, categoryName };
}

export function fmtDateTime(iso: string | null | undefined) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-CL', { dateStyle: 'short', timeStyle: 'short' });
}

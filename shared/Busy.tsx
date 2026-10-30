import { useEffect, useState, useSyncExternalStore } from 'react';
import { Logo } from './Logo';

/**
 * Indicador global de "la página está pensando": mientras haya algún proceso activo
 * (guardar, enviar, aprobar, cargar archivo…) se muestra el logo animado en el centro.
 */
let active = 0;
let message = '';
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const busy = {
  start(msg = 'Procesando…') {
    active++;
    message = msg;
    emit();
  },
  stop() {
    active = Math.max(0, active - 1);
    emit();
  },
  /** Ejecuta una tarea mostrando el indicador. */
  async run<T>(msg: string, fn: () => Promise<T>): Promise<T> {
    busy.start(msg);
    try {
      return await fn();
    } finally {
      busy.stop();
    }
  },
};

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const snapshot = () => (active > 0 ? message || 'Procesando…' : '');

/**
 * Reemplazo de `useState(false)` para estados "busy": además de deshabilitar botones,
 * muestra el indicador global mientras está en true.
 */
export function useGlobalBusy(msg = 'Guardando…'): [boolean, (v: boolean) => void] {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!on) return;
    busy.start(msg);
    return () => busy.stop();
  }, [on, msg]);
  return [on, setOn];
}

/** Capa con el logo animado; montar una vez en la app. Aparece tras 150 ms para evitar parpadeos. */
export function BusyOverlay({ variant = 'brand' }: { variant?: 'brand' | 'admin' }) {
  const msg = useSyncExternalStore(subscribe, snapshot);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!msg) return setVisible(false);
    const t = setTimeout(() => setVisible(true), 150);
    return () => clearTimeout(t);
  }, [msg]);
  if (!msg || !visible) return null;
  return (
    <div className="busy-overlay" role="status" aria-live="polite">
      <div className="busy-box">
        <LogoSpinner variant={variant} size={52} />
        <div className="busy-text">{msg}</div>
      </div>
    </div>
  );
}

/** Logo con animación de carga. */
export function LogoSpinner({ size = 40, variant = 'brand' }: { size?: number; variant?: 'brand' | 'admin' }) {
  return (
    <span className="logo-spinner" style={{ width: size + 16, height: size + 16 }}>
      <span className="logo-ring" />
      <span className="logo-pulse">
        <Logo size={size} variant={variant} />
      </span>
    </span>
  );
}

/** Reemplazo de los textos "Cargando…": logo animado + texto. */
export function LogoLoader({ text = 'Cargando…', variant = 'brand', page }: { text?: string; variant?: 'brand' | 'admin'; page?: boolean }) {
  return (
    <div className={page ? 'center-page' : 'logo-loader'}>
      <div className="logo-loader-inner">
        <LogoSpinner variant={variant} size={page ? 48 : 30} />
        <span className="muted small">{text}</span>
      </div>
    </div>
  );
}

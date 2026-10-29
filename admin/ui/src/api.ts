// Cliente de la API local. El token llega en el enlace (#t=...) al iniciar el servidor.
const KEY = 'admin-token';

function readToken(): string | null {
  const m = location.hash.match(/[#&]t=([a-f0-9]{64})/);
  if (m) {
    try { sessionStorage.setItem(KEY, m[1]); } catch { /* ignorar */ }
    history.replaceState(null, '', location.pathname + location.search);
    return m[1];
  }
  try { return sessionStorage.getItem(KEY); } catch { return null; }
}

let token = readToken();

export const hasToken = () => !!token;

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'x-admin-token': token ?? '', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = `Error ${res.status}`;
    try { msg = (await res.json()).error ?? msg; } catch { /* sin cuerpo */ }
    if (res.status === 401) token = null;
    throw new ApiError(res.status, msg);
  }
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
  async download(path: string, filename: string) {
    const res = await fetch(`/api${path}`, { headers: { 'x-admin-token': token ?? '' } });
    if (!res.ok) throw new ApiError(res.status, 'No se pudo exportar.');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  },
};

export function qs(params: Record<string, string | undefined>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}

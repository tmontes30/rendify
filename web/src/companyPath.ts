// Link por empresa: https://cavedevz.com/rendify/<empresa>/#/...
// (BASE_URL = '/rendify/' en producción; '/' en desarrollo).
const BASE = import.meta.env.BASE_URL;

/** Empresa indicada en la dirección (o '' si se entró por el link general). */
export function companyFromPath(): string {
  const path = location.pathname;
  const rest = path.startsWith(BASE) ? path.slice(BASE.length) : path.replace(/^\//, '');
  const slug = decodeURIComponent(rest.split('/')[0] || '').toLowerCase();
  return /^[a-z0-9-]{1,64}$/.test(slug) ? slug : '';
}

/** Deja la dirección en el link de la empresa del usuario, sin recargar la página. */
export function setCompanyPath(cid: string) {
  const want = `${BASE}${cid}/`;
  if (location.pathname !== want) history.replaceState(history.state, '', want + location.search + location.hash);
}

/** Link de ingreso de una empresa (para compartir). */
export function companyLink(cid: string) {
  return `${location.origin}${BASE}${cid}/`;
}

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { exec } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { args, config } from './firebase.js';
import { api } from './api.js';

const here = dirname(fileURLToPath(import.meta.url));
const uiDist = resolve(here, '../ui/dist');
const PORT = config.port;
const HOST = '127.0.0.1'; // solo accesible desde este PC
const devMode = args.has('--dev');

// Token de sesión aleatorio: cambia cada vez que se inicia el servidor.
// Evita que otras páginas web abiertas en tu navegador llamen a esta API.
const TOKEN = randomBytes(32).toString('hex');
const tokenBuf = Buffer.from(TOKEN);

const allowedHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
if (devMode) ['127.0.0.1:5174', 'localhost:5174'].forEach((h) => allowedHosts.add(h));
const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));

const app = express();
app.disable('x-powered-by');

// Protección contra DNS rebinding y peticiones desde otros orígenes.
app.use((req: Request, res: Response, next: NextFunction) => {
  const host = req.headers.host ?? '';
  if (!allowedHosts.has(host)) return res.status(403).send('Host no permitido');
  const origin = req.headers.origin;
  if (origin && !allowedOrigins.has(origin)) return res.status(403).send('Origen no permitido');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  next();
});

// Autenticación de la API con el token de sesión.
app.use('/api', (req: Request, res: Response, next: NextFunction) => {
  const given = Buffer.from(req.get('x-admin-token') ?? '');
  if (given.length !== tokenBuf.length || !timingSafeEqual(given, tokenBuf)) {
    return res.status(401).json({ error: 'Sesión inválida. Reinicia la app de administración y usa el enlace nuevo.' });
  }
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use('/api', express.json({ limit: '100kb' }), api);

if (existsSync(uiDist)) {
  app.use(express.static(uiDist, { index: 'index.html' }));
} else if (!devMode) {
  console.warn('[admin] No existe ui/dist. Ejecuta "npm run build:ui -w admin".');
}

// Manejo de errores: no exponer detalles internos.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const e = err as { status?: number; message?: string; code?: string };
  const status = e.status ?? 500;
  if (status >= 500) console.error('[admin] Error:', err);
  res.status(status).json({ error: status >= 500 ? mapFirebaseError(e) : e.message });
});

function mapFirebaseError(e: { code?: string; message?: string }): string {
  switch (e.code) {
    case 'auth/email-already-exists':
      return 'Ya existe un usuario con ese correo.';
    case 'auth/invalid-password':
      return 'La contraseña no es válida (mínimo 10 caracteres).';
    case 'auth/invalid-email':
      return 'Correo inválido.';
    case 'auth/user-not-found':
      return 'Usuario no encontrado.';
    default:
      return 'Error interno. Revisa la consola del servidor.';
  }
}

app.listen(PORT, HOST, () => {
  const uiPort = devMode ? 5174 : PORT;
  const url = `http://127.0.0.1:${uiPort}/#t=${TOKEN}`;
  console.log('\n==============================================');
  console.log(' App de administración (solo en este PC)');
  console.log(` Abre: ${url}`);
  console.log(' No compartas este enlace. Cierra con Ctrl+C.');
  console.log('==============================================\n');
  if (!args.has('--no-open')) openBrowser(url);
});

function openBrowser(url: string) {
  const cmd =
    process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => undefined);
}

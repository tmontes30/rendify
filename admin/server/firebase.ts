import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cert, initializeApp, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const here = dirname(fileURLToPath(import.meta.url));
const adminDir = resolve(here, '..');
const repoDir = resolve(adminDir, '..');

export interface LocalConfig {
  serviceAccountPath?: string;
  port: number;
}

export const args = new Set(process.argv.slice(2));
export const useEmulator = args.has('--emulator');
export const EMULATOR_PROJECT = 'demo-rendiciones';

function loadConfig(): LocalConfig {
  const file = resolve(adminDir, 'config.local.json');
  const cfg: LocalConfig = { port: 5050 };
  if (existsSync(file)) Object.assign(cfg, JSON.parse(readFileSync(file, 'utf8')));
  if (process.env.ADMIN_PORT) cfg.port = Number(process.env.ADMIN_PORT);
  return cfg;
}

export const config = loadConfig();

function isInside(child: string, parent: string) {
  const rel = relative(parent, child);
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
}

function initApp(): App {
  if (useEmulator) {
    process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080';
    process.env.FIREBASE_AUTH_EMULATOR_HOST ??= '127.0.0.1:9099';
    console.log(`[firebase] Usando EMULADORES (proyecto ${EMULATOR_PROJECT})`);
    return initializeApp({ projectId: EMULATOR_PROJECT });
  }

  const keyPath = config.serviceAccountPath ?? process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!keyPath || !existsSync(keyPath)) {
    console.error(
      '\n[firebase] No se encontró la clave de cuenta de servicio.\n' +
        '  1. Descárgala en Firebase Console > Configuración del proyecto > Cuentas de servicio.\n' +
        '  2. Guárdala FUERA de esta carpeta (y fuera de OneDrive).\n' +
        '  3. Copia admin/config.example.json a admin/config.local.json y pon la ruta.\n',
    );
    process.exit(1);
  }
  const abs = resolve(keyPath);
  if (isInside(abs, repoDir)) {
    console.error('[firebase] La clave está dentro del repositorio. Muévela fuera de la carpeta del proyecto.');
    process.exit(1);
  }
  if (/onedrive|dropbox|google drive/i.test(abs)) {
    console.warn('[firebase] ADVERTENCIA: la clave está en una carpeta sincronizada en la nube. Es más seguro moverla a una carpeta local.');
  }
  const sa = JSON.parse(readFileSync(abs, 'utf8'));
  console.log(`[firebase] Proyecto: ${sa.project_id}`);
  return initializeApp({ credential: cert(sa), projectId: sa.project_id });
}

export const app = initApp();
export const auth = getAuth(app);
export const db = getFirestore(app);

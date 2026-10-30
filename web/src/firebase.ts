import { initializeApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaV3Provider } from 'firebase/app-check';
import { connectAuthEmulator, getAuth } from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore';

const env = import.meta.env;

if (!env.VITE_FIREBASE_API_KEY || !env.VITE_FIREBASE_PROJECT_ID) {
  throw new Error('Falta la configuración de Firebase (variables VITE_FIREBASE_*).');
}

export const app = initializeApp({
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  appId: env.VITE_FIREBASE_APP_ID,
});

export const useEmulator = env.VITE_USE_EMULATOR === 'true';

// App Check (opcional): bloquea llamadas que no vengan de tu web.
if (env.VITE_RECAPTCHA_SITE_KEY && !useEmulator) {
  initializeAppCheck(app, {
    provider: new ReCaptchaV3Provider(env.VITE_RECAPTCHA_SITE_KEY),
    isTokenAutoRefreshEnabled: true,
  });
}

export const auth = getAuth(app);
auth.languageCode = 'es';
export const db = getFirestore(app);

if (useEmulator) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
}

// ---------- Creación de cuentas por el administrador de personal ----------
// Se usa una segunda instancia de Firebase para crear la cuenta: así el administrador
// no pierde su propia sesión (crear un usuario inicia sesión con él en esa instancia).
import { deleteUser, createUserWithEmailAndPassword, signOut as signOutAuth } from 'firebase/auth';
import { initializeApp as initApp, getApps } from 'firebase/app';

function secondaryAuth() {
  const existing = getApps().find((a) => a.name === 'account-creator');
  const second = existing ?? initApp(app.options, 'account-creator');
  const a = getAuth(second);
  if (useEmulator && !existing) connectAuthEmulator(a, 'http://127.0.0.1:9099', { disableWarnings: true });
  return a;
}

/**
 * Crea la cuenta de acceso y ejecuta `withUid` (p. ej. guardar el perfil). Si eso falla,
 * borra la cuenta recién creada para no dejar cuentas huérfanas.
 */
export async function createAccount(email: string, password: string, withUid: (uid: string) => Promise<void>) {
  const a = secondaryAuth();
  const cred = await createUserWithEmailAndPassword(a, email.trim().toLowerCase(), password);
  try {
    await withUid(cred.user.uid);
  } catch (e) {
    await deleteUser(cred.user).catch(() => undefined);
    throw e;
  } finally {
    await signOutAuth(a).catch(() => undefined);
  }
  return cred.user.uid;
}

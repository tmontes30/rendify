import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  browserLocalPersistence,
  browserSessionPersistence,
  onAuthStateChanged,
  sendPasswordResetEmail,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
  type User,
} from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import type { Company, Flow, UserProfile } from '@rendiciones/shared';
import { auth, db } from './firebase';

export interface Session {
  user: User;
  profile: UserProfile;
  company: Company;
  areaName: string;
  flow: Flow | null;
}

type AuthState =
  | { status: 'loading' }
  | { status: 'signedOut' }
  | { status: 'noAccess'; user: User }
  | { status: 'suspended'; user: User; companyName: string }
  | ({ status: 'ready' } & Session);

interface AuthCtx {
  state: AuthState;
  login: (email: string, password: string, remember: boolean) => Promise<void>;
  logout: () => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  /** Vuelve a leer el perfil (p. ej. tras cambiar el nombre). */
  refresh: () => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

type Loaded = Session | { suspended: string } | null;

async function loadSession(user: User): Promise<Loaded> {
  // Forzar token nuevo para tomar la empresa vigente asignada por el owner.
  const token = await user.getIdTokenResult(true);
  const companyId = token.claims.companyId as string | undefined;
  if (!companyId) return null;
  const snap = await getDoc(doc(db, 'users', user.uid));
  if (!snap.exists() || snap.data().active !== true || snap.data().companyId !== companyId) return null;
  const profile = { uid: user.uid, ...snap.data() } as UserProfile;
  // La empresa se lee primero: si el owner la suspendió, lo demás está bloqueado.
  const comp = await getDoc(doc(db, 'companies', companyId));
  if (!comp.exists()) return null;
  if (comp.data().active === false) return { suspended: (comp.data().name as string) ?? '' };
  const [area, flow] = await Promise.all([
    getDoc(doc(db, 'companies', companyId, 'areas', profile.areaId)),
    profile.flowId ? getDoc(doc(db, 'companies', companyId, 'flows', profile.flowId)) : Promise.resolve(null),
  ]);
  return {
    user,
    profile,
    company: { id: comp.id, ...(comp.data() as Omit<Company, 'id'>) },
    areaName: (area.data()?.name as string) ?? profile.areaId,
    flow: flow?.exists() ? ({ id: flow.id, ...flow.data() } as Flow) : null,
  };
}

function toState(user: User, s: Loaded): AuthState {
  if (!s) return { status: 'noAccess', user };
  if ('suspended' in s) return { status: 'suspended', user, companyName: s.suspended };
  return { status: 'ready', ...s };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  useEffect(() => {
    return onAuthStateChanged(auth, async (user) => {
      if (!user) return setState({ status: 'signedOut' });
      try {
        setState(toState(user, await loadSession(user)));
      } catch {
        // Permiso denegado = cuenta deshabilitada o sin perfil.
        setState({ status: 'noAccess', user });
      }
    });
  }, []);

  const value: AuthCtx = {
    state,
    async login(email, password, remember) {
      await setPersistence(auth, remember ? browserLocalPersistence : browserSessionPersistence);
      await signInWithEmailAndPassword(auth, email.trim(), password);
    },
    logout: () => signOut(auth),
    resetPassword: (email) => sendPasswordResetEmail(auth, email.trim()),
    async refresh() {
      const user = auth.currentUser;
      if (!user) return;
      setState(toState(user, await loadSession(user)));
    },
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth fuera de AuthProvider');
  return c;
}

/** Sesión del usuario ya autenticado (solo usar dentro de rutas protegidas). */
export function useSession(): Session {
  const { state } = useAuth();
  if (state.status !== 'ready') throw new Error('Sin sesión');
  return state;
}

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

type AuthState = { status: 'loading' } | { status: 'signedOut' } | { status: 'noAccess'; user: User } | ({ status: 'ready' } & Session);

interface AuthCtx {
  state: AuthState;
  login: (email: string, password: string, remember: boolean) => Promise<void>;
  logout: () => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

async function loadSession(user: User): Promise<Session | null> {
  // Forzar token nuevo para tomar la empresa vigente asignada por el owner.
  const token = await user.getIdTokenResult(true);
  const companyId = token.claims.companyId as string | undefined;
  if (!companyId) return null;
  const snap = await getDoc(doc(db, 'users', user.uid));
  if (!snap.exists() || snap.data().active !== true || snap.data().companyId !== companyId) return null;
  const profile = { uid: user.uid, ...snap.data() } as UserProfile;
  const [comp, area, flow] = await Promise.all([
    getDoc(doc(db, 'companies', companyId)),
    getDoc(doc(db, 'companies', companyId, 'areas', profile.areaId)),
    profile.flowId ? getDoc(doc(db, 'companies', companyId, 'flows', profile.flowId)) : Promise.resolve(null),
  ]);
  if (!comp.exists()) return null;
  return {
    user,
    profile,
    company: { id: comp.id, ...(comp.data() as Omit<Company, 'id'>) },
    areaName: (area.data()?.name as string) ?? profile.areaId,
    flow: flow?.exists() ? ({ id: flow.id, ...flow.data() } as Flow) : null,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  useEffect(() => {
    return onAuthStateChanged(auth, async (user) => {
      if (!user) return setState({ status: 'signedOut' });
      try {
        const s = await loadSession(user);
        setState(s ? { status: 'ready', ...s } : { status: 'noAccess', user });
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

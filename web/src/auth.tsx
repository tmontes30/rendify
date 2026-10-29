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
import type { Role, UserProfile } from '@rendiciones/shared';
import { auth, db } from './firebase';

type AuthState =
  | { status: 'loading' }
  | { status: 'signedOut' }
  | { status: 'noAccess'; user: User }
  | { status: 'ready'; user: User; profile: UserProfile; areaName: string };

interface AuthCtx {
  state: AuthState;
  login: (email: string, password: string, remember: boolean) => Promise<void>;
  logout: () => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  useEffect(() => {
    return onAuthStateChanged(auth, async (user) => {
      if (!user) return setState({ status: 'signedOut' });
      try {
        // Forzar token nuevo para tomar el rol/área vigentes asignados por el owner.
        const token = await user.getIdTokenResult(true);
        const role = token.claims.role as Role | undefined;
        const areaId = token.claims.areaId as string | undefined;
        if (!role || !areaId) return setState({ status: 'noAccess', user });
        const snap = await getDoc(doc(db, 'users', user.uid));
        if (!snap.exists() || snap.data().active !== true) return setState({ status: 'noAccess', user });
        const profile = { uid: user.uid, ...snap.data() } as UserProfile;
        const area = await getDoc(doc(db, 'areas', profile.areaId));
        setState({ status: 'ready', user, profile, areaName: (area.data()?.name as string) ?? profile.areaId });
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

/** Perfil del usuario ya autenticado (solo usar dentro de rutas protegidas). */
export function useProfile() {
  const { state } = useAuth();
  if (state.status !== 'ready') throw new Error('Sin sesión');
  return state;
}

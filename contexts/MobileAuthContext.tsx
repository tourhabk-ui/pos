'use client';

/**
 * MobileAuthContext — единый, cookie-based статус авторизации для мобильной
 * ветки главной страницы (Hero + bento-тайлы). Один fetch('/api/auth/me')
 * на всё дерево вместо дублирования в каждом компоненте.
 *
 * НЕ путать с contexts/AuthContext.tsx (useAuth) — тот завязан на
 * localStorage['user'] + Bearer-токен и не видит сессии, живущие только
 * в httpOnly-cookie auth_token. Здесь — тот же паттерн, что уже был в
 * MobileHeroDashboard (fetch без Authorization, полагается на cookie).
 */

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from 'react';

export type MobileAuthStatus = 'loading' | 'guest' | 'auth';

interface MobileAuthContextValue {
  status: MobileAuthStatus;
  userId: string | null;
  name: string | null;
  firstName: string | null;
  role: string | null;
  /** Форсировать повторную проверку (например, после логина в этой же вкладке) */
  refresh: () => void;
}

const MobileAuthContext = createContext<MobileAuthContextValue>({
  status: 'loading',
  userId: null,
  name: null,
  firstName: null,
  role: null,
  refresh: () => {},
});

interface MeResponse {
  success?: boolean;
  data?: { id?: string; name?: string | null; role?: string | null };
}

export function MobileAuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<MobileAuthStatus>('loading');
  const [userId, setUserId] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    fetch('/api/auth/me')
      .then(res => (res.ok ? res.json() : null))
      .then((json: MeResponse | null) => {
        if (cancelled) return;
        if (json?.success && json.data?.id) {
          setUserId(json.data.id);
          setName(json.data.name?.trim() || null);
          setRole(json.data.role ?? null);
          setStatus('auth');
        } else {
          setUserId(null);
          setName(null);
          setRole(null);
          setStatus('guest');
        }
      })
      .catch(() => {
        if (cancelled) return;
        setUserId(null);
        setName(null);
        setRole(null);
        setStatus('guest');
      });
    return () => { cancelled = true; };
  }, [nonce]);

  const refresh = useCallback(() => setNonce(n => n + 1), []);

  const firstName = name ? (name.split(' ')[0] || null) : null;

  const value: MobileAuthContextValue = { status, userId, name, firstName, role, refresh };
  return <MobileAuthContext.Provider value={value}>{children}</MobileAuthContext.Provider>;
}

export function useMobileAuth(): MobileAuthContextValue {
  return useContext(MobileAuthContext);
}

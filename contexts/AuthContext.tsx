'use client';

import React, { createContext, useContext, useState, useEffect } from 'react';

export interface User {
  id: string;
  email: string;
  name: string;
  avatar?: string;
  role: string;
  roles: string[];
  preferences: UserPreferences;
  createdAt: Date;
  updatedAt: Date;
  token?: string;
}

export interface UserPreferences {
  language: 'ru' | 'en';
  notifications: boolean;
  emergencyAlerts: boolean;
  locationSharing: boolean;
  theme: 'light' | 'dark' | 'system';
}

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, name: string) => Promise<void>;
  signOut: () => Promise<void>;
  updateUser: (updates: Partial<User>) => Promise<void>;
  updatePreferences: (preferences: Partial<UserPreferences>) => Promise<void>;
  /** Переключить активную роль. Возвращает путь кабинета новой роли для перехода. */
  switchRole: (role: string) => Promise<string>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

const defaultPreferences: UserPreferences = {
  language: 'ru',
  notifications: true,
  emergencyAlerts: true,
  locationSharing: false,
  theme: 'system'
};

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadUserFromStorage();
  }, []);

  // Auto-refresh token when it's about to expire (within 1 day)
  useEffect(() => {
    if (!user?.token) return;

    const checkAndRefresh = async () => {
      try {
        // Decode JWT payload (base64url) to read exp
        const parts = user.token!.split('.');
        if (parts.length !== 3) return;
        const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
        const exp = payload.exp as number | undefined;
        if (!exp) return;

        const now = Math.floor(Date.now() / 1000);
        const timeLeft = exp - now;
        const oneDayInSeconds = 86400;

        // Refresh if less than 1 day remaining
        if (timeLeft > 0 && timeLeft < oneDayInSeconds) {
          const response = await fetch('/api/auth/refresh', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${user.token}` },
          });
          if (response.ok) {
            const result = await response.json();
            if (result.success && result.token) {
              const updatedUser = { ...user, token: result.token };
              setUser(updatedUser);
              await saveUserToStorage(updatedUser);
            }
          }
        }
      } catch {
        // Silent fail — next check will retry
      }
    };

    checkAndRefresh();
    const interval = setInterval(checkAndRefresh, 30 * 60 * 1000); // every 30 min
    return () => clearInterval(interval);
  }, [user?.token]);

  const loadUserFromStorage = async () => {
    try {
      // Try to load from localStorage first
      const userData = localStorage.getItem('user');
      if (userData) {
        const parsedUser = JSON.parse(userData);
        parsedUser.createdAt = new Date(parsedUser.createdAt);
        parsedUser.updatedAt = new Date(parsedUser.updatedAt);
        parsedUser.preferences = { ...defaultPreferences, ...parsedUser.preferences };

        // Verify session with server
        try {
          const response = await fetch('/api/auth/me', {
            headers: {
              'Authorization': `Bearer ${parsedUser.token}`
            }
          });

          if (response.ok) {
            const result = await response.json();
            if (result.success) {
              result.data.token = parsedUser.token;
              setUser(result.data);

              return;
            }
          }
        } catch (err) {
        }

        // If verification failed, clear storage
        localStorage.removeItem('user');
      }

      // Fallback: сессия может жить только в httpOnly-cookie auth_token —
      // magic-link вход (ссылка из Telegram-бота) не пишет localStorage,
      // и раньше такой юзер был невидим для всех потребителей useAuth
      // (Protected выкидывал залогиненного на /auth/login). Запрос без
      // Authorization — сервер читает cookie (паттерн MobileAuthContext).
      await loadUserFromCookie();
    } catch (error) {
    } finally {
      setIsLoading(false);
    }
  };

  const loadUserFromCookie = async () => {
    try {
      const response = await fetch('/api/auth/me');
      if (!response.ok) return;
      const result = await response.json();
      if (!result.success || !result.data?.id) return;

      const cookieUser: User = {
        ...result.data,
        preferences: { ...defaultPreferences, ...result.data.preferences },
        createdAt: new Date(result.data.createdAt),
        updatedAt: new Date(result.data.updatedAt),
        // token намеренно undefined: cookie-only сессию рефрешит сервер,
        // и юзера НЕ пишем в localStorage['user'] — иначе следующая
        // загрузка пойдёт Bearer-веткой с пустым токеном.
      };
      setUser(cookieUser);

      // Паритет с signIn/signUp — AdminProtected читает user_roles
      if (Array.isArray(result.data.roles)) {
        localStorage.setItem('user_roles', JSON.stringify(result.data.roles));
      }
    } catch {
      // Нет сети/сессии — остаёмся гостем, как раньше
    }
  };

  const saveUserToStorage = async (userData: User | null) => {
    try {
      if (userData) {
        localStorage.setItem('user', JSON.stringify(userData));
      } else {
        localStorage.removeItem('user');
      }
    } catch (error) {
    }
  };

  const signIn = async (email: string, password: string) => {
    try {
      setIsLoading(true);
      const response = await fetch('/api/auth/signin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      const result = await response.json();
      
      if (!response.ok || !result.success) {
        throw new Error(result.error || 'Invalid credentials');
      }

      const userData = result.data;
      userData.preferences = { ...defaultPreferences, ...userData.preferences };
      userData.createdAt = new Date(userData.createdAt);
      userData.updatedAt = new Date(userData.updatedAt);
      
      setUser(userData);
      await saveUserToStorage(userData);
      
      // Also update roles in RoleContext
      if (typeof window !== 'undefined') {
        localStorage.setItem('user_roles', JSON.stringify(userData.roles));
      }
    } catch (error) {
      throw error;
    } finally {
      setIsLoading(false);
    }
  };

  const signUp = async (email: string, password: string, name: string) => {
    try {
      setIsLoading(true);
      const response = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, name }),
      });

      const result = await response.json();
      
      if (!response.ok || !result.success) {
        throw new Error(result.error || 'Registration failed');
      }

      const userData = result.data;
      userData.preferences = { ...defaultPreferences, ...userData.preferences };
      userData.createdAt = new Date(userData.createdAt);
      userData.updatedAt = new Date(userData.updatedAt);
      
      setUser(userData);
      await saveUserToStorage(userData);
      
      // Also update roles in RoleContext
      if (typeof window !== 'undefined') {
        localStorage.setItem('user_roles', JSON.stringify(userData.roles));
      }
    } catch (error) {
      throw error;
    } finally {
      setIsLoading(false);
    }
  };

  const signOut = async () => {
    try {
      setIsLoading(true);
      await fetch('/api/auth/signout', { method: 'POST' });
      setUser(null);
      await saveUserToStorage(null);
      
      // Clear roles in RoleContext
      if (typeof window !== 'undefined') {
        localStorage.removeItem('user_roles');
      }
    } catch (error) {
      throw error;
    } finally {
      setIsLoading(false);
    }
  };

  const updateUser = async (updates: Partial<User>) => {
    if (!user) return;
    
    try {
      const updatedUser = { 
        ...user, 
        ...updates, 
        updatedAt: new Date() 
      };
      setUser(updatedUser);
      await saveUserToStorage(updatedUser);
    } catch (error) {
      throw error;
    }
  };

  const switchRole = async (role: string): Promise<string> => {
    if (!user) throw new Error('Не авторизован');

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (user.token) headers['Authorization'] = `Bearer ${user.token}`;

    const response = await fetch('/api/auth/switch-role', {
      method: 'POST',
      headers,
      body: JSON.stringify({ role }),
    });
    const result = await response.json();
    if (!response.ok || !result.success) {
      throw new Error(result.error || 'Не удалось переключить роль');
    }

    const { role: newRole, roles, token, redirect } = result.data as {
      role: string; roles: string[]; token?: string; redirect: string;
    };

    const updatedUser: User = {
      ...user,
      role: newRole,
      roles,
      // Bearer-сессия получает новый токен; cookie-only сессия — undefined (её
      // рефрешит сервер по обновлённой cookie).
      token: token ?? user.token,
      updatedAt: new Date(),
    };
    setUser(updatedUser);
    // В localStorage['user'] пишем только Bearer-сессию (как в signIn) —
    // cookie-only не сохраняем, иначе загрузка пойдёт Bearer-веткой с пустым токеном.
    if (token) await saveUserToStorage(updatedUser);
    if (typeof window !== 'undefined') {
      localStorage.setItem('user_roles', JSON.stringify(roles));
    }
    return redirect;
  };

  const updatePreferences = async (preferences: Partial<UserPreferences>) => {
    if (!user) return;
    
    try {
      const updatedUser = {
        ...user,
        preferences: { ...user.preferences, ...preferences },
        updatedAt: new Date()
      };
      setUser(updatedUser);
      await saveUserToStorage(updatedUser);
    } catch (error) {
      throw error;
    }
  };

  const value: AuthContextType = {
    user,
    isLoading,
    signIn,
    signUp,
    signOut,
    updateUser,
    updatePreferences,
    switchRole,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};

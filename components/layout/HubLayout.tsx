'use client';

import { type ReactNode, useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { type LucideIcon } from 'lucide-react';
import { HubSidebar } from './HubSidebar';
import { useAuth } from '@/contexts/AuthContext';
import Link from 'next/link';
import { Sun, Moon, User } from 'lucide-react';
import { useTheme } from '@/contexts/ThemeContext';
import Logo from '@/components/shared/Logo';
import { ROLE_HUB } from '@/lib/auth/role-routes';
import { RoleSwitcher } from './RoleSwitcher';
import BottomNav from '@/components/shared/BottomNav';
import EmergencyAction from '@/components/shared/EmergencyAction';

interface SidebarItem {
  href: string;
  label: string;
  icon: LucideIcon;
  section?: string;
}

interface HubLayoutProps {
  children: ReactNode;
  sidebarItems: SidebarItem[];
  sidebarTitle: string;
  /** Роль(и), необходимые для доступа. Неавторизованные → /auth/login, чужая роль → свой хаб. */
  requiredRole: string | string[];
}

export function HubLayout({ children, sidebarItems, sidebarTitle, requiredRole }: HubLayoutProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { user, isLoading } = useAuth();
  const { isDark, toggleTheme } = useTheme();

  // Гибрид-оболочка (решение владельца 01.08): ТУРИСТ — потребитель, его
  // кабинет должен ощущаться продолжением приложения, а не отдельным
  // back-office-миром. На мобиле кабинет туриста получает платформенный
  // BottomNav (Дом/Карта/Кузьмич/Поездки/На маршруте всегда видны, «Поездки»
  // подсвечена внутри всего кабинета), чтобы «Поездки» перестала быть
  // дверью в один конец. Оператор/админ/гид — back-office: у них сайдбар без
  // нижнего бара, тут ничего не меняется.
  const isTourist = (Array.isArray(requiredRole) ? requiredRole : [requiredRole]).includes('tourist');

  useEffect(() => {
    if (isLoading) return;

    if (!user) {
      const from = typeof window !== 'undefined' ? window.location.pathname : '';
      router.replace(`/auth/login${from ? `?from=${encodeURIComponent(from)}` : ''}`);
      return;
    }

    const allowed = Array.isArray(requiredRole) ? requiredRole : [requiredRole];
    const userRoles: string[] = user.roles?.length ? user.roles : [user.role];

    if (!userRoles.some(r => allowed.includes(r))) {
      const myHub = ROLE_HUB[user.role] ?? ROLE_HUB[userRoles[0]] ?? '/';
      router.replace(myHub);
    }
  }, [isLoading, user, requiredRole, router]);

  if (isLoading || !user) {
    return (
      <div className="min-h-screen bg-[var(--bg-primary)] flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 rounded-full border-2 border-[var(--accent)] border-t-transparent animate-spin" />
          <p className="text-sm text-[var(--text-secondary)]">Проверка доступа…</p>
        </div>
      </div>
    );
  }

  const allowed = Array.isArray(requiredRole) ? requiredRole : [requiredRole];
  const userRoles: string[] = user.roles?.length ? user.roles : [user.role];
  if (!userRoles.some(r => allowed.includes(r))) return null;

  return (
    <div className="flex flex-col min-h-screen">
      {/* Header */}
      <header className="sticky top-0 z-40 bg-[var(--bg-card)] border-b border-[var(--border)]">
        <div className="max-w-full px-4 py-3 flex items-center justify-between">
          <Link href="/" style={{ textDecoration: 'none', display: 'flex', alignItems: 'center' }}>
            <Logo size={28} />
          </Link>
          <h1 className="text-lg font-bold text-[var(--text-primary)] hidden sm:block" style={{ fontFamily: 'var(--font-playfair)' }}>
            {sidebarTitle}
          </h1>
          <div className="flex items-center gap-3">
            <RoleSwitcher />
            {/* SOS в шапке — обязателен на экране с app-навигацией (§2, #887).
                Турист-кабинет теперь несёт BottomNav, значит и SOS: он
                потребитель в поле, а не оператор за столом. Для back-office
                (оператор/админ) бара нет и SOS в шапке не навязываем. */}
            {isTourist && <EmergencyAction />}
            <button onClick={toggleTheme} className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors" aria-label="Переключить тему">
              {isDark ? <Sun size={20} /> : <Moon size={20} />}
            </button>
            <Link href="/profile" className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors" aria-label="Личный кабинет">
              <User size={20} />
            </Link>
          </div>
        </div>
      </header>

      {/* Main content */}
      <div className="flex flex-col md:flex-row flex-1">
        <HubSidebar items={sidebarItems} title={sidebarTitle} />
        {/* Запас снизу под фиксированный BottomNav только у туриста на мобиле —
            иначе последний блок страницы прятался бы за баром. */}
        <div className={`flex-1 overflow-auto${isTourist ? ' pb-24 md:pb-0' : ''}`}>
          {children}
        </div>
      </div>

      {/* Платформенный нижний бар — только турист, только мобайл. «Поездки»
          подсвечена на всём /hub/tourist/*: кабинет живёт под этой вкладкой. */}
      {isTourist && (
        <BottomNav activePath={pathname?.startsWith('/hub/tourist') ? '/hub/tourist/trips' : (pathname ?? '')} />
      )}
    </div>
  );
}

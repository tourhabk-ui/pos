'use client';

import { Sun, Moon, User } from 'lucide-react';
import { useTheme } from '@/contexts/ThemeContext';
import Logo from '@/components/shared/Logo';
import Link from 'next/link';

interface PageShellProps {
  title: string;
  activePath?: string;
  children: React.ReactNode;
}

export default function PageShell({ title, children }: PageShellProps) {
  const { isDark, toggleTheme } = useTheme();

  return (
    <div className="min-h-screen">
      <header style={{ background: 'var(--bg-card)', borderBottom: '1px solid var(--border)', position: 'sticky', top: 0, zIndex: 50 }}>
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <Link href="/" style={{ textDecoration: 'none', display: 'flex', alignItems: 'center' }}>
            <Logo size={28} />
          </Link>
          {/* Подпись в шапке, а не заголовок страницы: H1 — у самого документа.
              Иначе у каждого правового документа два H1 (аудит vedarai.ru 01.10). */}
          <p className="text-lg font-bold text-[var(--text-primary)] hidden sm:block">{title}</p>
          <div className="flex items-center gap-3">
            <button onClick={toggleTheme} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors" aria-label="Переключить тему">
              {isDark ? <Sun size={20} /> : <Moon size={20} />}
            </button>
            <Link href="/profile" className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors" aria-label="Личный кабинет">
              <User size={20} />
            </Link>
          </div>
        </div>
      </header>
      {children}
    </div>
  );
}

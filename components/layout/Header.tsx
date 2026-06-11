'use client';

import React from 'react';
import Link from 'next/link';
import { Sun, Moon, UserCircle, Search } from 'lucide-react';
import { useScrollY } from '@/hooks/useScrollY';
import { useTheme } from '@/contexts/ThemeContext';
import { GeoToggle } from '@/components/geo/GeoToggle';
import Logo from '@/components/shared/Logo';

const FO = "var(--font-outfit,'Outfit',system-ui,sans-serif)";

const iconBtnBase: React.CSSProperties = {
  width: '32px',
  height: '32px',
  borderRadius: '50%',
  border: 'none',
  background: 'transparent',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  textDecoration: 'none',
  transition: 'color 0.2s, background 0.2s',
  flexShrink: 0,
};

export function Header() {
  const scrollY = useScrollY();
  const scrolled = scrollY > 60;
  const { isDark, toggleTheme } = useTheme();
  const iconColor = scrolled ? 'var(--text-secondary)' : 'rgba(255,255,255,0.85)';
  const iconBtn: React.CSSProperties = {
    ...iconBtnBase,
    color: iconColor,
  };

  return (
    <header
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: 'calc(env(safe-area-inset-top, 0px) + 10px) 12px 10px',
        fontFamily: FO,
        transition: 'background 0.3s, box-shadow 0.3s',
        background: scrolled
          ? 'var(--bg-card)'
          : 'linear-gradient(to bottom, rgba(0,0,0,0.28) 0%, transparent 100%)',
        boxShadow: scrolled ? '0 1px 0 var(--border)' : 'none',
      }}
    >
      {/* Logo */}
      <Link
        href="/"
        aria-label="KamchatourHub"
        style={{
          display: 'flex',
          alignItems: 'center',
          color: 'var(--text-primary)',
          textDecoration: 'none',
          flexShrink: 0,
        }}
      >
        <Logo size={24} />
      </Link>

      {/* Center nav — desktop only */}
      <nav style={{
        alignItems: 'center',
        gap: '4px',
        position: 'absolute',
        left: '50%',
        transform: 'translateX(-50%)',
      }} className="hidden lg:flex">
        {[
          { href: '/hub/fishing', label: 'Рыбалка' },
          { href: '/routes',      label: 'Маршруты' },
          { href: '/collections', label: 'Подборки' },
          { href: '/map',         label: 'Карта' },
          { href: '/accommodations', label: 'Жильё' },
          { href: '/ai-tools',    label: 'AI-арсенал' },
          { href: '/operators',   label: 'Операторы' },
          { href: '/catalog',     label: 'Туры' },
        ].map(item => (
          <Link
            key={item.href}
            href={item.href}
            style={{
              padding: '6px 14px',
              borderRadius: '20px',
              fontFamily: FO,
              fontSize: '14px',
              fontWeight: 500,
              color: iconColor,
              textDecoration: 'none',
              transition: 'color 0.2s, background 0.2s',
            }}
            className="hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
          >
            {item.label}
          </Link>
        ))}
      </nav>

      {/* Right side — icon buttons */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
        {/* Search */}
        <button
          onClick={() => window.dispatchEvent(new Event('open-search'))}
          aria-label="Поиск (Ctrl+K)"
          style={iconBtn}
          className="hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          <Search size={18} />
        </button>

        {/* Я на Камчатке */}
        <GeoToggle />

        {/* Theme toggle */}
        <button
          onClick={toggleTheme}
          aria-label={isDark ? 'Светлая тема' : 'Тёмная тема'}
          style={iconBtn}
          className="hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          {isDark ? <Sun size={18} /> : <Moon size={18} />}
        </button>

        {/* Profile */}
        <Link
          href="/profile"
          aria-label="Личный кабинет"
          style={iconBtn}
          className="hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          <UserCircle size={18} />
        </Link>
      </div>
    </header>
  );
}

'use client';

import React from 'react';
import Link from 'next/link';
import { Sun, Moon, UserCircle, Search, LogIn, Menu } from 'lucide-react';
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
  /**
   * Вошёл ли смотрящий. `null` — ещё не спросили или сеть не ответила: это
   * отдельное состояние, а не «гость». Спрашивается один раз за монтирование,
   * ответ дешёвый и не кэшируется прокси (роут force-dynamic).
   */
  const [authed, setAuthed] = React.useState<boolean | null>(null);

  React.useEffect(() => {
    let alive = true;
    fetch('/api/auth/me', { credentials: 'include' })
      .then(r => { if (alive) setAuthed(r.ok); })
      .catch(() => { /* связи нет — состояние остаётся «не знаю» */ });
    return () => { alive = false; };
  }, []);
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
        aria-label="Ведар"
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
          { href: '/places',      label: 'Места' },
          { href: '/routes',      label: 'Маршруты' },
          { href: '/safety',      label: 'Безопасность' },
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

        {/*
          Вход. Значок аккаунта стоял здесь ВСЕГДА — и у вошедшего, и у
          гостя. Сайт из-за этого выглядел залогиненным для всех, и человек
          узнавал правду только упёршись в отказ на действии: владелец 21.08
          на Диких озерках получил «Не авторизован» при отправке фото, будучи
          уверенным, что он в аккаунте, — и был прав в своей уверенности,
          потому что подтверждала её наша же шапка.

          Три исхода, а не два: пока ответ о входе не пришёл, значок остаётся
          прежним и ничего не обещает — путь /profile сам уводит на вход, если
          он нужен. Врать в одну сторону («вы гость») ничем не лучше, чем в
          другую.
        */}
        <Link
          href={authed === false ? '/auth/login' : '/profile'}
          aria-label={authed === false ? 'Войти' : 'Личный кабинет'}
          style={iconBtn}
          className="hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          {authed === false ? <LogIn size={18} /> : <UserCircle size={18} />}
        </Link>

        {/*
          «Ещё» — вся платформа одним касанием (владелец, 02.09). До этого на
          телефоне половина разделов была достижима только через футер, а он
          вмонтирован не на каждой странице. Список — общий реестр
          lib/navigation/platform-links; сторож mobile-two-taps держит, что
          каждая публичная страница из sitemap в двух касаниях отсюда.
        */}
        <Link
          href="/menu"
          aria-label="Ещё — все разделы"
          style={iconBtn}
          className="hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          <Menu size={18} />
        </Link>
      </div>
    </header>
  );
}

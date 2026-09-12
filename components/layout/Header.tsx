'use client';

import React from 'react';
import Link from 'next/link';
import { Sun, Moon, UserCircle, Search, LogIn, Menu } from 'lucide-react';
import EmergencyAction from '@/components/shared/EmergencyAction';
import { useScrollY } from '@/hooks/useScrollY';
import { useTheme } from '@/contexts/ThemeContext';
import { GeoToggle } from '@/components/geo/GeoToggle';
import Logo from '@/components/shared/Logo';

const FO = "var(--font-outfit,'Outfit',system-ui,sans-serif)";

// 44px — минимальная тач-цель DS (§10 vedar-design); 32 px в шапке были
// ниже правила и промахивались пальцем в перчатке (#1780).
const iconBtnBase: React.CSSProperties = {
  width: '44px',
  height: '44px',
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
    // /api/auth/state, а не /api/auth/me: у гостя «me» отвечает 401 и красит
    // консоль на каждом экране (#1780); «state» отдаёт 200 с флагом.
    fetch('/api/auth/state', { credentials: 'include' })
      .then(r => (r.ok ? r.json() : null))
      .then((d: { data?: { authenticated?: boolean } } | null) => {
        if (alive && typeof d?.data?.authenticated === 'boolean') setAuthed(d.data.authenticated);
      })
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
        /**
         * Три дорожки, а не flex с absolute-навигацией посередине.
         *
         * До 12.09 центральная навигация стояла `position:absolute; left:50%`
         * ПОВЕРХ ряда кнопок справа. Позиционированный элемент красится выше
         * статического — значит половина ширины навигации, дотянувшаяся до
         * кнопок, забирала их клики себе. Замер (headless-браузер,
         * elementFromPoint по центру каждой кнопки) на ширине окна:
         *
         *   1024px — перехвачены ВСЕ шесть, включая SOS («Операторы»);
         *   1280px — поиск, гео, тема;
         *   1440px — поиск;
         *   1536px и шире — чисто.
         *
         * То есть на всяком ноутбуке кнопка поиска и переключатель темы не
         * работали, а на 1024-1150 не работал и SOS: человек жал красную
         * кнопку и попадал в «Операторы». §7 и §11 требуют обратного — SOS
         * доступен всегда; кнопка, которую перекрывает меню, этого не даёт.
         *
         * Нашлось не глазами: ночной e2e честно кликал по роли и подписи, и
         * Playwright назвал перехватчика поимённо. Прежний разбор (прогон 7)
         * списал это на «селектор взял перекрытый элемент» — селектор был
         * верен, перекрытие настоящее.
         *
         * Grid снимает причину, а не симптом: у навигации своя дорожка, лечь
         * поверх соседней она не может ни при какой ширине и ни при каком
         * числе пунктов. Цена — на узких окнах навигация не «съезжает», а
         * раздвигает дорожки, поэтому ниже xl она скрыта (см. ниже).
         */
        display: 'grid',
        gridTemplateColumns: '1fr auto 1fr',
        alignItems: 'center',
        gap: '8px',
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
          justifySelf: 'start',
          color: 'var(--text-primary)',
          textDecoration: 'none',
          flexShrink: 0,
        }}
      >
        <Logo size={24} />
      </Link>

      {/*
        Центральная навигация — только там, где она ПОМЕЩАЕТСЯ.

        Десять пунктов занимают 896-970px (замер: два разных гротеска, живой
        шрифт между ними), ряд кнопок справа — 274px. На дорожках это значит
        минимум ~1180px на всё вместе; ниже навигация не сжимается, а
        выталкивает кнопки за край экрана — SOS уезжал бы вправо за границу
        окна. Поэтому порог xl (1280px), с запасом в сотню пикселей к худшему
        из замеров, а не lg (1024px), при котором она и налезала на кнопки.

        На окнах уже 1280 платформа достижима через «Ещё» (/menu, реестр
        lib/navigation/platform-links) — ровно так же, как на телефоне;
        сторож mobile-two-taps держит, что оттуда любая публичная страница в
        двух касаниях. Меню, закрывающее собой SOS, хуже меню, убранного в
        «Ещё».
      */}
      <nav style={{
        alignItems: 'center',
        justifySelf: 'center',
        gap: '2px',
      }} className="hidden xl:flex">
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
              padding: '6px 10px',
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
      <div style={{ display: 'flex', alignItems: 'center', justifySelf: 'end', gap: '2px' }}>
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
          SOS — фиксированная кнопка шапки на каждом экране (решение владельца
          29.07, §2). До 10.09 шапка её не несла, и на /routes, /catalog,
          /kuzmich и карточке тура SOS не было вовсе (#1775): страницы,
          которым шапка общая, кнопку получали только там, где автор экрана
          вспомнил положить её рядом с заголовком. Одна кнопка — в одной
          шапке; экран со своей копией рядом с заголовком показывал бы две.
        */}
        <EmergencyAction />

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

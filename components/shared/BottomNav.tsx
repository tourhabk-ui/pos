'use client';

import { useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { House, Map, Compass, Navigation, Siren, type LucideIcon } from 'lucide-react';

// Единая мобильная навигация (решение владельца 2026-07-18): на /map и
// /ai-assistant была другая навигация, чем на главной — набор пунктов,
// подписи и адреса разъезжались. Канон — таб-бар главной v8:
// Дом / Карта / Кузьмич / На маршруте / СОС. Здесь тот же набор на
// глобальных токенах (v8 использует локальные переменные темы .v7).
// ЛК по-прежнему только в шапке. СОС онлайн ведёт на полноценный /sos;
// офлайн — на /emergency (страница с нулевыми зависимостями, есть в
// precache) — инлайн-панель главной сюда не тащим.
const FO = "var(--font-outfit,'Outfit',sans-serif)";

interface NavItem {
  icon: LucideIcon;
  label: string;
  href: string;
  /** Пути, на которых пункт подсвечен (дубль /ai-assistant ↔ /kuzmich — Этап 9) */
  activeOn: string[];
}

const ITEMS: NavItem[] = [
  { icon: House,      label: 'Дом',         href: '/',                    activeOn: ['/'] },
  { icon: Map,        label: 'Карта',       href: '/map',                 activeOn: ['/map'] },
  { icon: Compass,    label: 'Кузьмич',     href: '/kuzmich',             activeOn: ['/kuzmich', '/ai-assistant'] },
  { icon: Navigation, label: 'На маршруте', href: '/planning?mode=trail', activeOn: ['/planning'] },
];

interface BottomNavProps {
  activePath: string;
  onNavClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void;
}

export default function BottomNav({ activePath, onNavClick }: BottomNavProps) {
  const router = useRouter();

  // Офлайн /sos не поднимется (RSC-подкачка) — уводим на офлайн-первый /emergency
  const sosClick = useCallback((e: React.MouseEvent<HTMLAnchorElement>) => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      e.preventDefault();
      router.push('/emergency');
      return;
    }
    onNavClick?.(e);
  }, [router, onNavClick]);

  return (
    <nav
      className="flex md:hidden"
      aria-label="Основная навигация"
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 100,
        alignItems: 'center',
        background: 'color-mix(in srgb, var(--bg-card) 88%, transparent)',
        backdropFilter: 'blur(18px) saturate(1.2)',
        WebkitBackdropFilter: 'blur(18px) saturate(1.2)',
        borderTop: '1px solid var(--border)',
        padding: '0 4px',
      }}
    >
      {ITEMS.map(({ icon: Icon, label, href, activeOn }) => {
        const isActive = activeOn.includes(activePath);
        return (
          <Link
            key={href}
            href={href}
            aria-label={label}
            onClick={onNavClick}
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '5px',
              padding: '8px 0 calc(7px + env(safe-area-inset-bottom))',
              color: isActive ? 'var(--accent)' : 'var(--text-muted)',
              textDecoration: 'none',
              fontFamily: FO,
              fontSize: '8px',
              fontWeight: 600,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              transition: 'color 220ms ease',
            }}
          >
            <span
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '46px',
                height: '28px',
                borderRadius: '999px',
                background: isActive ? 'color-mix(in srgb, var(--accent) 15%, transparent)' : 'transparent',
                transition: 'background 280ms ease',
              }}
            >
              <Icon size={19} strokeWidth={2} />
            </span>
            <span>{label}</span>
          </Link>
        );
      })}

      {/* СОС — всегда красный и видимый (фидбэк с Халактырского пляжа) */}
      <Link
        href="/sos"
        aria-label="СОС — экстренная помощь"
        onClick={sosClick}
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '5px',
          padding: '8px 0 calc(7px + env(safe-area-inset-bottom))',
          color: 'var(--danger)',
          textDecoration: 'none',
          fontFamily: FO,
          fontSize: '8px',
          fontWeight: 700,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '46px', height: '28px' }}>
          <Siren size={18} strokeWidth={2.2} />
        </span>
        <span>СОС</span>
      </Link>
    </nav>
  );
}

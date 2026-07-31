'use client';

import Link from 'next/link';
import { House, Map, Compass, Navigation, type LucideIcon } from 'lucide-react';

// Единая мобильная навигация (решение владельца 2026-07-18): на /map и
// /ai-assistant была другая навигация, чем на главной — набор пунктов,
// подписи и адреса разъезжались. С 31.07 главная тоже рендерит ЭТОТ компонент
// (свой инлайновый таб-бар удалён редизайном), а собственных переменных темы
// у неё больше нет — все страницы на глобальных токенах. ЛК только в шапке.
//
// СОС отсюда ушёл (решение владельца 2026-07-29, отменяет решение от 18.07):
// теперь это фиксированная кнопка в шапке на каждом экране —
// `components/shared/EmergencyAction.tsx`, единственная реализация на всю
// платформу. Не возвращать пункт сюда: две кнопки одного действия расходятся
// поведением, что с этой и уже случилось (одна копия уводила на /emergency,
// другая открывала инлайн-панель).
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

    </nav>
  );
}

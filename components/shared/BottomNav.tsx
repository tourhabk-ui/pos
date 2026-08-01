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
            // Типографика north-star (полевой скриншот 01.08): капс 8px читался
            // мелкой технической подписью. Обычный регистр 10.5px + активная
            // точка под подписью вместо пилюли-подложки.
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '4px',
              padding: '9px 0 calc(8px + env(safe-area-inset-bottom))',
              color: isActive ? 'var(--accent)' : 'var(--text-muted)',
              textDecoration: 'none',
              fontFamily: FO,
              fontSize: '10.5px',
              fontWeight: 600,
              letterSpacing: '0.01em',
              transition: 'color 220ms ease',
            }}
          >
            {href === '/kuzmich' ? (
              /* Кузьмич — медальон-гравюра, приподнятый над панелью (north-star
                 макет 31.07). Портрет вместо абстрактного компаса: проводник —
                 лицо платформы, и это его вход. Зона нажатия — весь Link. */
              <span
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: '48px',
                  height: '48px',
                  marginTop: '-18px',
                  borderRadius: '50%',
                  overflow: 'hidden',
                  flex: 'none',
                  background: 'var(--bg-card)',
                  border: isActive ? '2px solid var(--accent)' : '2px solid var(--border)',
                  boxShadow: '0 4px 14px rgba(0,0,0,.18)',
                  transition: 'border-color 280ms ease',
                }}
              >
                <img
                  src="/images/kuzmich/portrait-96.webp"
                  srcSet="/images/kuzmich/portrait-96.webp 96w, /images/kuzmich/portrait-192.webp 192w"
                  sizes="48px"
                  width={48}
                  height={48}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              </span>
            ) : href === '/planning?mode=trail' ? (
              /* «На маршруте» — фирменная иконка из пака владельца (31.07):
                 пин с пунктирным следом. Цвет вшит в PNG (коралл пака), поэтому
                 состояния делаются фильтром: неактивный — обесцвечен и
                 приглушён в тон остальных пунктов, активный — полноцветный.
                 Маской по currentColor нельзя: у пина рисованный светлый
                 контр-круг, в маске он бы залился сплошным. */
              <span
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: '46px',
                  height: '26px',
                }}
              >
                <img
                  src="/images/nav/route-48.webp"
                  srcSet="/images/nav/route-48.webp 48w, /images/nav/route-96.webp 96w"
                  sizes="22px"
                  width={22}
                  height={22}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  style={{
                    width: '22px',
                    height: '22px',
                    filter: isActive ? 'none' : 'grayscale(1) opacity(.55)',
                    transition: 'filter 220ms ease',
                  }}
                />
              </span>
            ) : (
              <span
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: '46px',
                  height: '26px',
                }}
              >
                <Icon size={20} strokeWidth={isActive ? 2.2 : 1.9} />
              </span>
            )}
            <span>{label}</span>
            <span
              aria-hidden
              style={{
                width: '4px',
                height: '4px',
                borderRadius: '50%',
                background: isActive ? 'var(--accent)' : 'transparent',
                transition: 'background 220ms ease',
              }}
            />
          </Link>
        );
      })}

    </nav>
  );
}

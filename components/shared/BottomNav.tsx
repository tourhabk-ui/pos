'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { House, Map, Compass, Navigation, Ticket, type LucideIcon } from 'lucide-react';

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

// Пять пунктов, Кузьмич строго ПО ЦЕНТРУ (решение владельца 01.08 — как в
// north-star макете). Четвёртый — «Туры» (/catalog, витрина operator_tours):
// раньше был «Поездки», но на телефоне коммерция оказалась спрятана — вход в
// туры вернули в таб-бар (решение владельца). Поездки туриста доступны из ЛК
// в шапке. Профиль и СОС пятыми быть НЕ могут: ЛК только в шапке (§2), СОС
// только в шапке (#887).
const ITEMS: NavItem[] = [
  { icon: House,      label: 'Дом',         href: '/',                    activeOn: ['/'] },
  { icon: Map,        label: 'Карта',       href: '/map',                 activeOn: ['/map'] },
  { icon: Compass,    label: 'Кузьмич',     href: '/kuzmich',             activeOn: ['/kuzmich', '/ai-assistant'] },
  { icon: Ticket,     label: 'Туры',        href: '/catalog',             activeOn: ['/catalog', '/marketplace'] },
  { icon: Navigation, label: 'На маршруте', href: '/planning?mode=trail', activeOn: ['/planning'] },
];

interface BottomNavProps {
  activePath: string;
  onNavClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void;
}

/**
 * Высота бара — CSS-переменная `--bottom-nav-h` на <html>.
 *
 * Плавающие элементы над баром (StickyLeadButton) ставились по своим
 * отступам и не знали, есть ли под ними бар: на /menu кнопка «Хочу тур»
 * легла под пункт «На маршруте», и нажать её было нельзя (аудит П1, #107).
 * Бар сам говорит, сколько места занимает; где его нет или он скрыт (md+),
 * переменная — 0px. Сторож: tests/unit/sticky-lead-fab.test.tsx.
 */
export const BOTTOM_NAV_HEIGHT_VAR = '--bottom-nav-h';

export default function BottomNav({ activePath, onNavClick }: BottomNavProps) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const publish = () => root.style.setProperty(BOTTOM_NAV_HEIGHT_VAR, `${el.offsetHeight}px`);
    publish();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(publish) : null;
    ro?.observe(el);
    window.addEventListener('resize', publish);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', publish);
      root.style.removeProperty(BOTTOM_NAV_HEIGHT_VAR);
    };
  }, []);

  return (
    <nav
      ref={ref}
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
            // мелкой технической подписью. Обычный регистр + активная точка под
            // подписью вместо пилюли-подложки.
            //
            // Неактивный пункт — --text-secondary, не --text-muted, и 11px в одну строку, не
            // 10.5: muted давал 1.84:1 в тёмной теме и 2.97:1 в светлой, и
            // «Туры» — единственный постоянный вход в коммерцию на телефоне —
            // почти не читался (аудит П1, #41/#110/#117). Сторож:
            // tests/unit/sticky-lead-fab.test.tsx.
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '4px',
              padding: '9px 0 calc(8px + env(safe-area-inset-bottom))',
              color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
              textDecoration: 'none',
              fontFamily: FO,
              fontSize: '11px',
              whiteSpace: 'nowrap',
              fontWeight: 600,
              letterSpacing: '0.01em',
              transition: 'color 220ms ease',
            }}
          >
            {href === '/kuzmich' ? (
              /* Кузьмич — медальон-гравюра, приподнятый над панелью (north-star
                 макет 31.07). Марка вместо абстрактного компаса: проводник —
                 лицо платформы, и это его вход. Зона нажатия — весь Link.
                 С 05.09 в медальоне медведь из брендового набора, а не портрет:
                 портрет остаётся секции «Проводник Кузьмич» на главной, где
                 он говорит; медведь раньше стоял в строке поиска над таб-баром,
                 и на одном экране Кузьмич встречался дважды (решение
                 владельца 05.09). */
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
                  src="/images/brand/bear-64.webp"
                  srcSet="/images/brand/bear-64.webp 64w, /images/brand/bear-128.webp 128w, /images/brand/bear-192.webp 192w"
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
                 пин с пунктирным следом. Активное состояние — полноцветный
                 PNG (коралл пака), неактивное — маска в currentColor ниже. */
              <span
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: '46px',
                  height: '26px',
                }}
              >
                {isActive ? (
                  <img
                    src="/images/nav/route-48.webp"
                    srcSet="/images/nav/route-48.webp 48w, /images/nav/route-96.webp 96w"
                    sizes="22px"
                    width={22}
                    height={22}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    style={{ width: '22px', height: '22px' }}
                  />
                ) : (
                  /* Неактивное состояние — МАСКА в currentColor, а не фильтр:
                     обесцвеченный коралловый PNG на тёмной теме превращался в
                     невидимое пятно (полевой скриншот 01.08, 17:08). Маска
                     красится в цвет подписи пункта и живёт в обеих темах.
                     Светлый контр-круг пина в маске заливается — для
                     приглушённого силуэта это норма, полноцветная гравюра
                     остаётся в активном состоянии. */
                  <span
                    aria-hidden
                    style={{
                      width: '22px',
                      height: '22px',
                      background: 'currentColor',
                      WebkitMaskImage: 'url(/images/nav/route-96.webp)',
                      maskImage: 'url(/images/nav/route-96.webp)',
                      WebkitMaskSize: 'contain',
                      maskSize: 'contain',
                      WebkitMaskRepeat: 'no-repeat',
                      maskRepeat: 'no-repeat',
                      WebkitMaskPosition: 'center',
                      maskPosition: 'center',
                    }}
                  />
                )}
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

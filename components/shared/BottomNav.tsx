'use client';

import { useCallback, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { House, Map, User, Navigation, Bot, Siren } from 'lucide-react';

// СОС — отдельный красный пункт (фидбэк с Халактырского пляжа: в поле
// скрытого long-press недостаточно, нужна ВИДИМАЯ кнопка). Ведёт на
// /emergency — офлайн-страница с нулевыми зависимостями (GPS + 112 + протоколы).
const LEFT_ITEMS = [
  { icon: House,      label: 'Домой',    href: '/' },
  { icon: Map,        label: 'Карта',    href: '/map' },
  { icon: Navigation, label: 'Маршрут',  href: '/planning' },
];

const RIGHT_ITEMS = [
  { icon: User,       label: 'ЛК',       href: '/profile' },
];

// Долгое удержание центральной кнопки — быстрый жест к СОС в дополнение
// к видимой красной кнопке (обе ведут на /emergency).
const SOS_LONG_PRESS_MS = 600;

interface BottomNavProps {
  activePath: string;
  onNavClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void;
}

export default function BottomNav({ activePath, onNavClick }: BottomNavProps) {
  const router = useRouter();
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFired = useRef(false);

  const startPress = useCallback(() => {
    longPressFired.current = false;
    pressTimer.current = setTimeout(() => {
      longPressFired.current = true;
      router.push('/emergency');
    }, SOS_LONG_PRESS_MS);
  }, [router]);

  const cancelPress = useCallback(() => {
    if (pressTimer.current) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  }, []);

  const handleKuzmichClick = useCallback((e: React.MouseEvent<HTMLAnchorElement>) => {
    if (longPressFired.current) {
      // Долгое удержание уже увело на /emergency — не открывать чат поверх
      e.preventDefault();
      return;
    }
    onNavClick?.(e);
  }, [onNavClick]);

  return (
    <nav
      /* display управляется ТОЛЬКО классами: inline display:flex перебивал
         md:hidden (инлайн-стиль сильнее класса) — нав был виден и на десктопе */
      className="flex md:hidden items-center justify-around"
      aria-label="Основная навигация"
      style={{
        position: 'fixed',
        bottom: '32px',
        left: '16px',
        right: '16px',
        zIndex: 100,
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        boxShadow: '0 4px 24px rgba(0,0,0,0.12)',
        borderRadius: '50px',
        padding: '12px 24px',
      }}
    >
      {LEFT_ITEMS.map(({ icon: Icon, label, href }) => {
        const isActive = activePath === href;
        return (
          <Link
            key={href}
            href={href}
            aria-label={label}
            onClick={onNavClick}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '2px',
              color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
              textDecoration: 'none',
              transition: 'color 200ms ease',
              padding: '4px 8px',
              borderRadius: '12px',
            }}
          >
            <Icon size={20} strokeWidth={1.5} />
            <span style={{ fontFamily: "var(--font-outfit,'Outfit',sans-serif)", fontSize: '10px', fontWeight: 500 }}>
              {label}
            </span>
          </Link>
        );
      })}

      {/* Center Kuzmich button — protruding, главный AI-центр (Field OS).
          Долгое удержание (600мс) — экстренный переход на /emergency (СОС). */}
      <div style={{ position: 'relative', width: '60px', flexShrink: 0 }}>
        <Link
          href="/ai-assistant"
          aria-label="Кузьмич (удерживайте для СОС)"
          onClick={handleKuzmichClick}
          onPointerDown={startPress}
          onPointerUp={cancelPress}
          onPointerLeave={cancelPress}
          onContextMenu={(e) => e.preventDefault()}
          style={{
            position: 'absolute',
            left: '50%',
            top: '-32px',
            transform: 'translateX(-50%)',
            width: '60px',
            height: '60px',
            borderRadius: '50%',
            background: 'var(--accent)',
            border: '3px solid var(--bg-primary)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            textDecoration: 'none',
            boxShadow: '0 0 15px var(--success)',
            transition: 'transform 200ms ease',
            touchAction: 'manipulation',
          }}
        >
          <Bot size={26} color="white" />
        </Link>
      </div>

      {RIGHT_ITEMS.map(({ icon: Icon, label, href }) => {
        const isActive = activePath === href;
        return (
          <Link
            key={href}
            href={href}
            aria-label={label}
            onClick={onNavClick}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '2px',
              color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
              textDecoration: 'none',
              transition: 'color 200ms ease',
              padding: '4px 8px',
              borderRadius: '12px',
            }}
          >
            <Icon size={20} strokeWidth={1.5} />
            <span style={{ fontFamily: "var(--font-outfit,'Outfit',sans-serif)", fontSize: '10px', fontWeight: 500 }}>
              {label}
            </span>
          </Link>
        );
      })}

      {/* СОС — всегда красный и видимый, ведёт на офлайн /emergency */}
      <Link
        href="/emergency"
        aria-label="СОС — экстренная помощь"
        onClick={onNavClick}
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '2px',
          color: 'var(--danger)',
          textDecoration: 'none',
          padding: '4px 8px',
          borderRadius: '12px',
        }}
      >
        <Siren size={20} strokeWidth={1.75} />
        <span style={{ fontFamily: "var(--font-outfit,'Outfit',sans-serif)", fontSize: '10px', fontWeight: 700 }}>
          СОС
        </span>
      </Link>
    </nav>
  );
}

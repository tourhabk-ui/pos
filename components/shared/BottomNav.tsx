'use client';

import Link from 'next/link';
import { House, Map, User, AlertTriangle, Navigation } from 'lucide-react';

const LEFT_ITEMS = [
  { icon: House,      label: 'Домой',    href: '/' },
  { icon: Map,        label: 'Карта',    href: '/map' },
];

const RIGHT_ITEMS = [
  { icon: Navigation, label: 'Маршрут',  href: '/planning' },
  { icon: User,       label: 'ЛК',       href: '/profile' },
];

interface BottomNavProps {
  activePath: string;
  onNavClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void;
}

export default function BottomNav({ activePath, onNavClick }: BottomNavProps) {
  return (
    <nav
      className="md:hidden"
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
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-around',
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

      {/* Center Kuzmich button — protruding */}
      <div style={{ position: 'relative', width: '52px', flexShrink: 0 }}>
        <Link
          href="/ai-assistant"
          aria-label="Кузьмич"
          onClick={onNavClick}
          style={{
            position: 'absolute',
            left: '50%',
            top: '-28px',
            transform: 'translateX(-50%)',
            width: '52px',
            height: '52px',
            borderRadius: '50%',
            background: 'var(--accent)',
            border: '3px solid var(--bg-primary)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            textDecoration: 'none',
            fontSize: '22px',
            boxShadow: '0 2px 12px rgba(0,0,0,0.20)',
            transition: 'transform 200ms ease',
          }}
        >
          🐻
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

      {/* SOS — right end */}
      <Link
        href="/emergency.html"
        aria-label="СОС"
        onClick={onNavClick}
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '2px',
          color: 'var(--danger)',
          textDecoration: 'none',
          transition: 'color 200ms ease',
          padding: '4px 8px',
          borderRadius: '12px',
        }}
      >
        <AlertTriangle size={20} strokeWidth={1.5} />
        <span style={{ fontFamily: "var(--font-outfit,'Outfit',sans-serif)", fontSize: '10px', fontWeight: 500 }}>
          СОС
        </span>
      </Link>
    </nav>
  );
}

'use client';

import React, { useRef, useCallback } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { House, Map, Sparkles, Compass, ShieldAlert } from 'lucide-react';

const FO = "var(--font-outfit,'Outfit',system-ui,sans-serif)";

const NAV = [
  { icon: House,      label: undefined,    href: '/'             },
  { icon: Compass,    label: 'Места',      href: '/routes?kind=place' },
  { icon: Map,        label: 'Карта',      href: '/map'          },
  { icon: Sparkles,   label: 'Кузьмич',   href: '/ai-assistant' },
  { icon: ShieldAlert, label: 'СОС',       href: '/safety'       },
];

export function GlobalMobileNav() {
  const pathname = usePathname();
  const itemRefs = useRef<(HTMLAnchorElement | null)[]>([]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    itemRefs.current.forEach(el => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      const t = Math.max(0, 1 - Math.abs(e.clientX - r.x - r.width / 2) / 120);
      el.style.transform = `scale(${1 + t * 0.4})`;
    });
  }, []);

  const handlePointerLeave = useCallback(() => {
    itemRefs.current.forEach(el => {
      if (el) el.style.transform = 'scale(1)';
    });
  }, []);

  // Hide on hub pages (they have sidebar nav) and on map page (takes full screen)
  if (pathname.startsWith('/hub') || pathname === '/map') return null;

  return (
    <nav
      className="lg:hidden"
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      style={{
        position: 'fixed',
        bottom: '12px',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 80,
        display: 'flex',
        alignItems: 'center',
        gap: '2px',
        padding: '5px',
        borderRadius: '100px',
        fontFamily: FO,
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        boxShadow: '0 4px 20px rgba(0,0,0,0.12), 0 1px 0 var(--border)',
      }}
    >
      {NAV.map((item, idx) => {
        const Icon = item.icon;
        const isActive = item.href === '/'
          ? pathname === '/'
          : pathname.startsWith(item.href.split('?')[0]);

        return (
          <Link
            key={item.href}
            href={item.href}
            ref={(el) => { itemRefs.current[idx] = el; }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              padding: item.label ? '7px 12px' : '7px 10px',
              borderRadius: '100px',
              color: isActive ? 'var(--accent)' : 'var(--text-muted)',
              background: isActive ? 'var(--accent)/10' : 'transparent',
              textDecoration: 'none',
              fontSize: '10px',
              fontWeight: 600,
              transition: 'color 0.15s, background 0.15s, transform 0.1s ease',
              transformOrigin: 'bottom center',
            }}
            className={isActive ? 'bg-[var(--accent)]/10' : ''}
          >
            <Icon size={18} strokeWidth={isActive ? 2.5 : 2} />
            {item.label && <span>{item.label}</span>}
          </Link>
        );
      })}
    </nav>
  );
}

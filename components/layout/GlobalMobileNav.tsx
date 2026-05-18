'use client';

import React from 'react';
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

  // Hide on hub pages (they have sidebar nav) and on map page (takes full screen)
  if (pathname.startsWith('/hub') || pathname === '/map') return null;

  return (
    <nav
      className="lg:hidden"
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
      {NAV.map((item) => {
        const Icon = item.icon;
        const isActive = item.href === '/'
          ? pathname === '/'
          : pathname.startsWith(item.href.split('?')[0]);

        return (
          <Link
            key={item.href}
            href={item.href}
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
              transition: 'color 0.15s, background 0.15s',
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

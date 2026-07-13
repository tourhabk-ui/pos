'use client';

import React from 'react';
import Link from 'next/link';
import { House, BookOpen, Map, User, Bot, Mountain } from 'lucide-react';

const FO = "var(--font-outfit,'Outfit',system-ui,sans-serif)";

const LEFT = [
  { icon: House,    label: 'Главная',  href: '/'       },
  { icon: Mountain, label: 'Места',    href: '/places' },
  { icon: BookOpen, label: 'Маршруты', href: '/routes' },
];
const RIGHT = [
  { icon: Map,  label: 'Карта',   href: '/map'     },
  { icon: User, label: 'Профиль', href: '/profile' },
];

export function HomeBottomNav() {
  return (
    <nav
      className="lg:hidden"
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 80,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-around',
        padding: '8px 12px calc(env(safe-area-inset-bottom, 0px) + 8px)',
        fontFamily: FO,
        background: 'var(--bg-card)',
        borderTop: '1px solid var(--border)',
      }}
    >
      {LEFT.map((item) => {
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '3px',
              padding: '6px 0',
              color: 'var(--text-muted)',
              textDecoration: 'none',
              fontSize: '10px',
              fontWeight: 500,
            }}
          >
            <Icon size={22} />
            <span>{item.label}</span>
          </Link>
        );
      })}

      {/* Kuzmich center button */}
      <Link
        href="/ai-assistant"
        style={{
          flex: '0 0 auto',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '3px',
          padding: '0 16px',
          textDecoration: 'none',
          fontFamily: FO,
          fontSize: '10px',
          fontWeight: 700,
          color: 'white',
          marginTop: '-20px',
        }}
      >
        <div style={{
          width: '52px',
          height: '52px',
          borderRadius: '50%',
          background: 'var(--accent)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: '0 4px 16px color-mix(in srgb, var(--accent) 50%, transparent)',
          border: '3px solid var(--bg-card)',
        }}>
          <Bot size={24} strokeWidth={1.5} />
        </div>
        <span style={{ color: 'var(--accent)' }}>Кузьмич</span>
      </Link>

      {RIGHT.map((item) => {
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '3px',
              padding: '6px 0',
              color: 'var(--text-muted)',
              textDecoration: 'none',
              fontSize: '10px',
              fontWeight: 500,
            }}
          >
            <Icon size={22} />
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

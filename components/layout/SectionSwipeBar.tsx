'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';

export interface SectionSwipeItem {
  label: string;
  href: string;
}

/**
 * Полоса подразделов раздела: стекло, нейтральные чипы, активный инвертирован.
 * Липнет под фиксированной шапкой (--header-h = safe-area + 64px, см. Header).
 * Ссылки рендерятся на сервере — есть в первом HTML.
 */
export function isActiveItem(pathname: string | null, href: string, items: SectionSwipeItem[]): boolean {
  if (!pathname) return false;
  const clean = pathname.replace(/\/+$/, '') || '/';
  if (clean === href) return true;
  // Вложенная страница подраздела активирует самый длинный подходящий пункт.
  const prefixMatches = items.filter((i) => clean.startsWith(`${i.href}/`));
  if (prefixMatches.length === 0) return false;
  const best = prefixMatches.reduce((a, b) => (b.href.length > a.href.length ? b : a));
  return best.href === href && !items.some((i) => i.href === clean);
}

export function SectionSwipeBar({
  items,
  label = 'Подразделы',
  className = '',
}: {
  items: SectionSwipeItem[];
  label?: string;
  className?: string;
}) {
  const pathname = usePathname();
  const activeRef = useRef<HTMLAnchorElement | null>(null);

  useEffect(() => {
    const el = activeRef.current;
    if (!el) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView?.({ inline: 'center', block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
  }, [pathname]);

  return (
    <nav aria-label={label} className={`section-swipebar ${className}`.trim()}>
      <ul className="section-swipebar__list">
        {items.map((item) => {
          const active = isActiveItem(pathname, item.href, items);
          return (
            <li key={item.href} className="shrink-0">
              <Link
                href={item.href}
                ref={active ? activeRef : undefined}
                aria-current={active ? 'page' : undefined}
                className={`section-swipebar__chip${active ? ' is-active' : ''}`}
              >
                <span className="section-swipebar__pill">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export const SAFETY_SECTION_ITEMS: SectionSwipeItem[] = [
  { label: 'Обстановка', href: '/safety' },
  { label: 'Что делать при ЧП', href: '/safety/offline' },
  { label: 'Инциденты', href: '/safety/incidents' },
  { label: 'Связь', href: '/safety/communication' },
];

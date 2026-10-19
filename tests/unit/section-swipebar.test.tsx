import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';

let path = '/safety';
vi.mock('next/navigation', () => ({ usePathname: () => path }));

import { SectionSwipeBar, SAFETY_SECTION_ITEMS, isActiveItem } from '@/components/layout/SectionSwipeBar';

afterEach(() => cleanup());

describe('SectionSwipeBar', () => {
  it('рендерит все пункты ссылками в nav с подписью', () => {
    render(<SectionSwipeBar items={SAFETY_SECTION_ITEMS} label="Разделы безопасности" />);
    expect(screen.getByRole('navigation', { name: 'Разделы безопасности' })).toBeTruthy();
    const links = screen.getAllByRole('link');
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '/safety', '/safety/offline', '/safety/incidents', '/safety/communication',
    ]);
  });

  it.each(SAFETY_SECTION_ITEMS.map((i) => [i.href]))('на %s активен ровно один пункт', (href) => {
    path = href;
    render(<SectionSwipeBar items={SAFETY_SECTION_ITEMS} />);
    const current = screen.getAllByRole('link').filter((l) => l.getAttribute('aria-current') === 'page');
    expect(current).toHaveLength(1);
    expect(current[0].getAttribute('href')).toBe(href);
  });

  it('/safety не активен на подстранице, хвостовой слэш не мешает', () => {
    expect(isActiveItem('/safety/offline', '/safety', SAFETY_SECTION_ITEMS)).toBe(false);
    expect(isActiveItem('/safety/offline/', '/safety/offline', SAFETY_SECTION_ITEMS)).toBe(true);
    expect(isActiveItem('/safety/other', '/safety', SAFETY_SECTION_ITEMS)).toBe(true);
    expect(isActiveItem(null, '/safety', SAFETY_SECTION_ITEMS)).toBe(false);
  });
});

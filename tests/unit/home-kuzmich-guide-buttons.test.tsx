/**
 * Блок «Проводник Кузьмич»: главная дорога — на сайт, рядом две равные
 * дороги в мессенджеры с официальными знаками. Судим рендером, не исходником.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import React from 'react';

import { KuzmichGuideActions } from '@/components/homepage/KuzmichGuideActions';
import { KUZMICH_TELEGRAM_URL, KUZMICH_MAX_URL } from '@/components/shared/KuzmichContacts';

afterEach(() => cleanup());

describe('действия блока «Проводник Кузьмич»', () => {
  it('главная кнопка — «Спросить на сайте» на /kuzmich', () => {
    render(<KuzmichGuideActions />);
    const site = screen.getByRole('link', { name: 'Спросить на сайте' });
    expect(site.getAttribute('href')).toBe('/kuzmich');
    expect(site.className).toContain('ask-site');
  });

  it('мессенджеры: короткие подписи, прежние адреса, официальные знаки', () => {
    const { container } = render(<KuzmichGuideActions />);
    const tg = screen.getByRole('link', { name: 'Кузьмич в Telegram' });
    const max = screen.getByRole('link', { name: 'Кузьмич в MAX' });
    expect(tg.getAttribute('href')).toBe(KUZMICH_TELEGRAM_URL);
    expect(max.getAttribute('href')).toBe(KUZMICH_MAX_URL);
    expect(tg.textContent).toContain('Telegram');
    expect(max.textContent).toContain('MAX');
    for (const link of [tg, max]) {
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.querySelector('svg')).not.toBeNull();
      expect(link.className).toContain('msg');
    }
    const fills = Array.from(container.querySelectorAll('svg path')).map((n) => n.getAttribute('fill') ?? '');
    expect(fills.some((f) => f.includes('#2AABEE'))).toBe(true);
    expect(fills.some((f) => f.startsWith('url(#'))).toBe(true);
    expect(container.querySelector('img')).toBeNull();
  });
});

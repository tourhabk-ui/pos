/**
 * Блок «Проводник Кузьмич»: главная дорога — на сайт, рядом две равные
 * дороги в мессенджеры с официальными знаками. Судим рендером, не исходником.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import React from 'react';

import { KuzmichGuideActions } from '@/components/homepage/KuzmichGuideActions';
import { KUZMICH_TELEGRAM_URL, KUZMICH_MAX_URL } from '@/components/shared/KuzmichContacts';
import { VedarChatIcon, VEDAR_CHAT_MARK_PATH } from '@/components/shared/MessengerIcons';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

afterEach(() => cleanup());

describe('действия блока «Проводник Кузьмич»', () => {
  it('главная кнопка — «Спросить на сайте» на /kuzmich', () => {
    render(<KuzmichGuideActions />);
    const site = screen.getByRole('link', { name: 'Спросить на сайте' });
    expect(site.getAttribute('href')).toBe('/kuzmich');
    expect(site.className).toContain('min-h-[52px]');
    // Подписи нет совсем: имя живёт только в aria-label (20.10).
    expect(site.textContent?.trim()).toBe('');
    // Фирменный знак чата Ведара увеличен до 32px, не generic-иконка.
    const mark = site.querySelector('[data-vedar-chat-icon="true"]');
    expect(mark).not.toBeNull();
    expect(mark?.getAttribute('width')).toBe('32');
  });

  it('мессенджеры: без подписей, прежние адреса, официальные знаки', () => {
    const { container } = render(<KuzmichGuideActions />);
    const tg = screen.getByRole('link', { name: 'Telegram' });
    const max = screen.getByRole('link', { name: 'MAX' });
    expect(tg.getAttribute('href')).toBe(KUZMICH_TELEGRAM_URL);
    expect(max.getAttribute('href')).toBe(KUZMICH_MAX_URL);
    expect(tg.textContent?.trim()).toBe('');
    expect(max.textContent?.trim()).toBe('');
    expect(tg.querySelector('svg')?.getAttribute('width')).toBe('28');
    expect(max.querySelector('svg')?.getAttribute('width')).toBe('28');
    for (const link of [tg, max]) {
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.querySelector('svg')).not.toBeNull();
      expect(link.className).toContain('min-h-[52px]');
    }
    const fills = Array.from(container.querySelectorAll('svg path')).map((n) => n.getAttribute('fill') ?? '');
    expect(fills.some((f) => f.includes('#2AABEE'))).toBe(true);
    expect(fills.some((f) => f.startsWith('url(#'))).toBe(true);
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('ряд стеклянных иконок Кузьмича', () => {
  it('три иконки-кнопки в один ряд, в порядке сайт — Telegram — MAX', () => {
    render(<KuzmichGuideActions />);
    const links = screen.getAllByRole('link');
    expect(links.map((l) => l.getAttribute('aria-label'))).toEqual(['Спросить на сайте', 'Telegram', 'MAX']);
    for (const l of links) {
      expect(l.className).toContain('backdrop-blur-md');
      expect(l.className).toContain('rounded-[16px]');
    }
  });
});

describe('фирменный знак чата Ведара', () => {
  it('силуэт Камчатки из логотипа внутри речевого пузыря', () => {
    const { container } = render(<VedarChatIcon size={24} />);
    const svg = container.querySelector('[data-vedar-chat-icon="true"]');
    expect(svg).not.toBeNull();
    const paths = Array.from(container.querySelectorAll('path'));
    // Контур силуэта — тот же, что в знаке Ведара (Logo), без перерисовки.
    expect(paths.some((n) => n.getAttribute('d') === VEDAR_CHAT_MARK_PATH)).toBe(true);
    const master = readFileSync(join(process.cwd(), 'public/brand/vedar-mark.svg'), 'utf-8').match(/d="([^"]+)"/)?.[1];
    expect(VEDAR_CHAT_MARK_PATH).toBe(master);
    // Пузырь — белый с акцентной обводкой: читается на акцентной кнопке и на тёмной панели.
    expect(paths.some((n) => n.getAttribute('fill') === '#FFFFFF' && (n.getAttribute('stroke') ?? '').includes('--accent'))).toBe(true);
    expect(container.querySelector('img')).toBeNull();
  });
});

/**
 * Действия Кузьмича: главная дорога — на сайт, рядом две равные дороги в
 * мессенджеры с официальными знаками. На мобильной главной с 23.10 — столбик
 * в герое под «Поделиться» (HeroKuzmichChats). Судим рендером, не исходником.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import React from 'react';

import { HeroKuzmichChats } from '@/components/homepage/HeroKuzmichChats';
import { KUZMICH_TELEGRAM_URL, KUZMICH_MAX_URL } from '@/components/shared/KuzmichContacts';
import { VedarChatIcon, VEDAR_CHAT_MARK_PATH } from '@/components/shared/MessengerIcons';
import { KuzmichActions } from '@/components/shared/KuzmichActions';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

afterEach(() => cleanup());

describe('единая система действий Кузьмича', () => {
  it('главная кнопка — «Спросить на сайте» на /kuzmich', () => {
    render(<KuzmichActions primaryHref="/kuzmich" />);
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
    const { container } = render(<KuzmichActions primaryHref="/kuzmich" />);
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
    render(<KuzmichActions primaryHref="/kuzmich" />);
    const links = screen.getAllByRole('link');
    expect(links.map((l) => l.getAttribute('aria-label'))).toEqual(['Спросить на сайте', 'Telegram', 'MAX']);
    for (const l of links) {
      expect(l.className).toContain('backdrop-blur-md');
      expect(l.className).toContain('rounded-[16px]');
    }
  });

  it('главная кнопка — белое стекло как у соседей, без оранжевой подложки', () => {
    render(<KuzmichActions primaryHref="/kuzmich" />);
    const site = screen.getByRole('link', { name: 'Спросить на сайте' });
    const tg = screen.getByRole('link', { name: 'Telegram' });
    const max = screen.getByRole('link', { name: 'MAX' });
    // Одна стеклянная семья: класс у главной байт-в-байт как у мессенджеров.
    expect(site.className).toBe(tg.className);
    expect(site.className).toBe(max.className);
    // Никакого инлайн-градиента акцента на подложке не осталось.
    expect(site.getAttribute('style')).toBeNull();
    // Фирменность — в инвертированном знаке: акцентный пузырь, белый силуэт.
    const mark = site.querySelector('[data-vedar-chat-icon="true"]');
    expect(mark?.getAttribute('data-vedar-chat-variant')).toBe('accent-bubble');
    const fills = Array.from(site.querySelectorAll('path')).map((n) => n.getAttribute('fill'));
    expect(fills).toContain('var(--accent)');
    expect(fills).toContain('#FFFFFF');
  });

  it('на тёмной теме (DeskHelp) семья остаётся белым стеклом, знак читаем', () => {
    render(<KuzmichActions primaryHref="/kuzmich" tone="dark" />);
    const links = screen.getAllByRole('link');
    for (const l of links) {
      expect(l.className).toContain('bg-white/10');
      expect(l.className).toContain('border-white/30');
      expect(l.className).toContain('backdrop-blur-md');
    }
    expect(links[0].className).toBe(links[1].className);
    expect(links[0].querySelector('[data-vedar-chat-variant="accent-bubble"]')).not.toBeNull();
  });
});

// Слово владельца 23.10: «кнопки чатов хочу сделать ниже кнопки поделиться,
// размер как у иконки поделиться, сверху вниз, нижняя будет наш сайт».
describe('чаты Кузьмича в герое главной', () => {
  it('сверху вниз: Telegram, MAX, чат на сайте — последним', () => {
    render(<HeroKuzmichChats />);
    const links = screen.getAllByRole('link');
    expect(links.map((l) => l.getAttribute('aria-label'))).toEqual(['Telegram', 'MAX', 'Спросить на сайте']);
    expect(screen.getByRole('group', { name: 'Спросить Кузьмича' })).toBeTruthy();
  });

  it('те же адреса, что у единой системы; мессенджеры — в новой вкладке, сайт — нет', () => {
    render(<HeroKuzmichChats />);
    const tg = screen.getByRole('link', { name: 'Telegram' });
    const max = screen.getByRole('link', { name: 'MAX' });
    const site = screen.getByRole('link', { name: 'Спросить на сайте' });
    expect(tg.getAttribute('href')).toBe(KUZMICH_TELEGRAM_URL);
    expect(max.getAttribute('href')).toBe(KUZMICH_MAX_URL);
    expect(site.getAttribute('href')).toBe('/kuzmich');
    for (const l of [tg, max]) {
      expect(l.getAttribute('target')).toBe('_blank');
      expect(l.getAttribute('rel')).toContain('noopener');
    }
    expect(site.getAttribute('target')).toBeNull();
  });

  it('круглые кнопки героя без подписи, знаки по размеру круга «Поделиться»', () => {
    render(<HeroKuzmichChats />);
    for (const l of screen.getAllByRole('link')) {
      expect(l.className).toBe('hero-chat');
      expect(l.textContent?.trim()).toBe('');
      expect(l.getAttribute('title')).toBe(l.getAttribute('aria-label'));
    }
    expect(screen.getByRole('link', { name: 'Telegram' }).querySelector('svg')?.getAttribute('width')).toBe('22');
    expect(screen.getByRole('link', { name: 'MAX' }).querySelector('svg')?.getAttribute('width')).toBe('22');
    const mark = screen.getByRole('link', { name: 'Спросить на сайте' }).querySelector('[data-vedar-chat-icon="true"]');
    expect(mark?.getAttribute('data-vedar-chat-variant')).toBe('accent-bubble');
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
    // Инверсия для белой стеклянной кнопки: пузырь — акцентный, силуэт внутри — белый.
    expect(paths.some((n) => (n.getAttribute('fill') ?? '').includes('--accent') && (n.getAttribute('stroke') ?? '').includes('--accent'))).toBe(true);
    expect(paths.some((n) => n.getAttribute('d') === VEDAR_CHAT_MARK_PATH && n.getAttribute('fill') === '#FFFFFF')).toBe(true);
    expect(container.querySelector('img')).toBeNull();
  });
});

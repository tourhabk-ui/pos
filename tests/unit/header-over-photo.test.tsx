/**
 * Шапка красится по тому, что под ней лежит, и на любой ширине держит
 * кнопки справа и путь к турам.
 *
 * ── Что нашлось (аудит П1, #102/#104/#118) ────────────────────────────────
 *
 * До прокрутки иконки и ссылки шапки были белыми ВСЕГДА, под ними —
 * затемняющий градиент. Поверх фото это читается; на кремовом фоне светлой
 * темы поиск, тема, вход, «Ещё» и все десять ссылок давали 1.48:1. Теперь
 * белый — объявление страницы (`overPhoto`), по умолчанию — токены.
 * Замер 24.09 (Playwright, все страницы с общей шапкой, 1440 и 390): фото
 * под непрокрученной шапкой только у карточки места (PlaceHero); десктопная
 * главная начинает героя ниже шапки.
 *
 * ── Что нашлось (аудит П1, #101/#108/#119) ────────────────────────────────
 *
 * Навигация скрыта ниже xl (display:none) и выпадает из сетки
 * `1fr auto 1fr`; ряд кнопок авторазмещением уезжал в центральную дорожку.
 * А таб-бар скрыт с md — на 768–1279 в каркасе не было пути к турам.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import React from 'react';

vi.mock('next/navigation', () => ({
  usePathname: () => '/catalog',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

import { Header } from '@/components/layout/Header';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, json: () => Promise.resolve(null) })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function parts(overPhoto?: boolean) {
  const { container } = render(overPhoto ? <Header overPhoto /> : <Header />);
  const header = container.querySelector('header') as HTMLElement;
  const search = container.querySelector('button[aria-label^="Поиск"]') as HTMLElement;
  const nav = header.querySelector('nav') as HTMLElement;
  const actions = search.parentElement as HTMLElement;
  return { header, search, nav, actions };
}

describe('цвет шапки', () => {
  it('по умолчанию — токены, без градиента', () => {
    const { header, search } = parts();
    expect(search.style.color, 'белые иконки без фото под шапкой — 1.48:1 на кремовом').toBe('var(--text-secondary)');
    expect(header.style.background).not.toMatch(/gradient/);
  });

  it('поверх фото — белые иконки и градиент под ними', () => {
    const { header, search } = parts(true);
    expect(search.style.color).toMatch(/255,\s*255,\s*255/);
    expect(header.style.background).toMatch(/gradient/);
  });

  it('карточка места объявляет фото под шапкой', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('app/places/[id]/_PlaceDetailClient.tsx', 'utf-8');
    expect(src, 'PlaceHero лежит под шапкой — без overPhoto её иконки потемнеют на фото').toContain('<Header overPhoto />');
  });
});

describe('дорожки и путь к турам', () => {
  it('навигация во второй дорожке, кнопки — в третьей при любой ширине', () => {
    const { nav, actions } = parts();
    expect(nav.style.gridColumn.split('/')[0].trim()).toBe('2');
    expect(actions.style.gridColumn.split('/')[0].trim(), 'кнопки уедут в центр, когда навигация скрыта').toBe('3');
  });

  it('на md–xl есть короткая ссылка «Туры» вне <nav>', () => {
    const { header, nav } = parts();
    const short = [...header.querySelectorAll('a[href="/catalog"]')].find(a => !nav.contains(a)) as HTMLElement | undefined;
    expect(short, 'на 768–1279 в каркасе нет пути к турам').toBeTruthy();
    expect(short!.textContent).toBe('Туры');
    expect(short!.className).toMatch(/\bmd:inline-flex\b/);
    expect(short!.className).toMatch(/\bxl:hidden\b/);
    expect(short!.className).toMatch(/(^|\s)hidden\b/);
    expect(short!.style.display, 'inline display перебьёт hidden/md:inline-flex').toBe('');
  });

  // Приёмка П1: текст ссылки был var(--accent) 14px/600 — в светлой теме (она
  // по умолчанию) 3.88:1 на кремовом и 4.39:1 на --bg-card, ниже AA 4.5:1.
  // 14px/600 — не «крупный текст» (нужно >=18.66px bold). Текст — токеном,
  // который проходит AA на обоих фонах шапки в обеих темах; акцент — точкой.
  it('текст «Туры» проходит AA на фонах шапки, акцент — отдельным элементом', async () => {
    const { header, nav } = parts();
    const short = [...header.querySelectorAll('a[href="/catalog"]')].find(a => !nav.contains(a)) as HTMLElement;
    const m = short.style.color.match(/^var\((--[\w-]+)\)$/);
    expect(m, `цвет текста «Туры» не токен: ${short.style.color}`).toBeTruthy();
    const token = m![1];
    const dot = short.querySelector('[data-accent-dot]') as HTMLElement | null;
    expect(dot, 'акцент ссылки пропал вместе с цветом текста').toBeTruthy();
    expect(dot!.style.background).toBe('var(--accent)');

    const { readFileSync } = await import('node:fs');
    const css = readFileSync('app/globals.css', 'utf-8');
    const block = (sel: string) => {
      const i = css.indexOf(sel);
      expect(i, `блок ${sel} не найден в globals.css`).toBeGreaterThanOrEqual(0);
      return css.slice(i, css.indexOf('}', i));
    };
    const hex = (t: string, name: string) => {
      const r = t.match(new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6})`));
      expect(r, `токен ${name} не найден`).toBeTruthy();
      return r![1];
    };
    const lum = (h: string) => {
      const c = [1, 3, 5].map(k => parseInt(h.slice(k, k + 2), 16) / 255)
        .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const contrast = (a: string, b: string) => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
      return (x + 0.05) / (y + 0.05);
    };
    for (const sel of [':root[data-theme="light"]', ':root[data-theme="dark"]']) {
      const t = block(sel);
      // Без прокрутки шапка прозрачна над --bg-primary, после — --bg-card.
      for (const bg of ['--bg-primary', '--bg-card']) {
        const c = contrast(hex(t, token), hex(t, bg));
        expect(c, `${sel}: ${token} на ${bg} = ${c.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

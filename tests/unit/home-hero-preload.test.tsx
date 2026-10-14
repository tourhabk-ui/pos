/**
 * Фото героя главной — картинка из нарезанных WebP с предзагрузкой того же
 * srcset (14.10) — рендером, как его получает браузер (правило 13.10).
 *
 * Элемент LCP мобильной главной — фото героя. До 14.10 оно стояло фоном из
 * CSS: браузер находил его только после разбора стилей и качал JPEG целиком —
 * 165 КБ на любом экране. Замер 01.10 (Pixel 7): фото на 3,8 с; тогда
 * добавили предзагрузку того же JPEG. Прогон 9 переписи (14.10, Lighthouse,
 * мобильный профиль): LCP 4,5 с — задержка загрузки 1,4 с и сама загрузка
 * 2,0 с. Теперь — <img> из WebP: `npm run images` режет герою и родную ширину
 * (1024, 86 КБ вместо 165), и телефон с DPR 1,75 (≈ 720 px) берёт её, а не
 * JPEG. Предзагрузка несёт тот же srcset — браузер ставит в очередь ровно тот
 * файл, который возьмёт картинка.
 */
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HeroBackdrop } from '@/components/homepage/HeroBackdrop';

afterEach(cleanup);

const LIGHT = '/images/hero/hero-light.jpeg';
const DARK = '/images/hero/hero-dark.jpeg';

function hero(src: string) {
  const { container } = render(<HeroBackdrop src={src} />);
  const img = container.querySelector('img');
  if (!img) throw new Error('картинки героя нет');
  return img;
}

describe('фото героя главной', () => {
  it('WebP по ширине экрана, не JPEG целиком: есть 640 и родные 1024', () => {
    const img = hero(LIGHT);
    expect(img.getAttribute('src')).toBe('/images/hero/hero-light.1024.webp');
    const srcset = img.getAttribute('srcset') ?? '';
    expect(srcset).toContain('/images/hero/hero-light.640.webp 640w');
    expect(srcset).toContain('/images/hero/hero-light.1024.webp 1024w');
    expect(srcset).not.toContain('.jpeg');
    expect(img.getAttribute('sizes')).toBe('100vw');
  });

  it('первый экран: высокий приоритет, без ленивой загрузки; декор — alt пустой', () => {
    const img = hero(LIGHT);
    expect(img.getAttribute('fetchpriority')).toBe('high');
    expect(img.getAttribute('loading')).toBeNull();
    expect(img.getAttribute('alt')).toBe('');
  });

  it('предзагрузка — тот же srcset и тот же приоритет: второй загрузки нет', () => {
    const img = hero(LIGHT);
    const link = document.querySelector('link[rel="preload"][as="image"]');
    expect(link, 'предзагрузки нет').not.toBeNull();
    expect(link?.getAttribute('imagesrcset')).toBe(img.getAttribute('srcset'));
    expect(link?.getAttribute('imagesizes')).toBe('100vw');
    expect(link?.getAttribute('fetchpriority')).toBe('high');
  });

  it('тёмная тема — своё фото, тоже WebP родной ширины', () => {
    const img = hero(DARK);
    expect(img.getAttribute('src')).toBe('/images/hero/hero-dark.1024.webp');
    expect(img.getAttribute('srcset')).not.toContain('.jpeg');
  });

  it('главная не ставит героя фоном из CSS — та же поздняя загрузка JPEG', () => {
    const src = readFileSync(join(process.cwd(), 'app/_home/_HomeV8Client.tsx'), 'utf-8');
    expect(src).not.toMatch(/className="hero-photo" style=\{\{ backgroundImage/);
    expect(src).not.toMatch(/\.hero-photo\{[^}]*background-size/);
  });
});

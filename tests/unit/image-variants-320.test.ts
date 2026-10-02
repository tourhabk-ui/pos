/**
 * Плитки берут снимок по размеру клетки (аудит 02.10).
 *
 * Герой каталога шёл оригиналом JPEG 1280 px (576 КБ) в клетку 412×151 на
 * телефоне; филмстрип тура — 640-вариантами (153 КБ) в клетки 89×89. Нарезка
 * получила ширину 320, а оба места — srcSet из нарезанных ширин, чтобы
 * браузер выбирал по экрану. Снимок без вариантов (S3, загрузка оператора)
 * по-прежнему едет оригиналом — photoSrcSet для него undefined.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { photoSrc, photoSrcSet } from '@/lib/images/variant';
import manifest from '@/lib/images/photo-variants.json';

const CARD = readFileSync('app/catalog/tours/[id]/_TourDetailClient.tsx', 'utf8');
const CATALOG = readFileSync('components/marketplace/MarketplaceClient.tsx', 'utf8');
const SCRIPT = readFileSync('scripts/optimize-images.mjs', 'utf8');

describe('ширина 320 нарезана и подключена', () => {
  it('скрипт нарезки знает 320 и не принимает свои варианты за исходники', () => {
    expect(SCRIPT).toMatch(/const WIDTHS = \[320, 640, 1280\]/);
    expect(SCRIPT).toMatch(/\\\.\(320\|640\|1280\)\\\.webp\$/);
  });

  it('у каждого фото манифеста есть 320', () => {
    const without = (manifest as Array<{ src: string; widths: number[] }>).filter((e) => !e.widths.includes(320)).map((e) => e.src);
    expect(without, without.join('\n')).toEqual([]);
  });

  it('photoSrc отдаёт 320 и srcSet перечисляет все ширины', () => {
    const hero = '/images/marketplace/hero-marketplace.jpg';
    expect(photoSrc(hero, 320)).toBe('/images/marketplace/hero-marketplace.320.webp');
    expect(photoSrcSet(hero)).toBe('/images/marketplace/hero-marketplace.320.webp 320w, /images/marketplace/hero-marketplace.640.webp 640w, /images/marketplace/hero-marketplace.1280.webp 1280w');
  });

  it('филмстрип тура: 320 по умолчанию, srcSet и sizes по клетке', () => {
    const i = CARD.indexOf('photoSrc(src, 320)');
    expect(i).toBeGreaterThan(0);
    const film = CARD.slice(i - 100, i + 400);
    expect(film).toContain('srcSet={photoSrcSet(src)}');
    expect(film).toMatch(/sizes="\(max-width: 640px\) 25vw, 15vw"/);
  });

  it('герой каталога: srcSet из WebP, приоритет загрузки, без оригинала JPEG в src', () => {
    const i = CATALOG.indexOf('srcSet={photoSrcSet(HERO_SRC)}');
    expect(i).toBeGreaterThan(0);
    const hero = CATALOG.slice(i - 300, i + 300);
    expect(hero).toContain('src={photoSrc(HERO_SRC, 1280)}');
    expect(hero).toContain('fetchPriority="high"');
    expect(hero).toContain('sizes="100vw"');
    expect(CATALOG).not.toMatch(/src="\/images\/marketplace\/hero-marketplace\.jpg"/);
  });
});

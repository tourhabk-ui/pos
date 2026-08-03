/**
 * Подробная карточка тура — колоночная раскладка + язык Ведара (выбор владельца).
 *
 * Владелец выбрал «колонки»: кино-герой, контент слева, липкая бронь справа,
 * шрифты платформы (Unbounded/JetBrains), светлый турист-вид. При переносе в код
 * обязаны сохраниться рабочие интеграции: бронь-форма, «написать оператору»,
 * предупреждения безопасности, партнёрские блоки, избранное, якорь #booking
 * (на него ведёт «Забронировать» из каталога). Сторож исходника.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(process.cwd(), 'app/marketplace/tours/[id]/_TourDetailClient.tsx'), 'utf-8');

describe('подробная карточка тура — колонки + Ведар', () => {
  it('двухколоночная раскладка (контент + сайдбар)', () => {
    expect(src.includes('lg:grid-cols-12')).toBe(true);
    expect(src.includes('lg:col-span-8')).toBe(true);
    expect(src.includes('lg:col-span-4')).toBe(true);
  });
  // Раньше здесь требовался Unbounded — но CLAUDE.md §2 и .claude/DESIGN_SYSTEM.md
  // называют дисплейным шрифтом платформы Playfair Display. Сторож закреплял
  // дрейф карточки от документированного языка; при вводе стандарта карточки
  // тура (§11, 03.08) выровняли по документу.
  it('дисплей-шрифт платформы Playfair (голос края, §2)', () => {
    expect(src).toMatch(/font-playfair/);
    expect(src).not.toMatch(/font-unbounded/);
  });
  it('липкая бронь справа', () => {
    expect(src).toMatch(/lg:sticky/);
  });
  it('сохранены рабочие интеграции', () => {
    for (const c of ['BookingFormClient', 'MessageOperatorButton', 'SafetyWarnings', 'RouteAffiliateBlock', 'YandexTravelBlock']) {
      expect(src.includes(`<${c}`)).toBe(true);
    }
  });
  it('якорь #booking сохранён (на него ведёт «Забронировать» из каталога)', () => {
    expect(src.includes('id="booking"')).toBe(true);
  });
  it('избранное и галерея-лайтбокс на месте', () => {
    expect(src.includes('handleWishlist')).toBe(true);
    expect(src.includes('Lightbox')).toBe(true);
  });
});

/**
 * Избранное и рейтинг на карточке тура — владелец 07.08:
 * «кнопка добавить в избранное не работает» и «если есть отзывы нужен и
 * рейтинг это логично».
 *
 * Избранное не работало по трём причинам сразу:
 *  1. DELETE: клиент шлёт JSON {itemType, itemId}, сервер ждал только ?id= —
 *     снять из избранного с карточки было нельзя никогда;
 *  2. состояние не читалось при загрузке — после перезагрузки всегда пустое
 *     сердце, даже если тур в избранном;
 *  3. все ошибки глотались молча (catch { /* silent *\/ }) — «Профиль не
 *     найден» и настоящий сбой выглядели одинаково: клик без последствий.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { plural } from '@/lib/home/data-freshness';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

describe('избранное: контракт удаления и честность клиента', () => {
  it('DELETE принимает {itemType, itemId} — формат, который шлёт карточка', () => {
    const src = read('app/api/tourist/wishlist/route.ts');
    expect(src).toMatch(/item_type = \$2 AND item_id = \$3/);
    // Старый контракт ?id= сохранён — им пользуется ЛК.
    expect(src).toMatch(/searchParams\.get\('id'\)/);
  });

  it('карточка читает реальное состояние избранного при загрузке', () => {
    const src = read('app/marketplace/tours/[id]/_TourDetailClient.tsx');
    expect(src).toMatch(/\/api\/tourist\/wishlist\?type=tour/);
    expect(src).toMatch(/setWishlisted\(true\)/);
  });

  it('отказ сервера показывается словами, а не глотается', () => {
    const src = read('app/marketplace/tours/[id]/_TourDetailClient.tsx');
    expect(src).toMatch(/setWishlistError\(data\.error/);
    expect(src).toMatch(/\{wishlistError\}/);
    // Молчаливого catch в обработчике избранного больше нет.
    const handler = src.slice(src.indexOf('const handleWishlist'), src.indexOf('const handleShare'));
    expect(handler).not.toMatch(/\/\* silent \*\//);
  });
});

describe('рейтинг живёт от отзывов', () => {
  it('публикация отзыва пересчитывает rating и review_count тура', () => {
    const src = read('app/api/reviews/tour/[tourId]/route.ts');
    expect(src).toMatch(/UPDATE operator_tours SET/);
    expect(src).toMatch(/AVG\(rating\)/);
    expect(src).toMatch(/COUNT\(\*\) FROM operator_tour_reviews/);
  });

  it('секция отзывов показывает сводку рейтинга при наличии отзывов', () => {
    const src = read('app/marketplace/tours/[id]/_TourDetailClient.tsx');
    expect(src).toMatch(/reviews\.length > 0 && rating > 0 &&/);
    // Склонение — общим хелпером, не своей копией (урок «1 событий»).
    expect(src).toMatch(/plural\(tour\.review_count/);
  });

  it('склонение отзывов правильное', () => {
    expect(plural(1, 'отзыв', 'отзыва', 'отзывов')).toBe('отзыв');
    expect(plural(3, 'отзыв', 'отзыва', 'отзывов')).toBe('отзыва');
    expect(plural(11, 'отзыв', 'отзыва', 'отзывов')).toBe('отзывов');
    expect(plural(21, 'отзыв', 'отзыва', 'отзывов')).toBe('отзыв');
  });
});

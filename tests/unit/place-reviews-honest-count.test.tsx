/**
 * Отзывы о месте: сводка по всем отзывам и прямое слово о том, кто их пишет
 * (15.10, §0 «честность»).
 *
 * Средняя и число считались по последним десяти, которые показывает карточка:
 * место с тридцатью отзывами писало «4.3 · 10». И отзыв о месте оставляют без
 * входа и без проверки поездки, публикуется он сразу — звёзды без этой строки
 * читались бы как проверенная оценка.
 *
 * Судится рендером блока; сводка SQL выполнена на PostgreSQL при правке.
 */
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import PlaceReviews from '@/components/places/PlaceReviews';

afterEach(cleanup);

const ten = Array.from({ length: 10 }, (_, i) => ({
  id: `r${i}`, rating: 5, comment: 'Красиво', authorName: 'Анна П.', createdAt: '2026-10-01T00:00:00.000Z',
}));

describe('отзывы о месте', () => {
  it('сводка — по всем отзывам, а не по показанным десяти', () => {
    const { container } = render(<PlaceReviews placeId="p" reviews={ten} summary={{ total: 30, avg: 4.3 }} />);
    expect(container.textContent).toContain('4.3 · 30');
    expect(container.textContent).not.toContain('· 10');
  });

  it('сказано, кто пишет: без входа и без проверки поездки', () => {
    const { container } = render(<PlaceReviews placeId="p" reviews={ten} summary={{ total: 30, avg: 4.3 }} />);
    expect(container.textContent).toContain('без входа и без проверки поездки');
  });

  it('нет отзывов — нет и числа', () => {
    const { container } = render(<PlaceReviews placeId="p" reviews={[]} summary={{ total: 0, avg: null }} />);
    expect(container.textContent).toContain('Отзывов пока нет');
    expect(container.textContent).not.toMatch(/\d · \d/);
    expect(container.textContent).not.toContain('без проверки поездки');
  });
});

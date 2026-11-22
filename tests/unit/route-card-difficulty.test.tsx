// @vitest-environment jsdom
/**
 * Сложность на карточке маршрута в каталоге (22.11).
 *
 * Карточка подставляла «Лёгкий» на любую незаписанную сложность и на
 * `extreme` — которого в её словаре не было. Ключевская сопка (миграция 1493:
 * «экстремальный») в каталоге выглядела лёгкой. Держит рендером: неизвестная —
 * без бейджа, экстремальная — своим словом, слово паспорта — кодом.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';

vi.mock('@/hooks/use-wishlist', () => ({
  useWishlist: () => ({ on: false, busy: false, localOnly: false, toggle: () => {} }),
  wishlistLabel: () => 'В избранное',
  WISHLIST_LOCAL_ONLY_HINT: '',
}));
import RoutePathCard from '@/components/routes/RoutePathCard';
import { difficultyCode } from '@/lib/routes/difficulty-scale';

afterEach(() => cleanup());

const base = {
  id: '11111111-1111-4111-8111-111111111111', kind: 'route' as const, urlSlug: 'vulkan-klyuchevskaya-sopka-413a7499',
  category: 'trekking', title: 'Вулкан Ключевская сопка', description: 'Восхождение на 4750 м.',
  lat: null, lng: null, durationDays: null,
};

const badge = (difficulty: string | null) => {
  const { container } = render(<RoutePathCard route={{ ...base, difficulty }} />);
  return container.querySelector('[data-testid="route-card-difficulty"]')?.textContent ?? null;
};

describe('карточка маршрута: сложность', () => {
  it('экстремальный — словом, а не «Лёгкий»', () => {
    expect(badge('extreme')).toBe('Экстремальный');
  });

  it('незаписанная и нераспознанная — без бейджа', () => {
    expect(badge(null)).toBeNull();
    cleanup();
    expect(badge('по договорённости')).toBeNull();
  });

  it('слово паспорта и код — одна ступень', () => {
    expect(badge('сложный')).toBe('Сложный');
    cleanup();
    expect(badge('easy')).toBe('Лёгкий');
  });
});

describe('difficultyCode', () => {
  it('коды, слова, moderate; прочее — null', () => {
    expect(difficultyCode('extreme')).toBe('extreme');
    expect(difficultyCode('Экстремальный')).toBe('extreme');
    expect(difficultyCode('лёгкий')).toBe('easy');
    expect(difficultyCode('средней сложности')).toBe('medium');
    expect(difficultyCode('moderate')).toBe('medium');
    expect(difficultyCode('сложный')).toBe('hard');
    expect(difficultyCode('')).toBeNull();
    expect(difficultyCode(null)).toBeNull();
    expect(difficultyCode(3)).toBeNull();
  });
});

/**
 * Карточка места называет, откуда координата, рядом с GPX и путём к месту
 * (15.10, §0 «честность»).
 *
 * Угаданная геокодером по названию точка и снятая на месте лежали в базе
 * неотличимо, и карточка вела к обеим одной кнопкой и одним файлом.
 * Происхождение пишется в places.coord_source (lib/places/coord-source.ts),
 * но карточка его не читала.
 *
 * Судится рендером строки и вызовом загрузчика с подставной базой.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import PlaceCoordSource from '@/components/places/PlaceCoordSource';

afterEach(cleanup);

const text = (source: Parameters<typeof PlaceCoordSource>[0]['source']) => {
  const { container } = render(<PlaceCoordSource source={source} />);
  return container.textContent ?? '';
};

describe('строка происхождения координаты', () => {
  it('угаданная по названию — сказано, и сказано, что делать', () => {
    expect(text('geocoded')).toContain('угадана по названию');
  });

  it('заглушка — не идти по точке', () => {
    expect(text('placeholder')).toContain('по этой точке не идите');
  });

  it('не записано — так и сказано', () => {
    expect(text('unknown')).toContain('у нас не записано');
  });

  it('снятая на месте и из справочника — без строки', () => {
    expect(text('surveyed')).toBe('');
    cleanup();
    expect(text('external')).toBe('');
  });
});

describe('загрузчик карточки отдаёт происхождение координаты', () => {
  const load = async (coord_source: string | null) => {
    vi.resetModules();
    vi.doMock('@/lib/database', () => ({
      query: async (sql: string) => ({
        rows: /FROM places p\s+LEFT JOIN place_description_drafts/.test(sql)
          ? [{ place_pk: 'test-place-0001', ark_id: '22222222-2222-2222-2222-222222222222', name: 'Озеро', lat: 53, lng: 158, location_type: 'lake', photo_count: 0, coord_source }]
          : [],
      }),
    }));
    vi.doMock('@/lib/db-pool', () => ({ pool: { query: async () => ({ rows: [] }) } }));
    const { loadPlaceDetail } = await import('@/lib/places/place-detail');
    const r = await loadPlaceDetail('test-place-0001', { countView: false });
    return (r.body.data as { coordSource?: string }).coordSource;
  };

  it('значение базы — к перечню; незнакомое — «не записано»', async () => {
    expect(await load('geocoded')).toBe('geocoded');
    expect(await load('osm_organic_930')).toBe('unknown');
    expect(await load(null)).toBe('unknown');
  });
});

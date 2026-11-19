/**
 * lastmod страниц-списков — по их содержимому, а не «сейчас» (аудит 01.10).
 *
 * `new Date()` у /places, /routes, /catalog объявлял «изменено сейчас» на
 * каждом запросе sitemap, и поисковик переставал верить lastmod сайта.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const query = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));

import { collectSitemapEntriesWithStatus, latestModified } from '@/lib/seo/sitemap-entries';

const OLD = new Date('2026-08-01T00:00:00Z');
const NEW = new Date('2026-09-15T00:00:00Z');

beforeEach(() => {
  query.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('lastmod списков', () => {
  it('список мест — самая поздняя дата его мест', async () => {
    query.mockImplementation((sql: string) => {
      if (String(sql).includes('FROM places')) {
        return Promise.resolve({ rows: [
          { ark_id: 'a', slug: 'a', updated_at: OLD, location_type: 'lake' },
          { ark_id: 'b', slug: 'b', updated_at: NEW, location_type: 'lake' },
        ] });
      }
      return Promise.resolve({ rows: [] });
    });
    const { entries } = await collectSitemapEntriesWithStatus();
    const places = entries.find(e => e.url === 'https://vedarai.ru/places');
    expect(new Date(places!.lastModified!).toISOString()).toBe(NEW.toISOString());
  });

  it('секция не прочиталась — дата списка не выдумывается из пустоты', async () => {
    query.mockImplementation((sql: string) =>
      String(sql).includes('FROM places') ? Promise.reject(new Error('boom')) : Promise.resolve({ rows: [] }));
    const { entries } = await collectSitemapEntriesWithStatus();
    expect(entries.find(e => e.url === 'https://vedarai.ru/places')).toBeTruthy();
  });

  // 19.11 (задача индексации): посадочные под запросы стояли с `new Date()`.
  it('посадочная под запрос — дата её туров; туров не прочиталось — даты нет, а не «сейчас»', async () => {
    query.mockImplementation((sql: string) => {
      if (String(sql).includes('FROM operator_tours')) {
        return Promise.resolve({ rows: [
          { id: 1, slug: 'tur-a', updated_at: OLD },
          { id: 2, slug: 'tur-b', updated_at: NEW },
        ] });
      }
      return Promise.resolve({ rows: [] });
    });
    const withTours = (await collectSitemapEntriesWithStatus()).entries;
    const bears = withTours.find(e => e.url === 'https://vedarai.ru/tury-medvedi-kamchatka');
    expect(new Date(bears!.lastModified!).toISOString()).toBe(NEW.toISOString());

    query.mockImplementation((sql: string) =>
      String(sql).includes('FROM operator_tours') ? Promise.reject(new Error('boom')) : Promise.resolve({ rows: [] }));
    const noTours = (await collectSitemapEntriesWithStatus()).entries;
    const bears2 = noTours.find(e => e.url === 'https://vedarai.ru/tury-medvedi-kamchatka');
    expect(bears2).toBeTruthy();
    expect(bears2!.lastModified).toBeUndefined();
  });

  it('latestModified', () => {
    expect(latestModified([])).toBeNull();
    expect(latestModified([{ url: 'x', lastModified: OLD }, { url: 'y', lastModified: NEW }, { url: 'z' }])?.toISOString())
      .toBe(NEW.toISOString());
  });
});

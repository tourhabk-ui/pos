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

  it('latestModified', () => {
    expect(latestModified([])).toBeNull();
    expect(latestModified([{ url: 'x', lastModified: OLD }, { url: 'y', lastModified: NEW }, { url: 'z' }])?.toISOString())
      .toBe(NEW.toISOString());
  });
});

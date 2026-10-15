/**
 * Китайские конспекты в sitemap — вызовом сборщика с подменённой базой (аудит
 * 15.10, CN-pages).
 *
 * В sitemap идут /zh/tours/* и /zh/places/* только с переводом, сделанным с
 * нынешнего текста: страница без перевода открывается, но китайскому поиску
 * её не предлагают — он получил бы русский текст под китайским адресом.
 * lastmod — дата перевода. Отказ чтения — секция в degraded (sitemap не
 * кэшируется), а не «китайских страниц нет».
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const poolQuery = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => poolQuery(...a) } }));
vi.mock('@/lib/database', () => ({ query: vi.fn(async () => ({ rows: [] })) }));

import { collectSitemapEntriesWithStatus } from '@/lib/seo/sitemap-entries';
import { normalizeSource, sourceHash } from '@/lib/zh/fields';

const BASE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

const tour = (id: string, slug: string | null, title: string, description: string | null) => ({
  id, slug, title, short_description: null, description, program: null, included: null, not_included: null,
  what_to_bring: null, base_price: '1000', price_unit: 'per_person', duration_hours: '8',
  max_participants: 10, season_start: null, season_end: null, safety_notes: null,
  operator_name: 'Тест', operator_slug: null, operator_public: null,
});

const TOURS = [
  tour('51', 'dolina-geyzerov', 'Долина гейзеров', 'Вылет утром.'),
  tour('52', null, 'Без адреса', null),
  tour('53', 'bez-perevoda', 'Без перевода', 'Описание.'),
  tour('54', 'polovina', 'Половина', 'Описание без перевода.'),
];
const PLACES = [
  { id: 'p-1', slug: 'kronotskij-zapovednik', ark_id: null, name: 'Кроноцкий заповедник', description: 'Заповедник.', lat: '54.8', lng: '160.6', altitude_m: null, hazard_types: null, profile_source: null },
  { id: 'p-2', slug: 'bez-opisaniya', ark_id: null, name: 'Без описания', description: null, lat: '53', lng: '158', altitude_m: null, hazard_types: null, profile_source: null },
];

const row = (entity_id: string, field: string, raw: string, at: string) => ({
  entity_id, field, text: '中文', source_hash: sourceHash('text', normalizeSource('text', raw) as string), translated_at: at, reviewed_at: null,
});

const TRANSLATIONS = [
  row('51', 'title', 'Долина гейзеров', '2026-10-15T09:00:00Z'),
  row('51', 'description', 'Вылет утром.', '2026-10-15T10:00:00Z'),
  row('52', 'title', 'Без адреса', '2026-10-14T00:00:00Z'),
  // У 54 переведено только название — описание без перевода: не индексируется.
  row('54', 'title', 'Половина', '2026-10-14T00:00:00Z'),
  row('p-1', 'description', 'Заповедник.', '2026-10-13T00:00:00Z'),
];

let failTranslations = false;

beforeEach(() => {
  failTranslations = false;
  poolQuery.mockReset();
  poolQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    const s = String(sql);
    if (s.includes('FROM content_translations')) {
      if (failTranslations) throw Object.assign(new Error('relation "content_translations" does not exist'), { code: '42P01' });
      const [entityType] = (params ?? []) as [string];
      return { rows: TRANSLATIONS.filter((t) => (entityType === 'place') === t.entity_id.startsWith('p-')) };
    }
    if (s.includes('ot.short_description')) return { rows: TOURS };
    if (s.includes('rw_zh') && s.includes('FROM places p')) return { rows: PLACES };
    return { rows: [] };
  });
});

describe('sitemap: китайские конспекты — только с переводом', () => {
  it('переведённые тур и место — в sitemap с датой перевода; без перевода и с половиной перевода — нет', async () => {
    const { entries, degraded } = await collectSitemapEntriesWithStatus();
    expect(degraded).toEqual([]);
    const zh = entries.filter((e) => e.url.includes('/zh/'));
    expect(zh.map((e) => e.url).sort()).toEqual([
      `${BASE}/zh/places/kronotskij-zapovednik`,
      `${BASE}/zh/tours/52`,
      `${BASE}/zh/tours/dolina-geyzerov`,
    ]);
    const geyser = zh.find((e) => e.url.endsWith('/dolina-geyzerov'));
    expect(new Date(geyser?.lastModified as Date).toISOString()).toBe('2026-10-15T10:00:00.000Z');
    // Сам /zh — по-прежнему в списке.
    expect(entries.some((e) => e.url === `${BASE}/zh`)).toBe(true);
  });

  it('исходник правили — перевод устарел, страница уходит из sitemap', async () => {
    TOURS[0] = tour('51', 'dolina-geyzerov', 'Долина гейзеров', 'Вылет вечером.');
    try {
      const { entries } = await collectSitemapEntriesWithStatus();
      expect(entries.some((e) => e.url.endsWith('/zh/tours/dolina-geyzerov'))).toBe(false);
    } finally {
      TOURS[0] = tour('51', 'dolina-geyzerov', 'Долина гейзеров', 'Вылет утром.');
    }
  });

  it('переводы не прочитались — секция в degraded, а не «китайских страниц нет»; остальной sitemap цел', async () => {
    failTranslations = true;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { entries, degraded } = await collectSitemapEntriesWithStatus();
    expect(degraded).toContain('китайские страницы');
    expect(entries.some((e) => e.url.includes('/zh/tours/'))).toBe(false);
    expect(entries.some((e) => e.url === `${BASE}/zh`)).toBe(true);
    err.mockRestore();
  });
});

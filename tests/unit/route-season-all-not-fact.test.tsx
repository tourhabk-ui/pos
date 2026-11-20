/**
 * Код сезона `all` — не факт (#3568, 20.11). Импорт паспортов ставил его по
 * умолчанию, когда в имени PDF не было «winter»/«summer», и карточка писала
 * «Круглый год» маршрутам, закрытым зимой (Плоский Толбачик — июнь–сентябрь;
 * сверка 20.11: 36 таких маршрутов из 127 паспортов). Проверки — вызовом:
 * импорт, подпись карточки, подпись для MCP и Editor, сниппет поиска.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));

import { parseRoutes } from '@/lib/services/ingest/visitkamchatka-importer';
import { seasonLabel } from '@/lib/routes/season-label';
import { routeSeasonLabel } from '@/lib/places/zone-labels';
import { routeFactsLine } from '@/lib/seo/place-meta';

const UP = 'https://visitkamchatka.ru/upload/route_passports';

describe('импорт паспортов: имя файла без сезона — сезон не записан', () => {
  it('tolbachik.pdf — null, winter/summer в имени — свой сезон', () => {
    const md = [
      `[Восхождение на Плоский Толбачик (PDF)](${UP}/tolbachik.pdf)`,
      `[Вилючинский водопад зимний (PDF)](${UP}/vilyuchinsky_waterfall_winter.pdf)`,
      `[Бабий камень (PDF)](${UP}/babiy_summer.PDF)`,
    ].join('\n');
    expect(parseRoutes(md, true).map((r) => [r.filename, r.season])).toEqual([
      ['tolbachik.pdf', null],
      ['vilyuchinsky_waterfall_winter.pdf', 'winter'],
      ['babiy_summer.PDF', 'summer'],
    ]);
  });
});

describe('подписи: `all` не становится «круглым годом»', () => {
  it('карточка маршрута', () => {
    expect(seasonLabel('all')).toBeNull();
    expect(seasonLabel('ALL')).toBeNull();
    expect(seasonLabel('summer')).toBe('Лето');
    // Подтверждённый текст миграции (образец 1385) — как есть.
    expect(seasonLabel('круглый год (паспорт КГБУ)')).toBe('круглый год (паспорт КГБУ)');
  });

  it('MCP и Editor: список кодов без `all`', () => {
    expect(routeSeasonLabel('all')).toBeNull();
    expect(routeSeasonLabel('summer, all')).toBe('лето');
    expect(routeSeasonLabel('winter, spring')).toBe('зима, весна');
  });

  it('сниппет поиска: ни «сезон all», ни «круглый год»', () => {
    const base = { distanceKm: 12, elevationGainM: null, durationHours: null, durationDays: null, difficulty: null } as const;
    const line = routeFactsLine({ ...base, season: 'all' } as Parameters<typeof routeFactsLine>[0]);
    expect(line).toBe('12 км');
    expect(routeFactsLine({ ...base, season: 'summer, autumn' } as Parameters<typeof routeFactsLine>[0])).toBe('12 км · сезон лето, осень');
    expect(routeFactsLine({ ...base, season: 'Июнь–сентябрь' } as Parameters<typeof routeFactsLine>[0])).toBe('12 км · сезон июнь–сентябрь');
  });
});

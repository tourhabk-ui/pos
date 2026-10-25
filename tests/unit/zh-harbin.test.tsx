// @vitest-environment node
/**
 * Страница «从哈尔滨飞往堪察加»: факты рейса и указа — из модуля со ссылками,
 * недельные туры — только с записанной длительностью 7 или 8 дней.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { HarbinFlight } from '@/components/zh/HarbinFlight';
import {
  HARBIN_PAGE, HARBIN_SOURCES, isSaturdayWeekTour, tourLengthDays,
} from '@/lib/zh/harbin';
import { ZH_PAGE_PATHS, catalogHreflang } from '@/lib/zh/pages';
import { ZH_CATALOG } from '@/lib/zh/catalog-copy';
import type { ZhTourRow } from '@/lib/zh/entry';

const tour = (id: string, hours: string | null): ZhTourRow => ({
  id, slug: `t-${id}`, title: `Тур ${id}`, base_price: '50000', price_unit: 'per_person',
  duration_hours: hours, operator_name: 'Оператор', operator_slug: null, operator_public: false,
});

describe('харбинский рейс', () => {
  it('называет IO-771/772, субботу, 3.5 часа, указ 872 до 2027-12-31 и официальные ссылки', () => {
    const html = renderToStaticMarkup(<HarbinFlight tours={[]} />);
    expect(html).toContain(HARBIN_PAGE.h1);
    expect(html).toContain('IO-771');
    expect(html).toContain('IO-772');
    expect(html).toContain('周六');
    expect(html).toContain('3.5');
    expect(html).toContain('872');
    expect(html).toContain('2027-12-31');
    expect(html).toContain('30');
    expect(html).toContain(HARBIN_PAGE.toursEmpty);
    expect(html).not.toContain('内容为俄文');
    for (const s of HARBIN_SOURCES) expect(html).toContain(s.url);
    expect(html).not.toMatch(/\d{1,2}:\d{2}/);
  });

  it('недельный тур в списке, однодневный и без длительности — нет', () => {
    expect(isSaturdayWeekTour(tourLengthDays({ duration_hours: 24 * 7 }))).toBe(true);
    expect(isSaturdayWeekTour(tourLengthDays({ duration_type: 'multi_day', multi_day_count: 8 }))).toBe(true);
    expect(tourLengthDays({ duration_type: 'multi_day', multi_day_count: null, duration_hours: 168 })).toBe(7);
    expect(tourLengthDays({ duration_type: 'multi_day', multi_day_count: 5, duration_hours: 168 })).toBe(5);
    expect(isSaturdayWeekTour(tourLengthDays({ duration_hours: 8 }))).toBe(false);
    expect(isSaturdayWeekTour(tourLengthDays({ duration_type: 'multi_day', multi_day_count: null }))).toBe(false);
    expect(tourLengthDays({})).toBeNull();

    const html = renderToStaticMarkup(<HarbinFlight tours={[tour('1', String(24 * 7))]} />);
    expect(html).toContain('href="/zh/tours/t-1"');
    expect(html).toContain('50,000 卢布');
    expect(html).toContain('约 7 天');
    expect(html).not.toContain(HARBIN_PAGE.toursEmpty);
  });

  it('отказ базы назван, а не пустым списком', () => {
    const html = renderToStaticMarkup(<HarbinFlight tours={null} />);
    expect(html).toContain('目录暂时不可用');
    expect(html).not.toContain(HARBIN_PAGE.toursEmpty);
  });

  it('адреса каталога и Харбина в общем списке китайских страниц, hreflang каталога взаимен', () => {
    expect(ZH_PAGE_PATHS).toContain('/zh/harbin');
    expect(ZH_PAGE_PATHS).toContain('/zh/catalog');
    expect(catalogHreflang('https://vedarai.ru/')).toEqual({
      ru: 'https://vedarai.ru/catalog',
      'zh-CN': 'https://vedarai.ru/zh/catalog',
    });
    expect(ZH_CATALOG.description.length).toBeLessThanOrEqual(160);
    expect(HARBIN_PAGE.description.length).toBeLessThanOrEqual(160);
    expect(ZH_CATALOG.description).not.toContain('内容为俄文');
  });
});

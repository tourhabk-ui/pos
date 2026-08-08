/**
 * Программатик-SEO страницы планов («Мой план 2.0», A-1; владелец 08.08:
 * «план мне нравится, реализуем»).
 *
 * Разведка TAAFT: 84 планировщика, ни одной индексируемой страницы про
 * Камчатку с реальной бронью. /plans/[slug] закрывает нишу: recommendTrip
 * собирает дни, страница ведёт к брони.
 *
 * Сторож держит три опасности программатик-SEO (skill seo-programmatic):
 *  1. thin content — интро каждого пресета рукописное и уникальное;
 *  2. сборка без БД — generateStaticParams запрещён (Docker-билд Timeweb
 *     уронил бы деплой при прогреве), только ISR по запросу;
 *  3. расхождение sitemap с роутом — sitemap строится из тех же пресетов.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLAN_PRESETS, findPlanPreset } from '@/lib/plans/presets';

const ROOT = process.cwd();
const PAGE = readFileSync(join(ROOT, 'app/plans/[slug]/page.tsx'), 'utf-8');
const HUB = readFileSync(join(ROOT, 'app/plans/page.tsx'), 'utf-8');
const SITEMAP = readFileSync(join(ROOT, 'app/sitemap.ts'), 'utf-8');
const SHARE_API = readFileSync(join(ROOT, 'app/api/trips/share/[token]/route.ts'), 'utf-8');

// Ключи INTEREST_TO_ZONES движка (lib/planner/engine.ts). Пресет с опечаткой
// в интересе дал бы пустой план на каждой загрузке — молча.
const ENGINE_INTERESTS = new Set([
  'volcano', 'fishing', 'bears', 'helicopter', 'thermal', 'trekking',
  'snowmobile', 'sea', 'hot_spring', 'geyser', 'mountain', 'river', 'boat_trip',
]);

describe('пресеты: качество программатик-контента', () => {
  it('слаги уникальны и в едином формате', () => {
    const slugs = PLAN_PRESETS.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of slugs) expect(s).toMatch(/^kamchatka-za-\d+-dney-[a-z-]+$/);
  });

  it('интро рукописные: длинные и не повторяются (гард от thin content)', () => {
    const intros = PLAN_PRESETS.map((p) => p.intro);
    expect(new Set(intros).size).toBe(intros.length);
    for (const p of PLAN_PRESETS) {
      expect(p.intro.length, p.slug).toBeGreaterThanOrEqual(150);
      expect(p.description.length, p.slug).toBeGreaterThanOrEqual(80);
    }
  });

  it('интересы каждого пресета — реальные ключи движка', () => {
    for (const p of PLAN_PRESETS) {
      expect(p.interests.length, p.slug).toBeGreaterThan(0);
      for (const i of p.interests) {
        expect(ENGINE_INTERESTS.has(i), `${p.slug}: неизвестный интерес «${i}»`).toBe(true);
      }
    }
  });

  it('findPlanPreset находит свои и не выдумывает чужих', () => {
    expect(findPlanPreset('kamchatka-za-7-dney-vulkany')?.days).toBe(7);
    expect(findPlanPreset('kamchatka-za-99-dney-nlo')).toBeUndefined();
  });
});

describe('страница /plans/[slug]', () => {
  it('ISR по запросу, БЕЗ прогрева на билде (БД в Docker-сборке недоступна)', () => {
    expect(PAGE).toMatch(/export const revalidate = 86400/);
    expect(PAGE).not.toMatch(/function generateStaticParams/);
  });

  it('неизвестный слаг — notFound, движок в try/catch (500 недопустим)', () => {
    expect(PAGE).toMatch(/if \(!preset\) notFound\(\)/);
    expect(PAGE).toMatch(/catch \{ \/\* план живёт на интро и CTA \*\/ \}/);
  });

  it('план ведёт к брони и несёт JSON-LD и канонику', () => {
    expect(PAGE).toMatch(/\/catalog\/tours\/\$\{tour\.id\}/);
    expect(PAGE).toMatch(/TouristTrip/);
    expect(PAGE).toMatch(/alternates: \{ canonical:/);
  });

  it('JSON-LD — только через экранирующую обёртку (XSS: «<» из БД в script)', () => {
    expect(PAGE).toMatch(/<JsonLd data=\{jsonLd\} \/>/);
    expect(PAGE).not.toMatch(/dangerouslySetInnerHTML/);
    const WRAPPER = readFileSync(join(ROOT, 'components/seo/JsonLd.tsx'), 'utf-8');
    expect(WRAPPER).toMatch(/replace\(\/</);
    const TRIP_PAGE = readFileSync(join(ROOT, 'app/trip/[token]/page.tsx'), 'utf-8');
    expect(TRIP_PAGE).toMatch(/<JsonLd data=\{jsonLd\} \/>/);
    expect(TRIP_PAGE).toMatch(/TouristTrip/);
  });

  it('перелинковка: страница ссылается на другие пресеты и планировщик', () => {
    expect(PAGE).toMatch(/Другие готовые планы/);
    expect(PAGE).toMatch(/href="\/planner"/);
    expect(HUB).toMatch(/\/plans\/\$\{p\.slug\}/);
  });
});

describe('единый источник пресетов', () => {
  it('sitemap строится из PLAN_PRESETS — не разъедется с роутом', () => {
    expect(SITEMAP).toMatch(/PLAN_PRESETS\.map/);
    expect(SITEMAP).toMatch(/\/plans\/\$\{p\.slug\}/);
  });

  it('подбор туров к дням — общий резолвер с публичным планом', () => {
    expect(PAGE).toMatch(/topToursByActivity/);
    expect(SHARE_API).toMatch(/topToursByActivity/);
  });
});

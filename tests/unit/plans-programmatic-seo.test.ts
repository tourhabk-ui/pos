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
import {
  PLAN_PRESETS, findPlanPreset, PLANS_TEXT_REVISION, planLastModified, plansHubLastModified,
} from '@/lib/plans/presets';
import { buildPlansFaq } from '@/lib/plans/faq';

const ROOT = process.cwd();
const PAGE = readFileSync(join(ROOT, 'app/plans/[slug]/page.tsx'), 'utf-8');
const HUB = readFileSync(join(ROOT, 'app/plans/page.tsx'), 'utf-8');
const SITEMAP = readFileSync(join(ROOT, 'lib/seo/sitemap-entries.ts'), 'utf-8');
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
    // Два законных формата: программатик «N дней под интерес» и посадочные
    // кластеры стратегии 14.08 (первая поездка, сезонные). Всё прочее —
    // опечатка слага, а не третий формат.
    for (const s of slugs) {
      expect(s).toMatch(/^(kamchatka-za-\d+-dney-[a-z-]+|pervaya-poezdka-na-kamchatku|kamchatka-v-[a-z]+|kamchatka-zimoy)$/);
    }
  });

  it('посадочный кластер обязан нести дату, источник и ограничения', () => {
    // Высокоинтентная страница без даты ревизии неотличима от устаревшей,
    // а в safety-first продукте устаревшая вредит сильнее отсутствующей.
    const clusters = PLAN_PRESETS.filter((p) => p.cluster);
    expect(clusters.length).toBeGreaterThanOrEqual(4);
    for (const p of clusters) {
      expect(p.cluster!.updated, p.slug).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(p.cluster!.sourceNote.length, p.slug).toBeGreaterThanOrEqual(20);
      expect(p.cluster!.limitations.length, p.slug).toBeGreaterThanOrEqual(2);
    }
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

describe('хаб /plans отвечает на запрос «Камчатка туры план» прямо (GEO, 18.09)', () => {
  it('заголовок и H1 — в форме запроса, прямой ответ в первом экране', () => {
    expect(HUB).toMatch(/title: 'Туры на Камчатку: готовые планы поездки/);
    expect(HUB).toMatch(/Туры на Камчатку: готовые планы поездки\s*<\/h1>/);
    // Число планов — из PLAN_PRESETS, не напечатано руками.
    expect(HUB).toMatch(/\{PLAN_PRESETS\.length\} готовых планов/);
  });

  it('вопросы-ответы — из lib/plans/faq, размечены FAQPage через обёртку; список — ItemList', () => {
    expect(HUB).toMatch(/from '@\/lib\/plans\/faq'/);
    expect(HUB).toMatch(/'@type': 'FAQPage'/);
    expect(HUB).toMatch(/'@type': 'ItemList'/);
    expect(HUB).toMatch(/<JsonLd data=\{faqJsonLd\} \/>/);
    expect(HUB).not.toMatch(/dangerouslySetInnerHTML/);
    const faq = buildPlansFaq();
    expect(faq.length).toBeGreaterThanOrEqual(4);
    const days = [...new Set(PLAN_PRESETS.map((p) => p.days))].sort((a, b) => a - b);
    // Ответ про длительность называет ровно те длины, что есть в пресетах.
    for (const d of days) expect(faq[0].answer).toContain(String(d));
    // Про цену — источник, а не выдуманная сумма (§4.0).
    expect(faq[1].answer).toMatch(/из живого каталога/);
    expect(faq[1].answer).not.toMatch(/\d{2,3} ?\d{3} ?₽/);
  });

  it('дата ревизии текстов — ISO, не раньше кластеров и не в будущем; хаб показывает её', () => {
    expect(PLANS_TEXT_REVISION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const rev = new Date(PLANS_TEXT_REVISION).getTime();
    expect(rev).toBeLessThanOrEqual(Date.now());
    for (const p of PLAN_PRESETS.filter((x) => x.cluster)) {
      expect(new Date(p.cluster!.updated).getTime(), p.slug).toBeLessThanOrEqual(rev);
    }
    expect(plansHubLastModified().getTime()).toBe(rev);
    expect(HUB).toMatch(/Обновлено \{updated\}/);
  });

  it('sitemap и JSON-LD планов берут дату ревизии, а не константу STABLE', () => {
    const block = SITEMAP.slice(SITEMAP.indexOf('/plans`'), SITEMAP.indexOf('/planning`'));
    expect(block).toMatch(/plansHubLastModified\(\)/);
    expect(block).toMatch(/planLastModified\(p\)/);
    expect(block).not.toMatch(/lastModified: STABLE/);
    expect(PAGE).toMatch(/dateModified: planLastModified\(preset\)/);
    // Кластер несёт свою дату, обычный пресет — общую.
    const cluster = PLAN_PRESETS.find((p) => p.cluster)!;
    expect(planLastModified(cluster).toISOString().slice(0, 10)).toBe(cluster.cluster!.updated);
    const plain = PLAN_PRESETS.find((p) => !p.cluster)!;
    expect(planLastModified(plain).toISOString().slice(0, 10)).toBe(PLANS_TEXT_REVISION);
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

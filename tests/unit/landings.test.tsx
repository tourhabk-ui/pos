/**
 * Посадочные Сыщика (20.11, lib/landings): 17 новых адресов и 4 апгрейда.
 * Держится: каждая новая страница существует и попадает в sitemap; блок туров
 * читает базу, а не текст (месяц — по сезону или открытой дате); Article +
 * FAQPage с датой ревизии; месяцы ссылаются друг на друга и на хаб; старые
 * страницы ведут на посадочные.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, cleanup, screen, within } from '@testing-library/react';

import { LANDINGS, NEW_LANDINGS, MONTH_SLUGS, monthLinks, landingBySlug, LANDING_CANONICAL, LANDING_CROSS_LINKS, MONTHS_HUB } from '@/lib/landings/landings';
import { tourRunsInMonth, tourMatchesSpec, type LandingBlockTour } from '@/lib/landings/tours';
import { LandingContent, landingJsonLd } from '@/components/landings/LandingContent';
import { LandingCrossLink } from '@/components/landings/LandingCrossLink';

const ROOT = process.cwd();
afterEach(cleanup);

const tour = (o: Partial<LandingBlockTour>): LandingBlockTour => ({
  id: '1', slug: 'tur', title: 'Тур', base_price: '10000', price_unit: 'per_person', duration_hours: '8',
  operator_name: 'Оператор', operator_slug: null, operator_public: null,
  season_start: null, season_end: null, next_open_date: null, any_day_open: null, ...o,
});

describe('реестр посадочных', () => {
  it('59 текстов: 49 новых адресов (17 + 10 + 9 третьей партии + хаб восхождений + 12 четвёртой) и 10 апгрейдов тех же URL', () => {
    // Хаб «Как добраться» (21.11) заменил текст первой партии под тем же адресом.
    expect(LANDINGS).toHaveLength(59);
    expect(NEW_LANDINGS).toHaveLength(49);
    expect(LANDINGS.filter((l) => l.type === 'upgrade').map((l) => l.path).sort()).toEqual([
      '/catalog', '/dolina-gejzerov-ekskursiya', '/kogda-ehat-na-kamchatku', '/places/kurilskoe-ozero', '/places/paratunskaya-zona-otdyha', '/places/vulkan-mutnovskij',
      '/plans/kamchatka-v-iyune', '/plans/kamchatka-v-sentyabre', '/rybalka-na-kamchatke-tury', '/voshozhdenie-na-avachinskij-vulkan',
    ]);
  });

  it('у каждой новой — своя страница в app/', () => {
    for (const l of NEW_LANDINGS) {
      const file = join(ROOT, 'app', l.path.slice(1), 'page.tsx');
      expect(existsSync(file), l.path).toBe(true);
      expect(readFileSync(file, 'utf-8')).toContain(`'${l.slug}'`);
    }
  });

  it('новые — в sitemap с датой ревизии текста', () => {
    const src = readFileSync(join(ROOT, 'lib/seo/sitemap-entries.ts'), 'utf-8');
    expect(src).toMatch(/\.\.\.NEW_LANDINGS\.map\(/);
    expect(src).toMatch(/lastModified: new Date\(`\$\{l\.date\}T00:00:00Z`\)/);
  });

  it('в тексте нет ни строки «Обновлено…», ни заглушки блока, ни абсолютных ссылок на свой сайт', () => {
    for (const l of LANDINGS) {
      const t = l.before + l.after;
      expect(t, l.slug).not.toMatch(/\*Обновлено:/);
      expect(t, l.slug).not.toMatch(/Блок для Фло/);
      expect(t, l.slug).not.toMatch(/\]\(https:\/\/vedarai\.ru/);
      expect(l.date, l.slug).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe('блок туров — из полей базы', () => {
  it('месяц: открытая дата или сезон оператора, через Новый год тоже', () => {
    expect(tourRunsInMonth(tour({ season_start: '2027-06-18', season_end: '2027-07-20' }), 6)).toBe(true);
    expect(tourRunsInMonth(tour({ season_start: '2027-06-18', season_end: '2027-07-20' }), 9)).toBe(false);
    expect(tourRunsInMonth(tour({ season_start: '2026-11-13', season_end: '2027-04-10' }), 1)).toBe(true);
    expect(tourRunsInMonth(tour({ season_start: '2026-11-13', season_end: '2027-04-10' }), 7)).toBe(false);
    expect(tourRunsInMonth(tour({ next_open_date: '2027-02-14' }), 2)).toBe(true);
    // Ни сезона, ни даты — не знаем, в месячный блок не идёт.
    expect(tourRunsInMonth(tour({}), 2)).toBe(false);
  });

  it('у каждого месяца — свой месяц; у «с детьми» — лёгкие туры до суток', () => {
    MONTH_SLUGS.forEach((s, i) => expect(landingBySlug(s).tours).toEqual({ kind: 'month', month: i + 1 }));
    const kids = landingBySlug('kamchatka-s-detmi').tours;
    expect(tourMatchesSpec(tour({ difficulty: 'easy', duration_hours: '6' }), kids)).toBe(true);
    expect(tourMatchesSpec(tour({ difficulty: 'easy', duration_hours: '72' }), kids)).toBe(false);
    expect(tourMatchesSpec(tour({ difficulty: 'hard', duration_hours: '6' }), kids)).toBe(false);
    expect(tourMatchesSpec(tour({ title: 'Медведи Курильского озера' }), landingBySlug('medvedi-kamchatki').tours)).toBe(true);
  });

  it('туры рисуются ссылками на карточки; база не ответила — так и сказано', () => {
    const l = landingBySlug('kamchatka-v-iyule');
    render(<LandingContent landing={l} tours={[tour({ id: '5', slug: 'kizhuch', title: 'Рыбалка на кижуча', season_start: '2027-07-01', season_end: '2027-09-30' })]} />);
    const block = document.querySelector('[data-landing-tours]') as HTMLElement;
    expect(within(block).getByRole('link', { name: 'Рыбалка на кижуча' }).getAttribute('href')).toContain('kizhuch');
    expect(within(block).getByText(/сезон: июл–сен/)).toBeTruthy();
    cleanup();
    render(<LandingContent landing={l} tours={null} />);
    expect(screen.getByText(/Туры сейчас не загрузились/)).toBeTruthy();
  });
});

describe('разметка и дата', () => {
  it('Article с датой ревизии и FAQPage из раздела «Частые вопросы»', () => {
    const l = landingBySlug('medvedi-kamchatki');
    const ld = landingJsonLd(l) as { '@graph': Array<Record<string, unknown>> };
    const article = ld['@graph'].find((n) => n['@type'] === 'Article')!;
    expect(String(article.dateModified)).toMatch(/^2026-11-20/);
    expect(article.url).toBe('https://vedarai.ru/medvedi-kamchatki');
    const faq = ld['@graph'].find((n) => n['@type'] === 'FAQPage') as { mainEntity: unknown[] } | undefined;
    expect(faq?.mainEntity.length).toBeGreaterThan(0);
  });

  it('видимая дата — та же', () => {
    render(<LandingContent landing={landingBySlug('kamchatka-v-mae')} tours={[]} />);
    expect(document.querySelector('[data-record-modified] time')?.getAttribute('dateTime')).toMatch(/^2026-11-20/);
  });
});

describe('перелинковка и каннибализация', () => {
  it('двенадцать месяцев по порядку, июнь и сентябрь — на /plans, хаб — «Когда ехать»', () => {
    const links = monthLinks();
    expect(links).toHaveLength(12);
    expect(links[5].href).toBe('/plans/kamchatka-v-iyune');
    expect(links[8].href).toBe('/plans/kamchatka-v-sentyabre');
    expect(links[0].href).toBe('/kamchatka-v-yanvare');
    render(<LandingContent landing={landingBySlug('kamchatka-v-marte')} tours={[]} />);
    const nav = document.querySelector('[data-landing-months]') as HTMLElement;
    expect(within(nav).getAllByRole('link')).toHaveLength(12);
    expect(within(nav).getByRole('link', { name: MONTHS_HUB.label }).getAttribute('href')).toBe('/kogda-ehat-na-kamchatku');
  });

  it('хаб показывает месяцы', () => {
    const src = readFileSync(join(ROOT, 'app/kogda-ehat-na-kamchatku/page.tsx'), 'utf-8');
    expect(src).toContain("import { MonthsNav } from '@/components/landings/LandingContent'");
    expect(src).toMatch(/MonthsNav current="\/kogda-ehat-na-kamchatku"/);
  });

  it('маршрут «Медведи Камчатки» — canonical на посадочную и вне sitemap', () => {
    expect(LANDING_CANONICAL['/routes/medvedi-kamchatki']).toBe('/medvedi-kamchatki');
    expect(readFileSync(join(ROOT, 'app/routes/[id]/page.tsx'), 'utf-8')).toMatch(/LANDING_CANONICAL\[`\/routes\/\$\{canonicalId\}`\]/);
    expect(readFileSync(join(ROOT, 'lib/seo/sitemap-entries.ts'), 'utf-8')).toMatch(/!LANDING_CANONICAL\[`\/routes\//);
  });

  it('место и статья о Долине гейзеров ведут на экскурсию, маршрут Паратунки — на место', () => {
    expect(LANDING_CROSS_LINKS['/places/dolina-gejzerov'].href).toBe('/dolina-gejzerov-ekskursiya');
    expect(LANDING_CROSS_LINKS['/articles/dolina-gejzerov'].href).toBe('/dolina-gejzerov-ekskursiya');
    expect(LANDING_CROSS_LINKS['/routes/paratunka'].href).toBe('/places/paratunskaya-zona-otdyha');
    render(<LandingCrossLink path="/routes/paratunka" />);
    expect(screen.getByRole('link').getAttribute('href')).toBe('/places/paratunskaya-zona-otdyha');
    cleanup();
    const { container } = render(<LandingCrossLink path="/routes/drugoj" />);
    expect(container.innerHTML).toBe('');
  });
});

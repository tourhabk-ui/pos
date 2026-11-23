/**
 * Пробелы аудита 23.11: землетрясения и цунами — раздел на /safety
 * (радар не уезжает вниз); северное сияние — раздел на /articles/zima,
 * без новой страницы.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  SAFETY_FAQ,
  SAFETY_LEAD,
  SAFETY_PAGE_DESCRIPTION,
  SAFETY_SECTIONS,
  SAFETY_SOURCES,
  SAFETY_TEXT_LINKS,
  safetyVisibleText,
} from '@/lib/seo/safety-page';

describe('/safety: землетрясения и цунами', () => {
  const quake = SAFETY_SECTIONS.find((s) => s.id === 'zemletryaseniya');

  it('вопрос-H2 стоит после вулканов и до погоды, радар по-прежнему выше статьи', () => {
    expect(quake?.heading).toBe('Опасны ли землетрясения и цунами?');
    const ids = SAFETY_SECTIONS.map((s) => s.id);
    expect(ids.indexOf('vulkany')).toBeLessThan(ids.indexOf('zemletryaseniya'));
    expect(ids.indexOf('zemletryaseniya')).toBeLessThan(ids.indexOf('pogoda'));
    const page = readFileSync('app/safety/page.tsx', 'utf8');
    const body = page.slice(page.indexOf('export default function'));
    expect(body.indexOf('<SafetyLive ')).toBeGreaterThan(body.indexOf('<SafetyLiveIntro'));
    expect(body.indexOf('<SafetyAbout')).toBeGreaterThan(body.indexOf('<SafetyLive '));
  });

  it('текст опирается на Visit Kamchatka и памятку МЧС, без цен и оценок', () => {
    const text = quake?.paragraphs.join(' ') ?? '';
    expect(text).toMatch(/сейсмоопасн/);
    expect(text).toMatch(/живой сводкой выше на этой странице/);
    expect(text).toMatch(/7 баллов/);
    expect(text).toMatch(/15–20 секунд/);
    expect(text).toMatch(/30–40 метров/);
    expect(text).toMatch(/2–3 километра/);
    expect(text).toMatch(/не пользуясь лифтом/);
    expect(text).not.toMatch(/₽|руб/);
    expect(text).not.toMatch(/лучш|уникальн|высочайш/);
    expect(SAFETY_LEAD).toMatch(/землетрясения/);
    expect(SAFETY_PAGE_DESCRIPTION).toMatch(/землетрясения/);
    expect(SAFETY_PAGE_DESCRIPTION.length).toBeLessThanOrEqual(160);
    expect(SAFETY_SOURCES.some((s) => s.href === 'https://visitkamchatka.ru/security/')).toBe(true);
    expect(
      SAFETY_SOURCES.some((s) =>
        s.href.includes('pravila-povedeniya-pri-ugroze-i-vozniknovenii-volny-cunami'),
      ),
    ).toBe(true);
    expect(SAFETY_TEXT_LINKS.some((l) => l.text === 'памятке ГУ МЧС по Камчатскому краю')).toBe(true);
    expect(SAFETY_FAQ.some((f) => /землетрясен/.test(f.question))).toBe(true);
    expect(SAFETY_FAQ.length).toBeLessThanOrEqual(7);
    expect(safetyVisibleText()).toMatch(/цунами/);
  });
});

describe('/articles/zima: северное сияние', () => {
  it('миграция 1503 добавляет раздел, вопрос в FAQ и источники, идемпотентно', () => {
    const sql = readFileSync('migrations/1503_zima_aurora_article.sql', 'utf8');
    expect(sql).toContain("WHERE slug = 'zima'");
    expect(sql).toContain('Можно ли увидеть северное сияние на Камчатке?');
    expect(sql).toContain('Планировать зимнюю поездку только ради сияния не стоит');
    expect(sql).toContain('20 на 21 января 2026');
    expect(sql).toContain('https://rg.ru/2025/08/17/gde-i-kogda-uvidet-severnoe-siianie-v-rossii-luchshie-mesta-sezony-i-sovety-dlia-puteshestvennikov.html');
    expect(sql).toContain('https://media41.ru/putevoditel-po-kamcatke/14929');
    expect(sql).toContain('https://kamtoday.ru/news/poluostrov/severnoe-siyanie-zafiksirovano-v-petropavlovske-kamchatskom/');
    expect(sql).toContain('https://kamchatkamedia.ru/news/2292191/');
    expect(sql).toContain("AND body NOT LIKE '%Можно ли увидеть северное сияние на Камчатке?%'");
    expect(sql).not.toMatch(/₽|руб/);
  });
});

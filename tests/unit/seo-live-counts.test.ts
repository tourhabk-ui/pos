/**
 * Счётчики на страницах — из базы, а не из текста (замер SEO 30.09).
 *
 * Сниппет поисковика цитирует цифры страницы. 30.09 одна и та же витрина
 * говорила по-разному: главная «Все туры (8)» — длина витрины, обрезанной
 * до PLATES_LIMIT, — при 11 в каталоге; /about держал «779 точек, 294
 * маршрута» с мая при 380 и 391 на главной. Замороженное число в тексте —
 * та же болезнь, что «778 мест» в CLAUDE.md: верить ему опаснее, чем не
 * иметь никакого.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (p: string) => readFileSync(p, 'utf-8');

describe('главная: «Все туры (N)» — число каталога', () => {
  const page = read('app/page.tsx');

  it('счётчик берётся из сводки каталога, не из длины витрины', () => {
    expect(page).toMatch(/queryCatalogSummaryForPage\(\)/);
    expect(page).toMatch(/<DeskTours plates=\{plates\} transfer=\{transfer\} total=\{catalogSummary\?\.total \?\? null\} \/>/);
    expect(page).not.toMatch(/total=\{plates\.length\}/);
  });

  it('не посчиталось — ссылка без числа, а не с выдуманным', () => {
    const tours = read('components/homepage/desk/DeskTours.tsx');
    expect(tours).toMatch(/total: number \| null/);
    expect(tours).toMatch(/total != null && total > 0 \? `Все туры \(\$\{total\}\)` : 'Все туры'/);
  });
});

describe('/about: цифры из базы', () => {
  const about = read('app/about/page.tsx');

  it('места, маршруты, профили — счётом главной; туры — сводкой каталога', () => {
    expect(about).toMatch(/getPlatformCounts\(\)/);
    expect(about).toMatch(/queryCatalogSummaryForPage\(\)/);
    // На запросе, а не ISR: revalidate отдавал первую версию со сборки, где
    // базы нет, — страницу без цифр (аудит 01.10). Счёт кэширует platform-counts.
    expect(about).toMatch(/export const dynamic = 'force-dynamic';/);
    expect(about).not.toMatch(/export const revalidate = \d+;/);
  });

  it('в тексте страницы нет замороженных чисел платформы', () => {
    // Комментарии допускают историю («прежние 779 / 294»), строки — нет.
    const code = about.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const n of ['779', '294', '763', '525', '112']) {
      expect(code, `замороженное «${n}» в /about`).not.toMatch(new RegExp(`['\`"][^'\`"]*\\b${n}\\b`));
    }
    expect(code).not.toMatch(/const STATS = \[/);
  });
});

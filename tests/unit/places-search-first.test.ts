// @vitest-environment node
/**
 * Страница мест и маршрутов: пока человек ищет, выдача стоит сразу за
 * строкой поиска (владелец 12.10, снимок с телефона: «если я хочу прочесть
 * про место озеро Толмачёва, оно не очень удобно находится» — карточка
 * найденного места стояла ниже туров, вкладок, парков, категорий и чипов
 * типов, двумя экранами под строкой поиска, которая сама была посередине).
 *
 * Держит порядок исходника: строка поиска — раньше блока туров и вкладок;
 * полосы парков и категорий и чипы типов рисуются только при пустом
 * запросе. Сами ссылки парков и категорий при этом остаются в первом HTML
 * без запроса — сторожа catalog-linking и catalog-categories-linked.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CLIENT = readFileSync(join(process.cwd(), 'app/routes/_RoutesPageClient.tsx'), 'utf-8');

describe('/routes и /places: поиск первым', () => {
  // 30.10 владелец: вкладки «Места» / «Маршруты» — самым верхом каталога,
  // строка поиска — сразу под ними, блок туров — после поиска.
  it('вкладки вверху, затем строка поиска, затем блок туров', () => {
    const tabs = CLIENT.indexOf('Вкладки «Места» / «Маршруты»');
    const search = CLIENT.indexOf('placeholder={searchPlaceholder}');
    const slot = CLIENT.indexOf('{toursSlot}');
    expect(tabs).toBeGreaterThan(0);
    expect(tabs).toBeLessThan(search);
    expect(search).toBeLessThan(slot);
  });

  it('признак поиска — непустой запрос без пробелов по краям', () => {
    expect(CLIENT).toContain('const searching = query.trim().length > 0;');
  });

  it('парки, категории и чипы типов — только пока не ищут', () => {
    expect(CLIENT).toMatch(/\{!searching && \(\s*<>\s*<ParksStrip initialParks=\{initialParks\} \/>\s*<CategoriesStrip categories=\{initialCategories\} \/>\s*<\/>\s*\)\}/);
    expect(CLIENT).toMatch(/\{kind === 'place' && !searching && \(/);
    expect(CLIENT).toMatch(/\{kind === 'route' && !searching && \(/);
  });
});

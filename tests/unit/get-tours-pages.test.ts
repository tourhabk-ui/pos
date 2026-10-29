/**
 * Страницы get_tours (#2314). На 11+ турах (каталог вырос с «Краем
 * Вулканов») клиент MCP обрезал ответ на середине. Держится: по 7 туров,
 * шапка и хвост на каждой странице, пояснение посреди списка — на странице
 * своего тура, приписка «страница P из N» и следующая; страница за пределами
 * — сказано, сколько их есть.
 *
 * 29.10 (ловушка MCP filter-coverage): одна страница называет себя «1 из 1» —
 * описание параметра page обещает строку о страницах всегда, а ответ без неё
 * агент не отличит от обрезанного; page=2 при одной странице — «Страницы 2
 * нет», а не первая страница ещё раз. Проводку (MCP — всегда страницы, чат —
 * по просьбе) держит вызов инструмента в tour-context-partners-join.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { capTourCatalog, paginateTourText, PROMPT_CATALOG_TOURS, TOURS_PAGE_SIZE } from '@/lib/kuzmich/tour-filter';

const tours = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `ID${from + i}: "Тур ${from + i}" тип:volcano`);
const catalog = (n: number) => ['РЕАЛЬНЫЕ ТУРЫ НА ПЛАТФОРМЕ:', ...tours(n), '', 'Хвост каталога.'].join('\n');

describe('paginateTourText', () => {
  it('по 7 туров: шапка и хвост на месте, приписка со следующей', () => {
    expect(TOURS_PAGE_SIZE).toBe(7);
    const p1 = paginateTourText(catalog(11), 1);
    expect(p1.match(/^ID\d+:/gm)).toHaveLength(7);
    expect(p1).toMatch(/^РЕАЛЬНЫЕ ТУРЫ НА ПЛАТФОРМЕ:/);
    expect(p1).toContain('Хвост каталога.');
    expect(p1).toMatch(/Страница 1 из 2, туров всего 11\. Следующая — get_tours с page=2/);
    const p2 = paginateTourText(catalog(11), 2);
    expect(p2.match(/^ID\d+:/gm)).toEqual(['ID8', 'ID9', 'ID10', 'ID11'].map((x) => x + ':'));
    expect(p2).toMatch(/Страница 2 из 2, туров всего 11\. Это последняя\./);
  });

  it('одна страница — ответ целиком и строка «Страница 1 из 1»', () => {
    expect(paginateTourText(catalog(7), 1)).toBe(`${catalog(7)}\n\nСтраница 1 из 1, туров всего 7. Других страниц нет.`);
    expect(paginateTourText(catalog(1), 1)).toMatch(/Страница 1 из 1, туров всего 1\. Других страниц нет\.$/);
  });

  it('страница за пределами — сказано, сколько есть, а не пустота и не первая страница снова', () => {
    expect(paginateTourText(catalog(11), 5)).toBe('Страницы 5 нет: туров 11, страниц 2. Начни с page=1.');
    // До 29.10 при семи турах и меньше page=2 молча повторял первую страницу.
    expect(paginateTourText(catalog(7), 2)).toBe('Страницы 2 нет: туров 7, страниц 1. Начни с page=1.');
    expect(paginateTourText(catalog(3), 2)).not.toContain('ID1:');
  });

  it('три блока фильтра на двух страницах: пояснение каждого — на странице его туров', () => {
    const near = 'Ещё упоминают «озеро» в названии, месте, кратком описании или главном месте тура — тип у них другой:';
    const far = 'Слово «озеро» есть только в полном описании или программе этих туров — не проверено:';
    // 3 по типу, 3 в (б), 4 в (в): страница 1 — тип, (б) и первый тур (в); страница 2 — остальные (в).
    const text = ['ШАПКА', ...tours(3), '', near, ...tours(3, 4), '', far, ...tours(4, 7), '', 'ХВОСТ'].join('\n');
    const p1 = paginateTourText(text, 1);
    expect(p1.match(/^ID\d+:/gm)).toEqual(['ID1:', 'ID2:', 'ID3:', 'ID4:', 'ID5:', 'ID6:', 'ID7:']);
    expect(p1.indexOf(near)).toBeLessThan(p1.indexOf('ID4:'));
    expect(p1.indexOf(far)).toBeGreaterThan(p1.indexOf('ID6:'));
    expect(p1.indexOf(far)).toBeLessThan(p1.indexOf('ID7:'));
    const p2 = paginateTourText(text, 2);
    expect(p2.match(/^ID\d+:/gm)).toEqual(['ID8:', 'ID9:', 'ID10:']);
    expect(p2).not.toContain(near);
    expect(p2.indexOf(far)).toBeLessThan(p2.indexOf('ID8:'));
    expect(p2).toMatch(/^ШАПКА/);
    expect(p2).toContain('ХВОСТ');
  });

  it('пояснение ПЕРВОЙ секции, отделённое от шапки пустой строкой, — не шапка: на странице без её туров его нет', () => {
    // Ревью 29.10: «Туры, где упоминается… Назови их» стояло до первого тура,
    // считалось шапкой и повторялось над страницей одних «не проверено».
    const near = 'Туры, где упоминается «пробное» (в названии, месте, кратком описании или главном месте тура). Назови их:';
    const far = 'Слово «пробное» есть только в полном описании или программе этих туров — не проверено:';
    const text = ['ШАПКА', 'Правило порядка.', '', near, ...tours(2), '', far, ...tours(8, 3), '', 'ХВОСТ'].join('\n');
    const p1 = paginateTourText(text, 1);
    expect(p1.match(/^ID\d+:/gm)).toEqual(['ID1:', 'ID2:', 'ID3:', 'ID4:', 'ID5:', 'ID6:', 'ID7:']);
    expect(p1.indexOf('ШАПКА')).toBeLessThan(p1.indexOf(near));
    expect(p1.indexOf(near)).toBeLessThan(p1.indexOf('ID1:'));
    const p2 = paginateTourText(text, 2);
    expect(p2.match(/^ID\d+:/gm)).toEqual(['ID8:', 'ID9:', 'ID10:']);
    expect(p2).not.toContain(near);
    expect(p2).toMatch(/^ШАПКА\nПравило порядка\./);
    expect(p2.indexOf(far)).toBeLessThan(p2.indexOf('ID8:'));
    expect(p2).toContain('ХВОСТ');
  });

  it('пояснение посреди списка — на каждой странице, где есть его туры', () => {
    const note = 'Ещё упоминают «вулканы» — тип у них другой:';
    // 8 туров по типу, затем пояснение и 3 тура «тип другой»: страница 1 —
    // только по типу, страница 2 — один по типу и блок с пояснением.
    const text = [...tours(8), '', note, ...tours(3, 9)].join('\n');
    const p1 = paginateTourText(text, 1);
    expect(p1).not.toContain(note);
    const p2 = paginateTourText(text, 2);
    expect(p2.match(/^ID\d+:/gm)).toEqual(['ID8:', 'ID9:', 'ID10:', 'ID11:']);
    expect(p2.indexOf('ID8:')).toBeLessThan(p2.indexOf(note));
    expect(p2.indexOf(note)).toBeLessThan(p2.indexOf('ID9:'));
    // Блок «тип другой» растянут на две страницы — пояснение на обеих.
    const long = [...tours(5), '', note, ...tours(6, 6)].join('\n');
    expect(paginateTourText(long, 1)).toContain(note);
    expect(paginateTourText(long, 2)).toContain(note);
    expect(paginateTourText(long, 2).indexOf(note)).toBeLessThan(paginateTourText(long, 2).indexOf('ID8:'));
  });
});

describe('capTourCatalog — каталог в подсказке Кузьмича (29.10)', () => {
  it('туров больше предела — первые 40 и названо, сколько всего и где остальные; хвост на месте', () => {
    expect(PROMPT_CATALOG_TOURS).toBe(40);
    const out = capTourCatalog(catalog(45));
    expect(out.match(/^ID\d+:/gm)).toHaveLength(40);
    expect(out).toContain('ID40: ');
    expect(out).not.toContain('ID41: ');
    expect(out).toContain('(Здесь 40 туров из 45 — первые по порядку витрины (правило в шапке). Остальные 5 — инструментом get_tours: страницы и фильтр по виду.)');
    expect(out).toMatch(/^РЕАЛЬНЫЕ ТУРЫ НА ПЛАТФОРМЕ:/);
    expect(out.endsWith('Хвост каталога.')).toBe(true);
  });

  it('в пределе — текст как был, без приписки', () => {
    expect(capTourCatalog(catalog(40))).toBe(catalog(40));
    expect(capTourCatalog(catalog(3))).toBe(catalog(3));
  });

  it('страницы get_tours идут по ВСЕМУ каталогу: 75 туров — 11 страниц, последняя называет всех', () => {
    expect(paginateTourText(catalog(75), 11)).toMatch(/Страница 11 из 11, туров всего 75\. Это последняя\./);
  });
});

describe('объявление page', () => {
  it('параметр page объявлен в схеме и в описании для чужих агентов', async () => {
    const schemas = readFileSync(join(process.cwd(), 'lib/kuzmich/tool-schemas.ts'), 'utf8');
    expect(schemas).toMatch(/page: looseString\(3\)\.optional\(\)/);
    const { PARAM_ENGLISH } = await import('@/lib/mcp/public-tools');
    expect(PARAM_ENGLISH.get_tours.page?.lead).toMatch(/7 tours/);
  });
});

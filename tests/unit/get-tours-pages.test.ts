/**
 * Страницы get_tours (#2314). На 11+ турах (каталог вырос с «Краем
 * Вулканов») клиент MCP обрезал ответ на середине. Держится: по 7 туров,
 * шапка и хвост на каждой странице, пояснение посреди списка — на странице
 * своего тура, приписка «страница P из N» и следующая; одна страница —
 * ответ без изменений; страница за пределами — сказано, сколько их есть.
 * И проводка: на MCP — всегда по страницам, в чате — только по просьбе.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { paginateTourText, TOURS_PAGE_SIZE } from '@/lib/kuzmich/tour-filter';

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

  it('одна страница — ответ как был', () => {
    expect(paginateTourText(catalog(7), 1)).toBe(catalog(7));
  });

  it('страница за пределами — сказано, сколько есть, а не пустота', () => {
    expect(paginateTourText(catalog(11), 5)).toBe('Страницы 5 нет: туров 11, страниц 2. Начни с page=1.');
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

describe('проводка get_tours', () => {
  const core = readFileSync(join(process.cwd(), 'lib/kuzmich/core.ts'), 'utf8');
  it('на MCP — всегда страницы, в чате — только по просьбе', () => {
    expect(core).toMatch(/if \(opts\.surface !== 'mcp' && !askedPage\) return text;\s*return paginateTourText\(text, askedPage \? page : 1\);/);
  });

  it('параметр page объявлен в схеме и в описании для чужих агентов', async () => {
    const schemas = readFileSync(join(process.cwd(), 'lib/kuzmich/tool-schemas.ts'), 'utf8');
    expect(schemas).toMatch(/page: looseString\(3\)\.optional\(\)/);
    const { PARAM_ENGLISH } = await import('@/lib/mcp/public-tools');
    expect(PARAM_ENGLISH.get_tours.page?.lead).toMatch(/7 tours/);
  });
});

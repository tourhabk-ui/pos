/**
 * Тексты тонких страниц, партия 7 (Сыщик 21.11): миграция 1488. Держит то,
 * что велел владелец: без цен и разметки, без служебных фраз и названия
 * стороннего каталога на экране, сомнительное не публикуется, решение
 * владельца не затирается.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { descriptionVoice } from '@/lib/places/description-voice';

const SQL = readFileSync(join(__dirname, '../../migrations/1488_thin_texts_batch7.sql'), 'utf-8');

interface Row { slug: string; txt: string; sources: string[] }
function rows(block: string): Row[] {
  const out: Row[] = [];
  const re = /\(\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)'::jsonb\)/g;
  for (const m of block.matchAll(re)) {
    const un = (s: string) => s.replace(/''/g, "'");
    out.push({ slug: un(m[1]), txt: un(m[2]), sources: JSON.parse(un(m[3])) });
  }
  return out;
}
const [placesBlock, routesBlock = ''] = SQL.split('-- ── Маршруты');
const places = rows(placesBlock);
const routes = rows(routesBlock);
const all = [...places, ...routes];

describe('миграция 1488: тексты тонких страниц, партия 7', () => {
  it('7 мест и 1 маршрут, slug без повторов, у каждого текста есть источник', () => {
    expect(places).toHaveLength(7);
    expect(routes).toHaveLength(1);
    expect(new Set(places.map((r) => r.slug)).size).toBe(7);
    expect(new Set(routes.map((r) => r.slug)).size).toBe(1);
    for (const r of all) {
      expect(r.sources.length, r.slug).toBeGreaterThan(0);
      for (const u of r.sources) expect(u, r.slug).toMatch(/^https:\/\/[^\s]+[^(]$/);
    }
  });

  it('простые абзацы: без markdown, сносок, цен и служебных фраз', () => {
    for (const { slug, txt } of all) {
      expect(txt, slug).not.toMatch(/^#|\*\*|\[\d+\]|\]\(/m);
      expect(txt, slug).not.toMatch(/₽|руб\.|рубл|\bцена\b|стоимост/i);
      expect(txt, slug).not.toMatch(/Ведар|ИдиЛес|idilesom|Википеди|черновик|оставляем|трек/i);
      expect(txt.length, slug).toBeGreaterThan(150);
      expect(descriptionVoice(txt).voice, slug).toBe('plain');
    }
  });

  it('высоты по решению владельца — одним значением по KVERT', () => {
    const text = all.map((r) => r.txt).join('\n');
    expect(text).not.toMatch(/2741|3140/);
    if (/Плоск\S* Толбачик/.test(text)) expect(text).toContain('3085 м по каталогу KVERT');
  });

  it('пишет только в пустое или короткое описание и не трогает решение владельца', () => {
    const blocks = routes.length ? 2 : 1;
    expect(SQL.match(/char_length\(COALESCE\(btrim\(t\.description\), ''\)\) < 300/g)).toHaveLength(blocks);
    expect(SQL.match(/written_by = 'owner-decision'/g)).toHaveLength(blocks);
    expect(SQL).toContain("'syshchik-sources'");
  });

  it('сомнительное не вошло: «Берингово море» у Шипунского, непроверенный фонд Елизова', () => {
    const text = all.map((r) => r.txt).join('\n');
    expect(text).not.toMatch(/Берингов/);
    expect(text).not.toContain('27 098');
  });

  it('имена карточек не меняются: Дзендзур — как у маршрута, вариант источника — в скобках речи', () => {
    const route = routes.find((r) => r.slug === 'fumarola-vulkana-dzendzur-2');
    expect(route?.txt).toContain('Дзендзур');
  });
});

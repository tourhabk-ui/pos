/**
 * Тексты тонких страниц, партия 1 (Сыщик 21.11): миграция 1480 и правки
 * справочника рыб. Держит то, что велел владелец: без цен и разметки, без
 * служебных фраз и названия стороннего каталога на экране, сомнительное
 * (противоречия источников) не публикуется, решение владельца не затирается.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { descriptionVoice } from '@/lib/places/description-voice';
import { FISH_SPECIES } from '@/lib/fish-species';

const SQL = readFileSync(join(__dirname, '../../migrations/1480_thin_pages_texts_batch1.sql'), 'utf-8');

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
const [placesBlock, routesBlock] = SQL.split('-- ── Маршруты');
const places = rows(placesBlock);
const routes = rows(routesBlock);
const all = [...places, ...routes];

describe('миграция 1480: тексты тонких страниц', () => {
  it('22 места и 15 маршрутов, slug без повторов, у каждого текста есть источник', () => {
    expect(places).toHaveLength(22);
    expect(routes).toHaveLength(15);
    expect(new Set(places.map((r) => r.slug)).size).toBe(22);
    expect(new Set(routes.map((r) => r.slug)).size).toBe(15);
    for (const r of all) {
      expect(r.sources.length, r.slug).toBeGreaterThan(0);
      for (const u of r.sources) expect(u, r.slug).toMatch(/^https:\/\/[^\s]+[^(]$/);
    }
  });

  it('простые абзацы: без markdown, сносок, цен и служебных фраз', () => {
    for (const { slug, txt } of all) {
      expect(txt, slug).not.toMatch(/^#|\*\*|\[\d+\]|\]\(/m);
      expect(txt, slug).not.toMatch(/₽|руб\.|рубл|\bцена\b|стоимост/i);
      expect(txt, slug).not.toMatch(/Ведар|ИдиЛес|idilesom|Википеди|источник[еау]? \[|черновик|оставляем|трек/i);
      expect(txt.length, slug).toBeGreaterThan(200);
      expect(descriptionVoice(txt).voice, slug).toBe('plain');
    }
  });

  it('противоречия источников не опубликованы', () => {
    const text = all.map((r) => r.txt).join('\n');
    expect(text).not.toMatch(/\b550\b|более 50 /);
    expect(text).not.toMatch(/самы[ех] северн/i);
    expect(text).not.toMatch(/военнопленн/i);
    const mayak = places.find((r) => r.slug === 'mayak-bolsheretskij')!;
    expect(mayak.txt).not.toMatch(/\b(150|250) м(етр)?/);
  });

  it('пишет только в пустое или короткое описание и не трогает решение владельца', () => {
    expect(SQL.match(/char_length\(COALESCE\(btrim\(t\.description\), ''\)\) < 300/g)).toHaveLength(2);
    expect(SQL.match(/written_by = 'owner-decision'/g)).toHaveLength(2);
    expect(SQL).toContain("'syshchik-sources'");
  });
});

describe('справочник рыб: правки по первоисточникам', () => {
  const mikizha = FISH_SPECIES.find((f) => f.id === 'mikizha')!;
  const krab = FISH_SPECIES.find((f) => f.id === 'krab')!;
  it('микижа — не эндемик, масса по Википедии', () => {
    expect(mikizha.shortDesc).not.toMatch(/^Эндемик/);
    expect(mikizha.shortDesc).toContain('не эндемичный');
    expect(mikizha.recordKg).not.toBe('до 10 кг');
  });
  it('краб — вселён намеренно, без «до 25 кг»', () => {
    expect(krab.funFact).not.toMatch(/случайно/);
    expect(krab.funFact).toMatch(/намеренно/);
    expect(`${krab.shortDesc} ${krab.recordKg}`).not.toMatch(/25 кг/);
  });
});

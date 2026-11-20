/**
 * Тексты тонких страниц, партия 5 (Сыщик 21.11): миграция 1484. Держит то,
 * что велел владелец: без цен и разметки, без служебных фраз и названия
 * стороннего каталога на экране, сомнительное не публикуется, решение
 * владельца не затирается.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { descriptionVoice } from '@/lib/places/description-voice';

const SQL = readFileSync(join(__dirname, '../../migrations/1484_thin_pages_texts_batch5.sql'), 'utf-8');

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

describe('миграция 1484: тексты тонких страниц, партия 5', () => {
  it('10 мест и 2 маршрута, slug без повторов, у каждого текста есть источник', () => {
    expect(places).toHaveLength(10);
    expect(routes).toHaveLength(2);
    expect(new Set(places.map((r) => r.slug)).size).toBe(10);
    expect(new Set(routes.map((r) => r.slug)).size).toBe(2);
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

  it('сомнительное не вошло: Энепка без подтверждения, сомы в Халактырском', () => {
    expect(all.map((r) => r.slug)).not.toContain('istochniki-enepka');
    const lake = all.find((r) => r.slug === 'halaktyrskoe-ozero');
    expect(lake?.txt).not.toMatch(/сом|горяч/i);
  });

  it('карточку с uuid в адресе находит и по ark_id/id, как страница места', () => {
    expect(all.map((r) => r.slug)).toContain('0b9f6ea0-0a7b-4c79-a805-5cd03ab3d379');
    expect(SQL).toContain('t.ark_id::text = s.slug OR t.id::text = s.slug');
  });
});

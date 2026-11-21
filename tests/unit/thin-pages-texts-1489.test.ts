/**
 * Тексты тонких страниц, партия 8 (Сыщик 21.11): миграция 1490 (номер сдвинут из-за столкновения с 1489_geyser_valley_facts_3487.sql). Держит то,
 * что велел владелец: без цен, телефонов и разметки, без служебных фраз и
 * названия стороннего каталога на экране, сомнительное не публикуется,
 * числа карточек не перебиваются, решение владельца не затирается.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { descriptionVoice } from '@/lib/places/description-voice';

const SQL = readFileSync(join(__dirname, '../../migrations/1490_thin_texts_batch8.sql'), 'utf-8');

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

describe('миграция 1490: тексты тонких страниц, партия 8', () => {
  it('2 места и 2 маршрута — те, что прислал Сыщик; у каждого текста есть источник', () => {
    expect(places.map((r) => r.slug).sort()).toEqual(['geologicheskij-muzej', 'vodopad-tahkoloch']);
    expect(routes.map((r) => r.slug).sort()).toEqual(['gora-letnyaya-poperechnaya', 'lezhbishche-sivuchej-marshrut']);
    for (const r of all) {
      expect(r.sources.length, r.slug).toBeGreaterThan(0);
      // Источники — только в журнале description_provenance; у сайта филиала
      // ТФГИ нет https, его адрес пишется как есть.
      for (const u of r.sources) expect(u, r.slug).toMatch(/^(https:\/\/|http:\/\/(www\.)?tfikamchatka\.ru\/)[^\s]+$/);
      for (const u of r.sources) expect(u, r.slug).not.toMatch(/idilesom/i);
    }
  });

  it('простые абзацы: без markdown, сносок, цен, телефонов и служебных фраз', () => {
    for (const { slug, txt } of all) {
      expect(txt, slug).not.toMatch(/^#|\*\*|\[\d+\]|\]\(/m);
      expect(txt, slug).not.toMatch(/₽|руб\.|рубл|\bцена\b|стоимост/i);
      expect(txt, slug).not.toMatch(/Ведар|ИдиЛес|idilesom|Википеди|черновик|оставляем|трек|не меняем/i);
      expect(txt, slug).not.toMatch(/\d{2}-\d{2}-\d{2}|\(8 ?4152\)|8\(4152\)/);
      expect(txt.length, slug).toBeGreaterThan(150);
      expect(descriptionVoice(txt).voice, slug).toBe('plain');
    }
  });

  it('сомнительное не вошло: координаты, высота и нитка пользовательского каталога; числа карточки маршрута не перебиваются', () => {
    const text = all.map((r) => r.txt).join('\n');
    expect(text).not.toMatch(/\d+[,.]\d{3,}°|\d+°\d+['′]/);
    expect(text).not.toMatch(/1417|1401|6,18/);
    const letnyaya = routes.find((r) => r.slug === 'gora-letnyaya-poperechnaya')!.txt;
    expect(letnyaya).not.toMatch(/12 км|четыр[её]х час/);
  });

  it('пишет только в пустое или короткое описание и не трогает решение владельца', () => {
    expect(SQL.match(/char_length\(COALESCE\(btrim\(t\.description\), ''\)\) < 300/g)).toHaveLength(2);
    expect(SQL.match(/written_by = 'owner-decision'/g)).toHaveLength(2);
    expect(SQL).toContain("'syshchik-sources'");
  });
});

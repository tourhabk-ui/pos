/**
 * Второй абзац описания парков (21.11, миграция 1483): дописывается к
 * сверенному справочнику, а не заменяет его; повтор ничего не меняет;
 * страница парка рисует описание абзацами.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { descriptionVoice } from '@/lib/places/description-voice';

const root = join(__dirname, '../..');
const SQL = readFileSync(join(root, 'migrations/1483_parks_nature_paragraph.sql'), 'utf-8');
const CLIENT = readFileSync(join(root, 'app/park/[slug]/_ParkClient.tsx'), 'utf-8');

const rows = [...SQL.matchAll(/\(\s*'([a-z-]+)',\s*'((?:[^']|'')*)'\)/g)].map((m) => ({
  slug: m[1],
  txt: m[2].replace(/''/g, "'"),
}));

describe('миграция 1483: абзац о природе парков', () => {
  it('четыре парка, «Река Коль» и «Вилючинский» не трогаются', () => {
    expect(rows.map((r) => r.slug).sort()).toEqual(['bystrinskiy', 'klyuchevskoy', 'komandorskiy', 'vachkazhets']);
  });

  it('простые абзацы без цен, разметки и служебных слов', () => {
    for (const { slug, txt } of rows) {
      expect(txt, slug).not.toMatch(/₽|руб|цена|стоимост|\*\*|Википеди|Ведар/i);
      expect(txt, slug).not.toContain('\n');
      expect(txt.length, slug).toBeGreaterThan(300);
      expect(descriptionVoice(txt).voice, slug).toBe('plain');
    }
  });

  it('дописывает, а не заменяет, и только один раз', () => {
    expect(SQL).toContain("SET description = btrim(p.description) || E'\\n' || src.txt");
    expect(SQL).toContain('position(src.txt IN p.description) = 0');
  });

  it('страница парка делит описание на абзацы', () => {
    expect(CLIENT).toContain(".split('\\n')");
  });
});

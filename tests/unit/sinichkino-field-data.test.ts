/**
 * Озеро Синичкино — полевые данные владельца (02.09.2026).
 *
 * Три вещи разошлись с реальностью на одном экране:
 *   - маркер места стоял на трассе А-401 у кольца в Северном, в 3.6 км от
 *     озера (Organic Maps / OSM: 53.081481, 158.691467);
 *   - пост Кузьмича ушёл с куратор-фото и оговоркой «своего снимка у нас
 *     пока нет», хотя снимок владельца есть;
 *   - попап карты обрывал описание на полуслове («дно илис»).
 *
 * Сторож держит: миграция называет источник и не выдаёт координату за
 * снятую прибором; снимок кладётся как настоящий (manual-upload) и не
 * затирает уже лежащий настоящий; попап режет по слову и с многоточием.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clipAtWord } from '@/lib/text/clip-at-word';

const ROOT = process.cwd();
const MIGRATION = readFileSync(join(ROOT, 'migrations/930_sinichkino_coords_and_owner_photo.sql'), 'utf-8');
const MAP_CLIENT = readFileSync(join(ROOT, 'app/map/_MapPageClient.tsx'), 'utf-8');

describe('миграция 930: координата', () => {
  it('переносит место на координату OSM и называет источник', () => {
    expect(MIGRATION).toMatch(/lat = 53\.081481/);
    expect(MIGRATION).toMatch(/lng = 158\.691467/);
    expect(MIGRATION).toMatch(/--[^\n]*владел/i);
    expect(MIGRATION).toMatch(/--[^\n]*Organic Maps/);
  });

  it('происхождение записано и не выдано за снятое прибором', () => {
    expect(MIGRATION).toMatch(/coord_source = 'osm_organic_930'/);
    expect(MIGRATION).toMatch(/coord_source_at = NOW\(\)/);
    expect(MIGRATION).not.toMatch(/coord_source = 'surveyed'/);
  });

  it('идемпотентна: guard по старой точке на трассе', () => {
    expect(MIGRATION).toMatch(/lat BETWEEN 53\.07 AND 53\.09/);
    expect(MIGRATION).toMatch(/lng BETWEEN 158\.63 AND 158\.65/);
  });
});

describe('миграция 930: снимок владельца', () => {
  // Hex разбит на смежные литералы по строкам (Postgres склеивает их в один):
  // одна 200-килобайтная строка делала регулярки других сторожей квадратичными.
  const decodeMatch = /decode\(\s*((?:'[0-9a-f]+'\s*)+),\s*'hex'\)/.exec(MIGRATION);
  const hexMatch = decodeMatch
    ? [decodeMatch[0], decodeMatch[1].replace(/['\s]/g, '')]
    : null;

  it('кладётся как настоящий снимок в каноне ручной загрузки', () => {
    expect(MIGRATION).toMatch(/'manual-upload'/);
    expect(MIGRATION).toMatch(/1280,\s*\n\s*720/);
    expect(MIGRATION).toMatch(/route_id, image_data, mime_type, prompt, model, width, height, author/);
  });

  it('байты — валидный JPEG разумного размера', () => {
    expect(hexMatch, 'в миграции нет decode(..., hex)').not.toBeNull();
    const buf = Buffer.from(hexMatch![1], 'hex');
    // SOI-маркер JPEG.
    expect(buf.subarray(0, 3).toString('hex')).toBe('ffd8ff');
    // EOI-маркер — файл не обрезан.
    expect(buf.subarray(-2).toString('hex')).toBe('ffd9');
    expect(buf.length).toBeGreaterThan(20_000);
    expect(buf.length).toBeLessThan(300_000);
  });

  it('не затирает уже лежащий настоящий снимок', () => {
    expect(MIGRATION).toMatch(/ON CONFLICT \(route_id\) DO UPDATE/);
    expect(MIGRATION).toMatch(/WHERE ai_route_images\.model NOT IN \('wikimedia', 'manual-upload'\)/);
  });

  it('привязывается через ark_id — так читают снимок карточка и постер', () => {
    expect(MIGRATION).toMatch(/SELECT p\.ark_id/);
    expect(MIGRATION).toMatch(/p\.ark_id IS NOT NULL/);
  });
});

describe('попап карты режет по слову', () => {
  it('короткий текст — как есть, без многоточия', () => {
    expect(clipAtWord('Вода пресная.', 120)).toBe('Вода пресная.');
  });

  it('длинный — по границе слова и с многоточием', () => {
    const text = 'От города до озера — полчаса на машине, и ты уже в тишине. Вода здесь пресная, к середине лета прогревается, но дно илистое.';
    const out = clipAtWord(text, 120);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toMatch(/илис…$/);
    expect(out.length).toBeLessThanOrEqual(121);
    // Обрезано по слову: перед многоточием — целое слово из исходника.
    const lastWord = out.slice(0, -1).split(' ').pop()!;
    expect(text.split(/[\s.,]+/)).toContain(lastWord);
  });

  it('висячая запятая перед многоточием снимается', () => {
    expect(clipAtWord('раз, два, три, четыре', 10)).toBe('раз, два…');
  });

  it('одно длинное слово без пробелов — режется по лимиту, но с многоточием', () => {
    expect(clipAtWord('а'.repeat(50), 10)).toBe(`${'а'.repeat(10)}…`);
  });

  it('карта пользуется общей обрезкой, а не slice по байту', () => {
    expect(MAP_CLIENT).toMatch(/clipAtWord\(firstLine, 120\)/);
    expect(MAP_CLIENT).toMatch(/clipAtWord\(firstLine, 80\)/);
    expect(MAP_CLIENT).not.toMatch(/description\.split\('\\n'\)\[0\]\.slice\(0, 120\)/);
  });
});

/**
 * Кошелевские термальные поля (миграция 1264, владелец 15.10: «поправь»).
 *
 * Две карточки в 6 км друг от друга: «Верхне-Кошелевские» и «Гремучие ключи».
 * Кроноцкий заповедник называет «Гремучими ключами» верхнее поле (кратер
 * вулкана Валентин, 1250–1400 м), а нижнее помещает на 750–800 м. Рельеф
 * (SRTM) ставит точки карточек на 1263 и 760 м, вторая — узел OSM с подписью
 * «Гремучие ключи». Значит, точки верны, а имя второй — нет.
 *
 * Держится: точки не двигаются; вторая карточка переименована только из
 * прежнего имени и прежнее имя ушло в псевдонимы до смены; «Гремучие ключи»
 * ищутся у обеих (у каждой — со своим источником); справки — только поверх
 * снятого 1247 и справочным голосом; пары источника у двух карточек разные
 * (уникальный индекс видимых мест).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { descriptionVoice } from '@/lib/places/description-voice';

const SQL = readFileSync(join(process.cwd(), 'migrations/1264_koshelev_thermal_fields.sql'), 'utf-8');
const BODY = SQL.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
const UPPER = '14999081-db57-43d3-8aad-f6c8361b69ac';
const LOWER = 'e7cc9f9d-479e-432f-8d1c-adcf6b62a1d8';

/** Текст справки, собранный из конкатенации литералов в SET description = …. */
function descriptionOf(id: string): string {
  const stmt = BODY.split(/;\s*\n/).find((s) => /SET description =/.test(s) && s.includes(`'${id}'`)) ?? '';
  const expr = stmt.slice(stmt.indexOf('SET description ='), stmt.indexOf('essence ='));
  return [...expr.matchAll(/E?'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'").replace(/\\n/g, '\n')).join('');
}

describe('миграция 1264', () => {
  it('точки не двигаются: ни lat, ни lng', () => {
    expect(BODY).not.toMatch(/\blat\s*=|\blng\s*=/);
    expect(BODY).not.toMatch(/DELETE FROM/);
  });

  it('вторая карточка переименована только из прежнего имени — после того, как оно ушло в псевдонимы', () => {
    const rename = BODY.indexOf("SET name = 'Нижне-Кошелевское термальное поле'");
    const aliases = BODY.indexOf('INSERT INTO place_aliases');
    expect(rename).toBeGreaterThan(-1);
    expect(aliases).toBeGreaterThan(-1);
    expect(aliases).toBeLessThan(rename);
    expect(BODY.slice(rename, BODY.indexOf(';', rename))).toMatch(new RegExp(`WHERE id::text = '${LOWER}'\\s+AND name = 'Гремучие ключи'`));
  });

  it('«Гремучие ключи» ищутся у обеих карточек, каждая — со своим источником', () => {
    expect(BODY).toContain(`('${LOWER}', 'Гремучие ключи', 'OpenStreetMap, узел 5140732311')`);
    expect(BODY).toMatch(new RegExp(`\\('${UPPER}', 'Гремучие ключи', 'kronoki\\.ru`));
    expect(BODY).toMatch(/ON CONFLICT DO NOTHING/);
  });

  it('справки — только поверх снятого 1247: то, что уже переписано, не трогается', () => {
    for (const id of [UPPER, LOWER]) {
      const stmt = BODY.split(/;\s*\n/).find((s) => /SET description =/.test(s) && s.includes(`'${id}'`)) ?? '';
      expect(stmt, id).toMatch(/AND description IS NULL\s+AND description_withdrawn IS NOT NULL/);
    }
  });

  it('справки — справочным голосом, с числами заповедника и без его опечатки', () => {
    const upper = descriptionOf(UPPER);
    const lower = descriptionOf(LOWER);
    for (const t of [upper, lower]) {
      expect(t.length).toBeGreaterThan(300);
      expect(descriptionVoice(t).voice, t.slice(0, 60)).not.toBe('diary');
    }
    expect(upper).toMatch(/в кратере вулкана Валентин/);
    expect(upper).toMatch(/1250–1400 м/);
    expect(lower).toMatch(/750–800 м/);
    expect(lower).toMatch(/подписана «Гремучие ключи»/);
    // «120–1530 °С» у заповедника — опечатка; числа, в котором ошибся источник, нет.
    expect(upper + lower).not.toMatch(/1530/);
  });

  it('у двух карточек — разные пары источника (уникальный индекс видимых мест)', () => {
    const names = [...BODY.matchAll(/source_name = '((?:[^']|'')*)'/g)].map((m) => m[1]);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
  });
});

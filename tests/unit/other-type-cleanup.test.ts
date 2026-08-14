/**
 * Разбор «прочего»: закопанные достопримечательности и не-места (миграция 859).
 *
 * Тип other оказался двумя кучами: настоящие места с потерянным типом
 * (Кутхины баты, Ганальские востряки, Парящая долина — в срезах по видам не
 * участвовали) и видимые не-места (эссе, лозунги, справки, судно). Первым —
 * честный тип, вторым — мягкое скрытие.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SQL = readFileSync(
  join(process.cwd(), 'migrations/859_other_type_cleanup.sql'),
  'utf-8',
);
const CODE = SQL.replace(/^\s*--.*$/gm, '');

describe('прицельность и идемпотентность', () => {
  it('каждый UPDATE типа гейтится текущим типом other', () => {
    const updates = CODE.match(/UPDATE places SET location_type[^;]+;/g) ?? [];
    expect(updates.length).toBeGreaterThanOrEqual(25);
    for (const u of updates) {
      expect(u).toMatch(/AND location_type = 'other'/);
      expect(u).toMatch(/WHERE id = '[0-9a-f-]{36}'/);
    }
  });

  it('скрытий ровно восемь, каждое гейтится именем и текущей видимостью', () => {
    // Скрытие — самое сильное действие миграции: имя в гейте гарантирует,
    // что прячется именно эссе, а не место, случайно получившее этот id.
    const hides = CODE.match(/UPDATE places SET is_visible = false[^;]+;/g) ?? [];
    expect(hides.length).toBe(8);
    for (const h of hides) {
      expect(h).toMatch(/AND name = '/);
      expect(h).toMatch(/AND is_visible = true/);
    }
  });

  it('видимость возвращается только не-местам, ничего не показывается впервые', () => {
    expect(CODE).not.toMatch(/SET is_visible = true/);
  });

  it('ничего не удаляется, не сливается, координаты и имена не трогаются', () => {
    expect(CODE).not.toMatch(/\bDELETE\b/);
    expect(CODE).not.toMatch(/merged_into_id/);
    expect(CODE).not.toMatch(/SET\s+lat/i);
    expect(CODE).not.toMatch(/SET\s+lng/i);
    expect(CODE).not.toMatch(/SET name/);
  });

  it('в строковых литералах нет точки с запятой (урок миграции 843)', () => {
    for (const m of SQL.matchAll(/'([^']*)'/g)) {
      expect(m[1]).not.toContain(';');
    }
  });
});

describe('назначаемые типы словарные', () => {
  it('все целевые типы имеют подписи в ОБОИХ словарях', () => {
    const targets = [...new Set(
      (CODE.match(/SET location_type = '(\w+)'/g) ?? [])
        .map(s => s.replace(/SET location_type = '(\w+)'/, '$1')),
    )];
    expect(targets.length).toBeGreaterThanOrEqual(8);
    for (const file of ['components/map/PlaceMapSheet.tsx', 'app/places/[id]/page.tsx']) {
      const dict = readFileSync(join(process.cwd(), file), 'utf-8');
      for (const t of targets) {
        expect(dict, `${t} в ${file}`).toMatch(new RegExp(`\\b${t}:`));
      }
    }
  });
});

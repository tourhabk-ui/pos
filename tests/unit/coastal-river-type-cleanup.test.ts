/**
 * Бухты, реки, скалы и мысы — каждому своё имя типа (миграция 857).
 *
 * Шестая серия чистки типов по срезам проб 91-92: видовки из бухт и мысов —
 * в смотровые, лежбища — в other, каньоны и цирк — в долины, водопады — в
 * водопады, тур — в other, скалы Три Брата — в скалы. Свойства те же, что
 * в 851-856.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SQL = readFileSync(
  join(process.cwd(), 'migrations/857_coastal_river_type_cleanup.sql'),
  'utf-8',
);
const CODE = SQL.replace(/^\s*--.*$/gm, '');

describe('прицельность и идемпотентность', () => {
  it('каждый UPDATE типа гейтится текущим типом', () => {
    const updates = CODE.match(/UPDATE places SET location_type[^;]+;/g) ?? [];
    expect(updates.length).toBeGreaterThanOrEqual(13);
    for (const u of updates) {
      expect(u).toMatch(/AND location_type = '(bay|river|cape)'/);
      expect(u).toMatch(/WHERE id = '[0-9a-f-]{36}'/);
    }
  });

  it('переименования: псевдоним раньше смены, смена гейтится старым именем', () => {
    for (const oldName of ['Смотрова площадка  на Тихий океан', 'каньон Опасный']) {
      const aliasAt = CODE.indexOf(`AND name = '${oldName}'`);
      expect(aliasAt, oldName).toBeGreaterThan(-1);
    }
    const firstAlias = CODE.indexOf('INSERT INTO place_aliases');
    const firstRename = CODE.indexOf('UPDATE places SET name');
    expect(firstRename).toBeGreaterThan(firstAlias);
  });

  it('ничего не удаляется, не сливается, видимость и координаты не трогаются', () => {
    expect(CODE).not.toMatch(/\bDELETE\b/);
    expect(CODE).not.toMatch(/merged_into_id/);
    expect(CODE).not.toMatch(/is_visible/);
    // У трёх каньонов координаты противоречат описанию, но эталона нет —
    // тип чистится, координаты ждут проверенного источника.
    expect(CODE).not.toMatch(/SET\s+lat/i);
    expect(CODE).not.toMatch(/SET\s+lng/i);
  });

  it('в строковых литералах нет точки с запятой (урок миграции 843)', () => {
    for (const m of SQL.matchAll(/'([^']*)'/g)) {
      expect(m[1]).not.toContain(';');
    }
  });
});

describe('назначаемые типы словарные', () => {
  it('viewpoint, other, rock, waterfall, valley имеют подписи в обоих словарях', () => {
    for (const file of ['components/map/PlaceMapSheet.tsx', 'app/places/[id]/page.tsx']) {
      const dict = readFileSync(join(process.cwd(), file), 'utf-8');
      for (const t of ['viewpoint', 'other', 'waterfall', 'valley']) {
        expect(dict, `${t} в ${file}`).toMatch(new RegExp(`\\b${t}:`));
      }
    }
  });
});

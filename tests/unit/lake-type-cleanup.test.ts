/**
 * Тип «озеро» — только озёра (миграция 855).
 *
 * Четвёртая серия чистки типов. Срез озёр (проба 89) нашёл в типе lake
 * водопад, реку, кордон и бассейн — им менять тип, не сливать: водопад
 * Тахколоч — не дубль озера, это другой объект с неверным типом.
 * Свойства держатся те же, что в 851/852/854.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SQL = readFileSync(
  join(process.cwd(), 'migrations/855_lake_type_cleanup.sql'),
  'utf-8',
);
const CODE = SQL.replace(/^\s*--.*$/gm, '');

describe('прицельность и идемпотентность', () => {
  it('каждый UPDATE типа гейтится текущим типом lake', () => {
    const updates = CODE.match(/UPDATE places SET location_type[^;]+;/g) ?? [];
    expect(updates.length).toBeGreaterThanOrEqual(4);
    for (const u of updates) {
      expect(u).toMatch(/AND location_type = 'lake'/);
      expect(u).toMatch(/WHERE id = '[0-9a-f-]{36}'/);
    }
  });

  it('ничего не удаляется, не сливается, видимость и имена не трогаются', () => {
    expect(CODE).not.toMatch(/\bDELETE\b/);
    expect(CODE).not.toMatch(/merged_into_id/);
    expect(CODE).not.toMatch(/is_visible/);
    expect(CODE).not.toMatch(/SET name/);
  });

  it('в строковых литералах нет точки с запятой (урок миграции 843)', () => {
    for (const m of SQL.matchAll(/'([^']*)'/g)) {
      expect(m[1]).not.toContain(';');
    }
  });
});

describe('назначаемые типы словарные', () => {
  it('waterfall, river, other имеют подписи в обоих словарях', () => {
    // Словари расходились: PlaceMapSheet знал cave, но не viewpoint,
    // страница места — наоборот. Проверяется объединение обоих.
    const dicts =
      readFileSync(join(process.cwd(), 'components/map/PlaceMapSheet.tsx'), 'utf-8') +
      readFileSync(join(process.cwd(), 'app/places/[id]/page.tsx'), 'utf-8');
    for (const t of ['waterfall', 'river', 'other']) {
      expect(dicts).toMatch(new RegExp(`\\b${t}:`));
    }
  });
});

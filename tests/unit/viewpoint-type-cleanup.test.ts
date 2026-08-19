/**
 * Смотровые называются смотровыми (миграция 854).
 *
 * Третья серия чистки типов. «Вид на сопку Острая» в типе mountain — это
 * смотровая, занимавшая в срезе гор место ближайшего соседа настоящей горы.
 * Свойства держатся те же, что в 851/852.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SQL = readFileSync(
  join(process.cwd(), 'migrations/854_viewpoint_type_cleanup.sql'),
  'utf-8',
);
const CODE = SQL.replace(/^\s*--.*$/gm, '');

describe('прицельность и идемпотентность', () => {
  it('каждый UPDATE типа гейтится текущим типом', () => {
    const updates = CODE.match(/UPDATE places SET location_type[^;]+;/g) ?? [];
    expect(updates.length).toBeGreaterThanOrEqual(3);
    for (const u of updates) {
      expect(u).toMatch(/location_type = '(mountain|lake|other)'/);
    }
  });

  it('переименование гейтится старым именем', () => {
    expect(CODE).toMatch(/AND name = 'смотровая'/);
  });

  it('ничего не удаляется, не сливается, видимость не трогается', () => {
    expect(CODE).not.toMatch(/\bDELETE\b/);
    expect(CODE).not.toMatch(/merged_into_id/);
    expect(CODE).not.toMatch(/is_visible/);
  });

  it('в строковых литералах нет точки с запятой (урок миграции 843)', () => {
    for (const m of SQL.matchAll(/'([^']*)'/g)) {
      expect(m[1]).not.toContain(';');
    }
  });
});

describe('назначаемые типы словарные', () => {
  it('waterfall, viewpoint, hot_spring имеют подписи', () => {
    const dicts =
      readFileSync(join(process.cwd(), 'components/map/PlaceMapSheet.tsx'), 'utf-8') +
      readFileSync(join(process.cwd(), 'app/places/[id]/page.tsx'), 'utf-8');
    for (const t of ['waterfall', 'viewpoint', 'hot_spring']) {
      expect(dicts).toMatch(new RegExp(`\\b${t}:`));
    }
  });
});

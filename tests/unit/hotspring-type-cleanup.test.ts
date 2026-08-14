/**
 * Тип «термальный источник» — только источники (миграция 852).
 *
 * Продолжение 851: перепись источников (проба 83) нашла в типе hot_spring
 * водопады, спортивное событие, зону отдыха, бассейн, трубу с газом и
 * природный парк целиком. Свойства миграции те же, и сторож держит те же
 * три: прицельность, нетронутую видимость, словарные типы.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SQL = readFileSync(
  join(process.cwd(), 'migrations/852_hotspring_type_cleanup.sql'),
  'utf-8',
);
const CODE = SQL.replace(/^\s*--.*$/gm, '');

describe('миграция прицельна и идемпотентна', () => {
  it('каждый UPDATE гейтится текущим типом hot_spring', () => {
    const updates = CODE.match(/UPDATE places SET location_type[^;]+;/g) ?? [];
    expect(updates.length).toBeGreaterThanOrEqual(2);
    for (const u of updates) {
      expect(u).toMatch(/location_type = 'hot_spring'/);
    }
  });

  it('ничего не удаляется, не сливается, видимость не трогается', () => {
    expect(CODE).not.toMatch(/\bDELETE\b/);
    expect(CODE).not.toMatch(/merged_into_id/);
    expect(CODE).not.toMatch(/is_visible/);
  });
});

describe('новые типы — со словарной подписью', () => {
  it('каждый назначаемый тип известен хотя бы одному словарю', () => {
    const dicts =
      readFileSync(join(process.cwd(), 'components/map/PlaceMapSheet.tsx'), 'utf-8') +
      readFileSync(join(process.cwd(), 'app/places/[id]/page.tsx'), 'utf-8');
    const assigned = [...CODE.matchAll(/SET location_type = '(\w+)'/g)].map(m => m[1]);
    expect(assigned.length).toBeGreaterThan(0);
    for (const t of new Set(assigned)) {
      expect(dicts).toMatch(new RegExp(`\\b${t}:`));
    }
  });
});

/**
 * Тип «Этнокультурное место» (ethnic) — решение владельца 04.10 «завести».
 *
 * Тип без производителя — провод в никуда (правило 10.09): держим связку
 * целиком — подпись, форма значка, место в счёте стихий, фильтры каталога и
 * карты, и миграцию, которая тип кому-то выдала.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { locationTypeLabel } from '@/lib/places/location-types';
import { PLACE_MARKER_KINDS, PLACE_KIND_COLOR } from '@/lib/map/place-marker-icons';
import { EXCLUDED_TYPES } from '@/lib/stats/element-groups';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('ethnic — объявлен вместе с производителем', () => {
  it('подпись и значок свои', () => {
    expect(locationTypeLabel('ethnic')).toBe('Этнокультурное место');
    expect(PLACE_MARKER_KINDS).toContain('ethnic');
    expect(PLACE_KIND_COLOR.ethnic).toMatch(/^#[0-9A-F]{6}$/i);
  });

  it('в счёт стихий не идёт (не природа), но и не теряется', () => {
    expect(EXCLUDED_TYPES).toContain('ethnic');
  });

  it('находится фильтром каталога и /map', () => {
    expect(read('app/routes/_RoutesPageClient.tsx')).toContain("value: 'ethnic'");
    expect(read('app/map/_MapPageClient.tsx')).toContain("id: 'ethnic'");
  });

  it('миграция выдаёт тип по имени места и прежнему типу, без угадывания', () => {
    const sql = read('migrations/1160_ethnic_location_type.sql');
    expect(sql).toContain("name = 'Этническое стойбище Кайныран'");
    expect(sql).toContain("AND location_type = 'historical'");
    expect(sql).toContain("name = 'Ительменская деревня — этнотуризм'");
    expect(sql).toContain("AND location_type = 'settlement'");
    expect(sql).not.toMatch(/ILIKE|~\*/);
  });
});

// @vitest-environment node
/**
 * «Зеленовские озерки»: чужая линия снята (миграция 1192, скрин владельца 09.10).
 *
 * После правки точки 03.10 полевой экран говорил «Данные маршрута не сходятся»:
 * линия маршрута (три вершины, «gpx», 0,57 км) лежала в 29,9 км от его же
 * единственной точки. Сторож держит и симптом на настоящих числах прода, и
 * лекарство: миграция снимает ровно ту линию и ничего больше, линия остаётся в
 * архиве (триггер 901), числа уходят вместе с ней, происхождение точки
 * записывается без права называться «снятой на месте».
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { approachPlan, DATA_CONFLICT_KM } from '@/lib/on-route/approach';

const SQL = readFileSync(join(process.cwd(), 'migrations/1192_zelenovskie_ozerki_foreign_line.sql'), 'utf-8');
const CODE = SQL.replace(/--[^\n]*/g, '');

// Числа прода (пробы 740-742): точка места и линия маршрута.
const POINT = { lat: 53.287721, lng: 158.348899 };
const LINE = [
  { lat: 53.07791, lng: 158.629878 },
  { lat: 53.078989, lng: 158.635923 },
  { lat: 53.08001, lng: 158.637284 },
];

describe('симптом: что экран видел до миграции', () => {
  it('точка в ~30 км от линии — это конфликт данных, а не неточность', () => {
    const plan = approachPlan(POINT, POINT, LINE)!;
    expect(plan.dataConflict).toBe(true);
    expect(plan.exitKm).toBeGreaterThan(29);
    expect(plan.exitKm).toBeLessThan(31);
    expect(plan.exitKm).toBeGreaterThan(DATA_CONFLICT_KM * 10);
  });

  it('без линии конфликту не из чего родиться: плана подхода нет, экран считает расстояние до точки', () => {
    expect(approachPlan(POINT, POINT, [])).toBeNull();
  });
});

describe('миграция 1192', () => {
  it('снимает линию, расстояние и набор высоты — всё, что посчитано по ней', () => {
    expect(CODE).toMatch(/SET geometry = NULL,\s+distance_km = NULL,\s+elevation_gain_m = NULL/);
  });

  it('гейт — сама линия (три её координаты), а не только id: заменённую линию не трогаем', () => {
    expect(CODE).toMatch(/geometry::text LIKE '%53\.07791%'/);
    expect(CODE).toMatch(/geometry::text LIKE '%158\.629878%'/);
    expect(CODE).toMatch(/geometry::text LIKE '%158\.637284%'/);
    expect(CODE).toMatch(/AND geometry IS NOT NULL/);
  });

  it('id сравниваются текстом с обеих сторон (id и ark_id: API отдаёт COALESCE)', () => {
    expect(CODE).toMatch(/id::text = 'cf257914-fff2-4a72-baba-4a4381d7a83d'/);
    expect(CODE).toMatch(/ark_id::text = 'cf257914-fff2-4a72-baba-4a4381d7a83d'/);
  });

  it('линия не удаляется насовсем: ни DELETE, ни DROP — возврат из архива 901', () => {
    expect(CODE).not.toMatch(/\bDELETE\b|\bDROP\b|TRUNCATE/i);
    expect(SQL).toMatch(/route_geometry_archive/);
    // координаты чужой линии записаны в шапке — читаются и без базы
    expect(SQL).toMatch(/\(53\.07791, 158\.629878\) → \(53\.078989, 158\.635923\) → \(53\.08001, 158\.637284\)/);
  });

  it('точка: coord_source — external и только из unknown; «снята на месте» не ставится', () => {
    expect(CODE).toMatch(/SET coord_source = 'external'/);
    expect(CODE).toMatch(/AND coord_source = 'unknown'/);
    expect(CODE).not.toMatch(/coord_source = 'surveyed'/);
    expect(CODE).toMatch(/id::text = 'f31f3774-65d4-47b7-a03e-4e3d4a575100'/);
  });

  it('координата места не двигается: правка 03.10 остаётся', () => {
    expect(CODE).not.toMatch(/\blat\s*=|\blng\s*=/);
  });

  it('исход называется вслух: линия осталась или точка не external — предупреждение', () => {
    expect(CODE).toMatch(/RAISE WARNING '\[1192\] у «Зеленовских озерок» линия осталась/);
    expect(CODE).toMatch(/RAISE WARNING '\[1192\] coord_source места/);
  });
});

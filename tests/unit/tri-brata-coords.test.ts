/**
 * Три Брата встают на своё место (миграция 858).
 *
 * Единственная миграция серии, которая трогает координаты, — и ровно потому,
 * что для неё есть проверяемый эталон (ruwiki «Три Брата (Камчатка)»:
 * 52.8937/158.6879). Сторож закрепляет само правило: координатная правка
 * без гейта по точным старым значениям — это правка вслепую.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SQL = readFileSync(
  join(process.cwd(), 'migrations/858_tri_brata_coords.sql'),
  'utf-8',
);
const CODE = SQL.replace(/^\s*--.*$/gm, '');

describe('координатная правка — только с эталоном и гейтом', () => {
  it('правится ровно одна запись, гейт по точным старым координатам', () => {
    const coordUpdates = CODE.match(/UPDATE places\s+SET lat[^;]+;/g) ?? [];
    expect(coordUpdates.length).toBe(1);
    expect(coordUpdates[0]).toMatch(/'e265d0f0-8187-4d7a-b0e4-fe9be5a2d9e0'/);
    expect(coordUpdates[0]).toMatch(/AND lat = 52\.94662920 AND lng = 158\.67862180/);
  });

  it('новые координаты — эталон ruwiki, и он назван в миграции', () => {
    expect(CODE).toMatch(/SET lat = 52\.8937, lng = 158\.6879/);
    expect(SQL).toMatch(/ruwiki/);
    expect(SQL).toMatch(/961494/);
  });

  it('переименование: псевдоним раньше смены, смена гейтится старым именем', () => {
    const aliasAt = CODE.indexOf('INSERT INTO place_aliases');
    const renameAt = CODE.indexOf("UPDATE places SET name = 'Скалы Три Брата'");
    expect(aliasAt).toBeGreaterThan(-1);
    expect(renameAt).toBeGreaterThan(aliasAt);
    expect(CODE).toMatch(/AND name = 'Скалы три брата'/);
  });

  it('ничего не удаляется, не сливается, видимость и типы не трогаются', () => {
    expect(CODE).not.toMatch(/\bDELETE\b/);
    expect(CODE).not.toMatch(/merged_into_id/);
    expect(CODE).not.toMatch(/is_visible/);
    expect(CODE).not.toMatch(/location_type/);
  });

  it('в строковых литералах нет точки с запятой (урок миграции 843)', () => {
    for (const m of SQL.matchAll(/'([^']*)'/g)) {
      expect(m[1]).not.toContain(';');
    }
  });
});

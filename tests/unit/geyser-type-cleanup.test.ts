/**
 * Тип «гейзер» — только гейзерное; Долина гейзеров снова видна (миграция 856).
 *
 * Пятая серия чистки типов. Срез гейзеров (проба 90) нашёл в типе geyser
 * нарзаны, парогидротермальные источники, фумаролу, долину, мыс и кальдеру,
 * а в горах — два трека-маршрута. Им менять тип, не сливать.
 *
 * Отдельно охраняется возврат видимости «Долине гейзеров»: единственные две
 * записи о визитной карточке Камчатки стояли скрытыми — у миграции есть
 * законное право тронуть is_visible, но ровно у одной записи и ровно в одну
 * сторону (false → true).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SQL = readFileSync(
  join(process.cwd(), 'migrations/856_geyser_mountain_type_cleanup.sql'),
  'utf-8',
);
const CODE = SQL.replace(/^\s*--.*$/gm, '');

describe('прицельность и идемпотентность', () => {
  it('каждый UPDATE типа гейтится текущим типом', () => {
    const updates = CODE.match(/UPDATE places SET location_type[^;]+;/g) ?? [];
    expect(updates.length).toBeGreaterThanOrEqual(10);
    for (const u of updates) {
      expect(u).toMatch(/AND location_type = '(geyser|mountain)'/);
      expect(u).toMatch(/WHERE id = '[0-9a-f-]{36}'/);
    }
  });

  it('переименование: псевдоним раньше смены имени, смена гейтится старым именем', () => {
    const aliasAt = CODE.indexOf('INSERT INTO place_aliases');
    const renameAt = CODE.indexOf("UPDATE places SET name = 'Долина Смерти'");
    expect(aliasAt).toBeGreaterThan(-1);
    expect(renameAt).toBeGreaterThan(aliasAt);
    expect(CODE).toMatch(/AND name = 'ТРОПА МЕДВЕДЯ \(ДОЛИНА СМЕРТИ\)'/);
  });

  it('видимость трогается ровно у одной записи и только false → true', () => {
    const vis = CODE.match(/UPDATE places SET is_visible[^;]+;/g) ?? [];
    expect(vis.length).toBe(1);
    expect(vis[0]).toMatch(/SET is_visible = true/);
    expect(vis[0]).toMatch(/'796c18b3-e199-4ac6-bbd6-de50d560ff40'/);
    expect(vis[0]).toMatch(/AND name = 'Долина гейзеров'/);
    expect(vis[0]).toMatch(/AND is_visible = false/);
    expect(CODE).not.toMatch(/is_visible = false\s*(,|WHERE)/);
  });

  it('ничего не удаляется и не сливается', () => {
    expect(CODE).not.toMatch(/\bDELETE\b/);
    expect(CODE).not.toMatch(/merged_into_id/);
  });

  it('в строковых литералах нет точки с запятой (урок миграции 843)', () => {
    for (const m of SQL.matchAll(/'([^']*)'/g)) {
      expect(m[1]).not.toContain(';');
    }
  });

  it('координаты не трогаются: эталона для Долины Смерти ещё нет', () => {
    expect(CODE).not.toMatch(/SET\s+lat/i);
    expect(CODE).not.toMatch(/SET\s+lng/i);
  });
});

describe('назначаемые типы словарные', () => {
  it('hot_spring, valley, cape, volcano, other имеют подписи в ОБОИХ словарях', () => {
    // Словари расходились (PlaceMapSheet знал cave, но не viewpoint; страница
    // места — наоборот) — с этой серии оба словаря синхронизированы до полного
    // объединения, и проверка стала строже: каждый тип в КАЖДОМ словаре.
    for (const file of ['components/map/PlaceMapSheet.tsx', 'app/places/[id]/page.tsx']) {
      const dict = readFileSync(join(process.cwd(), file), 'utf-8');
      for (const t of ['hot_spring', 'valley', 'cape', 'volcano', 'viewpoint', 'cave', 'other']) {
        expect(dict, `${t} в ${file}`).toMatch(new RegExp(`\\b${t}:`));
      }
    }
  });
});

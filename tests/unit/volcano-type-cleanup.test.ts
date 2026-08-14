/**
 * Тип «вулкан» перестаёт быть свалкой (миграция 851).
 *
 * Перепись 14.08: в типе volcano помимо вулканов лежали электростанция,
 * водопад, две лавовые пещеры, смотровая и семь названий туров. Слово
 * владельца: «менять тип, не сливать» — ГеоЭС не дубль вулкана, это другой
 * объект с неверным типом.
 *
 * Сторож держит три свойства миграции, которые легко потерять при правке:
 * прицельность (id И текущий тип), нетронутую видимость, и то, что старое имя
 * Ходутки уходит в псевдонимы, а не в никуда.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SQL = readFileSync(
  join(process.cwd(), 'migrations/851_volcano_type_cleanup.sql'),
  'utf-8',
);
const CODE = SQL.replace(/^\s*--.*$/gm, '');

describe('миграция прицельна и идемпотентна', () => {
  it('каждый UPDATE типа гейтится текущим типом volcano', () => {
    // Без гейта повторный прогон перезаписал бы тип, выставленный позже
    // руками. Гейт делает каждый UPDATE no-op после первого применения.
    const updates = CODE.match(/UPDATE places SET location_type[^;]+;/g) ?? [];
    expect(updates.length).toBeGreaterThanOrEqual(4);
    for (const u of updates) {
      expect(u).toMatch(/location_type = 'volcano'/);
    }
  });

  it('ничего не удаляется и не сливается', () => {
    expect(CODE).not.toMatch(/\bDELETE\b/);
    expect(CODE).not.toMatch(/merged_into_id/);
  });

  it('видимость не трогается', () => {
    // Это правка ТИПА: скрытые туры остаются скрытыми, видимый водопад —
    // видимым. Витриной распоряжаются другие механизмы.
    expect(CODE).not.toMatch(/is_visible/);
  });
});

describe('новые типы — из живого словаря, не сироты', () => {
  it('каждый назначаемый тип имеет подпись хотя бы в одном словаре', () => {
    // Словари типов на платформе разошлись (находка 14.08): карточка места
    // знает viewpoint, но не cave; лист карты — наоборот. У обоих есть
    // фолбэк «Место», поэтому проверяем объединение — тип, которого нет
    // НИГДЕ, был бы сиротой без подписи вовсе.
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

describe('Ходутка', () => {
  it('запись не удаляется — это единственный настоящий вулкан Ходутка', () => {
    expect(CODE).toMatch(/SET name = 'Вулкан Ходутка'/);
  });

  it('старое имя уходит в псевдонимы до переименования', () => {
    // Поиск по «затерянный мир» продолжает находить вулкан.
    const aliasAt = CODE.indexOf('INSERT INTO place_aliases');
    const renameAt = CODE.indexOf("SET name = 'Вулкан Ходутка'");
    expect(aliasAt).toBeGreaterThan(-1);
    expect(aliasAt).toBeLessThan(renameAt);
  });

  it('переименование гейтится старым именем — идемпотентно', () => {
    expect(CODE).toMatch(/AND name = 'Вулкан Ходутка — затерянный мир'/);
  });
});

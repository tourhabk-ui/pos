/**
 * Запись подстраивается под настоящий тип колонки.
 *
 * Владелец 05.08, глядя на очередную правку: «мы делаем одно и то же по кругу».
 * Он был прав, и вот из чего состоял круг.
 *
 * Схема прода год расходилась с тем, что объявляли миграции: состав тура был
 * `jsonb` там, где репозиторий считал `TEXT[]`. Миграция 823 привела три
 * колонки — данные починились, но «Сохранить» в кабинете всё равно падало с
 * «invalid input syntax for type json»: разошлась не только тройка. Дальше
 * напрашивалось угадать следующую колонку, выкатить, проверить, угадать
 * снова — то есть крутить тот же круг ещё несколько раз.
 *
 * Поэтому запись перестала предполагать. Она спрашивает у `information_schema`,
 * какой тип у колонки, и сериализует значение соответственно: массив в `TEXT[]`
 * идёт массивом, в `json`/`jsonb` — строкой. Кабинет работает в любой схеме, а
 * миграции приводят её к одному виду отдельно и без спешки.
 *
 * Цена ошибки в обе стороны одинаково молчаливая: `JSON.stringify(['а','б'])`
 * в `TEXT[]` ляжет ОДНИМ пунктом с кавычками и скобками, а массив в `jsonb` не
 * разберётся вовсе.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { valueForColumn } from '@/lib/db/column-types';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const strip = (s: string) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

describe('значение готовится по типу колонки', () => {
  const asText = new Map([['included', '_text']]);
  const asJsonb = new Map([['included', 'jsonb']]);
  const asJson = new Map([['included', 'json']]);

  it('в TEXT[] массив идёт массивом', () => {
    expect(valueForColumn(['а', 'б'], 'included', asText)).toEqual(['а', 'б']);
  });

  it('в jsonb — строкой JSON', () => {
    expect(valueForColumn(['а', 'б'], 'included', asJsonb)).toBe('["а","б"]');
  });

  it('json и jsonb обрабатываются одинаково', () => {
    expect(valueForColumn(['а'], 'included', asJson))
      .toBe(valueForColumn(['а'], 'included', asJsonb));
  });

  it('не-массивы не трогаются', () => {
    for (const v of ['текст', 42, true, null, undefined]) {
      expect(valueForColumn(v, 'included', asJsonb)).toBe(v);
    }
  });

  it('неизвестная колонка — значение как есть', () => {
    // Пусть ошибётся Postgres и назовёт колонку, чем мы молча подменим смысл.
    expect(valueForColumn(['а'], 'нет_такой', asText)).toEqual(['а']);
  });

  it('пустой массив остаётся пустым, а не превращается в null', () => {
    expect(valueForColumn([], 'included', asText)).toEqual([]);
    expect(valueForColumn([], 'included', asJsonb)).toBe('[]');
  });
});

describe('все пути записи тура спрашивают схему', () => {
  const WRITERS = [
    'app/api/admin/operator-tours/[id]/route.ts',
    'app/api/hub/operator/tours/[id]/route.ts',
    'lib/api/operator-tours.ts',
  ];

  it('каждый зовёт getColumnTypes и valueForColumn', () => {
    for (const file of WRITERS) {
      const src = strip(read(file));
      expect(src, `${file} не спрашивает типы колонок`).toMatch(/getColumnTypes\(/);
      expect(src, `${file} не готовит значение по типу`).toMatch(/valueForColumn|arrayField/);
    }
  });

  it('ни один не пишет массив вслепую JSON.stringify', () => {
    for (const file of WRITERS) {
      const src = strip(read(file));
      for (const col of ['included', 'not_included', 'what_to_bring']) {
        expect(src, `${file} — ${col}`).not.toMatch(
          new RegExp(`JSON\\.stringify\\(\\s*[\\w]+(\\.[\\w]+)*\\.${col}\\b`),
        );
      }
    }
  });
});

describe('миграция 826 приводит схему целиком, а не по одной колонке', () => {
  const sql = strip(read('migrations/826_operator_tours_all_arrays_to_text.sql'));

  it('охватывает все объявленные массивами колонки', () => {
    for (const col of ['included', 'not_included', 'what_to_bring', 'photos', 'safety_notes', 'tags']) {
      expect(sql).toContain(`'${col}'`);
    }
  });

  it('не трогает program — там JSON по делу', () => {
    // program — массив объектов {title, text}, это настоящий JSON.
    expect(sql).not.toMatch(/'program'/);
  });

  it('выбирает колонки по фактическому типу, а не по списку подозреваемых', () => {
    expect(sql).toMatch(/udt_name IN \('json', 'jsonb'\)/);
  });

  it('переносит содержимое и снимает DEFAULT', () => {
    expect(sql).toMatch(/jsonb_array_elements_text/);
    expect(sql).toMatch(/DROP DEFAULT/);
  });

  it('имена вью не вписаны руками', () => {
    expect(sql).toMatch(/pg_get_viewdef/);
    expect(sql).not.toMatch(/DROP VIEW IF EXISTS [a-z_]+ CASCADE/);
  });
});

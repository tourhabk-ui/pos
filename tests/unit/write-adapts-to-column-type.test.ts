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
import { readdirSync, readFileSync } from 'node:fs';
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

/**
 * Смена типа колонки не тащит подзапрос в USING.
 *
 * Postgres запрещает подзапрос в `ALTER COLUMN ... TYPE ... USING` и говорит об
 * этом прямо: «cannot use subquery in transform expression». Миграции 823 и 826
 * написаны именно так и упали обе; вслед за ними упала 824, потому что колонки
 * остались jsonb. Я прочитал состояние неверно и сообщил владельцу, что данные
 * починились — на скриншоте кабинета были его несохранённые правки в форме, а
 * не содержимое базы.
 *
 * Обход — вынести преобразование в функцию: её вызов подзапросом не считается.
 */
describe('ALTER TYPE не содержит подзапроса', () => {
  const DIR = join(ROOT, 'migrations');

  /**
   * Найдено этим же сторожем: та же ошибка сделана раньше и не замечена.
   * `715_gear_schema.sql` приводит `gear_items.tags` к TEXT[] через
   * `ARRAY(SELECT ...)` в USING — значит по тем же правилам Postgres она тоже
   * упала, просто про аренду снаряжения никто не спрашивал. Не трогаю: это
   * другой домен, и лезть туда попутно значило бы делать то, о чём не просили.
   * Запись здесь — чтобы находка не потерялась.
   */
  const KNOWN = new Set(['715_gear_schema.sql']);

  it('ни одна миграция не пишет ARRAY(SELECT ...) внутри USING', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(DIR).filter((f) => f.endsWith('.sql'))) {
      if (KNOWN.has(file)) continue;
      const sql = readFileSync(join(DIR, file), 'utf-8');
      // USING ... до конца выражения: ловим подзапрос в той же конструкции.
      for (const m of sql.matchAll(/TYPE\s+[^\n]*\bUSING\b([\s\S]{0,400}?)(?:;|\$f\$)/gi)) {
        if (/\(\s*SELECT\b/i.test(m[1])) offenders.push(`${file}: подзапрос в USING`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('827 приводит тип вызовом функции', () => {
    const sql = readFileSync(join(DIR, '827_arrays_to_text_via_function.sql'), 'utf-8');
    expect(sql).toMatch(/USING _jsonb_to_text_array\(/);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION _jsonb_to_text_array/);
    // Временная функция не остаётся в схеме.
    expect(sql).toMatch(/DROP FUNCTION IF EXISTS _jsonb_to_text_array/);
  });
});

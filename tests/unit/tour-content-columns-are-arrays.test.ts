/**
 * Состав тура хранится в TEXT[] — и код пишет туда массивы, а не JSON-строки.
 *
 * Год расхождения, три дня разбирательств и три неудачные миграции — из-за
 * одной бесшумной мелочи. Миграция 056 объявила
 * `included/not_included/what_to_bring` как `TEXT[]`, но добавляла их через
 * `ADD COLUMN IF NOT EXISTS`, а на проде колонки уже существовали как `json`.
 * Такой ADD молча ничего не делает. С тех пор:
 *
 *   • миграции, писавшие `ARRAY[...]` (796, 806, 819), падали с ошибкой типа —
 *     и падали НЕЗАМЕТНО: причина ложилась в `_migration_failures`, а на
 *     карточке просто оставался старый демо-состав;
 *   • код, писавший `JSON.stringify(...)`, наоборот работал — и тем закреплял
 *     расхождение;
 *   • владелец, попытавшийся исправить тур руками, получил от базы
 *     «invalid input syntax for type json». Это и назвало причину вслух.
 *
 * Миграция 823 привела прод к тому, что репозиторий объявлял с самого начала.
 * Этот сторож держит одну сторону: раз колонки `TEXT[]`, код обязан передавать
 * массив. `JSON.stringify(['а','б'])` в `TEXT[]` — это ОДНА строка с кавычками
 * и скобками вместо двух пунктов состава; молчаливая порча данных, которую
 * заметят не раньше, чем турист прочитает карточку.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const CONTENT_COLUMNS = ['included', 'not_included', 'what_to_bring'];

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, entry);
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, acc);
    else if (/\.ts$/.test(entry)) acc.push(rel);
  }
  return acc;
}

const SOURCES = [...walk('app/api'), ...walk('lib')];

describe('код пишет в состав тура массивы, а не JSON-строки', () => {
  it('нигде нет JSON.stringify на полях состава', () => {
    const offenders: string[] = [];
    for (const file of SOURCES) {
      const src = readFileSync(join(ROOT, file), 'utf-8');
      for (const col of CONTENT_COLUMNS) {
        // Ловим ровно запись поля в базу:
        //   `included: JSON.stringify(...)`  — значение в объекте параметров;
        //   `JSON.stringify(input.included …)` — само поле как аргумент.
        // НЕ ловим `JSON.stringify({ … included: … })` — это сериализация
        // ответа наружу (так отдают результат инструменту ИИ), к колонке
        // отношения не имеющая.
        const patterns = [
          new RegExp(`\\b${col}\\s*:\\s*JSON\\.stringify`),
          new RegExp(`JSON\\.stringify\\(\\s*[\\w]+(\\.[\\w]+)*\\.${col}\\b`),
        ];
        if (patterns.some((re) => re.test(src))) {
          offenders.push(`${file} — ${col}`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

describe('миграция 823 приводит тип, не ломая вью', () => {
  const SQL = readFileSync(
    join(ROOT, 'migrations/823_operator_tours_arrays_to_text.sql'),
    'utf-8',
  );
  const sql = SQL.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

  it('меняет тип всех трёх колонок', () => {
    expect(sql).toMatch(/TYPE TEXT\[\]/);
    for (const col of CONTENT_COLUMNS) expect(sql).toContain(`'${col}'`);
  });

  it('переносит содержимое, а не обнуляет его', () => {
    // Без USING ... jsonb_array_elements_text состав превратился бы в пустоту:
    // «починка», после которой карточка становится ещё беднее.
    expect(sql).toMatch(/jsonb_array_elements_text/);
  });

  it('снимает DEFAULT перед сменой типа', () => {
    // Старый DEFAULT '[]'::json к TEXT[] не приводится и уронил бы ALTER.
    expect(sql).toMatch(/DROP DEFAULT/);
  });

  it('имена зависимых вью не вписаны руками', () => {
    // Вписанный список вью устаревает молча — ровно этим была бесполезна
    // диагностика сплава.
    expect(sql).toMatch(/pg_get_viewdef/);
    expect(sql).not.toMatch(/DROP VIEW IF EXISTS [a-z_]+ CASCADE/);
  });

  it('идемпотентна: на уже приведённых колонках ничего не делает', () => {
    expect(sql).toMatch(/udt_name IN \('json', 'jsonb'\)/);
    expect(sql).toMatch(/RETURN;/);
  });
});

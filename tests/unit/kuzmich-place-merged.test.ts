/**
 * Об объекте отвечает ОДНА запись: слитые дубли не говорят с туристом.
 *
 * Найдено 19.09 на собственной ошибке. Миграция 988 слила мой дубль
 * «Каньон на Шивелуче» в уже существовавший «Каньон Крылья Гамулов
 * (Дракон)» — скрыла его и проставила merged_into_id. Через час тот же
 * дубль ответил на запрос к проду: «Каньон на Шивелуче [null]», без типа и
 * без описания, — при том что настоящая запись рядом отвечала полным
 * текстом владельца. Запрос `get_place_info` в lib/kuzmich/core.ts не
 * фильтровал ни слияние, ни порядок: три любые строки по ILIKE.
 *
 * Слияние затем и делается, чтобы об объекте говорила одна запись. Дубль,
 * продолжающий отвечать, — это та же болезнь, что «скрытое место на
 * полевой карте»: спрятали в одном месте, осталось в другом.
 *
 * Проверяются ИСХОДНИКИ запросов, а не выдача: до БД тест не ходит
 * (тот же приём, что в place-route-visibility.test.ts), а забытый фильтр
 * виден в SQL.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const core = readFileSync(join(ROOT, 'lib/kuzmich/core.ts'), 'utf-8');
const guardian = readFileSync(join(ROOT, 'lib/kuzmich/guardian-context.ts'), 'utf-8');

/**
 * Тело запроса инструмента get_place_info — от FROM places до LIMIT.
 * С 25.09 выборка живёт в lib/kuzmich/place-info-tool (сверка MCP: ответ
 * смешивал соседние объекты); core.ts зовёт её, и сторож идёт за кодом.
 */
function placeInfoSql(): string {
  const at = core.indexOf("if (name === 'get_place_info')");
  expect(at, 'инструмент get_place_info исчез из core.ts — тест нужно переписать, а не удалять').toBeGreaterThan(0);
  expect(core.slice(at, at + 600)).toContain("import('@/lib/kuzmich/place-info-tool')");
  const tool = readFileSync(join(ROOT, 'lib/kuzmich/place-info-tool.ts'), 'utf-8');
  const from = tool.indexOf('FROM places');
  const to = tool.indexOf('LIMIT 3', from);
  expect(from).toBeGreaterThan(0);
  expect(to).toBeGreaterThan(from);
  return tool.slice(from, to + 'LIMIT 3'.length);
}

describe('get_place_info', () => {
  it('не отвечает из слитого дубля', () => {
    expect(placeInfoSql()).toContain('merged_into_id IS NULL');
  });

  it('при нескольких совпадениях первой идёт запись с кратчайшим именем', () => {
    // То же правило, что у стража: «Шивелуч» вперёд «Каньона на Шивелуче».
    // Без ORDER BY порядок задаёт план запроса, то есть случай.
    expect(placeInfoSql()).toMatch(/ORDER BY char_length\(name\) ASC/);
  });
});

describe('паритет со стражем', () => {
  it('у стража то же правило слияния — оно не разъехалось', () => {
    expect(guardian).toContain('p.merged_into_id IS NULL');
    expect(guardian).toMatch(/merged_into_id IS NULL AND is_visible = true/);
  });

  it('скрытое место страж знать может: это записанное решение, а не упущение', () => {
    // Сторож держит и границу правки 19.09: чинились ДУБЛИ, а видимость
    // осталась как была. Если решение изменится — менять здесь осознанно.
    expect(guardian).toMatch(/страж может знать скрытое место/);
    // 25.09 владелец решил: скрытые не называются в списке «похожих» —
    // фильтр живёт в сборке ответа, а ВЫБОРКА по-прежнему видимость не режет:
    // основной ответ о скрытом месте остаётся (правило 19.09).
    const info = placeInfoSql();
    const where = info.slice(info.indexOf('WHERE'));
    expect(where, 'фильтр is_visible в выборке get_place_info — отдельное решение, не побочная правка')
      .not.toContain('is_visible');
  });
});

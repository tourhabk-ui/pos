/**
 * Сторож потолка диагностического запроса (issue #1654, 06.09).
 *
 * Находка эволюции была права по существу: `rows.slice(0, 20)` обрезал УЖЕ
 * полученный результат, то есть `SELECT * FROM большая_таблица` целиком
 * приезжал в память и только потом обрезался. Срез ВЫГЛЯДЕЛ ограничением, не
 * будучи им, — и именно поэтому дефект прожил незамеченным.
 *
 * Предложенное находкой лечение — дописать ` LIMIT 20` в хвост — сторож НЕ
 * принимает: оно ломается на CTE, UNION и завершающей точке с запятой, о чём
 * сама находка и предупреждала. Ограничение ставится обёрткой подзапросом.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { withDiagnosticLimit, DIAGNOSTIC_ROW_LIMIT } from '@/lib/agents/tools/board-executor-tools';

const SRC = readFileSync(join(process.cwd(), 'lib/agents/tools/board-executor-tools.ts'), 'utf8');

describe('потолок ставится обёрткой, а не дописыванием в хвост', () => {
  it('простой запрос оборачивается', () => {
    expect(withDiagnosticLimit('SELECT * FROM places'))
      .toBe(`SELECT * FROM (SELECT * FROM places) AS diagnostic_scope LIMIT ${DIAGNOSTIC_ROW_LIMIT}`);
  });

  it('завершающая точка с запятой снимается — иначе синтаксическая ошибка', () => {
    expect(withDiagnosticLimit('SELECT 1;')).not.toContain(';)');
    expect(withDiagnosticLimit('SELECT 1;  ')).toContain('(SELECT 1)');
  });

  it('CTE и UNION переживают обёртку целиком', () => {
    const cte = 'WITH t AS (SELECT 1 AS n) SELECT n FROM t';
    expect(withDiagnosticLimit(cte)).toContain(`(${cte})`);
    const union = 'SELECT 1 UNION SELECT 2';
    expect(withDiagnosticLimit(union)).toContain(`(${union})`);
  });

  it('свой LIMIT внутри не ломается — внешний просто не даёт больше', () => {
    expect(withDiagnosticLimit('SELECT * FROM places LIMIT 5'))
      .toBe(`SELECT * FROM (SELECT * FROM places LIMIT 5) AS diagnostic_scope LIMIT ${DIAGNOSTIC_ROW_LIMIT}`);
  });
});

describe('исполнение', () => {
  const body = SRC.slice(SRC.indexOf('export async function runDiagnosticQuery'));
  const fn = body.slice(0, body.indexOf('\n}\n'));

  it('в базу уходит ограниченный запрос, а не исходный', () => {
    expect(fn).toMatch(/pool\.query\(withDiagnosticLimit\(sql\)\)/);
    expect(fn).not.toMatch(/pool\.query\(sql\)/);
  });

  it('среза-обманки больше нет', () => {
    expect(fn).not.toMatch(/rows\.slice\(0,\s*20\)/);
  });

  it('второй запрос через точку с запятой отклоняется', () => {
    expect(fn).toMatch(/диагностика выполняет ровно один запрос/);
  });

  it('потолок не выдаётся за полное число строк', () => {
    // Полного числа строк мы после обёртки НЕ ЗНАЕМ; сообщение обязано это
    // говорить, а не подавать «20» как «всего двадцать» (§4.0).
    expect(fn).toMatch(/Строк получено/);
    expect(fn).toMatch(/потолок \$\{DIAGNOSTIC_ROW_LIMIT\}/);
  });
});

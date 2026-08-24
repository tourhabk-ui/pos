/**
 * Полнота переписи: ни один запрос формы «вставь, если такого ещё нет» не
 * проходит мимо суда.
 *
 * 24.08 один дефект нашёлся в трёх местах: маяк воронки не записал ни одного
 * события за всё время, а профиль партнёра не создавался вовсе — ни при
 * регистрации, ни при входе. Форма у всех одна:
 *
 *     INSERT INTO t (...) SELECT $1, ... WHERE NOT EXISTS (... WHERE c = $1)
 *
 * PostgreSQL выводит тип параметра из контекста. В списке SELECT контекста
 * нет, в сравнении с колонкой — есть. Выводы расходятся, ответ 42P08
 * «inconsistent types deduced», и запрос не выполняется НИКОГДА. Не иногда,
 * не под нагрузкой — никогда.
 *
 * ПОЧЕМУ ЭТОТ СТОРОЖ НЕ СУДИТ САМ. Первая его версия требовала приведение у
 * каждого употребления повторённого параметра — и пометила два РАБОЧИХ
 * запроса. В `lib/places/aliases.ts` параметр сравнивается с `p.id::text`, а
 * вставляется в `place_id`: правильное приведение у двух употреблений РАЗНОЕ,
 * и «одинаковый тип везде» там просто неверно. Вывод типов статикой не
 * повторить — его делает сервер.
 *
 * Поэтому разделение труда: приговор выносит PREPARE на проде
 * (`/api/cron/sql-shape-check`), а этот сторож отвечает за ПОЛНОТУ — чтобы
 * запрос, написанный завтра, не остался вне реестра и, значит, вне суда.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { SHAPES } from '@/app/api/cron/sql-shape-check/route';

/** Файл переписи — он же держит копии реестра; себя не проверяем. */
const CENSUS = 'app/api/cron/sql-shape-check/route.ts';
/** Проба записи маяка держит копию запроса приёмника намеренно (свой сторож). */
const BEACON = 'app/api/cron/beacon-check/route.ts';

function sourceFiles(): string[] {
  const out = execSync("git ls-files 'app' 'lib' 'scripts'", {
    encoding: 'utf-8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return out.split('\n').filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
}

/** Запросы формы «вставь, если такого ещё нет» из одного файла. */
export function extractGuardedInserts(src: string): string[] {
  const found: string[] = [];
  for (const m of src.matchAll(/`([^`]*)`/g)) {
    const sql = m[1];
    if (!/INSERT\s+INTO/i.test(sql)) continue;
    if (!/WHERE\s+NOT\s+EXISTS/i.test(sql)) continue;
    if (!/\bSELECT\b/i.test(sql)) continue;
    found.push(sql);
  }
  return found;
}

function skeleton(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

describe('извлечение считает то, что задумано', () => {
  it('видит запрос нужной формы', () => {
    const src = 'q(`INSERT INTO t (a) SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM t WHERE a = $1)`)';
    expect(extractGuardedInserts(src)).toHaveLength(1);
  });

  it('обычный INSERT ... VALUES не трогает', () => {
    expect(extractGuardedInserts('q(`INSERT INTO t (a) VALUES ($1)`)')).toHaveLength(0);
  });

  it('NOT EXISTS без INSERT не трогает', () => {
    expect(extractGuardedInserts('q(`SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM t)`)')).toHaveLength(0);
  });
});

describe('реестр переписи полон', () => {
  it('каждый такой запрос из кода внесён в SHAPES', () => {
    const registry = new Set(SHAPES.map((s) => skeleton(s.sql)));
    const missing: string[] = [];
    let scanned = 0;

    for (const file of sourceFiles()) {
      if (file === CENSUS || file === BEACON) continue;
      for (const sql of extractGuardedInserts(readFileSync(file, 'utf-8'))) {
        scanned += 1;
        if (!registry.has(skeleton(sql))) {
          missing.push(`${file}: ${skeleton(sql).slice(0, 120)}`);
        }
      }
    }

    // Ноль осмотренных — отказ проверки, а не «всё внесено». Сломанное
    // извлечение выглядело бы как идеально полный реестр (§4.0).
    expect(scanned, 'ни одного запроса не осмотрено — сторож не работает').toBeGreaterThan(0);
    expect(
      missing,
      `Эти запросы не проходят PREPARE-проверку, потому что их нет в SHAPES ` +
      `(app/api/cron/sql-shape-check/route.ts):\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('в реестре нет записей-призраков: каждая находится в своём файле', () => {
    for (const shape of SHAPES) {
      const src = skeleton(readFileSync(shape.source, 'utf-8'));
      expect(src, `«${shape.name}» не найден в ${shape.source}`).toContain(skeleton(shape.sql));
    }
  });
});

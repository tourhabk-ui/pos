/**
 * Контекст Кузьмича детерминирован: LIMIT только после ORDER BY.
 *
 * Находка эволюции 21.08 предлагала «валидацию согласованности ответов ИИ
 * повторными запросами через Claude API». Симптом в примере был настоящим —
 * несовпадающие списки точек при одинаковых запросах, — а причина не в модели:
 * SQL с LIMIT без ORDER BY не обязан быть стабильным.
 *
 * Худшее было в гео-выборке: квадрат ±2° покрывает большую часть Камчатки,
 * LIMIT 200 отдавал произвольные 200 точек, и «ближайшие места» считались из
 * случайной подвыборки — настоящая ближайшая могла не попасть в кандидаты.
 * Модель, получающая разный контекст, даёт разные ответы; сверять их вторым
 * вызовом LLM значило бы измерять собственную лотерею.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'lib/ai/rag-context.ts'), 'utf-8');
const code = SRC.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

describe('выборки контекста упорядочены до лимита', () => {
  it('в каждом SQL с LIMIT есть ORDER BY', () => {
    const queries = code.match(/`[^`]*\bFROM\b[^`]*`/gs) ?? [];
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) {
      if (!/\bLIMIT\b/i.test(q)) continue;
      expect(q, `LIMIT без ORDER BY:\n${q.slice(0, 160)}`).toMatch(/\bORDER\s+BY\b/i);
    }
  });

  it('текстовый поиск ранжирован по ts_rank, а не «как получится»', () => {
    expect(code).toMatch(/ORDER BY ts_rank\(/);
  });

  it('гео-кандидаты режутся лимитом по расстоянию, а не случайно', () => {
    // Поправка долготы на cos(широты): без неё восток-запад весит вдвое
    // больше, чем надо, на широте Камчатки (~53°).
    expect(code).toMatch(/ORDER BY \(lat - \$1\)\^2 \+ \(\(lng - \$2\) \* cos\(radians\(\$1\)\)\)\^2/);
  });

  it('вторичный ключ стабилен — равный ранг не возвращает лотерею', () => {
    const ordered = code.match(/ORDER BY[^`]*/g) ?? [];
    for (const o of ordered) {
      expect(o, `нет детерминирующего второго ключа: ${o.slice(0, 80)}`).toMatch(/,\s*title/);
    }
  });

  it('отказ БД не глушится пустым catch', () => {
    expect(code).not.toMatch(/catch\s*\{\s*return \[\];\s*\}/);
    expect(SRC).toMatch(/не выполнен/);
  });
});

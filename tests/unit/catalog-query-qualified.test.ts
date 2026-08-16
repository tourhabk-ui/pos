/**
 * Каталог: каждое условие называет свою таблицу.
 *
 * Ночью 16.08 карта опустела: `/api/routes` отдавал 503, а Postgres говорил
 * «column reference "is_visible" is ambiguous». Условие писалось без
 * префикса и работало ровно до тех пор, пока такой колонки не завелось у
 * присоединяемых таблиц (ai_route_images / location_real_time_status).
 * Тогда безобидная строка `is_visible = TRUE` стала неоднозначной, и весь
 * каталог — а с ним карта и списки мест — лёг целиком.
 *
 * Сторож требует явного алиаса во всех условиях: тогда чужая колонка в
 * соседней таблице ничего не ломает.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(process.cwd(), 'lib/routes/catalog-query.ts'), 'utf-8');

/** Колонки, которые есть и в VIEW, и потенциально у соседей по JOIN. */
const SHARED_COLUMNS = [
  'is_visible', 'kind', 'category', 'location_type', 'activity_type',
  'lat', 'lng', 'payload', 'title', 'description',
];

describe('условия каталога', () => {
  const block = src.slice(src.indexOf('const conditions: string[]'), src.indexOf('const where ='));

  it('стартовое условие видимости квалифицировано', () => {
    expect(block).toContain("'ark.is_visible = TRUE'");
    expect(block, 'без алиаса условие ломается, как только колонка появится у соседа по JOIN')
      .not.toContain("'is_visible = TRUE'");
  });

  // Проверяем ТОЛЬКО содержимое строковых литералов: имена JS-переменных
  // фильтров совпадают с именами колонок («if (location_type)»), и без
  // этого сужения тест ловил бы сам себя.
  const sqlLiterals = [
    ...[...block.matchAll(/`([^`]*)`/g)].map(m => m[1]),
    ...[...block.matchAll(/'([^']*)'/g)].map(m => m[1]),
  ].filter(lit => /[a-z_]+\s*(=|IS|ILIKE|>=|<=|->>)/.test(lit));

  for (const col of SHARED_COLUMNS) {
    it(`условие по «${col}» не пишется без таблицы`, () => {
      const bare = new RegExp(`(?<![.\\w'])${col}\\b`);
      const guilty = sqlLiterals.filter(lit => bare.test(lit));
      expect(guilty, `«${col}» без алиаса: ${guilty.join(' | ')}`).toHaveLength(0);
    });
  }
});

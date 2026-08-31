/**
 * «Последние 20 событий» ledger должны быть последними.
 *
 * Дефект 31.08, найденный в собственном ответе приёмки. В роуте стояло
 *
 *   SELECT id::text, ... FROM safety_decision_events ORDER BY id DESC LIMIT 20
 *
 * В SQL имя ВЫХОДНОЙ колонки в ORDER BY имеет приоритет над входной, а Postgres
 * называет выражение `id::text` по нижележащей колонке — тем же словом `id`.
 * Сортировка уходила на текст и становилась лексикографической; в живом ответе
 * это видно прямо: 9999, 9998, ... 9990, 999, 9989. При 67 348 записях
 * «последние 20» были выборкой из середины, а их метки времени читались как
 * «последняя запись вчера» — вывод, которого данные не давали.
 *
 * Судить статикой такое НЕЛЬЗЯ: разрешение имён в ORDER BY делает сервер, и
 * прецедент 42P08 в CLAUDE.md ровно об этом — форму запроса доказывает только
 * настоящий PostgreSQL. Поэтому сторож берёт SQL ИЗ ИСХОДНИКА роута (не копию:
 * копия разошлась бы с оригиналом и охраняла бы саму себя) и исполняет его.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;

if (!PG_URL) {
  // eslint-disable-next-line no-console
  console.warn(
    '[ledger-check-recent-order] KERNEL_PG_TEST_URL не задан — тест пропущен (не прогнан, а не зелёный)',
  );
}

const ROUTE = join(process.cwd(), 'app/api/cron/safety-ledger-check/route.ts');

/**
 * Достаёт из исходника роута запрос последних событий — именно тот, что уйдёт
 * в прод.
 *
 * Привязка СТРУКТУРНАЯ (от объявления `const recent`), а не по первому
 * попавшемуся `SELECT id::text` в бэктиках. Первая версия сторожа искала
 * вторым способом и вытащила фрагмент из комментария, который описывает этот
 * самый дефект: комментарий про сломанный запрос сломал сторож сломанного
 * запроса. Текст в комментариях — не код, и отличать одно от другого должен
 * извлекатель, а не удача.
 */
function recentQueryFromRoute(): string {
  const src = readFileSync(ROUTE, 'utf8');
  const at = src.indexOf('const recent = ');
  if (at === -1) throw new Error('в safety-ledger-check/route.ts не найдено объявление `const recent`');
  const m = /`([\s\S]*?)`/.exec(src.slice(at));
  if (!m) throw new Error('после `const recent` не найден SQL в бэктиках');
  return m[1];
}

withPg('safety-ledger-check: «последние» события действительно последние', () => {
  let pool: import('pg').Pool;
  const TABLE = 'safety_decision_events';

  beforeAll(async () => {
    const { Pool } = await import('pg');
    pool = new Pool({ connectionString: PG_URL, max: 2 });
    await pool.query(readFileSync(join(process.cwd(), 'migrations', '925_safety_decision_events.sql'), 'utf-8'));

    // Больше 9999 строк — ниже этого числа текстовый и числовой порядок
    // совпадают, и дефект не проявился бы вовсе. Именно поэтому он и дожил до
    // прода: на малых объёмах запрос выглядел исправным.
    await pool.query(`
      INSERT INTO ${TABLE} (entity_type, event_type, actor_type, actor_id)
      SELECT 'external_alert', 'signal_normalized', 'source', 'seed/' || g
        FROM generate_series(1, 10005) AS g
    `);
  });

  afterAll(async () => {
    // Таблица append-only по построению (триггер на UPDATE/DELETE), поэтому
    // убирается целиком, а не вычищается построчно.
    await pool.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`).catch(() => undefined);
    await pool.end();
  });

  it('запрос роута отдаёт наибольшие id по ЧИСЛУ, а не по тексту', async () => {
    const { rows } = await pool.query<{ event_id: string }>(recentQueryFromRoute());

    expect(rows).toHaveLength(20);
    const ids = rows.map((r) => Number(r.event_id));

    const { rows: maxRows } = await pool.query<{ max: string }>(`SELECT max(id)::text AS max FROM ${TABLE}`);
    const maxId = Number(maxRows[0].max);

    expect(ids[0], 'первая строка обязана быть максимальным id').toBe(maxId);
    expect(ids, 'двадцать последних идут подряд вниз от максимума').toEqual(
      Array.from({ length: 20 }, (_, i) => maxId - i),
    );
  });

  it('порядок строго убывающий — лексикографический бы его нарушил', async () => {
    const { rows } = await pool.query<{ event_id: string }>(recentQueryFromRoute());
    const ids = rows.map((r) => Number(r.event_id));
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i], `строка ${i} не меньше предыдущей — порядок не числовой`).toBeLessThan(ids[i - 1]);
    }
  });

  it('прежняя форма запроса действительно ломалась — дефект воспроизводится', async () => {
    // Без этой проверки предыдущие две прошли бы и на исправном, и на
    // сломанном сервере: надо показать, что стерегомое свойство вообще может
    // быть нарушено, и что нарушала его именно потеря псевдонима.
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id::text, entity_id, event_type FROM ${TABLE} ORDER BY id DESC LIMIT 20`,
    );
    const first = Number(rows[0].id);
    const { rows: maxRows } = await pool.query<{ max: string }>(`SELECT max(id)::text AS max FROM ${TABLE}`);

    expect(rows[0].id, 'прежняя форма сортирует текстом: наибольший — «9999»').toBe('9999');
    expect(first, 'и это НЕ максимальный id').toBeLessThan(Number(maxRows[0].max));
  });

  it('в роуте не осталось приведения к тексту без псевдонима в сортируемой колонке', () => {
    const src = readFileSync(ROUTE, 'utf8');
    const q = recentQueryFromRoute();
    expect(q, 'ORDER BY обязан связываться с bigint-колонкой, а не с текстовым выводом').toMatch(
      /SELECT id::text AS \w+/,
    );
    expect(src).toContain('ORDER BY id DESC');
  });
});

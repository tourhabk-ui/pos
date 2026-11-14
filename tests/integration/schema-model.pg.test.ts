/**
 * Модель схемы из файлов против настоящей базы, собранной из тех же файлов.
 *
 * Объектив эволюции (`lib/agents/evo/schema-lens`) объявляет «в таблице нет
 * колонки — запрос упадёт» и «соединение мимо внешнего ключа» по модели,
 * которую `schema-model` выводит разбором baseline и миграций. Разбор текста
 * — не сервер: запись, которую он не понял, делает модель неверной молча.
 *
 * Так и вышло. Миграция 1350 переименовала `stay_request_messages` в
 * `request_messages`, модель переименования не знала — и за две недели
 * завела три ложные «критические» задачи (#2891, #3268, #3343), а в очереди
 * лежала ещё сотня таких же. Замер 14.11: 101 находка из 119 — от
 * переименования, 12 — от ключей, объявленных рядом с колонкой.
 *
 * Здесь судья — сервер: шаблон интеграционных тестов строит базу из baseline
 * и миграций новее него, а модель читает те же файлы. Они обязаны совпасть.
 * Миграция с записью, которую разбор не понимает, краснеет в своём PR и
 * называет, что именно разошлось.
 *
 * Что значит расхождение:
 *  - база знает, модель нет — объектив заведёт ложную находку о рабочем коде;
 *  - модель знает, базы нет — объектив промолчит о запросе, который упадёт.
 * Чинится в `lib/agents/evo/schema-model.ts` (научить разбор этой записи), а
 * не списком исключений здесь.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { loadSchemaModel, type SchemaModel } from '@/lib/agents/evo/schema-model';
import { createTestDatabase } from '../helpers/pg-schema';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;

if (!PG_URL) {
  console.warn('[schema-model] KERNEL_PG_TEST_URL не задан — тест ПРОПУЩЕН (не прогнан, а не зелёный)');
}

const TEST_DB = 'schema_model_test';

/**
 * Имя, которое PostgreSQL хранит не строчными: `accounts."userId"`. Объектив
 * сворачивает имена в строчные, как сервер у имени без кавычек, — обращение
 * `a.userid` в базе действительно упадёт. Таких колонок модель не знает
 * намеренно.
 */
const isFolded = (name: string) => name === name.toLowerCase();

/** Одна база на файл: копия шаблона стоит секунды, а обеим частям хватает одной. */
let pool: Pool;

withPg('объектив схемы на настоящем PostgreSQL', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: await createTestDatabase(PG_URL, TEST_DB), max: 2 });
  }, 600_000);

  afterAll(async () => {
    await pool?.end();
  });

  describe('модель схемы совпадает с настоящей базой', () => {
    let model: SchemaModel;
    const realColumns = new Map<string, Set<string>>();
    const realViews = new Set<string>();
    /** `table.column` → все цели ключа (у колонки их бывает больше одной). */
    const realFks = new Map<string, Set<string>>();

    beforeAll(async () => {
      model = loadSchemaModel(process.cwd());

      const cols = await pool.query<{ table_name: string; column_name: string }>(`
        SELECT c.table_name, c.column_name
          FROM information_schema.columns c
          JOIN information_schema.tables t
            ON t.table_schema = c.table_schema AND t.table_name = c.table_name
         WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'`);
      for (const r of cols.rows) {
        const set = realColumns.get(r.table_name) ?? new Set<string>();
        set.add(r.column_name);
        realColumns.set(r.table_name, set);
      }

      const views = await pool.query<{ name: string }>(`
        SELECT table_name AS name FROM information_schema.views WHERE table_schema = 'public'
        UNION
        SELECT matviewname AS name FROM pg_matviews WHERE schemaname = 'public'`);
      for (const r of views.rows) realViews.add(r.name);

      const fks = await pool.query<{ tbl: string; col: string; ref_tbl: string; ref_col: string }>(`
        SELECT cl.relname AS tbl, a.attname AS col, rcl.relname AS ref_tbl, ra.attname AS ref_col
          FROM pg_constraint con
          JOIN pg_class cl ON cl.oid = con.conrelid
          JOIN pg_namespace n ON n.oid = cl.relnamespace AND n.nspname = 'public'
          JOIN pg_class rcl ON rcl.oid = con.confrelid
          JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
          JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = con.confkey[1]
         WHERE con.contype = 'f' AND array_length(con.conkey, 1) = 1`);
      for (const r of fks.rows) {
        const key = `${r.tbl}.${r.col}`;
        const set = realFks.get(key) ?? new Set<string>();
        set.add(`${r.ref_tbl}.${r.ref_col}`);
        realFks.set(key, set);
      }
    });

    it('база и модель прочитаны: сравнивать есть что', () => {
      // Ноль таблиц с любой стороны сделал бы все сверки ниже зелёными впустую.
      expect(realColumns.size).toBeGreaterThan(300);
      expect(model.columns.size).toBeGreaterThan(300);
      expect(realFks.size).toBeGreaterThan(300);
      expect(realViews.size).toBeGreaterThan(5);
    });

    it('таблицы — те же', () => {
      const unknownToModel = [...realColumns.keys()].filter((t) => !model.columns.has(t)).sort();
      const unknownToBase = [...model.columns.keys()].filter((t) => !realColumns.has(t)).sort();
      expect(unknownToModel, 'таблицы есть в базе, модель их не знает').toEqual([]);
      expect(unknownToBase, 'модель знает таблицы, которых в базе нет').toEqual([]);
    });

    it('колонки — те же', () => {
      const unknownToModel: string[] = [];
      const unknownToBase: string[] = [];
      for (const [table, real] of realColumns) {
        const known = model.columns.get(table);
        if (!known) continue; // названо сверкой таблиц
        for (const c of real) if (isFolded(c) && !known.has(c)) unknownToModel.push(`${table}.${c}`);
        for (const c of known) if (!real.has(c)) unknownToBase.push(`${table}.${c}`);
      }
      expect(
        unknownToModel.sort(),
        'колонки есть в базе, модель их не знает — объектив объявит их несуществующими',
      ).toEqual([]);
      expect(
        unknownToBase.sort(),
        'модель знает колонки, которых в базе нет — объектив промолчит о запросе к ним',
      ).toEqual([]);
    });

    it('три таблицы, о которых заводились ложные задачи, прочитаны целиком', () => {
      for (const [table, cols] of [
        ['request_messages', ['body', 'author', 'stay_request_id', 'lead_id', 'created_at']],
        ['request_chat_waits', ['status', 'chat_id', 'channel', 'side', 'expires_at']],
      ] as const) {
        for (const c of cols) {
          expect(realColumns.get(table)?.has(c), `в базе нет ${table}.${c}`).toBe(true);
          expect(model.columns.get(table)?.has(c), `модель не знает ${table}.${c}`).toBe(true);
        }
      }
    });

    it('вьюхи — те же, и ни одна не судится как таблица', () => {
      const unknownToModel = [...realViews].filter((v) => !model.views.has(v)).sort();
      const unknownToBase = [...model.views].filter((v) => !realViews.has(v)).sort();
      expect(unknownToModel, 'вьюхи есть в базе, модель их не знает').toEqual([]);
      expect(unknownToBase, 'модель считает вьюхой то, что в базе не вьюха').toEqual([]);
      expect([...realViews].filter((v) => model.columns.has(v)), 'вьюха числится таблицей').toEqual([]);
    });

    it('внешние ключи — те же', () => {
      const unknownToModel: string[] = [];
      const wrong: string[] = [];
      for (const [key, targets] of realFks) {
        const fk = model.foreignKeys.get(key);
        if (!fk) unknownToModel.push(`${key} → ${[...targets].join(' | ')}`);
        else if (!targets.has(`${fk.refTable}.${fk.refColumn}`)) {
          wrong.push(`${key}: в базе ${[...targets].join(' | ')}, в модели ${fk.refTable}.${fk.refColumn}`);
        }
      }
      const unknownToBase = [...model.foreignKeys.keys()].filter((k) => !realFks.has(k)).sort();
      expect(
        unknownToModel.sort(),
        'ключи есть в базе, модель их не знает — верное соединение двух ссылок объектив объявит ошибкой',
      ).toEqual([]);
      expect(wrong.sort(), 'ключ ведёт не туда, куда в базе').toEqual([]);
      expect(unknownToBase, 'модель знает ключи, которых в базе нет').toEqual([]);
    });
  });

  /**
   * Миграция 1441: находки объектива, записанные до его починки, уходят из
   * очереди — и только они. Шаблон базы миграцию уже накатил (на пустой
   * таблице); здесь она исполняется ещё раз поверх посеянных строк — заодно это
   * проверка идемпотентности.
   */
  describe('миграция 1441: находки объектива схемы сняты с очереди', () => {
    const SQL = readFileSync(join(process.cwd(), 'migrations/1441_schema_lens_stale_findings.sql'), 'utf-8');
    const NO_COLUMN = 'Обращение к несуществующей колонке';
    const PAST_KEY = 'Соединение мимо внешнего ключа';
    const LENS_COLUMN = 'в таблице request_messages нет колонки body — запрос упадёт';
    const LENS_KEY = 'leads.operator_id ссылается на partners.id внешним ключом, а соединяется с '
      + 'partner_incoming_answers.partner_id — совпадений не будет';

    /** [метка, заголовок, описание, статус, ссылка на задачу, ожидаемый статус] */
    const ROWS: Array<[string, string, string, string, string | null, string]> = [
      ['колонка, ждёт', NO_COLUMN, LENS_COLUMN, 'suggested', null, 'ignored'],
      ['колонка, открыта', NO_COLUMN, LENS_COLUMN, 'open', null, 'ignored'],
      ['ключ, ждёт', PAST_KEY, LENS_KEY, 'suggested', null, 'ignored'],
      ['задача уже заведена', NO_COLUMN, LENS_COLUMN, 'suggested', 'https://github.com/tourhabk-ui/pos/issues/3343', 'suggested'],
      ['уже принята', NO_COLUMN, LENS_COLUMN, 'accepted', null, 'accepted'],
      ['уже отвергнута', NO_COLUMN, LENS_COLUMN, 'rejected', null, 'rejected'],
      ['тот же заголовок, слова модели', NO_COLUMN, 'Запрос читает колонку body, которой в таблице нет', 'suggested', null, 'suggested'],
      ['фраза объектива внутри чужого текста', NO_COLUMN, `Проверка говорит: ${LENS_COLUMN}. Но это не так.`, 'suggested', null, 'suggested'],
      ['другая находка', 'Пустой catch глушит отказ', LENS_COLUMN, 'suggested', null, 'suggested'],
    ];

    const statuses = async () => {
      const { rows } = await pool.query<{ file_path: string; status: string; resolved_at: Date | null }>(
        `SELECT file_path, status, resolved_at FROM evo_growth_issues WHERE file_path LIKE 'zz-1441/%' ORDER BY file_path`,
      );
      return rows;
    };

    beforeAll(async () => {
      for (const [label, title, description, status, url] of ROWS) {
        await pool.query(
          `INSERT INTO evo_growth_issues (category, severity, file_path, title, description, status, github_issue_url)
           VALUES ('bug', 'critical', $1, $2, $3, $4, $5)`,
          [`zz-1441/${label}`, title, description, status, url],
        );
      }
      await pool.query(SQL);
    });

    it('с очереди ушли находки объектива без задачи — и только они', async () => {
      const got = new Map((await statuses()).map((r) => [r.file_path.replace('zz-1441/', ''), r.status]));
      expect(got.size).toBe(ROWS.length);
      for (const [label, , , , , expected] of ROWS) expect(got.get(label), label).toBe(expected);
    });

    it('снятым записано время, остальным — нет', async () => {
      for (const r of await statuses()) {
        if (r.status === 'ignored') expect(r.resolved_at, r.file_path).not.toBeNull();
        else expect(r.resolved_at, r.file_path).toBeNull();
      }
    });

    it('повторный запуск ничего не меняет', async () => {
      const before = await statuses();
      await pool.query(SQL);
      expect(await statuses()).toEqual(before);
    });
  });
});

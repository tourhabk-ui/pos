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
 *
 * Тем же судьёй проверяется перепись сроков хранения (#3388, п. 2,
 * `lib/legal/retention-census`): её список таблиц и колонок составлен чтением
 * схемы, мок ответил бы на любое имя. Здесь каждая строка списка выполняется
 * на той же базе: опечатка — «нет таблицы» или «не смог», и тест краснеет.
 * Своим файлом это не заведено: число pg-файлов держит размен «последовательно
 * вместо изоляции» (`tests/unit/pg-tests-run-in-ci.test.ts`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { loadSchemaModel, type SchemaModel } from '@/lib/agents/evo/schema-model';
import { RETENTION_TARGETS, runRetentionCensus } from '@/lib/legal/retention-census';
import { PURGE_STEPS, ERASED_MARK, runRetentionPurge } from '@/lib/legal/retention-purge';
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

  it('миграция 1454: образец сообщений Telegram-группы снят из советов туристов, остальное на месте (ревью #3460)', async () => {
    const SQL = readFileSync(join(process.cwd(), 'migrations/1454_group_tips_sample_withdrawn.sql'), 'utf-8');
    await pool.query(`INSERT INTO kamchatka_routes (dedupe_key, slug, title, category, metadata, is_visible) VALUES
      ('tg_tip_1454_a', 'tg-tip-1454-a', 'Тест — советы туристов', 'tourist_tip',
       '{"source":"telegram_group","group_id":"-1","tips":["брать бахилы"],"sample":["Тест: звоните +70000000000"]}', false),
      ('tg_tip_1454_b', 'tg-tip-1454-b', 'Тест — чужой источник', 'tourist_tip',
       '{"source":"other","sample":["не наш ключ"]}', false)`);
    await pool.query(SQL);
    await pool.query(SQL); // повтор без вреда
    const { rows } = await pool.query<{ dedupe_key: string; metadata: Record<string, unknown> }>(
      `SELECT dedupe_key, metadata FROM kamchatka_routes WHERE dedupe_key LIKE 'tg_tip_1454_%' ORDER BY dedupe_key`);
    expect(rows).toEqual([
      { dedupe_key: 'tg_tip_1454_a', metadata: { source: 'telegram_group', group_id: '-1', tips: ['брать бахилы'] } },
      { dedupe_key: 'tg_tip_1454_b', metadata: { source: 'other', sample: ['не наш ключ'] } },
    ]);
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

  describe('перепись сроков хранения на той же базе', () => {
    it('каждая таблица и колонка списка есть в схеме: ни «нет таблицы», ни «не смог»', async () => {
      const out = await runRetentionCensus((sql, params) => pool.query(sql, params));
      const bad = out.rows.filter((r) => r.state !== 'ok').map((r) => `${r.table}.${r.column}: ${r.state}`);
      expect(bad).toEqual([]);
      expect(out.rows).toHaveLength(RETENTION_TARGETS.length);
    });

    it('журнал: старше 90 дней — за сроком, свежее — нет', async () => {
      await pool.query(`INSERT INTO page_views (path, visitor_hash, created_at) VALUES
        ('/a', 'h1', NOW() - INTERVAL '120 days'), ('/b', 'h2', NOW() - INTERVAL '10 days')`);
      const out = await runRetentionCensus(
        (sql, params) => pool.query(sql, params),
        RETENTION_TARGETS.filter((t) => t.table === 'page_views'),
      );
      expect(out.rows[0]).toMatchObject({ state: 'ok', total: 2, over_term: 1 });
    });

    it('профиль (1452): вход отмечается сам, отметка не идёт назад, активность — позднее из регистрации и входа', async () => {
      const { rows: [u] } = await pool.query<{ id: string }>(`INSERT INTO users (email, name, password_hash, role, created_at)
        VALUES ('retention-1452@example.org', 'Проверка', 'x', 'tourist', NOW() - INTERVAL '4 years') RETURNING id::text`);
      const { rows: [quiet] } = await pool.query<{ id: string }>(`INSERT INTO users (email, name, password_hash, role, created_at)
        VALUES ('retention-1452-quiet@example.org', 'Проверка', 'x', 'tourist', NOW() - INTERVAL '4 years') RETURNING id::text`);
      const mark = async (id: string) => (await pool.query<{ at: Date | null }>(
        'SELECT last_login_at AS at FROM user_last_login WHERE user_id = $1::uuid', [id])).rows[0]?.at ?? null;

      // Ни одна дверь входа не знает об отметке: её пишет вставка сессии.
      await pool.query(`INSERT INTO user_sessions (user_id, token, expires_at, created_at)
        VALUES ($1::uuid, 'tok-1452-a', NOW() + INTERVAL '7 days', NOW() - INTERVAL '2 days')`, [u.id]);
      const first = await mark(u.id);
      expect(first).not.toBeNull();
      // Сессия с более ранней датой (часы, перенос) отметку назад не двигает.
      await pool.query(`INSERT INTO user_sessions (user_id, token, expires_at, created_at)
        VALUES ($1::uuid, 'tok-1452-b', NOW() + INTERVAL '7 days', NOW() - INTERVAL '30 days')`, [u.id]);
      expect(await mark(u.id)).toEqual(first);
      // Выход стирает сессию — отметка остаётся.
      await pool.query('DELETE FROM user_sessions WHERE user_id = $1::uuid', [u.id]);
      expect(await mark(u.id)).toEqual(first);
      // Аккаунт удалён — отметка уходит с ним (внешний ключ с каскадом).
      const { rows: [gone] } = await pool.query<{ id: string }>(`INSERT INTO users (email, name, password_hash, role)
        VALUES ('retention-1452-gone@example.org', 'Проверка', 'x', 'tourist') RETURNING id::text`);
      await pool.query(`INSERT INTO user_sessions (user_id, token, expires_at) VALUES ($1::uuid, 'tok-1452-c', NOW() + INTERVAL '7 days')`, [gone.id]);
      expect(await mark(gone.id)).not.toBeNull();
      await pool.query('DELETE FROM user_sessions WHERE user_id = $1::uuid', [gone.id]);
      await pool.query('DELETE FROM users WHERE id = $1::uuid', [gone.id]);
      expect(await mark(gone.id)).toBeNull();

      const act = await pool.query<{ user_id: string; recent: boolean }>(
        `SELECT user_id::text, last_activity_at > NOW() - INTERVAL '1 year' AS recent
           FROM v_user_last_activity WHERE user_id = ANY($1::uuid[]) ORDER BY recent DESC`, [[u.id, quiet.id]]);
      expect(act.rows).toEqual([{ user_id: u.id, recent: true }, { user_id: quiet.id, recent: false }]);

      const out = await runRetentionCensus(
        (sql, params) => pool.query(sql, params),
        RETENTION_TARGETS.filter((t) => t.term === 'profile_3y'),
      );
      // Вошедший недавно — в сроке; молчавший четыре года — за сроком.
      expect(out.rows[0]).toMatchObject({ state: 'ok', over_term: 1 });
    });
  });

  describe('уборка сроков хранения на той же базе', () => {
    const OLD = "NOW() - INTERVAL '120 days'";
    const NEW = "NOW() - INTERVAL '5 days'";

    it('сухой прогон: каждый шаг выполняется на схеме, ничего не пишется', async () => {
      const before = await pool.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM retention_purge_log');
      const run = await runRetentionPurge((sql, params) => pool.query(sql, params), { apply: false });
      expect(run.rows.filter((r) => r.state !== 'ok').map((r) => `${r.table}: ${r.state}`)).toEqual([]);
      expect(run.rows).toHaveLength(PURGE_STEPS.length);
      const after = await pool.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM retention_purge_log');
      expect(after.rows[0].n).toBe(before.rows[0].n);
    });

    it('с apply: старое удалено или обезличено, свежее не тронуто, журнал записан; повтор — ноль', async () => {
      await pool.query(`INSERT INTO rag_quality_log (query, answer, created_at) VALUES ('старый вопрос', 'ответ', ${OLD}), ('свежий вопрос', 'ответ', ${NEW})`);
      await pool.query(`INSERT INTO a2a_requests (binding, op, version, ok, agent, ua_family, caller_hash, context_key, created_at) VALUES
        ('jsonrpc', 'message/send', '0.3', TRUE, 'bot', 'bot', 'old-caller', 'old-ctx', ${OLD}),
        ('jsonrpc', 'message/send', '0.3', TRUE, 'bot', 'bot', 'new-caller', 'new-ctx', ${NEW})`);
      await pool.query(`INSERT INTO audit_log (entity_type, entity_id, action, ip_address, user_agent, created_at) VALUES
        ('user', gen_random_uuid(), 'role_switch', '10.0.0.1', 'UA', ${OLD})`);
      // Регистрация партнёра пишет в data почту и ИНН рядом с ролями и согласиями.
      await pool.query(`INSERT INTO audit_log (entity_type, entity_id, action, data, created_at) VALUES
        ('partner', gen_random_uuid(), 'register', '{"email":"old@example.org","inn":"410100000000","roles":["operator"],"consents":{"pd":true}}', ${OLD}),
        ('partner', gen_random_uuid(), 'register', '{"email":"new@example.org","inn":"410100000001","roles":["guide"]}', ${NEW})`);
      await pool.query(`INSERT INTO mcp_clients (caller_hash, day) VALUES ('old-client', (${OLD})::date), ('new-client', CURRENT_DATE)`);
      // Память агентов (#3433): истёкшая — с журналом правок, живая и бессрочная.
      const { rows: [expired] } = await pool.query<{ id: string }>(`INSERT INTO agent_memory (agent_id, memory_type, key, value, expires_at)
        VALUES ('evo', 'intelligence', 'purge-expired', '{"context":"старое"}', NOW() - INTERVAL '1 hour') RETURNING id::text`);
      await pool.query(`INSERT INTO agent_memory_edits (memory_id, agent_id, old_value, new_value, edited_by)
        VALUES ($1, 'evo', '{}', '{"context":"старое"}', 'evo')`, [expired.id]);
      await pool.query(`INSERT INTO agent_memory (agent_id, memory_type, key, value, expires_at) VALUES
        ('evo', 'intelligence', 'purge-live', '{}', NOW() + INTERVAL '1 day'),
        ('evo', 'intelligence', 'purge-forever', '{}', NULL)`);

      const query = (sql: string, params: unknown[]) => pool.query(sql, params);
      const run = await runRetentionPurge(query, { apply: true });
      expect(run.failed).toBe(0);
      const mem = await pool.query<{ key: string }>(`SELECT key FROM agent_memory WHERE key LIKE 'purge-%' ORDER BY key`);
      expect(mem.rows.map((r) => r.key)).toEqual(['purge-forever', 'purge-live']);
      expect((await pool.query('SELECT 1 FROM agent_memory_edits WHERE memory_id = $1::uuid', [expired.id])).rowCount).toBe(0);
      expect(run.rows.find((r) => r.table === 'agent_memory')).toMatchObject({ state: 'ok', rows: 1 });

      const rag = await pool.query<{ query: string }>('SELECT query FROM rag_quality_log ORDER BY created_at');
      expect(rag.rows.map((r) => r.query)).toEqual(['свежий вопрос']);
      const a2a = await pool.query<{ caller_hash: string; context_key: string | null }>(
        'SELECT caller_hash, context_key FROM a2a_requests ORDER BY created_at');
      expect(a2a.rows).toEqual([{ caller_hash: ERASED_MARK, context_key: null }, { caller_hash: 'new-caller', context_key: 'new-ctx' }]);
      // Строка аудита осталась — доказательство выдачи прав; IP и браузер стёрты.
      const audit = await pool.query("SELECT action, ip_address, user_agent FROM audit_log WHERE action = 'role_switch'");
      expect(audit.rows).toEqual([{ action: 'role_switch', ip_address: null, user_agent: null }]);
      const reg = await pool.query<{ data: Record<string, unknown> }>(
        "SELECT data FROM audit_log WHERE action = 'register' ORDER BY created_at");
      expect(reg.rows.map((r) => r.data)).toEqual([
        { roles: ['operator'], consents: { pd: true } },
        { email: 'new@example.org', inn: '410100000001', roles: ['guide'] },
      ]);
      const clients = await pool.query<{ caller_hash: string }>('SELECT caller_hash FROM mcp_clients ORDER BY day');
      expect(clients.rows.map((r) => r.caller_hash)).toEqual(['new-client']);

      const log = await pool.query<{ table_name: string; action: string; rows_affected: number; state: string }>(
        `SELECT table_name, action, rows_affected, state FROM retention_purge_log
          WHERE table_name IN ('rag_quality_log', 'a2a_requests', 'audit_log', 'mcp_clients') ORDER BY id`);
      expect(log.rows).toEqual([
        { table_name: 'a2a_requests', action: 'anonymize', rows_affected: 1, state: 'ok' },
        { table_name: 'mcp_clients', action: 'delete', rows_affected: 1, state: 'ok' },
        { table_name: 'audit_log', action: 'anonymize', rows_affected: 2, state: 'ok' },
        { table_name: 'rag_quality_log', action: 'delete', rows_affected: 1, state: 'ok' },
      ]);

      const again = await runRetentionPurge(query, { apply: true });
      expect(again.total).toBe(0);
    });
  });
});

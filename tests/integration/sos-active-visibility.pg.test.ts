/**
 * Увидит ли дежурный живой SOS — проверка ВЫПОЛНЕНИЕМ на настоящем PostgreSQL.
 *
 * Находка аудита 08.09: в сводке SOS `LIMIT 20` стоял ДО фильтра активных.
 * Двадцать свежих закрытых сигналов вытесняли старый неразрешённый, и сводка
 * печатала «Активных SOS-инцидентов нет» — при живом активном инциденте.
 *
 * Это дефект ФОРМЫ ЗАПРОСА, а форму запроса доказывает только сервер. Поэтому
 * здесь берётся SQL ИЗ ИСХОДНИКА (не копия: копия разошлась бы с оригиналом и
 * охраняла бы саму себя), выкладывается ровно тот сценарий, что описан в
 * находке, и обе формы исполняются рядом.
 *
 * Без второй половины — прогона СТАРОЙ формы — «зелено» не значило бы, что
 * дефект вообще был.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;

if (!PG_URL) {
  // eslint-disable-next-line no-console
  console.warn(
    '[sos-active-visibility] KERNEL_PG_TEST_URL не задан — тест ПРОПУЩЕН (не прогнан, а не зелёный)',
  );
}

const AGENCY = join(process.cwd(), 'lib/agents/agencies/rescue-agency.ts');
const TEST_SCHEMA = 'sos_visibility_test';

/** Живой запрос активных из исходника — тот самый, что уйдёт в прод. */
function liveActiveSql(): string {
  const src = readFileSync(AGENCY, 'utf8');
  const at = src.indexOf('pool.query<SosEventRow>(');
  if (at < 0) throw new Error('в rescue-agency не найден запрос активных SOS');
  const open = src.indexOf('`', at);
  const close = src.indexOf('`', open + 1);
  if (open < 0 || close < 0) throw new Error('запрос активных SOS не в шаблонной строке');
  return src.slice(open + 1, close);
}

/** Форма до починки: ограничение раньше фильтра. Здесь она нужна как эталон дефекта. */
const BROKEN_SQL = `
  SELECT id, status
    FROM sos_events
   WHERE created_at >= NOW() - INTERVAL '30 days'
   ORDER BY created_at DESC
   LIMIT 20
`;

const SCHEMA = `
  DROP TABLE IF EXISTS sos_events;
  CREATE TABLE sos_events (
    id SERIAL PRIMARY KEY,
    user_id INT,
    lat NUMERIC,
    lng NUMERIC,
    status TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

/**
 * Ровно сценарий из находки: один активный сигнал СТАРШЕ окна и двадцать
 * более новых закрытых. Двадцати достаточно, чтобы вытеснить активный из
 * прежней выборки; сороковой день выводит его ещё и за тридцатидневное окно.
 */
const SEED = `
  INSERT INTO sos_events (status, lat, lng, created_at)
  VALUES ('active', 53.02, 158.65, NOW() - INTERVAL '40 days');

  INSERT INTO sos_events (status, lat, lng, created_at)
  SELECT 'resolved', 53.0, 158.6, NOW() - (g || ' hours')::interval
    FROM generate_series(1, 20) AS g;
`;

withPg('активный SOS не должен теряться за свежими закрытыми', () => {
  let pool: Pool;

  beforeAll(async () => {
    const bootstrap = new Pool({ connectionString: PG_URL });
    await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${TEST_SCHEMA}`);
    await bootstrap.end();

    // Схема — параметром соединения, а не `SET search_path`: пул меняет
    // соединение после любой ошибки запроса, и сессионная настройка теряется.
    pool = new Pool({
      connectionString: PG_URL,
      options: `-c search_path=${TEST_SCHEMA}`,
    });
    await pool.query(SCHEMA);
    await pool.query(SEED);
  }, 60_000);

  afterAll(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await pool?.end();
  });

  it('прежняя форма теряет активный сигнал — дефект был, а не привиделся', async () => {
    const { rows } = await pool.query<{ id: number; status: string }>(BROKEN_SQL);
    const active = rows.filter(r => !['resolved', 'false_alarm'].includes(r.status));
    expect(rows).toHaveLength(20);
    expect(active, 'старая форма обязана терять активный — иначе тест ничего не сторожит')
      .toHaveLength(0);
  });

  it('ЖИВОЙ запрос из исходника активный находит', async () => {
    const { rows } = await pool.query<{ id: number; status: string; active_total: number }>(
      liveActiveSql(), [50],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('active');
  });

  it('счёт активных берётся до ограничения', async () => {
    // Ограничение показа в единицу: список усечён, число — нет.
    const { rows } = await pool.query<{ active_total: number }>(liveActiveSql(), [1]);
    expect(rows).toHaveLength(1);
    expect(rows[0].active_total).toBe(1);
  });

  it('усечение видно: при десяти активных и показе трёх счёт остаётся десять', async () => {
    await pool.query(`
      INSERT INTO sos_events (status, created_at)
      SELECT 'active', NOW() - (g || ' minutes')::interval FROM generate_series(1, 9) AS g
    `);
    const { rows } = await pool.query<{ active_total: number }>(liveActiveSql(), [3]);
    expect(rows).toHaveLength(3);
    expect(rows[0].active_total).toBe(10);
    await pool.query(`DELETE FROM sos_events WHERE status = 'active' AND created_at > NOW() - INTERVAL '1 day'`);
  });

  it('когда активных нет — пусто, и это честное «нет»', async () => {
    await pool.query(`UPDATE sos_events SET status = 'resolved' WHERE status = 'active'`);
    const { rows } = await pool.query(liveActiveSql(), [50]);
    expect(rows).toHaveLength(0);
  });
});

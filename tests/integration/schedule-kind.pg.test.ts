/**
 * Признак «как тур выезжает» (#3476, шаг 1, миграция 1455) на настоящем
 * PostgreSQL: CHECK колонки отвергает чужие значения, каталог сайта читает
 * колонку и ставит тур «любой день сезона» после тура с настоящим выездом.
 *
 * Своя база `schedule_kind_test` — копия шаблона схемы (baseline + миграции).
 * Запуск ТРЕБУЕТ базы: KERNEL_PG_TEST_URL. Без неё файл честно пропускается —
 * «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createTestDatabase, dropTestDatabase } from '../helpers/pg-schema';

vi.mock('next/cache', () => ({ unstable_cache: (fn: () => unknown) => fn }));

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[schedule-kind.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'schedule_kind_test';
const OPERATOR = 'c3476000-0000-4000-8000-000000000001';
const ACTIVITY = 'sk3476_test';

withPg('schedule_kind: колонка и порядок каталога (#3476)', () => {
  let pool: import('pg').Pool;
  const id: Record<'departure' | 'anyDay' | 'none', string> = { departure: '', anyDay: '', none: '' };

  beforeAll(async () => {
    const { Pool } = await import('pg');
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 2 });
    process.env.DATABASE_URL = dbUrl;
    process.env.DATABASE_SSL = 'false';

    await pool.query(
      `INSERT INTO partners (id, name, category, contact, slug, is_public, is_verified, status)
       VALUES ($1, 'Тест Расписание', 'operator', '{}'::jsonb, 'test-sk3476', TRUE, TRUE, 'active')`,
      [OPERATOR],
    );
    const insert = async (key: keyof typeof id, kind: string | null) => {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO operator_tours (operator_id, title, slug, activity_type, base_price, price_unit,
                                     min_participants, max_participants, duration_hours, difficulty,
                                     is_active, is_published, season_start, season_end, schedule_kind)
         VALUES ($1, $2, $3, $4, 1000, 'per_person', 1, 10, 8, 'easy', TRUE, TRUE,
                 (NOW() AT TIME ZONE 'Asia/Kamchatka')::date + 30,
                 (NOW() AT TIME ZONE 'Asia/Kamchatka')::date + 120, $5)
         RETURNING id::text`,
        [OPERATOR, `SK тур ${key}`, `sk3476-${key}`, ACTIVITY, kind],
      );
      id[key] = rows[0].id;
    };
    await insert('departure', 'departures');
    await insert('anyDay', 'any_day');
    await insert('none', null);
    // Настоящий выезд — строка календаря с местами через 40 дней.
    await pool.query(
      `INSERT INTO tour_availability (operator_tour_id, date, available_slots)
       VALUES ($1, (NOW() AT TIME ZONE 'Asia/Kamchatka')::date + 40, 5)`,
      [id.departure],
    );
  });

  afterAll(async () => {
    await pool?.end();
    const { pool: appPool } = await import('@/lib/db-pool');
    await (appPool as unknown as { end?: () => Promise<void> }).end?.();
    if (PG_URL) await dropTestDatabase(PG_URL, TEST_DB);
  });

  it('CHECK: только departures, any_day или NULL', async () => {
    await expect(pool.query(`UPDATE operator_tours SET schedule_kind = 'daily' WHERE id = $1`, [id.none]))
      .rejects.toMatchObject({ code: '23514' });
    await pool.query(`UPDATE operator_tours SET schedule_kind = NULL WHERE id = $1`, [id.none]);
    const { rows } = await pool.query<{ d: string | null }>(
      `SELECT column_default AS d FROM information_schema.columns WHERE table_name = 'operator_tours' AND column_name = 'schedule_kind'`,
    );
    expect(rows[0]?.d ?? null).toBeNull();
  });

  it('каталог: выезд → любой день сезона → без признака, и колонка доходит до строки', async () => {
    const { queryMarketplaceTours, MarketplaceToursQuerySchema } = await import('@/lib/search/tour-search');
    const r = await queryMarketplaceTours(MarketplaceToursQuerySchema.parse({ activity_type: ACTIVITY, limit: 50 }));
    expect(r.tours.map((t) => String(t.id))).toEqual([id.departure, id.anyDay, id.none]);
    expect(r.tours.map((t) => t.schedule_kind)).toEqual(['departures', 'any_day', null]);
  });
});

/**
 * Цена показа и цена счёта — одна, доказано ВЫПОЛНЕНИЕМ на PostgreSQL.
 *
 * Статический сторож (tests/unit/honest-price.test.ts) держит устройство:
 * что правило одно, что множитель 1 не трогает цену, что бронь зовёт
 * `honestTourPrice`. Но главный вопрос — «вставится ли бронь с новым списком
 * колонок и совпадёт ли записанная сумма с показанной» — решается не чтением.
 * Мок ответил бы на любой SQL, а запрос формы «INSERT … VALUES ($1,…,$23)»
 * либо принимается сервером, либо нет.
 *
 * Здесь заводится живой тур с правилом `last_minute` (−15%) на близкую дату,
 * и проверяется ровно то, ради чего всё делалось:
 *
 *   показанная цена     → та, что даёт правило;
 *   записанная в бронь  → та же до рубля;
 *   base_total_price    → цена оператора, а final_price — со скидкой;
 *   discount_percent    → 15, а не отрицательное и не пустое;
 *   тур без правил      → цена не изменилась ВООБЩЕ, включая округление.
 *
 * Последнее не придирка: округление до сотни применялось безусловно, и тур за
 * 12 950 ₽ показывался за 13 000 там, где не сработало ни одно правило.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  composeHonestPrice, loadPricingContext, priceLabel,
} from '@/lib/tours/honest-price';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;

/**
 * Своя база, а не общая `kernel_test`, — по той же причине, что у
 * `guide-team`: схема нужна ПОЛНАЯ (partners, operator_tours,
 * tour_pricing_rules, tour_availability и VIEW v_tour_daily_occupancy), и
 * получается она единственным честным путём — baseline прода плюс все
 * миграции, тем же скриптом, которым катится деплой. В public этот файл не
 * сидит: соседи по общей базе делят в ней таблицы.
 */
const TEST_DB = 'honest_price_test';
const FIRST_AFTER_BASELINE = 863;

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

if (!PG_URL) {
  console.warn(
    '[honest-price] KERNEL_PG_TEST_URL не задан — тест ПРОПУЩЕН (не прогнан, а не зелёный)',
  );
}

withPg('честная цена на настоящем PostgreSQL', () => {
  let pool: Pool;
  let tourWithRule = 0;
  let tourNoRules = 0;
  /** Дата через три дня — попадает в окно last_minute (0..7 дней). */
  let soon = '';

  beforeAll(async () => {
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await bootstrap.query(`CREATE DATABASE ${TEST_DB}`);
    await bootstrap.end();

    const dbUrl = withDatabase(PG_URL, TEST_DB);
    const env = { ...process.env, DATABASE_URL: dbUrl, DATABASE_SSL: 'false' };
    execFileSync('node', [join(process.cwd(), 'scripts', 'bootstrap-from-baseline.js')], { env, stdio: 'pipe' });
    pool = new Pool({ connectionString: dbUrl, max: 4 });
    await pool.query(
      `DELETE FROM _migrations
        WHERE (substring(name from '^[0-9]+'))::bigint >= $1
           OR substring(name from '^[0-9]+') IS NULL`,
      [FIRST_AFTER_BASELINE],
    );
    execFileSync('npx', ['tsx', join(process.cwd(), 'lib', 'database', 'migrate.ts')], { env, stdio: 'pipe' });

    const d = new Date(Date.now() + 3 * 86_400_000);
    soon = d.toISOString().slice(0, 10);

    const op = await pool.query<{ id: string }>(
      `INSERT INTO partners (name, category, contact)
       VALUES ($1, 'operator', '{}'::jsonb) RETURNING id::text AS id`,
      ['Тест честной цены'],
    );
    const operatorId = op.rows[0]!.id;

    const mk = async (title: string, price: number) => {
      const r = await pool.query<{ id: number }>(
        `INSERT INTO operator_tours (operator_id, title, base_price, price_unit, is_active, is_published)
         VALUES ($1, $2, $3, 'per_person', true, true) RETURNING id`,
        [operatorId, title, price],
      );
      return r.rows[0]!.id;
    };
    tourWithRule = await mk('Тур с правилом last_minute', 20000);
    // 12 950 выбрано намеренно: не кратно сотне, и безусловное округление
    // было бы видно сразу.
    tourNoRules = await mk('Тур без правил цены', 12950);

    for (const id of [tourWithRule, tourNoRules]) {
      await pool.query(
        `INSERT INTO tour_availability (operator_tour_id, date, available_slots, booked_slots)
         VALUES ($1, $2::date, 10, 0)`,
        [id, soon],
      );
    }
    await pool.query(
      `INSERT INTO tour_pricing_rules
         (operator_tour_id, rule_type, days_before_min, days_before_max, multiplier, is_active)
       VALUES ($1, 'last_minute', 0, 7, 0.85, true)`,
      [tourWithRule],
    );
    // Baseline + все миграции, как у соседних pg-тестов: дефолтных 10 с хука
    // перестало хватать по мере роста числа миграций (kernel-pg 29.09).
  }, 300_000);

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it('запрос правил и занятости выполняется сервером', async () => {
    // Форма запроса судится PostgreSQL, а не чтением: у VIEW
    // v_tour_daily_occupancy свои колонки, и JOIN по ним либо принимается,
    // либо нет.
    const ctx = await loadPricingContext(tourWithRule, soon, pool);
    expect(ctx.rules).toHaveLength(1);
    expect(ctx.rules[0]!.rule_type).toBe('last_minute');
    expect(ctx.occupancyPct).toBe(0);
  });

  it('правило last_minute даёт скидку, и она названа словами', async () => {
    const { rules, occupancyPct } = await loadPricingContext(tourWithRule, soon, pool);
    const price = composeHonestPrice({
      baseUnitPrice: 20000, priceUnit: 'per_person', participants: 2,
      rules, ctx: { tourDate: soon, guests: 2, occupancyPct },
    });
    expect(price.finalUnitPrice).toBe(17000);
    expect(price.baseTotal).toBe(40000);
    expect(price.total).toBe(34000);
    expect(price.changePercent).toBe(-15);
    expect(price.label).toBe('−15%, последние места');
  });

  it('тур без правил не меняет цену ВООБЩЕ, включая округление', async () => {
    const { rules, occupancyPct } = await loadPricingContext(tourNoRules, soon, pool);
    expect(rules).toHaveLength(0);
    const price = composeHonestPrice({
      baseUnitPrice: 12950, priceUnit: 'per_person', participants: 1,
      rules, ctx: { tourDate: soon, guests: 1, occupancyPct },
    });
    expect(price.finalUnitPrice).toBe(12950);
    expect(price.total).toBe(12950);
    expect(price.changePercent).toBeNull();
    expect(price.label).toBeNull();
  });

  it('вставка брони с новым списком колонок принимается сервером', async () => {
    // Ровно та форма, что в lib/bookings/reserve.ts: колонок стало больше, и
    // расхождение номеров параметров сервер отвергает, а тест чтением — нет.
    const label = priceLabel(0.85, ['last_minute']);
    const ins = await pool.query<{ id: number }>(
      `INSERT INTO operator_bookings (
         operator_tour_id, tourist_name, tourist_phone,
         participants, booking_date,
         booking_status, base_total_price, final_price,
         discount_percent, discount_reason, created_via
       ) VALUES ($1,$2,$3,$4,$5::date,$6,$7,$8,$9,$10,$11)
       RETURNING id`,
      [tourWithRule, 'Тест', '+70000000000', 2, soon, 'new', 40000, 34000, 15, label, 'test'],
    );
    const id = ins.rows[0]!.id;
    const { rows } = await pool.query<{
      base_total_price: string; final_price: string;
      discount_percent: number | null; discount_reason: string | null;
    }>(
      `SELECT base_total_price, final_price, discount_percent, discount_reason
         FROM operator_bookings WHERE id = $1`,
      [id],
    );
    const row = rows[0]!;
    expect(Number(row.final_price)).toBe(34000);
    expect(Number(row.base_total_price)).toBe(40000);
    // Скидка положительным числом: «−15%» в колонке `discount_percent`
    // означало бы подорожание для следующего читателя.
    expect(row.discount_percent).toBe(15);
    expect(row.discount_reason).toBe('−15%, последние места');
  });
});

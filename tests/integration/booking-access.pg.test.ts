/**
 * Чужой номер брони не открывает бронь — доказательство ВЫПОЛНЕНИЕМ.
 *
 * Статический сторож (tests/unit/booking-access.test.ts) держит устройство:
 * что проверка вызвана, что отказ — 404, что pdf_token не возвращается. Но
 * вопрос «а получит ли турист B данные туриста A» решается не чтением кода, а
 * настоящей базой: засыпку старых строк делает волатильный DEFAULT, и то, что
 * у каждой брони ключ СВОЙ, — свойство PostgreSQL, а не наше обещание.
 *
 * Здесь берётся сама миграция 943 и исполняется, потом заводятся две брони и
 * проверяется ровно то, ради чего всё делалось:
 *
 *   A с ключом A  → видит свою бронь;
 *   B с ключом A  → не видит бронь B (ключ не подходит к чужому номеру);
 *   любой без ключа → не видит ничего;
 *   старые строки → получили РАЗНЫЕ ключи, а не один общий.
 *
 * Последнее — не придирка: один общий ключ на всех был бы той же дырой, где
 * вместо номера 36 символов.
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
    '[booking-access] KERNEL_PG_TEST_URL не задан — тест ПРОПУЩЕН (не прогнан, а не зелёный)',
  );
}

const MIGRATION = readFileSync(
  join(process.cwd(), 'migrations/943_operator_bookings_access_token.sql'),
  'utf-8',
);

withPg('ключ брони на настоящем PostgreSQL', () => {
  let pool: Pool;
  const ids: number[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_URL });

    // Минимальная таблица того же рода, что боевая: BIGSERIAL-номер и
    // содержательные поля. Полную схему тянуть незачем — проверяется ключ.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS operator_bookings (
        id            BIGSERIAL PRIMARY KEY,
        tourist_name  TEXT NOT NULL,
        tourist_phone TEXT
      )
    `);

    // Две брони ДО миграции — это и есть «старые строки», которые она засыпает.
    for (const [name, phone] of [['Турист А', '+79001110011'], ['Турист Б', '+79002220022']]) {
      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO operator_bookings (tourist_name, tourist_phone) VALUES ($1, $2) RETURNING id`,
        [name, phone],
      );
      ids.push(rows[0]!.id);
    }

    await pool.query(MIGRATION);
  });

  afterAll(async () => {
    await pool?.query('DROP TABLE IF EXISTS operator_bookings');
    await pool?.end();
  });

  it('старые брони получили РАЗНЫЕ ключи, а не один общий', async () => {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT COUNT(DISTINCT access_token)::text AS n FROM operator_bookings`,
    );
    expect(Number(rows[0]!.n)).toBe(ids.length);
  });

  it('ключ не пустой и уникален по индексу', async () => {
    const { rows } = await pool.query<{ access_token: string }>(
      `SELECT access_token::text AS access_token FROM operator_bookings WHERE id = $1`,
      [ids[0]],
    );
    expect(rows[0]!.access_token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    // Повторить чужой ключ нельзя — это держит уникальный индекс миграции.
    await expect(
      pool.query(
        `INSERT INTO operator_bookings (tourist_name, access_token)
         VALUES ('Подделка', (SELECT access_token FROM operator_bookings WHERE id = $1))`,
        [ids[0]],
      ),
    ).rejects.toThrow();
  });

  it('ключ подходит только к своей брони', async () => {
    const key = async (id: number) => (
      await pool.query<{ t: string }>(
        `SELECT access_token::text AS t FROM operator_bookings WHERE id = $1`, [id],
      )
    ).rows[0]!.t;

    const keyA = await key(ids[0]!);

    // Тот же запрос, что стоит в lib/bookings/access.ts: сверка ключа с
    // ключом ИМЕННО этой строки.
    const check = async (id: number, token: string) => {
      const { rows } = await pool.query<{ access_token: string }>(
        `SELECT access_token::text AS access_token FROM operator_bookings WHERE id = $1`, [id],
      );
      return rows[0]?.access_token === token;
    };

    expect(await check(ids[0]!, keyA)).toBe(true);   // свой ключ к своей броне
    expect(await check(ids[1]!, keyA)).toBe(false);  // ключ А к броне Б — нет
    expect(await check(ids[1]!, '')).toBe(false);    // без ключа — нет
  });
});

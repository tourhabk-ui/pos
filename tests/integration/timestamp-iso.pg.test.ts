/**
 * isoUtcSql на настоящем PostgreSQL (03.10, плитка «Радар» «9 ч назад»).
 *
 * Колонка `timestamp` без пояса хранит стенное время пояса сессии. Проверяем
 * при НЕ-UTC поясе (Москва и Камчатка): ISO-строка обязана указывать на тот же
 * момент, что NOW(), а прежний `::text` — нет (он и давал «из будущего» на
 * сервере и «9 ч назад» на телефоне).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { isoUtcSql } from '@/lib/db/timestamp-iso';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[timestamp-iso.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

withPg('метка без пояса → момент в UTC', () => {
  let client: import('pg').Client;

  beforeAll(async () => {
    const { Client } = await import('pg');
    client = new Client({ connectionString: PG_URL });
    await client.connect();
  });
  afterAll(async () => { await client?.end(); });

  for (const tz of ['Europe/Moscow', 'Asia/Kamchatka', 'UTC']) {
    it(`пояс сессии ${tz}: ISO совпадает с now(), ::text — только при UTC`, async () => {
      await client.query(`SET TIME ZONE '${tz}'`);
      await client.query('CREATE TEMP TABLE IF NOT EXISTS lrs_tz (updated_at timestamp DEFAULT now())');
      await client.query('TRUNCATE lrs_tz');
      await client.query('INSERT INTO lrs_tz DEFAULT VALUES');
      const { rows } = await client.query<{ iso: string; old: string; now: Date }>(
        `SELECT ${isoUtcSql('MAX(updated_at)')} AS iso, MAX(updated_at)::text AS old, now() AS now FROM lrs_tz`,
      );
      const nowMs = rows[0].now.getTime();
      expect(rows[0].iso).toMatch(/Z$/);
      expect(Math.abs(Date.parse(rows[0].iso) - nowMs)).toBeLessThan(2_000);
      // Прежняя форма, разобранная в UTC (как на сервере): верна только при UTC.
      const oldAsUtc = Date.parse(`${rows[0].old.replace(' ', 'T')}Z`);
      if (tz === 'UTC') expect(Math.abs(oldAsUtc - nowMs)).toBeLessThan(2_000);
      else expect(Math.abs(oldAsUtc - nowMs)).toBeGreaterThan(60 * 60 * 1000);
    });
  }

  it('пустая таблица — null, а не строка', async () => {
    const { rows } = await client.query<{ iso: string | null }>(
      `SELECT ${isoUtcSql('MAX(x)')} AS iso FROM (SELECT NULL::timestamp AS x WHERE false) s`,
    );
    expect(rows[0].iso).toBeNull();
  });
});

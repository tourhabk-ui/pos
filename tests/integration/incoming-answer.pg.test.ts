/**
 * Ответ на входящую заявку на настоящем PostgreSQL.
 *
 * Мок принял бы любой INSERT. Здесь сервер решает: миграция 1331
 * применяется повторно, одна строка на предмет, второе нажатие не
 * переписывает первое, чужой партнёр строку не создаёт, запрос владельца
 * по каждому виду предмета выполняется (битая колонка — исход «не прочитал»,
 * не «заявки нет»).
 *
 * Своя база `incoming_answer_test`. Без KERNEL_PG_TEST_URL файл
 * пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTestDatabase, dropTestDatabase } from '../helpers/pg-schema';
import type { IncomingKind } from '@/lib/requests/incoming-card';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[incoming-answer.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'incoming_answer_test';
const MIGRATION = join(process.cwd(), 'migrations', '1331_partner_incoming_answers.sql');
const KINDS: IncomingKind[] = ['lead', 'stay_request', 'stay_booking', 'gear', 'booking'];

withPg('ответ на входящую заявку на PostgreSQL', () => {
  let pool: import('pg').Pool;
  let dbUrl = '';

  beforeAll(async () => {
    const { Pool } = await import('pg');
    dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    process.env.DATABASE_URL = dbUrl;
    process.env.DATABASE_SSL = 'false';
    pool = new Pool({ connectionString: dbUrl, max: 2 });
    pool.on('error', () => undefined);
    const sql = readFileSync(MIGRATION, 'utf8');
    await pool.query(sql);
    await pool.query(sql);
  }, 120_000);

  afterAll(async () => {
    const { pool: appPool } = await import('@/lib/db-pool');
    appPool.on('error', () => undefined);
    await Promise.resolve(appPool.end()).catch(() => undefined);
    await pool?.end().catch(() => undefined);
    if (PG_URL) await dropTestDatabase(PG_URL, TEST_DB);
  });

  it('одна строка, повтор не переписывает, чужой не пишет, каждый вид читается', async () => {
    const { claimIncomingAnswer } = await import('@/lib/requests/incoming-answer-store');
    const owner = await pool.query<{ id: string }>(
      `INSERT INTO partners (name, category, contact, contacts, is_verified, is_public, slug)
       VALUES ('Хозяин заявки', 'operator', '{"phone":"+70000000000"}', '{"phone":"+70000000000"}', FALSE, TRUE, $1)
       RETURNING id::text`,
      [`in-${randomUUID().slice(0, 8)}`],
    );
    const other = await pool.query<{ id: string }>(
      `INSERT INTO partners (name, category, contact, contacts, is_verified, is_public, slug)
       VALUES ('Чужой', 'operator', '{"phone":"+70000000001"}', '{"phone":"+70000000001"}', FALSE, TRUE, $1)
       RETURNING id::text`,
      [`in-${randomUUID().slice(0, 8)}`],
    );
    const ownerId = owner.rows[0]!.id;
    const otherId = other.rows[0]!.id;
    const lead = await pool.query<{ id: string; status: string }>(
      `INSERT INTO leads (name, phone, status, operator_id)
       VALUES ('Проба', '+70000000002', 'new', $1) RETURNING id::text, status`,
      [ownerId],
    );
    const leadId = lead.rows[0]!.id;
    const statusBefore = lead.rows[0]!.status;

    expect(await claimIncomingAnswer({ partnerId: ownerId, kind: 'lead', subjectId: leadId, answer: 'accept' }))
      .toEqual({ outcome: 'saved' });
    expect(await claimIncomingAnswer({ partnerId: ownerId, kind: 'lead', subjectId: leadId, answer: 'no_seats' }))
      .toEqual({ outcome: 'already', answer: 'accept' });
    expect(await claimIncomingAnswer({ partnerId: otherId, kind: 'lead', subjectId: leadId, answer: 'clarify' }))
      .toEqual({ outcome: 'not_yours' });
    expect(await claimIncomingAnswer({ partnerId: 'не-uuid', kind: 'lead', subjectId: leadId, answer: 'self' }))
      .toEqual({ outcome: 'missing' });

    const rows = await pool.query<{ answer: string; n: number }>(
      `SELECT answer, count(*)::int AS n FROM partner_incoming_answers
        WHERE subject_kind = 'lead' AND subject_id = $1 GROUP BY answer`,
      [leadId],
    );
    expect(rows.rows).toEqual([{ answer: 'accept', n: 1 }]);
    const status = await pool.query<{ status: string }>('SELECT status FROM leads WHERE id = $1::uuid', [leadId]);
    expect(status.rows[0]!.status).toBe(statusBefore);

    for (const kind of KINDS) {
      const missed = await claimIncomingAnswer({
        partnerId: ownerId, kind, subjectId: randomUUID(), answer: 'accept',
      });
      expect(missed, kind).toEqual({ outcome: 'missing' });
    }

    const bad = pool.query(
      `INSERT INTO partner_incoming_answers (partner_id, subject_kind, subject_id, answer)
       VALUES ($1::uuid, 'lead', $2, 'take')`,
      [ownerId, randomUUID()],
    );
    await expect(bad).rejects.toMatchObject({ code: '23514' });
    expect(dbUrl).toContain(TEST_DB);
  });
});

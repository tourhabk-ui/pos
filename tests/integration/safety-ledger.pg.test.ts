/**
 * Safety Decision Ledger (925) на настоящем PostgreSQL.
 *
 * Regex-сторож (safety-ledger.test.ts) держит форму кода и точки врезки;
 * здесь — append-only на уровне БД (мокать нельзя, прецедент 42P08 из
 * CLAUDE.md: вывод типов/констрейнтов повторяет только настоящий сервер) и
 * fail-soft appendSafetyEvent на реальном нарушении констрейнта.
 *
 * Запуск ТРЕБУЕТ базы: KERNEL_PG_TEST_URL=postgresql://user:pass@host/db.
 * Без неё файл честно пропускается (третье состояние §4.0 — «не прогнано»,
 * а не «прошло»).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;

if (!PG_URL) {
  // eslint-disable-next-line no-console
  console.warn('[safety-ledger.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

if (PG_URL) {
  process.env.DATABASE_URL = PG_URL;
  process.env.DATABASE_SSL = 'false';
}

type Ledger = typeof import('@/lib/safety/ledger');

withPg('Safety Decision Ledger на настоящем PostgreSQL', () => {
  let ledger: Ledger;
  let pool: import('pg').Pool;

  beforeAll(async () => {
    const { Pool } = await import('pg');
    pool = new Pool({ connectionString: PG_URL, max: 4 });
    await pool.query(readFileSync(join(process.cwd(), 'migrations', '925_safety_decision_events.sql'), 'utf-8'));
    ledger = await import('@/lib/safety/ledger');
  });

  afterAll(async () => {
    const { pool: appPool } = await import('@/lib/db-pool');
    await appPool.end().catch(() => undefined);
    await pool.end().catch(() => undefined);
  });

  it('appendSafetyEvent пишет строку и возвращает id', async () => {
    const res = await ledger.appendSafetyEvent({
      entityId: null,
      eventType: 'source_observed',
      actorType: 'source',
      actorId: 'pg-test',
      details: { note: 'first' },
    });
    expect(res.ok).toBe(true);
    expect(res.id).toBeTypeOf('number');

    const { rows } = await pool.query('SELECT event_type, actor_type, actor_id FROM safety_decision_events WHERE id = $1', [res.id]);
    expect(rows[0]).toMatchObject({ event_type: 'source_observed', actor_type: 'source', actor_id: 'pg-test' });
  });

  it('append-only: UPDATE и DELETE отклоняет сама БД', async () => {
    const res = await ledger.appendSafetyEvent({ entityId: null, eventType: 'fetch_failed', actorType: 'source', actorId: 'pg-test' });
    expect(res.ok).toBe(true);

    await expect(pool.query(`UPDATE safety_decision_events SET decision_reason = 'tamper' WHERE id = $1`, [res.id]))
      .rejects.toThrow(/append-only/);
    await expect(pool.query(`DELETE FROM safety_decision_events WHERE id = $1`, [res.id]))
      .rejects.toThrow(/append-only/);
  });

  it('fail-soft: реальное нарушение констрейнта не бросает исключение, возвращает {ok:false}', async () => {
    // prior_event_id ссылается на несуществующую строку — настоящее нарушение
    // FK, не мок. appendSafetyEvent обязан поймать это сам и не уронить
    // вызывающий safety-критичный конвейер.
    const res = await ledger.appendSafetyEvent({
      entityId: null,
      eventType: 'risk_classified',
      actorType: 'system',
      priorEventId: 999_999_999,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBeTruthy();
  });

  it('hashPayload детерминирован независимо от порядка ключей', () => {
    const a = ledger.hashPayload({ title: 'X', alert_type: 'fire_danger' });
    const b = ledger.hashPayload({ alert_type: 'fire_danger', title: 'X' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

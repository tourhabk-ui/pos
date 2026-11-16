/**
 * Перепись целостности броней и заявок (#3388 п.3, шаг 1) — на настоящем
 * PostgreSQL. Мок отвечает на любой SQL; выполняются ли запросы переписи на
 * схеме прода и считают ли они то, что обещают, говорит только сервер.
 *
 * Сцена: схема baseline прода плюс все миграции, один тур, брони с известными
 * нарушениями. Каждое правило переписи обязано назвать ровно своё число, а
 * «повтор того же человека» — не путать две разные группы на одну дату с
 * повтором.
 *
 * Своя база `booking_integrity_census_test`. Без KERNEL_PG_TEST_URL файл
 * честно пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from '../helpers/pg-schema';
import { INTEGRITY_MEASURES, assembleIntegrityCensus, type IntegrityMeasure } from '@/lib/bookings/integrity-census';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[booking-integrity-census.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'booking_integrity_census_test';

withPg('перепись целостности броней на настоящем PostgreSQL', () => {
  let pool: import('pg').Pool;
  let tourId = '';
  let goneTourId = '';

  async function run() {
    const got: Partial<Record<IntegrityMeasure, Record<string, unknown>[]>> = {};
    for (const [measure, sql] of INTEGRITY_MEASURES) {
      got[measure] = (await pool.query(sql)).rows;
    }
    return assembleIntegrityCensus(got, [], '2026-11-16T00:00:00Z');
  }

  async function booking(fields: Record<string, unknown>): Promise<void> {
    const row = {
      operator_tour_id: tourId,
      booking_date: '2027-07-20',
      participants: 2,
      booking_status: 'new',
      created_at: '2026-11-10 10:00:00',
      ...fields,
    };
    const cols = Object.keys(row);
    await pool.query(
      `INSERT INTO operator_bookings (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(row),
    );
  }

  beforeAll(async () => {
    const { Pool } = await import('pg');
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 2 });
    const partner = await pool.query<{ id: string }>(
      `INSERT INTO partners (name, category, contact, is_verified, is_public, slug)
       VALUES ('Оператор', 'operator', '{}', TRUE, TRUE, 'op-integrity') RETURNING id`,
    );
    const tour = await pool.query<{ id: string }>(
      `INSERT INTO operator_tours (operator_id, title, base_price, max_participants, is_active, is_published, activity_type, difficulty)
       VALUES ($1, 'Горелый', 15000, 20, TRUE, TRUE, 'hiking', 'medium') RETURNING id::text AS id`,
      [partner.rows[0]!.id],
    );
    tourId = tour.rows[0]!.id;
    const gone = await pool.query<{ id: string }>(
      `INSERT INTO operator_tours (operator_id, title, base_price, max_participants, is_active, is_published, activity_type, difficulty, deleted_at)
       VALUES ($1, 'Снятый тур', 15000, 20, FALSE, FALSE, 'hiking', 'medium', NOW()) RETURNING id::text AS id`,
      [partner.rows[0]!.id],
    );
    goneTourId = gone.rows[0]!.id;
  }, 300_000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
  });

  it('пустая база: все запросы выполняются, нарушений ноль, правила готовы к ограничению', async () => {
    const r = await run();
    expect(r.ok).toBe(true);
    expect(r.bookings).toMatchObject({ total: 0, participants_not_positive: 0, cancelled_then_active: 0 });
    expect(r.booking_repeats).toEqual({ groups: 0, rows: 0 });
    expect(r.leads).toMatchObject({ total: 0 });
    expect(Object.values(r.constraint_ready).every((v) => v === true)).toBe(true);
    // Что база уже держит — читается из самой базы: CHECK статуса брони (1291)
    // и «число людей больше нуля» (baseline) там есть.
    const guards = r.existing_guards.operator_bookings?.map((g) => g.name) ?? [];
    expect(guards).toContain('operator_bookings_booking_status_check');
    expect(guards).toContain('participants_valid');
  });

  it('каждое нарушение названо своим числом, а две группы на одну дату — не повтор', async () => {
    // Повтор: тот же человек (одна почта в разном регистре), тот же тур и дата, обе действующие.
    await booking({ tourist_email: 'anna@example.org', tourist_phone: '+7 914 000-00-01' });
    await booking({ tourist_email: 'Anna@Example.org ', tourist_phone: '+7 914 000-00-01', booking_status: 'confirmed' });
    // Другая группа на ту же дату — обычное дело, не повтор.
    await booking({ tourist_email: 'boris@example.org' });
    // Нарушения правил по одному.
    // Ноль людей база уже не примет (participants_valid) — счёт обязан остаться нулём.
    await expect(booking({ participants: 0, tourist_email: 'p0@example.org' })).rejects.toThrow(/participants_valid/);
    await booking({ participants: 3, adult_count: 2, child_count: 2, tourist_email: 'mix@example.org' });
    await booking({ booking_date: '2026-11-01', tourist_email: 'past@example.org' });
    await booking({ booking_date: '2029-01-01', tourist_email: 'far@example.org' });
    await booking({ booking_date: '2027-07-20', end_date: '2027-07-18', tourist_email: 'end@example.org' });
    await booking({ booking_status: 'confirmed', cancelled_at: '2026-11-12 10:00:00', tourist_email: 'back@example.org' });
    await booking({ booking_status: 'cancelled', tourist_email: 'notime@example.org' });
    // Правильно отменённая бронь (статус и время отмены) — не улика возврата в работу.
    await booking({ booking_status: 'cancelled', cancelled_at: '2026-11-12 10:00:00', tourist_email: 'proper@example.org' });
    await booking({ operator_tour_id: goneTourId, tourist_email: 'gone@example.org' });
    await booking({ pd_consent_at: '2026-11-10 10:00:00', tourist_email: 'ok@example.org', booking_date: '2027-08-01' });
    await pool.query(
      `INSERT INTO leads (name, phone, status, group_size, pd_consent_at) VALUES
         ('Турист', '+79140000002', 'new', 2, NOW()),
         ('Турист', '+79140000003', 'cancelled', 0, NULL)`,
    );

    const r = await run();
    expect(r.ok).toBe(true);
    expect(r.bookings).toMatchObject({
      total: 12,
      participants_not_positive: 0,
      parts_mismatch: 1,
      date_before_creation: 1,
      date_beyond_two_years: 1,
      end_before_start: 1,
      cancelled_then_active: 1,
      cancelled_without_time: 1,
      without_consent: 11,
    });
    expect(r.booking_repeats).toEqual({ groups: 1, rows: 2 });
    // На 20.07 у тура несколько действующих броней разных людей — дата одна.
    expect(r.booking_shared_dates).toMatchObject({ dates: 1 });
    expect(r.booking_tour_gone).toEqual({ on_deleted_tour: 1, active_on_deleted_tour: 1 });
    expect(r.leads).toMatchObject({ total: 2, cancelled_by_client: 1, without_consent: 1, group_size_not_positive: 1 });
    expect(r.constraint_ready).toMatchObject({
      participants_positive: true,
      cancelled_stays_cancelled: false,
      no_repeat_same_person: false,
      lead_group_size_positive: false,
    });

    // В ответе — только числа и имена схемы: ни почт, ни телефонов.
    const text = JSON.stringify(r);
    expect(text).not.toContain('@example.org');
    expect(text).not.toContain('914');
  });
});

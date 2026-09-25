/**
 * Команда оператора и кабинет гида на настоящем PostgreSQL (пакет B, 25.09).
 *
 * Все запросы связки «оператор — гид — бронь» и календаря гида живут в
 * `lib/guides/team-queries.ts` и ИСПОЛНЯЮТСЯ здесь на схеме baseline + всех
 * миграций (1018, 1019) — тем же путём, что у деплоя. Юнит-моки отвечают на
 * любой текст; прежний кабинет гида так и прожил с uuid = bigint во всех
 * соединениях, отвечая 500 на каждый экран.
 *
 * Здесь же — правила доступа, записанные в SQL: оператор назначает только на
 * свою бронь и только гида своей команды; гид видит контакт туриста только по
 * назначенной ему брони и только пока он в команде; выход/исключение снимает
 * будущие назначения.
 *
 * Запуск ТРЕБУЕТ базы: KERNEL_PG_TEST_URL=postgresql://user:pass@host/db.
 * Без неё файл честно пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { TEAM_SQL, SCHEDULE_SQL } from '@/lib/guides/team-queries';
import { GUIDES_SQL } from '@/lib/operator/screen-queries';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[guide-team.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'guide_team_test';
const FIRST_AFTER_BASELINE = 863;

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

withPg('команда оператора и кабинет гида на настоящем PostgreSQL', () => {
  let pool: import('pg').Pool;
  const ids = {
    opA: '', opB: '', opAUser: '', g1: '', g1User: '', g2: '',
    tourA: '', tourB: '', bookingA: '', bookingB: '', entry: '', inviteA1: '',
  };
  let date = '';

  beforeAll(async () => {
    const { Pool } = await import('pg');
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

    const user = async (email: string, role: string) => (await pool.query<{ id: string }>(
      `INSERT INTO users (email, name, password_hash, role) VALUES ($1, $1, 'x', $2) RETURNING id`, [email, role],
    )).rows[0].id;
    const partner = async (name: string, category: string, userId: string | null) => (await pool.query<{ id: string }>(
      `INSERT INTO partners (name, category, contact, user_id) VALUES ($1, $2, '{}', $3) RETURNING id`,
      [name, category, userId],
    )).rows[0].id;
    const tour = async (operatorId: string, title: string) => (await pool.query<{ id: string }>(
      `INSERT INTO operator_tours (operator_id, title, base_price, max_participants, is_active, is_published, activity_type, duration_hours)
       VALUES ($1, $2, 5000, 10, TRUE, TRUE, 'hiking', 6) RETURNING id::text`, [operatorId, title],
    )).rows[0].id;
    const booking = async (tourId: string) => (await pool.query<{ id: string }>(
      `INSERT INTO operator_bookings (operator_tour_id, booking_date, participants, booking_status, payment_status, tourist_name, tourist_phone)
       VALUES ($1::bigint, CURRENT_DATE + 7, 3, 'confirmed', 'pending', 'Турист Тестов', '+79990000001') RETURNING id::text`,
      [tourId],
    )).rows[0].id;

    ids.opAUser = await user('op-a@example.com', 'operator');
    ids.opA = await partner('Оператор А', 'operator', ids.opAUser);
    ids.opB = await partner('Оператор Б', 'operator', await user('op-b@example.com', 'operator'));
    ids.g1User = await user('Guide-One@Example.com', 'guide');
    ids.g1 = await partner('Гид Один', 'guide', ids.g1User);
    ids.g2 = await partner('Гид Два', 'guide', await user('guide-two@example.com', 'guide'));
    ids.tourA = await tour(ids.opA, 'Тур оператора А');
    ids.tourB = await tour(ids.opB, 'Тур оператора Б');
    ids.bookingA = await booking(ids.tourA);
    ids.bookingB = await booking(ids.tourB);
    date = (await pool.query<{ d: string }>(`SELECT (CURRENT_DATE + 7)::text AS d`)).rows[0].d;
  }, 300_000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
  });

  it('приглашение: гид находится по e-mail без учёта регистра, повтор ждущего не плодится', async () => {
    const found = await pool.query(TEAM_SQL.findGuideByEmail, ['guide-one@example.com']);
    expect(found.rows[0]).toMatchObject({ id: ids.g1, guide_operator_id: null });
    const first = await pool.query<{ id: string }>(TEAM_SQL.insertInvite, [ids.opA, ids.g1, ids.opAUser]);
    expect(first.rows).toHaveLength(1);
    ids.inviteA1 = first.rows[0].id;
    const dup = await pool.query(TEAM_SQL.insertInvite, [ids.opA, ids.g1, ids.opAUser]);
    expect(dup.rows).toHaveLength(0);
    expect((await pool.query(TEAM_SQL.pendingInvitesForGuide, [ids.g1])).rows).toHaveLength(1);
    expect((await pool.query(TEAM_SQL.operatorInvites, [ids.opA])).rows[0]).toMatchObject({ status: 'pending', guide_name: 'Гид Один' });
  });

  it('до принятия гид не в команде: назначить его оператор не может', async () => {
    expect((await pool.query(TEAM_SQL.teamGuide, [ids.g1, ids.opA])).rows).toHaveLength(0);
    expect((await pool.query(TEAM_SQL.membership, [ids.g1])).rows[0].operator_id).toBeNull();
  });

  it('чужой гид не может ответить на приглашение (строка не блокируется)', async () => {
    const r = await pool.query(TEAM_SQL.lockPendingInviteForGuide, [ids.inviteA1, ids.g2]);
    expect(r.rows).toHaveLength(0);
  });

  it('принятие пишет членство; второй оператор его не перезапишет', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(TEAM_SQL.lockGuide, [ids.g1]);
      expect((await client.query(TEAM_SQL.lockPendingInviteForGuide, [ids.inviteA1, ids.g1])).rows).toHaveLength(1);
      expect((await client.query(TEAM_SQL.setMembership, [ids.g1, ids.opA])).rows).toHaveLength(1);
      expect((await client.query(TEAM_SQL.respondInvite, [ids.inviteA1, 'accepted'])).rows).toHaveLength(1);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect((await pool.query(TEAM_SQL.setMembership, [ids.g1, ids.opB])).rows).toHaveLength(0);
    expect((await pool.query(TEAM_SQL.membership, [ids.g1])).rows[0]).toMatchObject({ operator_id: ids.opA, operator_name: 'Оператор А' });
    expect((await pool.query(TEAM_SQL.teamGuide, [ids.g1, ids.opA])).rows).toHaveLength(1);
    expect((await pool.query(TEAM_SQL.teamGuide, [ids.g1, ids.opB])).rows).toHaveLength(0);
    expect((await pool.query(TEAM_SQL.teamGuide, [ids.g2, ids.opA])).rows).toHaveLength(0);
  });

  it('оператор блокирует только свою бронь; назначение видно гиду с контактом туриста', async () => {
    expect((await pool.query(TEAM_SQL.lockOperatorBooking, [ids.bookingB, ids.opA])).rows).toHaveLength(0);
    const own = await pool.query(TEAM_SQL.lockOperatorBooking, [ids.bookingA, ids.opA]);
    expect(own.rows[0]).toMatchObject({ booking_status: 'confirmed', tour_title: 'Тур оператора А', guide_partner_id: null });
    await pool.query(TEAM_SQL.setBookingGuide, [ids.bookingA, ids.g1]);

    const mine = await pool.query(TEAM_SQL.assignedUpcoming, [ids.g1]);
    expect(mine.rows).toHaveLength(1);
    expect(mine.rows[0]).toMatchObject({ booking_id: ids.bookingA, tourist_phone: '+79990000001', participants: 3 });
    expect((await pool.query(TEAM_SQL.assignedUpcoming, [ids.g2])).rows).toHaveLength(0);
    expect((await pool.query(TEAM_SQL.assignedInRange, [ids.g1, date, date])).rows).toHaveLength(1);
  });

  it('бронь чужого оператора, записанная на гида в обход API, контакт не открывает', async () => {
    await pool.query(`UPDATE operator_bookings SET guide_partner_id = $1 WHERE id = $2::bigint`, [ids.g1, ids.bookingB]);
    const mine = await pool.query<{ booking_id: string }>(TEAM_SQL.assignedUpcoming, [ids.g1]);
    expect(mine.rows.map((r) => r.booking_id)).toEqual([ids.bookingA]);
    await pool.query(`UPDATE operator_bookings SET guide_partner_id = NULL WHERE id = $1::bigint`, [ids.bookingB]);
  });

  it('«Мои туры» и «Гиды» оператора считают назначения', async () => {
    const tours = await pool.query(TEAM_SQL.operatorTours, [ids.opA, ids.g1]);
    expect(tours.rows).toHaveLength(1);
    expect(tours.rows[0]).toMatchObject({ id: ids.tourA, my_assignments: 1 });
    const team = await pool.query(GUIDES_SQL, [ids.opA]);
    expect(team.rows).toHaveLength(1);
    expect(team.rows[0]).toMatchObject({ id: ids.g1, tours_count: '1' });
  });

  it('календарь: вставка, пересечение, одна запись на бронь, владение', async () => {
    const ins = await pool.query<{ id: string }>(SCHEDULE_SQL.insert, [
      ids.g1, date, '10:00', '12:00', 'Выход с группой', null, ids.bookingA, 10, 'Парковка', null,
    ]);
    ids.entry = ins.rows[0].id;
    expect((await pool.query(SCHEDULE_SQL.overlap, [ids.g1, date, '11:00', '13:00', null])).rows).toHaveLength(1);
    expect((await pool.query(SCHEDULE_SQL.overlap, [ids.g1, date, '12:00', '13:00', null])).rows).toHaveLength(0);
    // Встык с другой стороны — тоже не пересечение.
    expect((await pool.query(SCHEDULE_SQL.overlap, [ids.g1, date, '08:00', '10:00', null])).rows).toHaveLength(0);
    expect((await pool.query(SCHEDULE_SQL.overlap, [ids.g1, date, '11:00', '13:00', ids.entry])).rows).toHaveLength(0);
    expect((await pool.query(SCHEDULE_SQL.overlap, [ids.g2, date, '11:00', '13:00', null])).rows).toHaveLength(0);
    expect((await pool.query(SCHEDULE_SQL.bookingEntryExists, [ids.g1, ids.bookingA, null])).rows).toHaveLength(1);
    expect((await pool.query(SCHEDULE_SQL.bookingAssignedToGuide, [ids.bookingA, ids.g1])).rows).toHaveLength(1);
    expect((await pool.query(SCHEDULE_SQL.bookingAssignedToGuide, [ids.bookingA, ids.g2])).rows).toHaveLength(0);
    const list = await pool.query(SCHEDULE_SQL.list, [ids.g1, date, date, null]);
    expect(list.rows[0]).toMatchObject({ start_time: '10:00', end_time: '12:00', tour_title: 'Тур оператора А', tour_date: date });
    expect((await pool.query(SCHEDULE_SQL.list, [ids.g1, date, date, 'cancelled'])).rows).toHaveLength(0);
    expect((await pool.query(SCHEDULE_SQL.one, [ids.entry, ids.g1])).rows).toHaveLength(1);
    expect((await pool.query(SCHEDULE_SQL.one, [ids.entry, ids.g2])).rows).toHaveLength(0);
    expect((await pool.query(SCHEDULE_SQL.ownership, [ids.entry, ids.g2])).rows).toHaveLength(0);
  });

  it('уведомление пишется с допустимым приоритетом', async () => {
    await pool.query(TEAM_SQL.notify, [ids.g1User, 'guide_assignment', 'Вас назначили на тур', 'Тур, дата', '{}', '/hub/guide/groups']);
  });

  it('отзыв приглашения — только своего; выход снимает членство и будущие назначения', async () => {
    const inv = await pool.query<{ id: string }>(TEAM_SQL.insertInvite, [ids.opA, ids.g2, ids.opAUser]);
    expect((await pool.query(TEAM_SQL.revokeInvite, [inv.rows[0].id, ids.opB])).rows).toHaveLength(0);
    expect((await pool.query(TEAM_SQL.revokeInvite, [inv.rows[0].id, ids.opA])).rows).toHaveLength(1);
    expect((await pool.query(TEAM_SQL.lockPendingInviteForGuide, [inv.rows[0].id, ids.g2])).rows).toHaveLength(0);

    expect((await pool.query(TEAM_SQL.clearMembership, [ids.g1, ids.opB])).rows).toHaveLength(0);
    expect((await pool.query(TEAM_SQL.clearMembership, [ids.g1, ids.opA])).rows).toHaveLength(1);
    await pool.query(TEAM_SQL.closeAcceptedInvites, [ids.g1, ids.opA, 'left']);
    await pool.query(TEAM_SQL.unassignFutureBookings, [ids.g1, ids.opA]);

    expect((await pool.query(TEAM_SQL.assignedUpcoming, [ids.g1])).rows).toHaveLength(0);
    expect((await pool.query(SCHEDULE_SQL.bookingAssignedToGuide, [ids.bookingA, ids.g1])).rows).toHaveLength(0);
    const st = await pool.query<{ status: string }>(`SELECT status FROM guide_operator_invites WHERE id = $1`, [ids.inviteA1]);
    expect(st.rows[0].status).toBe('left');
    const b = await pool.query<{ guide_partner_id: string | null }>(
      `SELECT guide_partner_id FROM operator_bookings WHERE id = $1::bigint`, [ids.bookingA],
    );
    expect(b.rows[0].guide_partner_id).toBeNull();
  });
});

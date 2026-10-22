/**
 * Общая запись дат тура (lib/tours/availability-open.ts) — на настоящем
 * PostgreSQL (22.10, «Открой даты словами», этап B).
 *
 * Мок ответил бы на любой SQL, а здесь всё решает сервер:
 *   - занятость по БРОНЯМ, а не по счётчику `booked_slots` (он растёт только
 *     при оплате, а оплата выключена с 05.10): бронь на дате без строки
 *     календаря и середина многодневной брони;
 *   - порядок с гейтом брони: запись дат берёт `FOR NO KEY UPDATE` на строке
 *     тура, гейт — `FOR UPDATE`; бронь, начатая раньше, видна записи, а бронь,
 *     начатая позже, ждёт и видит новые места. Это проверяется настоящими
 *     двумя соединениями и ожиданием блокировки в `pg_stat_activity`;
 *   - повтор, в том числе одновременный: одна запись, второй видит «уже
 *     открыта»;
 *   - владение и удаление тура; скрытый тур (кабинет пишет, чат и помощник —
 *     отказ «скрыт», а не «не найден»); сезон; прошедшие и дальние даты, и
 *     горизонт — тем же днём через год, что у витрины (високосный год);
 *     закрытые даты (кабинет открывает, чат и помощник — нет), в том числе
 *     закрытые ДРУГИМ писателем без блокировки тура между чтением и записью;
 *     цена даты без права цен; снятие `deleted_at`, причины и
 *     `is_cancelled IS NULL`;
 *   - помощник кабинета (`OperatorAgency.addSlots`) целиком, через настоящее
 *     ядро: без числа мест — вопрос и ни одной записи, умолчания 10 нет.
 *
 * Своя база `tour_dates_open_test` — копия шаблона схемы (baseline +
 * миграции). Запуск ТРЕБУЕТ базы: KERNEL_PG_TEST_URL=postgresql://user:pass@host/db.
 * Без неё файл честно пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createTestDatabase, dropTestDatabase } from '../helpers/pg-schema';

const { operatorA, operatorB } = vi.hoisted(() => ({
  operatorA: 'd0e10000-0000-4000-8000-00000000000a',
  operatorB: 'd0e10000-0000-4000-8000-00000000000b',
}));

// Кабинет помощника — оператор A (вход и права команды здесь не предмет).
vi.mock('@/lib/operators/team-access', async (orig) => ({
  ...(await orig<typeof import('@/lib/operators/team-access')>()),
  operatorAccess: vi.fn(async () => ({ kind: 'owner', partnerId: operatorA })),
}));

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[tour-dates-open.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'tour_dates_open_test';
/** «Сегодня» для проверок прошлого, горизонта и сезона — фиксированное. */
const TODAY = '2026-10-22';

withPg('общая запись дат тура на настоящем PostgreSQL', () => {
  let pool: import('pg').Pool;
  let mod: typeof import('@/lib/tours/availability-open');
  const tour: Record<'plain' | 'season' | 'multi' | 'foreign' | 'off' | 'deleted' | 'lock' | 'agent', string> = {
    plain: '', season: '', multi: '', foreign: '', off: '', deleted: '', lock: '', agent: '',
  };

  interface DateRow {
    date: string; slots: number; booked: number; price: string | null;
    is_cancelled: boolean | null; reason: string | null; deleted: boolean; updated_at: string;
  }
  async function row(tourId: string, date: string): Promise<DateRow | undefined> {
    const r = await pool.query<DateRow>(
      `SELECT date::text AS date, available_slots AS slots, booked_slots AS booked,
              base_price_override::text AS price, is_cancelled, cancellation_reason AS reason,
              (deleted_at IS NOT NULL) AS deleted, updated_at::text AS updated_at
         FROM tour_availability WHERE operator_tour_id = $1 AND date = $2::date`,
      [tourId, date],
    );
    return r.rows[0];
  }

  async function addTour(operatorId: string, title: string, extra: Partial<Record<string, unknown>> = {}): Promise<string> {
    const cols = {
      operator_id: operatorId, title, slug: `t-${title.replace(/\W+/g, '-').toLowerCase()}-${Math.random().toString(36).slice(2, 8)}`,
      activity_type: 'hiking', base_price: 5000, price_unit: 'per_person', min_participants: 1, max_participants: 10,
      duration_hours: 8, difficulty: 'easy', is_active: true, is_published: true, ...extra,
    };
    const keys = Object.keys(cols);
    const r = await pool.query<{ id: string }>(
      `INSERT INTO operator_tours (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id::text`,
      Object.values(cols),
    );
    return r.rows[0]!.id;
  }

  async function book(tourId: string, start: string, end: string | null, people: number, status = 'new'): Promise<void> {
    await pool.query(
      `INSERT INTO operator_bookings (operator_tour_id, booking_date, end_date, participants, booking_status)
       VALUES ($1, $2::date, $3::date, $4, $5)`,
      [tourId, start, end, people, status],
    );
  }

  /** Ждёт, пока чьё-то соединение встанет на блокировку (или выходит по сроку). */
  async function someoneWaitsOnLock(ms = 3000): Promise<boolean> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const r = await pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      if (Number(r.rows[0]!.n) > 0) return true;
      await new Promise((res) => setTimeout(res, 50));
    }
    return false;
  }

  const chat = (tourId: string, dates: string[], slots: number, today = TODAY) => ({
    operatorId: operatorA, tourId, rows: dates.map((date) => ({ date, slots })),
    mayPrice: false, inactiveTour: 'refuse' as const, skipExisting: true, closedDates: 'keep' as const, today, enforceSeason: true,
  });
  const cabinet = (tourId: string, dates: string[], slots: number, extra: { mayPrice?: boolean; price?: number; skipExisting?: boolean } = {}) => ({
    operatorId: operatorA, tourId, rows: dates.map((date) => ({ date, slots, price: extra.price ?? null })),
    mayPrice: extra.mayPrice ?? false, inactiveTour: 'write' as const, skipExisting: extra.skipExisting ?? false, closedDates: 'reopen' as const,
  });

  beforeAll(async () => {
    const { Pool } = await import('pg');
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 6 });
    // Функция, гейт брони и ядро ходят пулом приложения — ему тот же адрес.
    process.env.DATABASE_URL = dbUrl;
    process.env.DATABASE_SSL = 'false';

    for (const [id, slug] of [[operatorA, 'dates-op-a'], [operatorB, 'dates-op-b']]) {
      await pool.query(
        `INSERT INTO partners (id, name, category, contact, slug, is_public, is_verified, status)
         VALUES ($1, $2, 'operator', '{}'::jsonb, $3, TRUE, TRUE, 'active')`,
        [id, `Оператор ${slug}`, slug],
      );
    }
    tour.plain = await addTour(operatorA, 'Вулкан Горелый');
    tour.season = await addTour(operatorA, 'Летняя рыбалка', { season_start: '2027-05-01', season_end: '2027-09-30' });
    tour.multi = await addTour(operatorA, 'Пять дней', { duration_type: 'multi_day', multi_day_count: 5, duration_hours: 120 });
    tour.foreign = await addTour(operatorB, 'Чужой тур');
    tour.off = await addTour(operatorA, 'Выключенный', { is_active: false });
    tour.deleted = await addTour(operatorA, 'Удалённый');
    await pool.query(`UPDATE operator_tours SET deleted_at = NOW() WHERE id = $1`, [tour.deleted]);
    tour.lock = await addTour(operatorA, 'Блокировка');
    tour.agent = await addTour(operatorA, 'Помощник', { season_start: '2027-05-01', season_end: '2027-09-30' });

    mod = await import('@/lib/tours/availability-open');
  }, 300_000);

  afterAll(async () => {
    const { pool: appPool } = await import('@/lib/db-pool');
    await Promise.resolve(appPool.end()).catch(() => undefined);
    await pool?.end().catch(() => undefined);
    if (PG_URL) await dropTestDatabase(PG_URL, TEST_DB);
  });

  it('занятость — по броням: дата без строки, бронь на 9 при booked_slots = 0, мест 8 — отказ, строки нет', async () => {
    await book(tour.plain, '2027-06-10', null, 9);
    const out = await mod.openTourDates(chat(tour.plain, ['2027-06-10'], 8));
    expect(out).toMatchObject({ ok: true, written: 0, perDate: [{ date: '2027-06-10', result: 'refused_booked', taken: 9 }] });
    expect(await row(tour.plain, '2027-06-10')).toBeUndefined();

    // Отменённая бронь места не держит.
    await book(tour.plain, '2027-06-11', null, 9, 'cancelled');
    const free = await mod.openTourDates(chat(tour.plain, ['2027-06-11'], 8));
    expect(free).toMatchObject({ ok: true, perDate: [{ date: '2027-06-11', result: 'opened' }] });
  });

  it('многодневная бронь занимает свою середину: с 3-го на 5 дней, 5-е при местах меньше записанных — отказ', async () => {
    await book(tour.multi, '2027-08-03', '2027-08-07', 6);
    const out = await mod.openTourDates(cabinet(tour.multi, ['2027-08-05', '2027-08-09'], 4));
    expect(out).toMatchObject({
      ok: true, written: 1,
      perDate: [
        { date: '2027-08-05', result: 'refused_booked', taken: 6 },
        { date: '2027-08-09', result: 'opened' },
      ],
    });
    expect(await row(tour.multi, '2027-08-05')).toBeUndefined();
  });

  it('кабинет не опускает места открытой даты ниже записанных (updated → refused_booked)', async () => {
    await mod.openTourDates(cabinet(tour.plain, ['2027-06-20'], 10));
    await book(tour.plain, '2027-06-20', null, 7);
    const down = await mod.openTourDates(cabinet(tour.plain, ['2027-06-20'], 5));
    expect(down).toMatchObject({ ok: true, written: 0, perDate: [{ result: 'refused_booked', taken: 7 }] });
    expect((await row(tour.plain, '2027-06-20'))!.slots).toBe(10);
    const up = await mod.openTourDates(cabinet(tour.plain, ['2027-06-20'], 7));
    expect(up).toMatchObject({ ok: true, written: 1, perDate: [{ result: 'updated', from: 10 }] });
    expect((await row(tour.plain, '2027-06-20'))!.slots).toBe(7);

    // Счётчик оплаченных тоже занятость: booked_slots 6 при брони меньше.
    await pool.query(`UPDATE tour_availability SET booked_slots = 7 WHERE operator_tour_id = $1 AND date = '2027-06-20'`, [tour.plain]);
    await pool.query(`UPDATE operator_bookings SET booking_status = 'cancelled' WHERE operator_tour_id = $1 AND booking_date = '2027-06-20'`, [tour.plain]);
    const paid = await mod.openTourDates(cabinet(tour.plain, ['2027-06-20'], 6));
    expect(paid).toMatchObject({ ok: true, written: 0, perDate: [{ result: 'refused_booked', taken: 7 }] });
  });

  it('бронь, начатая раньше, видна записи: запись ждёт гейт брони и не открывает дату ниже записанных', async () => {
    const holder = await pool.connect();
    try {
      // Та же блокировка, что берёт reserveBooking, и бронь внутри неё.
      await holder.query('BEGIN');
      await holder.query(`SELECT id FROM operator_tours WHERE id = $1 FOR UPDATE`, [tour.lock]);
      await holder.query(
        `INSERT INTO operator_bookings (operator_tour_id, booking_date, participants, booking_status)
         VALUES ($1, '2027-07-05', 9, 'new')`,
        [tour.lock],
      );
      const pending = mod.openTourDates(chat(tour.lock, ['2027-07-05'], 8));
      expect(await someoneWaitsOnLock(), 'запись дат обязана ждать блокировку гейта брони').toBe(true);
      await holder.query('COMMIT');
      const out = await pending;
      expect(out).toMatchObject({ ok: true, written: 0, perDate: [{ date: '2027-07-05', result: 'refused_booked', taken: 9 }] });
      expect(await row(tour.lock, '2027-07-05')).toBeUndefined();
    } finally {
      holder.release();
    }
  });

  it('бронь, начатая позже, ждёт запись дат и видит новые места', async () => {
    await mod.openTourDates(cabinet(tour.lock, ['2027-07-12'], 2));
    const { reserveBooking } = await import('@/lib/bookings/reserve');
    const writer = await pool.connect();
    try {
      await writer.query('BEGIN');
      const opened = await mod.openTourDatesTx(writer, cabinet(tour.lock, ['2027-07-12'], 8));
      expect(opened).toMatchObject({ ok: true, perDate: [{ result: 'updated', from: 2 }] });
      const reserving = reserveBooking({
        tourId: Number(tour.lock), touristName: 'Проба', touristPhone: '+70000000000',
        participants: 5, date: '2027-07-12', createdVia: 'website',
      });
      expect(await someoneWaitsOnLock(), 'гейт брони обязан ждать запись дат').toBe(true);
      await writer.query('COMMIT');
      const reserved = await reserving;
      expect(Number(reserved.bookingId)).toBeGreaterThan(0);
    } finally {
      writer.release();
    }
  });

  it('повтор: последовательный не пишет второй раз, одновременный — одна запись, второй видит «уже открыта»', async () => {
    const first = await mod.openTourDates(chat(tour.plain, ['2027-06-25'], 6));
    expect(first).toMatchObject({ ok: true, written: 1, perDate: [{ result: 'opened' }] });
    const before = (await row(tour.plain, '2027-06-25'))!.updated_at;
    const again = await mod.openTourDates(chat(tour.plain, ['2027-06-25'], 6));
    expect(again).toMatchObject({ ok: true, written: 0, perDate: [{ result: 'already_open', slots: 6 }] });
    expect((await row(tour.plain, '2027-06-25'))!.updated_at).toBe(before);

    const both = await Promise.all([
      mod.openTourDates(chat(tour.plain, ['2027-06-26'], 6)),
      mod.openTourDates(chat(tour.plain, ['2027-06-26'], 6)),
    ]);
    const kinds = both.map((o) => (o.ok ? o.perDate[0]!.result : o.reason)).sort();
    expect(kinds).toEqual(['already_open', 'opened']);
  });

  it('чужой и удалённый тур — tour_not_found при любых настройках, календарь не тронут', async () => {
    for (const t of [tour.foreign, tour.deleted]) {
      for (const input of [cabinet(t, ['2027-06-01'], 5), chat(t, ['2027-06-01'], 5)]) {
        const out = await mod.openTourDates(input);
        expect(out, t).toEqual({ ok: false, reason: 'tour_not_found' });
      }
      expect(await row(t, '2027-06-01')).toBeUndefined();
    }
  });

  it('скрытый тур: помощник и чат — «скрыт» с названием, а не «не найден»; кабинет пишет, как до 22.10', async () => {
    const refused = await mod.openTourDates(chat(tour.off, ['2027-06-02'], 5));
    expect(refused).toEqual({ ok: false, reason: 'tour_inactive', title: 'Выключенный' });
    expect(await row(tour.off, '2027-06-02')).toBeUndefined();

    // Карточка тура (addAvailability): тур скрыт на межсезонье, даты сезона
    // готовятся заранее. Туристы их не видят — тур скрыт, гейт брони его не берёт.
    const { addAvailability } = await import('@/lib/api/operator-tours');
    const written = await addAvailability(BigInt(tour.off), [{ date: '2027-06-02', available_slots: 8 }], false, operatorA);
    expect(written).toMatchObject({
      ok: true, written: 1, tour: { isActive: false }, perDate: [{ date: '2027-06-02', result: 'opened' }],
    });
    expect(await row(tour.off, '2027-06-02')).toMatchObject({ slots: 8, is_cancelled: false });
    const { reserveBooking } = await import('@/lib/bookings/reserve');
    await expect(reserveBooking({
      tourId: Number(tour.off), touristName: 'Проба', touristPhone: '+70000000000',
      participants: 1, date: '2027-06-02', createdVia: 'website',
    })).rejects.toThrow(/не найден|не доступен/);
  });

  it('сезон: чат вне окна не открывает, кабинет открывает; уже открытую дату окно не трогает', async () => {
    const out = await mod.openTourDates(chat(tour.season, ['2027-07-01', '2027-10-05'], 6));
    expect(out).toMatchObject({
      ok: true, written: 1,
      perDate: [
        { date: '2027-07-01', result: 'opened' },
        { date: '2027-10-05', result: 'refused_season', seasonStart: '2027-05-01', seasonEnd: '2027-09-30', from: '2027-05-01', to: '2027-09-30' },
      ],
    });
    expect(await row(tour.season, '2027-10-05')).toBeUndefined();

    const cab = await mod.openTourDates(cabinet(tour.season, ['2027-10-05'], 6));
    expect(cab).toMatchObject({ ok: true, perDate: [{ result: 'opened' }] });
    const again = await mod.openTourDates(chat(tour.season, ['2027-10-05'], 6));
    expect(again).toMatchObject({ ok: true, perDate: [{ result: 'already_open', slots: 6 }] });
  });

  it('горизонт — тот же день через год, как у витрины: сверка с PostgreSQL, в том числе через 29 февраля', async () => {
    for (const today of ['2026-10-22', '2027-03-01', '2027-02-28', '2028-02-29', '2027-10-22', '2027-12-31']) {
      const pg = await pool.query<{ d: string }>(`SELECT ($1::date + INTERVAL '1 year')::date::text AS d`, [today]);
      expect(mod.horizonLastDate(today), today).toBe(pg.rows[0]!.d);
    }
    // С 1 марта 2027 впереди 29.02.2028: 365 дней кончились бы 29 февраля, а
    // витрина покажет и 1 марта 2028.
    const out = await mod.openTourDates(chat(tour.plain, ['2028-03-01', '2028-03-02'], 4, '2027-03-01'));
    expect(out).toMatchObject({
      ok: true, written: 1,
      perDate: [
        { date: '2028-03-01', result: 'opened' },
        { date: '2028-03-02', result: 'refused_horizon', lastDate: '2028-03-01' },
      ],
    });
  });

  it('прошедшая дата и дальше года — отказ при today; без today кабинету можно', async () => {
    const out = await mod.openTourDates(chat(tour.plain, ['2026-10-21', '2026-10-22', '2027-10-22', '2027-10-23'], 4));
    expect(out).toMatchObject({
      ok: true, written: 2,
      perDate: [
        { date: '2026-10-21', result: 'refused_past' },
        { date: '2026-10-22', result: 'opened' },
        { date: '2027-10-22', result: 'opened' },
        { date: '2027-10-23', result: 'refused_horizon', lastDate: '2027-10-22' },
      ],
    });
    const cab = await mod.openTourDates(cabinet(tour.plain, ['2026-10-21'], 4));
    expect(cab).toMatchObject({ ok: true, perDate: [{ result: 'opened' }] });
  });

  it('цена: открытая дата чатом не тронута и цена её цела; новая — без цены; кабинет без права места меняет, цену нет', async () => {
    await mod.openTourDates(cabinet(tour.plain, ['2027-06-28'], 5, { mayPrice: true, price: 7000 }));
    const before = (await row(tour.plain, '2027-06-28'))!;
    expect(before).toMatchObject({ slots: 5, price: '7000.00' });

    const out = await mod.openTourDates(chat(tour.plain, ['2027-06-28', '2027-06-29'], 8));
    expect(out).toMatchObject({ ok: true, perDate: [{ result: 'already_open', slots: 5 }, { result: 'opened' }] });
    expect(await row(tour.plain, '2027-06-28')).toMatchObject({ slots: 5, price: '7000.00', updated_at: before.updated_at });
    expect(await row(tour.plain, '2027-06-29')).toMatchObject({ slots: 8, price: null });

    await mod.openTourDates(cabinet(tour.plain, ['2027-06-28'], 9));
    expect(await row(tour.plain, '2027-06-28')).toMatchObject({ slots: 9, price: '7000.00' });

    // Цена без права — ошибка вызывающего до базы, а не «база не ответила».
    await expect(mod.openTourDates({ ...chat(tour.plain, ['2027-06-30'], 8), rows: [{ date: '2027-06-30', slots: 8, price: 100 }] }))
      .rejects.toThrow(/без права цен/);
  });

  it('закрытая дата: чат не открывает (причина в ответе), кабинет открывает снова и снимает причину', async () => {
    await pool.query(
      `INSERT INTO tour_availability (operator_tour_id, date, available_slots, is_cancelled, cancellation_reason)
       VALUES ($1, '2027-07-20', 0, TRUE, 'Шторм')`,
      [tour.plain],
    );
    const out = await mod.openTourDates(chat(tour.plain, ['2027-07-20'], 6));
    expect(out).toMatchObject({ ok: true, written: 0, perDate: [{ result: 'refused_closed', reason: 'Шторм' }] });
    expect(await row(tour.plain, '2027-07-20')).toMatchObject({ is_cancelled: true, reason: 'Шторм', slots: 0 });

    const cab = await mod.openTourDates(cabinet(tour.plain, ['2027-07-20'], 6));
    expect(cab).toMatchObject({ ok: true, perDate: [{ result: 'reopened', reason: 'Шторм' }] });
    expect(await row(tour.plain, '2027-07-20')).toMatchObject({ is_cancelled: false, reason: null, slots: 6, deleted: false });
  });

  it('дату закрыл писатель без блокировки тура (SQL роута block) между чтением и записью — чат её не открывает', async () => {
    // Закрытие легло раньше нашей записи, но не зафиксировано: чтение
    // состояния его не видит (строки «нет»), а upsert ждёт его фиксации.
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query(
        `INSERT INTO tour_availability (operator_tour_id, date, available_slots, is_cancelled, cancellation_reason)
         SELECT $1::bigint, d, 0, true, $3::text FROM unnest($2::date[]) AS d
         ON CONFLICT (operator_tour_id, date) DO UPDATE SET
           is_cancelled = true, cancellation_reason = EXCLUDED.cancellation_reason, updated_at = NOW()`,
        [tour.plain, ['2027-07-15'], 'Шторм'],
      );
      const pending = mod.openTourDates(chat(tour.plain, ['2027-07-15', '2027-07-16'], 6));
      expect(await someoneWaitsOnLock(), 'upsert обязан ждать чужую вставку той же даты').toBe(true);
      await blocker.query('COMMIT');
      const out = await pending;
      expect(out).toMatchObject({
        ok: true, written: 1,
        perDate: [
          { date: '2027-07-15', result: 'refused_closed', reason: 'Шторм' },
          { date: '2027-07-16', result: 'opened' },
        ],
      });
      expect(await row(tour.plain, '2027-07-15')).toMatchObject({ is_cancelled: true, reason: 'Шторм', slots: 0 });
    } finally {
      blocker.release();
    }
  });

  it('дату открыл писатель без блокировки между чтением и записью — чат (skipExisting) её места не переписывает', async () => {
    const other = await pool.connect();
    try {
      await other.query('BEGIN');
      // Форма POST /api/operator/calendar: одна дата, 4 места.
      await other.query(
        `INSERT INTO tour_availability (operator_tour_id, date, available_slots, is_cancelled)
         VALUES ($1, '2027-07-17', 4, FALSE)`,
        [tour.plain],
      );
      const pending = mod.openTourDates(chat(tour.plain, ['2027-07-17'], 6));
      expect(await someoneWaitsOnLock()).toBe(true);
      await other.query('COMMIT');
      const out = await pending;
      expect(out).toMatchObject({ ok: true, written: 0, perDate: [{ date: '2027-07-17', result: 'already_open', slots: 4 }] });
      expect(await row(tour.plain, '2027-07-17')).toMatchObject({ slots: 4 });
    } finally {
      other.release();
    }
  });

  it('снятая строка и строка без отметки (is_cancelled IS NULL) — открываются снова, отметки снимаются', async () => {
    await pool.query(
      `INSERT INTO tour_availability (operator_tour_id, date, available_slots, is_cancelled, deleted_at)
       VALUES ($1, '2027-07-21', 3, FALSE, NOW()), ($1, '2027-07-22', 3, NULL, NULL)`,
      [tour.plain],
    );
    const out = await mod.openTourDates(chat(tour.plain, ['2027-07-21', '2027-07-22'], 6));
    expect(out).toMatchObject({
      ok: true, written: 2,
      perDate: [{ result: 'reopened', reason: null }, { result: 'reopened', reason: null }],
    });
    expect(await row(tour.plain, '2027-07-21')).toMatchObject({ deleted: false, is_cancelled: false, slots: 6 });
    expect(await row(tour.plain, '2027-07-22')).toMatchObject({ is_cancelled: false, slots: 6 });
  });

  it('помощник кабинета: без числа мест — вопрос и ни одной записи; с числом — правила чата и исход каждой даты', async () => {
    const { OperatorAgency } = await import('@/lib/agents/agencies/operator-agency');
    const ctx = {
      user: { userId: 'd0e10000-0000-4000-8000-0000000000aa', role: 'operator' },
      task: {}, platform: { routesCount: 0, activeOperators: 0, toursCount: 0 },
      execution: { agentName: 't', startedAt: new Date() },
    } as unknown as Parameters<InstanceType<typeof OperatorAgency>['addSlots']>[0];
    const tasks = async () => Number((await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM agent_tasks WHERE capability = 'tour.add_slots'`)).rows[0]!.n);

    const asked = await new OperatorAgency().addSlots(ctx, `добавь слоты туру ${tour.agent} с 2027-09-28 по 2027-10-02`);
    expect(asked.response).toMatch(/Сколько мест/);
    expect(await tasks()).toBe(0);
    expect(await row(tour.agent, '2027-09-28')).toBeUndefined();

    await pool.query(
      `INSERT INTO tour_availability (operator_tour_id, date, available_slots, is_cancelled, cancellation_reason)
       VALUES ($1, '2027-09-29', 0, TRUE, 'Шторм'), ($1, '2027-09-30', 4, FALSE, NULL)`,
      [tour.agent],
    );
    // «Сегодня» помощник берёт по Камчатке от часов процесса — часы фиксируются,
    // чтобы тест не протух вместе с сезоном 2027 года.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(`${TODAY}T00:00:00Z`));
    try {
      const res = await new OperatorAgency().addSlots(ctx, `добавь слоты туру ${tour.agent} с 2027-09-28 по 2027-10-02, 6 мест`);
      const perDate = (res.data as { perDate: Array<{ date: string; result: string }> }).perDate;
      expect(perDate.map((r) => [r.date, r.result])).toEqual([
        ['2027-09-28', 'opened'],
        ['2027-09-29', 'refused_closed'],
        ['2027-09-30', 'already_open'],
        ['2027-10-01', 'refused_season'],
        ['2027-10-02', 'refused_season'],
      ]);
      expect(res.response).toMatch(/Открыто \(1\)/);
      expect(res.response).toMatch(/закрыли вы.*«Шторм»/);
      expect(res.response).toMatch(/вне сезона тура/);
    } finally {
      vi.useRealTimers();
    }
    expect(await row(tour.agent, '2027-09-28')).toMatchObject({ slots: 6, price: null });
    expect(await row(tour.agent, '2027-09-29')).toMatchObject({ is_cancelled: true, reason: 'Шторм' });
    expect(await row(tour.agent, '2027-09-30')).toMatchObject({ slots: 4 });
    expect(await tasks()).toBe(1);

    // Скрытый тур: помощник называет причину, а не «не найден», и не пишет.
    const hidden = await new OperatorAgency().addSlots(ctx, `открой даты туру ${tour.off} 2027-06-03, 6 мест`);
    expect(hidden.response).toMatch(/Тур «Выключенный» скрыт/);
    expect(hidden.response).toMatch(/Ничего не открыто/);
    expect(await row(tour.off, '2027-06-03')).toBeUndefined();
  });
});

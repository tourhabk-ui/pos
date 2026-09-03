/**
 * Трансферы: обе гонки — на настоящем PostgreSQL.
 *
 * Мокнутая база доказала бы форму вызовов, но не то, ради чего схема так и
 * устроена: что ДВЕ поездки одной машины на день отвергает уникальный индекс, а
 * продажу мест сверх вместимости — блокировка строки. И то, и другое делает
 * сервер, а не наш код, и статикой это не судится (прецедент 42P08 в CLAUDE.md).
 *
 * Обе проверки идут через настоящий конкурентный запуск (`Promise.all`), а не
 * последовательно: гонка, проверенная по очереди, — не гонка.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;

if (!PG_URL) {
  console.warn('[transfers] KERNEL_PG_TEST_URL не задан — тест пропущен (не прогнан, а не зелёный)');
}

if (PG_URL) {
  process.env.DATABASE_URL = PG_URL;
  process.env.DATABASE_SSL = 'false';
}

type Service = typeof import('@/lib/transfers/service');

withPg('трансферы на настоящем PostgreSQL', () => {
  let svc: Service;
  let pool: import('pg').Pool;
  let partnerId: string;
  let otherPartnerId: string;
  let vehicleId: string;

  beforeAll(async () => {
    const { Pool } = await import('pg');
    pool = new Pool({ connectionString: PG_URL, max: 6 });

    // ── Схема собирается НАЧИСТО, и это не гигиена, а условие осмысленности ──
    //
    // Миграция идемпотентна (IF NOT EXISTS), поэтому на базе, где таблицы уже
    // есть, она не делает НИЧЕГО — и тест проверяет схему прошлого прогона, а
    // не тот файл, который лежит в репозитории сейчас. Поймано 01.09 попыткой
    // отнять у теста защиту: убрал уникальность индекса, а тест остался зелёным,
    // потому что в базе жил прежний уникальный индекс. Зелёный без зубов хуже
    // красного: он утверждает то, чего не проверял.
    await pool.query(`
      DROP TABLE IF EXISTS transfer_seat_bookings, transfer_trips, transfer_fleet_vehicles CASCADE`);

    // Минимальное окружение: partners и places нужны как цели внешних ключей.
    // Полный baseline тянуть незачем — проверяем схему 926, а не всю платформу.
    await pool.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS partners (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        name varchar(255) NOT NULL
      )`);
    // Только id: тесту нужен лишь адресат внешнего ключа. Первая версия
    // объявляла ещё и email и вставляла его — и упала на базе, где `users`
    // осталась от чужого прогона без этой колонки. CREATE TABLE IF NOT EXISTS
    // не чинит форму существующей таблицы, поэтому фикстура не должна зависеть
    // от колонок, которые ей не нужны.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4()
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS places (
        -- Как на проде: places.id — TEXT, UUID у места лежит в ark_id (аудит
        -- 28.07). Стенд с uuid здесь пропускал inline-FK, который на проде
        -- падал 31 раз подряд (Watchdog 02.09): проверять надо ту форму,
        -- которая есть у прода, а не удобную.
        id text PRIMARY KEY,
        ark_id uuid DEFAULT uuid_generate_v4(),
        name varchar(255)
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS kamchatka_routes (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        title varchar(255)
      )`);

    await pool.query(readFileSync(join(process.cwd(), 'migrations', '926_transfer_fleet_orders.sql'), 'utf-8'));

    svc = await import('@/lib/transfers/service');
  });

  afterAll(async () => {
    const { pool: appPool } = await import('@/lib/db-pool');
    await appPool.end().catch(() => undefined);
    await pool.end().catch(() => undefined);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE transfer_seat_bookings, transfer_trips, transfer_fleet_vehicles CASCADE');
    await pool.query('TRUNCATE partners CASCADE');
    const p = await pool.query<{ id: string }>(
      `INSERT INTO partners (name) VALUES ('Камчатка-Транс'), ('Чужой перевозчик') RETURNING id`,
    );
    partnerId = p.rows[0]!.id;
    otherPartnerId = p.rows[1]!.id;
    const v = await svc.addVehicle({
      partnerId,
      kind: 'vahtovka',
      title: 'ГАЗ-66 вахтовка',
      seats: 12,
    });
    vehicleId = v.id;
  });

  it('машину нельзя занять двумя поездками в один день — судит индекс, не код', async () => {
    const make = () =>
      svc.createTrip({
        partnerId,
        vehicleId,
        tripDate: '2026-09-20',
        fromText: 'Петропавловск-Камчатский',
        toText: 'Вулкан Горелый',
        seatsTotal: 12,
      });

    // Одновременно, а не по очереди: последовательная проверка не проверяет гонку.
    const [a, b] = await Promise.all([make(), make()]);
    const okCount = [a, b].filter((r) => r.ok).length;
    const taken = [a, b].find((r) => !r.ok && r.code === 'day_taken');

    expect(okCount, 'ровно одна поездка должна пройти').toBe(1);
    expect(taken, 'вторая обязана получить названный исход day_taken, а не 500').toBeTruthy();
    expect(taken && !taken.ok && taken.message).toContain('уже есть поездка');
  });

  it('отменённая поездка освобождает день — индекс частичный', async () => {
    const first = await svc.createTrip({
      partnerId, vehicleId, tripDate: '2026-09-21',
      fromText: 'ПК', toText: 'Горелый', seatsTotal: 12,
    });
    expect(first.ok).toBe(true);
    await pool.query(`UPDATE transfer_trips SET status = 'cancelled' WHERE id = $1`, [
      first.ok ? first.value.id : '',
    ]);

    const second = await svc.createTrip({
      partnerId, vehicleId, tripDate: '2026-09-21',
      fromText: 'ПК', toText: 'Мутновский', seatsTotal: 12,
    });
    expect(second.ok, 'после отмены день снова свободен').toBe(true);
  });

  it('нельзя выставить мест больше, чем в машине', async () => {
    const r = await svc.createTrip({
      partnerId, vehicleId, tripDate: '2026-09-22',
      fromText: 'ПК', toText: 'Горелый', seatsTotal: 20,
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe('seats_over_capacity');
    // Обе цифры в сообщении: иначе непонятно, что менять.
    expect(!r.ok && r.message).toContain('12');
    expect(!r.ok && r.message).toContain('20');
  });

  it('места сверх остатка не продаются даже при одновременном подтверждении', async () => {
    const trip = await svc.createTrip({
      partnerId, vehicleId, tripDate: '2026-09-23',
      fromText: 'ПК', toText: 'Горелый', seatsTotal: 10, pricePerSeat: 5000, isPublished: true,
    });
    expect(trip.ok).toBe(true);
    const tripId = trip.ok ? trip.value.id : '';

    // Две заявки, вместе больше вместимости: 6 + 6 при десяти местах.
    const r1 = await svc.requestSeats({ tripId, orderedByPartnerId: otherPartnerId, seats: 6 });
    const r2 = await svc.requestSeats({ tripId, orderedByPartnerId: otherPartnerId, seats: 6 });
    expect(r1.ok && r2.ok).toBe(true);

    const [c1, c2] = await Promise.all([
      svc.confirmSeats({ bookingId: r1.ok ? r1.value.id : '', partnerId, price: 30000 }),
      svc.confirmSeats({ bookingId: r2.ok ? r2.value.id : '', partnerId, price: 30000 }),
    ]);

    const confirmed = [c1, c2].filter((r) => r.ok).length;
    const refused = [c1, c2].find((r) => !r.ok && r.code === 'not_enough_seats');

    expect(confirmed, 'подтвердиться должна ровно одна заявка из двух').toBe(1);
    expect(refused, 'вторая — названный отказ «не хватает мест», а не сбой').toBeTruthy();

    // И база это подтверждает: занято не больше выставленного.
    const { rows } = await pool.query<{ taken: string }>(
      `SELECT COALESCE(SUM(seats), 0)::text AS taken
         FROM transfer_seat_bookings WHERE trip_id = $1 AND status = 'confirmed'`,
      [tripId],
    );
    expect(parseInt(rows[0]!.taken, 10)).toBeLessThanOrEqual(10);
  });

  it('витрина показывает честный остаток мест, а запросы его не съедают', async () => {
    const trip = await svc.createTrip({
      partnerId, vehicleId, tripDate: '2026-09-24',
      fromText: 'ПК', toText: 'Горелый', seatsTotal: 10, pricePerSeat: 5000, isPublished: true,
    });
    const tripId = trip.ok ? trip.value.id : '';

    const req = await svc.requestSeats({ tripId, orderedByPartnerId: otherPartnerId, seats: 4 });
    let shown = await svc.listPublishedTrips({ fromDate: '2026-09-01', toDate: '2026-09-30' });
    expect(shown).toHaveLength(1);
    // Незакрытая заявка НЕ держит места: иначе забытый запрос выключил бы
    // витрину, и вахтовка ехала бы полупустой при живом спросе.
    expect(shown[0]!.seats_free, 'запрос мест не занимает').toBe(10);

    await svc.confirmSeats({ bookingId: req.ok ? req.value.id : '', partnerId, price: 20000 });
    shown = await svc.listPublishedTrips({ fromDate: '2026-09-01', toDate: '2026-09-30' });
    expect(shown[0]!.seats_taken).toBe(4);
    expect(shown[0]!.seats_free, 'подтверждение — занимает').toBe(6);

    // Фильтр по числу мест отсекает то, куда группа не влезет.
    const forSeven = await svc.listPublishedTrips({
      fromDate: '2026-09-01', toDate: '2026-09-30', minSeats: 7,
    });
    expect(forSeven).toHaveLength(0);
  });

  it('неопубликованная поездка в витрину не попадает', async () => {
    await svc.createTrip({
      partnerId, vehicleId, tripDate: '2026-09-25',
      fromText: 'ПК', toText: 'Горелый', seatsTotal: 10,
    });
    const shown = await svc.listPublishedTrips({ fromDate: '2026-09-01', toDate: '2026-09-30' });
    // Свободное место и готовность взять попутчика — разные вещи.
    expect(shown).toHaveLength(0);
  });

  it('чужой перевозчик не подтверждает и не отклоняет чужие места', async () => {
    const trip = await svc.createTrip({
      partnerId, vehicleId, tripDate: '2026-09-26',
      fromText: 'ПК', toText: 'Горелый', seatsTotal: 10, isPublished: true,
    });
    const req = await svc.requestSeats({
      tripId: trip.ok ? trip.value.id : '', orderedByUserId: null,
      orderedByPartnerId: otherPartnerId, seats: 2,
    });
    const bookingId = req.ok ? req.value.id : '';

    const c = await svc.confirmSeats({ bookingId, partnerId: otherPartnerId });
    expect(c.ok).toBe(false);
    expect(!c.ok && c.code).toBe('not_your_vehicle');

    const d = await svc.declineSeats({ bookingId, partnerId: otherPartnerId, reason: 'нет' });
    expect(d.ok).toBe(false);
    expect(!d.ok && d.code).toBe('not_your_vehicle');
  });

  it('повторная обработка заявки называет её текущий статус, а не «не получилось»', async () => {
    const trip = await svc.createTrip({
      partnerId, vehicleId, tripDate: '2026-09-27',
      fromText: 'ПК', toText: 'Горелый', seatsTotal: 10, isPublished: true,
    });
    const req = await svc.requestSeats({
      tripId: trip.ok ? trip.value.id : '', orderedByPartnerId: otherPartnerId, seats: 2,
    });
    const bookingId = req.ok ? req.value.id : '';

    await svc.declineSeats({ bookingId, partnerId, reason: 'машина в ремонте' });
    const again = await svc.confirmSeats({ bookingId, partnerId });

    expect(again.ok).toBe(false);
    expect(!again.ok && again.code).toBe('wrong_status');
    expect(!again.ok && again.message).toContain('declined');
  });

  it('заказчик обязан быть ровно один — это держит база', async () => {
    const trip = await svc.createTrip({
      partnerId, vehicleId, tripDate: '2026-09-28',
      fromText: 'ПК', toText: 'Горелый', seatsTotal: 10,
    });
    const tripId = trip.ok ? trip.value.id : '';

    // Ни одного заказчика.
    await expect(
      pool.query(`INSERT INTO transfer_seat_bookings (trip_id, seats) VALUES ($1, 2)`, [tripId]),
    ).rejects.toThrow(/one_customer/);

    // Два сразу.
    const u = await pool.query<{ id: string }>(`INSERT INTO users DEFAULT VALUES RETURNING id`);
    await expect(
      pool.query(
        `INSERT INTO transfer_seat_bookings (trip_id, seats, ordered_by_partner_id, ordered_by_user_id)
         VALUES ($1, 2, $2, $3)`,
        [tripId, otherPartnerId, u.rows[0]!.id],
      ),
    ).rejects.toThrow(/one_customer/);
  });

  it('цена места допускает «не назначена», но не ноль', async () => {
    const trip = await svc.createTrip({
      partnerId, vehicleId, tripDate: '2026-09-29',
      fromText: 'ПК', toText: 'Горелый', seatsTotal: 10,
    });
    // NULL — законное состояние: поездка ушла под одну группу, поштучно не продаётся.
    expect(trip.ok && trip.value.price_per_seat).toBeNull();

    // Ноль — враньё о бесплатном месте, и его отвергает CHECK.
    await expect(
      pool.query(
        `INSERT INTO transfer_trips (vehicle_id, trip_date, from_text, to_text, seats_total, price_per_seat)
         VALUES ($1, '2026-10-01', 'ПК', 'Горелый', 10, 0)`,
        [vehicleId],
      ),
    ).rejects.toThrow();
  });
});

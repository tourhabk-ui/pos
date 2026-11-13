/**
 * Обстановка на день выезда на настоящем PostgreSQL (#2969).
 *
 * Мок ответил бы на любой SQL; здесь судит база:
 *  - выезды: брони new/confirmed/pending_payment и живые заявки с датой и
 *    туром в source_data; отменённые брони, своя заявка, «lost» — мимо;
 *    координаты — тура, иначе главного места; зона — места;
 *  - туристы послезавтра: бронь с чатом бота, бронь без канала, заявка с
 *    MAX гостя;
 *  - запись обстановки и чтение для «Сегодня» (повторная запись — обновление);
 *  - журнал и последний отправленный отпечаток;
 *  - выезды «Сегодня» оператора несут id тура.
 *
 * Своя база `trip_situation_test`. Запуск ТРЕБУЕТ KERNEL_PG_TEST_URL; без неё
 * файл честно пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase, dropTestDatabase } from '../helpers/pg-schema';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[trip-situation.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}
const TEST_DB = 'trip_situation_test';
const D1 = '2099-11-04';
const D2 = '2099-11-05';

withPg('обстановка на день выезда — SQL', () => {
  let pool: import('pg').Pool;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const { Pool } = await import('pg');
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 2 });
    process.env.DATABASE_URL = dbUrl;
    process.env.DATABASE_SSL = 'false';

    ids.user = (await pool.query<{ id: string }>(
      `INSERT INTO users (email, name, password_hash, role, telegram_id) VALUES ('op@test', 'op', 'x', 'operator', 9001) RETURNING id`,
    )).rows[0].id;
    ids.tourist = (await pool.query<{ id: string }>(
      `INSERT INTO users (email, name, password_hash, role, telegram_id) VALUES ('t@test', 't', 'x', 'tourist', 7007) RETURNING id`,
    )).rows[0].id;
    ids.operator = (await pool.query<{ id: string }>(
      `INSERT INTO partners (name, category, contact, user_id, profile_status) VALUES ('Оператор', 'operator', '{}', $1, 'approved') RETURNING id`, [ids.user],
    )).rows[0].id;
    ids.place = (await pool.query<{ id: string }>(
      `INSERT INTO places (id, name, lat, lng, ark_id, location_type, zone, is_visible)
       VALUES (gen_random_uuid(), 'Авачинский', 53.25, 158.83, gen_random_uuid(), 'volcano', 'avachinsky', TRUE) RETURNING id::text`,
    )).rows[0].id;
    const tour = async (title: string, place: string | null) => (await pool.query<{ id: string }>(
      `INSERT INTO operator_tours (operator_id, title, base_price, max_participants, is_active, is_published, activity_type, duration_hours, main_place_id)
       VALUES ($1, $2, 10000, 10, TRUE, TRUE, 'hiking', 6, $3::uuid) RETURNING id::text`, [ids.operator, title, place],
    )).rows[0].id;
    ids.tourA = await tour('Авачинский', ids.place);
    ids.tourB = await tour('Без места', null);
    const booking = async (tourId: string, date: string, status: string, meta: Record<string, unknown> | null, userId: string | null) => (await pool.query<{ id: string }>(
      `INSERT INTO operator_bookings (operator_tour_id, booking_date, participants, booking_status, final_price, tourist_name, tourist_email, metadata, user_id)
       VALUES ($1::bigint, $2::date, 2, $3, 20000, 'Турист', 'x@test', $4::jsonb, $5::uuid) RETURNING id::text`,
      [tourId, date, status, meta ? JSON.stringify(meta) : null, userId],
    )).rows[0].id;
    ids.bBot = await booking(ids.tourA, D2, 'confirmed', { tg_chat_id: 555, platform: 'max' }, null);
    ids.bAccount = await booking(ids.tourA, D2, 'new', null, ids.tourist);
    ids.bCancelled = await booking(ids.tourA, D2, 'cancelled', { tg_chat_id: 556 }, null);
    ids.bTomorrow = await booking(ids.tourB, D1, 'confirmed', null, null);
    const lead = async (status: string, sd: Record<string, unknown>, isSelf: boolean, guest: number | null) => (await pool.query<{ id: string }>(
      `INSERT INTO leads (name, phone, comment, status, operator_id, source_data, is_self, guest_max_chat_id)
       VALUES ('Анна', '+79990001122', 'заявка', $1, $2::uuid, $3::jsonb, $4, $5) RETURNING id::text`,
      [status, ids.operator, JSON.stringify(sd), isSelf, guest],
    )).rows[0].id;
    ids.lLive = await lead('new', { tool: 'create_booking_request', tour_id: Number(ids.tourA), date: D2 }, false, 8008);
    ids.lLost = await lead('lost', { tour_id: Number(ids.tourA), date: D2 }, false, 8009);
    // Заявку отменил клиент (1427): ни в счёт выезда, ни в рассылку обстановки она не идёт.
    ids.lCancelled = await lead('cancelled', { tool: 'create_booking_request', tour_id: Number(ids.tourA), date: D2 }, false, 8011);
    ids.lSelf = await lead('new', { tour_id: Number(ids.tourA), date: D2 }, true, 8010);
  }, 240_000);

  afterAll(async () => {
    const { pool: appPool } = await import('@/lib/db-pool');
    await Promise.resolve(appPool.end()).catch(() => undefined);
    await pool?.end().catch(() => undefined);
    await dropTestDatabase(PG_URL, TEST_DB);
  });

  it('выезды завтра и послезавтра: брони и живые заявки, координаты и зона места', async () => {
    const { loadDepartingTours } = await import('@/lib/trips/situation-store');
    const tours = await loadDepartingTours([D1, D2]);
    expect(tours.map((t) => [t.tourId, t.date, t.travellers])).toEqual([
      [Number(ids.tourB), D1, 1],
      [Number(ids.tourA), D2, 3], // две брони и одна живая заявка; отменённая бронь, «lost», отменённая клиентом и своя — мимо
    ]);
    const a = tours.find((t) => t.tourId === Number(ids.tourA))!;
    expect(a).toMatchObject({ lat: 53.25, lng: 158.83, zone: 'avachinsky', operatorId: ids.operator });
    expect(tours.find((t) => t.tourId === Number(ids.tourB))).toMatchObject({ lat: null, lng: null, zone: null });
  });

  it('туристы послезавтра: чат бота, аккаунт с Telegram, MAX гостя заявки', async () => {
    const { loadTouristRecipients } = await import('@/lib/trips/situation-store');
    const r = await loadTouristRecipients(D2);
    const by = new Map(r.map((x) => [x.ref, x]));
    expect(by.get(ids.bBot)).toMatchObject({ kind: 'tourist_booking', channel: 'max', chatId: '555' });
    expect(by.get(ids.bAccount)).toMatchObject({ kind: 'tourist_booking', channel: 'telegram', chatId: '7007' });
    expect(by.get(ids.lLive)).toMatchObject({ kind: 'tourist_lead', channel: 'max', chatId: '8008' });
    expect(by.has(ids.bCancelled)).toBe(false);
    expect(by.has(ids.lLost)).toBe(false);
    expect(by.has(ids.lCancelled)).toBe(false);
    expect(by.has(ids.lSelf)).toBe(false);
  });

  it('обстановка пишется и читается; повторная запись обновляет строку', async () => {
    const { saveSituation } = await import('@/lib/trips/situation-store');
    const { readStoredSituations } = await import('@/lib/trips/situation-read');
    await saveSituation(Number(ids.tourA), D2, { kind: 'unknown', risks: [], unchecked: ['погоду — сбой'] });
    await saveSituation(Number(ids.tourA), D2, { kind: 'risk', risks: ['погода: ветер до 72 км/ч'], unchecked: [] });
    const got = await readStoredSituations([Number(ids.tourA), Number(ids.tourB)], [D1, D2]);
    expect(got).not.toBe('failed');
    expect((got as Array<{ kind: string; line: string; checkedAt: string }>)).toEqual([
      expect.objectContaining({ tourId: Number(ids.tourA), date: D2, kind: 'risk', line: 'есть риски — погода: ветер до 72 км/ч.' }),
    ]);
    expect(Number.isNaN(new Date((got as Array<{ checkedAt: string }>)[0].checkedAt.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00')).getTime())).toBe(false);
  });

  it('журнал и последний отправленный отпечаток', async () => {
    const { logNotice, lastSentFingerprint } = await import('@/lib/trips/situation-store');
    expect(await lastSentFingerprint('tourist_booking', ids.bBot, D2)).toBeNull();
    await logNotice({ kind: 'tourist_booking', ref: ids.bBot, tourId: Number(ids.tourA), date: D2, fingerprint: 'risk|a', outcome: 'sent', channel: 'max' });
    await logNotice({ kind: 'tourist_booking', ref: ids.bBot, tourId: Number(ids.tourA), date: D2, fingerprint: 'risk|b', outcome: 'failed', channel: 'max', reason: 'MAX не принял' });
    expect(await lastSentFingerprint('tourist_booking', ids.bBot, D2)).toBe('risk|a');
    await expect(logNotice({ kind: 'operator', ref: 'x', tourId: 1, date: D2, fingerprint: 'f', outcome: 'bogus' as never })).rejects.toThrow();
  });

  it('лента предупреждений и оценка зоны читаются на настоящей схеме', async () => {
    const { OFFICIAL_ALERTS_SQL, ZONE_DANGER_SQL, liveSources, situationFor } = await import('@/lib/trips/situation-store');
    await expect(pool.query(OFFICIAL_ALERTS_SQL)).resolves.toBeDefined();
    await expect(pool.query(ZONE_DANGER_SQL, ['avachinsky'])).resolves.toBeDefined();
    // Живые источники без прогноза (координат нет): погода «не проверена», лента и зона прочитаны.
    const s = await situationFor({ tourId: Number(ids.tourB), date: D1, title: 'Без места', operatorId: ids.operator,
      activityType: 'hiking', locationType: null, zone: null, lat: null, lng: null, travellers: 1 }, liveSources());
    expect(s).toEqual({ kind: 'unknown', risks: [], unchecked: ['погоду — у тура не записаны координаты'] });
  });

  it('где тур: координаты и зона — тем же правилом, что у выездов; тура нет — null (2в)', async () => {
    const { loadTourSite } = await import('@/lib/trips/situation-store');
    expect(await loadTourSite(Number(ids.tourA))).toEqual({
      tourId: Number(ids.tourA), title: 'Авачинский', operatorId: ids.operator, activityType: 'hiking', locationType: null,
      zone: 'avachinsky', lat: 53.25, lng: 158.83,
    });
    expect(await loadTourSite(Number(ids.tourB))).toMatchObject({ zone: null, lat: null, lng: null });
    expect(await loadTourSite(987654321)).toBeNull();
  });

  it('проверка дат после отказа по погоде: место, предупреждения по месту, лента и оценка зоны читаются с настоящей схемы (2в)', async () => {
    const { checkTourDates } = await import('@/lib/trips/date-check');
    const { liveSources } = await import('@/lib/trips/situation-store');
    const { loadTourPlaceAlerts } = await import('@/lib/trips/tour-place-alerts');
    // «Сейчас» — утро D1 по Камчатке: прогноз покрывает D1…D1+4.
    const now = () => Date.parse('2099-11-03T20:00:00Z');
    const D3 = '2099-11-06';
    const FAR = '2099-12-01';
    // Прогноз — подставной (сети в тесте нет): D1 — ветер 95 км/ч, дальше спокойно.
    // Тур, статус места, предупреждения по месту, общая лента и оценка зоны — из базы.
    const day = (date: string, windKmh: number) => ({ date, tempMax: null, tempMin: null, precipMm: null, windKmh, weatherCode: 3, description: 'облачно' });
    const windy = async () => ({ ok: true as const, days: [day(D1, 95), day(D2, 10), day(D3, 12)] });
    const still = async () => ({ ok: true as const, days: [day(D1, 10), day(D2, 10), day(D3, 12)] });
    const low = async () => ({ name: 'Авачинско-Петропавловский', level: 'low' as const });
    // Источники каждый раз новые: liveSources запоминает ленту на один прогон.
    const src = (over: { forecast?: typeof windy; zone?: typeof low | null } = {}) => {
      const live = liveSources();
      return { ...live, forecast: over.forecast ?? windy, ...(over.zone === null ? {} : { zone: over.zone ?? low }) };
    };
    const check = (tour: string, sources = src()) => checkTourDates(Number(tour), D1, [D2, D3, FAR], { sources, now });
    const CLEAR = { state: 'confirmed', risks: ['погода: ветер до 95 км/ч'], clear: [D2, D3], risk: 0, unchecked: 0, beyond: 1, place: 'Авачинский', zoneAssessed: true };

    // Статус главного места не рассчитан. Ветер на дату отказа известен — причина названа,
    // но ни одна свободная дата не проверена; при спокойном прогнозе — «не проверено».
    expect(await check(ids.tourA)).toEqual({ ...CLEAR, clear: [], unchecked: 2 });
    expect(await check(ids.tourA, src({ forecast: still }))).toEqual({ state: 'unchecked', why: ['статус главного места не рассчитан'] });

    const ark = (await pool.query<{ ark_id: string }>(`SELECT ark_id::text FROM places WHERE id::text = $1`, [ids.place])).rows[0].ark_id;
    await pool.query(
      `INSERT INTO location_real_time_status (agent_route_id, is_open, recommender_status, updated_at)
       VALUES ($1::uuid, TRUE, 'green', '2099-11-03 19:30:00')`, [ark],
    );
    // Зелёный свежий статус; на дату отказа прогноз называет ветер — причина видна, соседние даты проверены.
    expect(await check(ids.tourA)).toEqual(CLEAR);
    // Предупреждений по месту нет — и это прочитано, а не «не знаю»: зона места записана.
    expect(await loadTourPlaceAlerts(Number(ids.tourA))).toEqual({ zone: 'avachinsky', alerts: [] });
    expect(await loadTourPlaceAlerts(Number(ids.tourB))).toBeNull();

    // Оценка зоны — из базы: действующей строки нет, значит оценка не проверена, а не «опасности нет».
    expect(await check(ids.tourA, src({ zone: null }))).toEqual({ ...CLEAR, clear: [], unchecked: 2 });
    expect(await check(ids.tourA, src({ zone: null, forecast: still }))).toEqual({ state: 'unchecked', why: ['у зоны нет действующей оценки опасности'] });
    // Действующая оценка (вьюха v_current_danger судит срок по часам базы): низкая — не препятствие…
    const { rows: [da] } = await pool.query<{ id: string }>(
      `INSERT INTO danger_assessments (zone, expires_at, risk_score, risk_level, analysis_text)
       VALUES ('avachinsky', NOW() + INTERVAL '1 hour', 10, 'low', 'тест 2в') RETURNING id::text`,
    );
    expect(await check(ids.tourA, src({ zone: null }))).toEqual(CLEAR);
    // …высокая — «сейчас», отдельным исходом: о дате через три дня она не говорит.
    await pool.query(`UPDATE danger_assessments SET risk_level = 'high', risk_score = 80 WHERE id = $1::bigint`, [da.id]);
    expect(await check(ids.tourA, src({ zone: null }))).toEqual({ state: 'zone_risk', zone: 'Авачинско-Петропавловский', level: 'high' });
    await pool.query(`DELETE FROM danger_assessments WHERE id = $1::bigint`, [da.id]);

    // ── Предупреждения по главному месту: тем же предикатом, что красит статус места ──
    const addAlert = async (ext: string, cols: Record<string, unknown>) => {
      const row = { alert_type: 'weather', severity: 2, title: ext, affected_zones: '{}', expires_at: '2099-11-20 00:00:00', external_id: `test-2v-${ext}`, ...cols };
      const keys = Object.keys(row);
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO external_alerts (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id::text`,
        Object.values(row),
      );
      return rows[0]!.id;
    };
    const dropAlerts = () => pool.query(`DELETE FROM external_alerts WHERE external_id LIKE 'test-2v-%'`);

    // Жёлтый уровень (severity 1) по зоне места: место он не красит, а в данных Ведара есть.
    // Действует по D2 включительно (D3 по Камчатке начинается 05.11 в 12:00 UTC).
    await addAlert('yellow', { severity: 1, title: 'Жёлтый уровень: сильный ветер', affected_zones: '{avachinsky}', expires_at: '2099-11-05 06:00:00' });
    // Истёкшее штормовое по той же зоне в счёт не идёт.
    await addAlert('old', { title: 'Штормовое предупреждение прошлой недели', affected_zones: '{avachinsky}', expires_at: '2020-01-01 00:00:00' });
    expect((await loadTourPlaceAlerts(Number(ids.tourA)))!.alerts).toEqual([
      expect.objectContaining({ alert_type: 'weather', severity: 1, title: 'Жёлтый уровень: сильный ветер', expires_at: '2099-11-05T06:00:00.000Z' }),
    ]);
    // То же предупреждение, переизданное источником под другим номером с более ранним сроком, — одна строка.
    await addAlert('yellow-again', { severity: 1, title: 'Жёлтый уровень: сильный ветер', affected_zones: '{avachinsky}', expires_at: '2099-11-04 03:00:00' });
    expect((await loadTourPlaceAlerts(Number(ids.tourA)))!.alerts).toEqual([
      expect.objectContaining({ title: 'Жёлтый уровень: сильный ветер', expires_at: '2099-11-05T06:00:00.000Z' }),
    ]);
    // При спокойном прогнозе оно и есть причина на дату отказа; D2 — под ним, D3 — после его срока.
    expect(await check(ids.tourA, src({ forecast: still }))).toEqual({
      ...CLEAR, risks: ['официальное предупреждение: Жёлтый уровень: сильный ветер'], clear: [D3], risk: 1,
    });
    await dropAlerts();

    // Справка уровня 0 по зоне — не предупреждение.
    await addAlert('info', { alert_type: 'info', severity: 0, title: 'Оперативная сводка', affected_zones: '{avachinsky}' });
    expect((await loadTourPlaceAlerts(Number(ids.tourA)))!.alerts).toEqual([]);
    await dropAlerts();

    // Запрет у вулкана той же зоны, привязанный к ДРУГОМУ вулкану за сотню километров, к месту тура
    // не относится: ни причины, ни препятствия. Совпадения зон мало (ревью 2в, третий проход).
    const other = (await pool.query<{ ark: string }>(
      `INSERT INTO places (id, name, lat, lng, ark_id, location_type, zone, is_visible)
       VALUES (gen_random_uuid(), 'Мутновский', 52.45, 158.19, gen_random_uuid(), 'volcano', 'avachinsky', TRUE) RETURNING ark_id::text AS ark`,
    )).rows[0]!.ark;
    await addAlert('ban-other', { alert_type: 'volcanic_eruption', title: 'Вулкан Мутновский: не приближаться', affected_zones: '{avachinsky}', volcano_ark_id: other });
    expect((await loadTourPlaceAlerts(Number(ids.tourA)))!.alerts).toEqual([]);
    expect(await check(ids.tourA)).toEqual(CLEAR);
    expect(await check(ids.tourA, src({ forecast: still }))).toEqual({ state: 'unconfirmed', place: 'Авачинский', zoneAssessed: true });
    // Тот же запрет у вулкана самого тура — относится, и дат под ним нет.
    await addAlert('ban-own', { alert_type: 'volcanic_eruption', title: 'Вулкан Авачинский: не приближаться', affected_zones: '{avachinsky}', volcano_ark_id: ark });
    expect(await check(ids.tourA)).toMatchObject({ state: 'confirmed', clear: [], risk: 2, risks: ['погода: ветер до 95 км/ч', 'официальное предупреждение: Вулкан Авачинский: не приближаться'] });
    await dropAlerts();

    // Дорога уровня 1 в нескольких километрах от места — относится (координатой), дальше радиуса — нет.
    await addAlert('road-near', { alert_type: 'road_closure', severity: 1, title: 'Проезд по пропускам', lat: 53.30, lng: 158.80 });
    await addAlert('road-far', { alert_type: 'road_closure', severity: 1, title: 'Перекрыта дорога на юге', lat: 51.5, lng: 157.0 });
    expect((await loadTourPlaceAlerts(Number(ids.tourA)))!.alerts.map((a) => a.title)).toEqual(['Проезд по пропускам']);
    // Постоянный режим уровня 1 причиной отказа по погоде не называется: при спокойном прогнозе —
    // «причина в данных не отражена»; при ветре причина — ветер, а дни под режимом проверку не проходят.
    // Само предупреждение при этом отдано — человеку его назовут с оговоркой.
    expect(await check(ids.tourA, src({ forecast: still })))
      .toEqual({ state: 'unconfirmed', place: 'Авачинский', zoneAssessed: true, standing: ['Проезд по пропускам'] });
    expect(await check(ids.tourA)).toEqual({ ...CLEAR, clear: [], risk: 2 });
    await dropAlerts();

    // Морская тревога по зоне на горное место не ложится; закрытие парка, в котором места нет, — тоже.
    await addAlert('marine', { title: 'Опасное волнение моря', affected_zones: '{avachinsky}' });
    await addAlert('park', { alert_type: 'park_closure', title: 'Закрыты маршруты парка', affected_parks: '{test-park-2v}' });
    expect((await loadTourPlaceAlerts(Number(ids.tourA)))!.alerts).toEqual([]);
    // И проверку они не гасят: место у обоих установлено.
    expect(await check(ids.tourA)).toEqual(CLEAR);
    // Парк не назван — место не установлено: дни под таким предупреждением не проверены.
    await pool.query(`UPDATE external_alerts SET affected_parks = '{}' WHERE external_id = 'test-2v-park'`);
    expect(await check(ids.tourA)).toEqual({ ...CLEAR, clear: [], unchecked: 2 });
    await dropAlerts();

    // Серьёзное предупреждение без зоны и без привязки — то же: D2 и D3 под ним не «чисто».
    await addAlert('lost', { title: 'Штормовое предупреждение', expires_at: '2099-11-07 00:00:00' });
    expect(await check(ids.tourA)).toEqual({ ...CLEAR, clear: [], unchecked: 2 });
    await dropAlerts();

    // Главное место скрыто с витрины — места у тура нет: предупреждения о нём не читаются.
    await pool.query(`UPDATE places SET is_visible = FALSE WHERE id::text = $1`, [ids.place]);
    expect(await loadTourPlaceAlerts(Number(ids.tourA))).toBeNull();
    expect(await check(ids.tourA)).toEqual({ state: 'no_data', missing: ['place'] });
    await pool.query(`UPDATE places SET is_visible = TRUE WHERE id::text = $1`, [ids.place]);

    // У главного места не записана зона — зональные предупреждения к нему не относятся ни одно:
    // «предупреждений нет» про него сказать нельзя.
    await pool.query(`UPDATE places SET zone = NULL WHERE id::text = $1`, [ids.place]);
    expect(await check(ids.tourA)).toEqual({ state: 'no_data', missing: ['place_zone'] });
    await pool.query(`UPDATE places SET zone = 'avachinsky' WHERE id::text = $1`, [ids.place]);

    // Статус места устарел — пробел «на сейчас»; жёлтый или закрыто человеком — ни одной даты.
    await pool.query(`UPDATE location_real_time_status SET updated_at = '2099-11-03 10:00:00' WHERE agent_route_id = $1::uuid`, [ark]);
    expect(await check(ids.tourA, src({ forecast: still }))).toEqual({ state: 'unchecked', why: ['статус главного места устарел'] });
    await pool.query(`UPDATE location_real_time_status SET updated_at = '2099-11-03 19:30:00', recommender_status = 'yellow' WHERE agent_route_id = $1::uuid`, [ark]);
    expect(await check(ids.tourA)).toEqual({ state: 'place_risk', place: 'Авачинский', level: 'yellow' });
    await pool.query(`UPDATE location_real_time_status SET recommender_status = 'green', is_open = FALSE WHERE agent_route_id = $1::uuid`, [ark]);
    expect(await check(ids.tourA)).toEqual({ state: 'place_risk', place: 'Авачинский', level: 'closed' });
    await pool.query(`DELETE FROM location_real_time_status WHERE agent_route_id = $1::uuid`, [ark]);

    // У тура нет ни места, ни координат — проверять не по чему; тура нет — не проверено.
    expect(await check(ids.tourB)).toEqual({ state: 'no_data', missing: ['coords', 'place'] });
    expect(await check('987654321')).toEqual({ state: 'unchecked', why: ['тур не найден'] });
  });

  it('выезды «Сегодня» оператора несут id тура', async () => {
    const { loadDepartures } = await import('@/lib/operators/live-seats');
    const d = await loadDepartures(ids.operator, [D1, D2]);
    expect(d).not.toBe('failed');
    expect(d as unknown[]).toEqual([
      { date: D1, tourId: Number(ids.tourB), title: 'Без места', people: 2, bookings: 1 },
      { date: D2, tourId: Number(ids.tourA), title: 'Авачинский', people: 2, bookings: 1 },
    ]);
  });
});

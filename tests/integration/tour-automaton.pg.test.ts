/**
 * Автомат предлагает правку тура — на настоящем PostgreSQL.
 *
 * Слово владельца 23.11: «Автоматы (кроны описаний и фото, импортёры) пишут
 * в туры только через очередь проверки, своих обходных путей у них нет».
 *
 * Здесь судится дверь автомата на схеме прода (миграция 1511):
 *  - тур на сайте: описание автомата — черновик с пометкой, витрина прежняя;
 *  - администратор и владелец видят, чьё это предложение;
 *  - поле, которое владелец уже отправил на проверку, автомат не перебивает;
 *  - владелец поменял предложенное — пометка уходит; прислал то же — остаётся;
 *  - отклонённое предложение автомата владельцу не показывается и не
 *    сообщается; одобренное — сообщается: его тур изменился;
 *  - тур, которого туристы не видят, автомат правит как владелец — в строку;
 *  - автомат не просит публикацию и не пишет без карточки тура.
 *
 * Своя база `tour_automaton_test`. Без KERNEL_PG_TEST_URL файл честно
 * пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase, dropTestDatabase } from '../helpers/pg-schema';
import type { TourPatchInput } from '@/lib/tours/tour-write';
import type { AutomatonTourChange, TourChange } from '@/lib/tours/tour-change';

vi.mock('next/cache', () => ({ unstable_cache: (fn: () => unknown) => fn }));
vi.mock('@/lib/auth/middleware', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/middleware')>()),
  requireAdmin: vi.fn(async () => ({ userId: 'c5000000-0000-4000-8000-0000000002ad', role: 'admin' })), // = ADMIN
}));
// Транспорт сообщения владельцу подменён: настоящие чаты из тестов не тревожим.
const sent = vi.hoisted(() => ({ alerts: [] as Array<{ text: string }> }));
vi.mock('@/lib/notifications/pd-alert', () => ({
  sendPdAlert: vi.fn(async (a: { text: string }) => {
    sent.alerts.push(a);
    return { channel: 'max', delivered: true };
  }),
}));
vi.mock('@/lib/seo/indexnow', async (orig) => ({
  ...(await orig<typeof import('@/lib/seo/indexnow')>()),
  pingTourChanged: vi.fn(),
}));

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[tour-automaton.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'tour_automaton_test';
const OP = 'c5000000-0000-4000-8000-000000000101';
const USER = 'c5000000-0000-4000-8000-000000000201';
const ADMIN = 'c5000000-0000-4000-8000-0000000002ad';
const SHORT = 'Короткое описание.';
/** Собранный текст длиннее порога (300 знаков). */
const COMPOSED = `Собранное описание тура. ${'Факт из данных тура. '.repeat(20)}`.trim();
const OWNER_TEXT = `Описание владельца. ${'Сам написал про свой тур. '.repeat(15)}`.trim();

withPg('автомат предлагает правку тура', () => {
  let pool: import('pg').Pool;

  const addTour = async (title: string, o: { published?: boolean; description?: string | null } = {}) => (await pool.query<{ id: string }>(
    `INSERT INTO operator_tours (operator_id, title, description, base_price, price_unit, max_participants, is_active, is_published,
                                 activity_type, duration_hours, photos, tour_image)
     VALUES ($1, $2, $3, 10000, 'person', 8, TRUE, $4, 'hiking', 6, ARRAY['/images/tours/a.jpg'], '/images/tours/a.jpg')
     RETURNING id::text AS id`,
    [OP, title, o.description === undefined ? SHORT : o.description, o.published === true],
  )).rows[0].id;

  const liveOf = async (id: string) => (await pool.query<{ description: string | null; base_price: number; is_published: boolean }>(
    `SELECT description, base_price::float8 AS base_price, is_published FROM operator_tours WHERE id = $1::bigint`, [id],
  )).rows[0];

  const draftOf = async (id: string) => (await pool.query<{ patch: Record<string, unknown>; proposed_by: Record<string, string>; wants_publish: boolean; created_by: string | null }>(
    `SELECT patch, proposed_by, wants_publish, created_by::text AS created_by
       FROM operator_tour_edits WHERE tour_id = $1::bigint AND moderation_status = 'pending'`, [id],
  )).rows[0] ?? null;

  /** Правка автомата: прочитать тур под замком и пройти той же дверью. */
  const propose = async (id: string, input: Record<string, unknown>): Promise<AutomatonTourChange> => {
    const { proposeTourChange, readTourForAutomaton } = await import('@/lib/tours/tour-change');
    const { transaction } = await import('@/lib/database');
    return transaction(async (client) => {
      const tour = await readTourForAutomaton(client, id);
      if (!tour) return { outcome: 'not_found' } as const;
      return proposeTourChange(client, { tourId: id, source: 'tour-describe', input: input as TourPatchInput, tour });
    });
  };

  /** Правка владельца — дверь человека. */
  const ownerSaves = async (id: string, input: Record<string, unknown>): Promise<TourChange> => {
    const { saveTourChange } = await import('@/lib/tours/tour-change');
    const { transaction } = await import('@/lib/database');
    return transaction((client) => saveTourChange(client, {
      tourId: id, ownerId: OP, userId: USER, input: input as TourPatchInput, current: {},
    }));
  };

  const adminGet = async () => {
    const { GET } = await import('@/app/api/admin/moderation/tour-edits/route');
    const res = await GET(new NextRequest('http://localhost/api/admin/moderation/tour-edits'));
    return (await res.json()) as { data: { edits: Array<{ id: string; tourId: string; seen: string; changes: Array<{ field: string; proposedBy?: string }> }> } };
  };
  const adminPost = async (id: string, body: unknown) => {
    const { POST } = await import('@/app/api/admin/moderation/tour-edits/[id]/route');
    const res = await POST(
      new NextRequest(`http://localhost/api/admin/moderation/tour-edits/${id}`, { method: 'POST', body: JSON.stringify(body) }),
      { params: Promise.resolve({ id }) },
    );
    return { status: res.status, body: await res.json() };
  };
  const ownView = async (id: string) => {
    const { loadOwnTourEdits } = await import('@/lib/tours/moderation-store');
    const live = (await pool.query(`SELECT description, base_price FROM operator_tours WHERE id = $1::bigint`, [id])).rows[0];
    const edits = await loadOwnTourEdits([id], new Map([[id, live]]));
    if (edits === null) throw new Error('правки владельца не прочитаны');
    return edits.get(id) ?? null;
  };

  beforeAll(async () => {
    const { Pool } = await import('pg');
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 4 });
    process.env.DATABASE_URL = dbUrl;
    process.env.DATABASE_SSL = 'false';

    await pool.query(`INSERT INTO users (id, email, name, password_hash, role) VALUES
      ($1, 'auto-op@example.test', 'Тест', 'x', 'operator'), ($2, 'auto-admin@example.test', 'Администратор', 'x', 'admin')`, [USER, ADMIN]);
    await pool.query(
      `INSERT INTO partners (id, name, category, contact, profile_status, is_public, is_test, user_id, max_chat_id)
       VALUES ($1, 'Оператор', 'operator', '{}'::jsonb, 'approved', TRUE, FALSE, $2, 555002)`,
      [OP, USER],
    );
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    const { pool: appPool } = await import('@/lib/db-pool');
    await (appPool as unknown as { end?: () => Promise<void> }).end?.();
    await dropTestDatabase(PG_URL, TEST_DB).catch(() => {});
  });

  it('тур на сайте: описание автомата — черновик с пометкой; на витрине прежний текст', async () => {
    const tour = await addTour('Автомат: тур на сайте', { published: true });
    const r = await propose(tour, { description: COMPOSED });
    expect(r.outcome).toBe('pending');
    expect((await liveOf(tour)).description).toBe(SHORT);
    const draft = await draftOf(tour);
    expect(draft.patch).toEqual({ description: COMPOSED });
    expect(draft.proposed_by).toEqual({ description: 'tour-describe' });
    // Человек правку не сохранял: автора-пользователя у черновика нет.
    expect(draft.created_by).toBeNull();

    // Администратор и владелец видят, чьё это предложение.
    const card = (await adminGet()).data.edits.find((e) => e.tourId === tour)!;
    expect(card.changes.map((c) => [c.field, c.proposedBy])).toEqual([['description', 'сборка описания из данных тура']]);
    expect((await ownView(tour))?.pending?.changes.map((c) => [c.field, c.proposedBy]))
      .toEqual([['description', 'сборка описания из данных тура']]);
  });

  it('владелец уже отправил описание на проверку — автомат его не перебивает и черновик не трогает', async () => {
    const tour = await addTour('Автомат: поле владельца', { published: true });
    await ownerSaves(tour, { description: OWNER_TEXT });
    const before = await pool.query(`SELECT updated_at FROM operator_tour_edits WHERE tour_id = $1::bigint`, [tour]);
    const r = await propose(tour, { description: COMPOSED });
    expect(r).toEqual({ outcome: 'kept_owner', fields: ['description'] });
    const draft = await draftOf(tour);
    expect(draft.patch).toEqual({ description: OWNER_TEXT });
    expect(draft.proposed_by).toEqual({});
    const after = await pool.query(`SELECT updated_at FROM operator_tour_edits WHERE tour_id = $1::bigint`, [tour]);
    expect(after.rows[0].updated_at).toEqual(before.rows[0].updated_at);

    // Другое поле того же черновика автомат добавить может: оно ляжет с пометкой, поле владельца — без.
    const mixed = await propose(tour, { description: COMPOSED, pickup_details: 'Забираем от гостиницы' });
    expect(mixed.outcome === 'pending' && mixed.pending.keptOwner).toEqual(['description']);
    const both = await draftOf(tour);
    expect(both.patch).toEqual({ description: OWNER_TEXT, pickup_details: 'Забираем от гостиницы' });
    expect(both.proposed_by).toEqual({ pickup_details: 'tour-describe' });
  });

  it('владелец поменял предложенное — пометка уходит; прислал то же (форма целиком) — остаётся', async () => {
    const tour = await addTour('Автомат: владелец правит предложенное', { published: true });
    await propose(tour, { description: COMPOSED });
    // Форма владельца шлёт себя целиком вместе с правкой на проверке: то же описание и своя цена.
    await ownerSaves(tour, { description: COMPOSED, base_price: 12000 });
    let draft = await draftOf(tour);
    expect(draft.patch).toEqual({ description: COMPOSED, base_price: 12000 });
    expect(draft.proposed_by).toEqual({ description: 'tour-describe' });
    // Правка другого поля пометку не снимает.
    await ownerSaves(tour, { base_price: 13000 });
    expect((await draftOf(tour)).proposed_by).toEqual({ description: 'tour-describe' });
    // Владелец переписал описание: это уже его слово.
    await ownerSaves(tour, { description: OWNER_TEXT });
    draft = await draftOf(tour);
    expect(draft.patch).toEqual({ description: OWNER_TEXT, base_price: 13000 });
    expect(draft.proposed_by).toEqual({});
    // Вернул описание к витрине — поле ушло из черновика вместе с пометкой.
    await propose(tour, { pickup_details: 'Забираем от гостиницы' });
    await ownerSaves(tour, { pickup_details: null });
    expect((await draftOf(tour)).proposed_by).toEqual({});
  });

  it('своё прежнее предложение автомат заменить может', async () => {
    const tour = await addTour('Автомат: замена своего', { published: true });
    await propose(tour, { description: COMPOSED });
    const again = await propose(tour, { description: `${COMPOSED} Дополнено.` });
    expect(again.outcome).toBe('pending');
    const draft = await draftOf(tour);
    expect(draft.patch).toEqual({ description: `${COMPOSED} Дополнено.` });
    expect(draft.proposed_by).toEqual({ description: 'tour-describe' });
  });

  it('отклонённое предложение автомата владельцу не показывается и не сообщается; администратору сказано, что отклонено', async () => {
    const tour = await addTour('Автомат: отказ', { published: true });
    // Раньше владельцу вернули его собственную правку — она и должна остаться на его экране.
    await ownerSaves(tour, { base_price: 9000 });
    const own = (await adminGet()).data.edits.find((e) => e.tourId === tour)!;
    await adminPost(own.id, { action: 'reject', reason: 'Цена ниже себестоимости, уточните.' });
    expect((await ownView(tour))?.rejected?.reason).toBe('Цена ниже себестоимости, уточните.');

    await propose(tour, { description: COMPOSED });
    const card = (await adminGet()).data.edits.find((e) => e.tourId === tour)!;
    sent.alerts.length = 0;
    const r = await adminPost(card.id, { action: 'reject', reason: 'Собранный текст повторяет программу.' });
    expect(r.status).toBe(200);
    expect(r.body.message).toBe('«Автомат: отказ»: предложение автомата отклонено, на сайте прежняя версия');
    expect(sent.alerts).toHaveLength(0);
    expect((await liveOf(tour)).description).toBe(SHORT);
    // На экране владельца — по-прежнему его возвращённая правка, а не отказ автомату.
    const view = await ownView(tour);
    expect(view?.pending).toBeNull();
    expect(view?.rejected?.reason).toBe('Цена ниже себестоимости, уточните.');
    expect(view?.rejected?.fields).toEqual(['base_price']);
  });

  it('одобренное предложение автомата: текст на сайте, владельцу сказано, что тур изменён по предложению платформы', async () => {
    const tour = await addTour('Автомат: одобрение', { published: true });
    await propose(tour, { description: COMPOSED });
    const card = (await adminGet()).data.edits.find((e) => e.tourId === tour)!;
    sent.alerts.length = 0;
    const r = await adminPost(card.id, { action: 'approve', seen: card.seen });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await liveOf(tour)).description).toBe(COMPOSED);
    expect(sent.alerts).toHaveLength(1);
    expect(sent.alerts[0].text).toContain('Тур изменён по предложению платформы');
    expect(sent.alerts[0].text).toContain('платформа предложила правку (описание)');
    expect(sent.alerts[0].text).not.toContain('Правка тура одобрена');
  });

  it('смешанная правка: отказ сообщается владельцу и называет, что предложила платформа', async () => {
    const tour = await addTour('Автомат: смешанная', { published: true });
    await ownerSaves(tour, { base_price: 15000 });
    await propose(tour, { description: COMPOSED });
    const card = (await adminGet()).data.edits.find((e) => e.tourId === tour)!;
    expect(card.changes.map((c) => [c.field, c.proposedBy ?? null])).toEqual([
      ['description', 'сборка описания из данных тура'], ['base_price', null],
    ]);
    sent.alerts.length = 0;
    const r = await adminPost(card.id, { action: 'reject', reason: 'Цена не сходится с программой.' });
    expect(r.body.message).toBe('«Автомат: смешанная»: правка отклонена, на сайте прежняя версия');
    expect(sent.alerts).toHaveLength(1);
    expect(sent.alerts[0].text).toContain('Правка тура отклонена');
    expect(sent.alerts[0].text).toContain('Из этого предложила платформа: описание.');
    // Смешанный отказ владельцу виден: в нём есть его поле.
    expect((await ownView(tour))?.rejected?.fields).toEqual(['description', 'base_price']);
  });

  it('тур, которого туристы не видят: автомат пишет в строку, как владелец; публикацию не просит', async () => {
    const tour = await addTour('Автомат: тур не на сайте');
    const r = await propose(tour, { description: COMPOSED, is_published: true });
    expect(r.outcome).toBe('written');
    const live = await liveOf(tour);
    expect(live.description).toBe(COMPOSED);
    expect(live.is_published).toBe(false);
    expect(await draftOf(tour)).toBeNull();

    // Тур просит публикацию — содержание замерло: дальше автомат идёт черновиком.
    await ownerSaves(tour, { is_published: true });
    const next = await propose(tour, { pickup_details: 'Забираем от гостиницы' });
    expect(next.outcome).toBe('pending');
    const draft = await draftOf(tour);
    expect(draft.wants_publish).toBe(true);
    expect(draft.proposed_by).toEqual({ pickup_details: 'tour-describe' });
    expect((await liveOf(tour)).is_published).toBe(false);
  });

  it('тур просил публикацию и получил поле от автомата: отказ — это отказ владельцу, и он его видит', async () => {
    const tour = await addTour('Автомат: отказ в публикации');
    await ownerSaves(tour, { is_published: true });
    await propose(tour, { pickup_details: 'Забираем от гостиницы' });
    // В правке одно поле, и оно от автомата, — но публикацию просил владелец.
    expect((await draftOf(tour)).proposed_by).toEqual({ pickup_details: 'tour-describe' });
    const card = (await adminGet()).data.edits.find((e) => e.tourId === tour)!;
    sent.alerts.length = 0;
    const r = await adminPost(card.id, { action: 'reject', reason: 'Нет программы дня, допишите.' });
    expect(r.body.message).toBe('«Автомат: отказ в публикации»: тур не опубликован');
    expect(sent.alerts).toHaveLength(1);
    expect(sent.alerts[0].text).toContain('Тур не опубликован');
    const view = await ownView(tour);
    expect(view?.rejected?.reason).toBe('Нет программы дня, допишите.');
    expect(view?.rejected?.wantsPublish).toBe(true);
  });

  it('автомату тур виден целиком: витрина плюс правка на проверке, поля владельца названы', async () => {
    const tour = await addTour('Автомат: чтение тура', { published: true });
    await ownerSaves(tour, { base_price: 11000 });
    await propose(tour, { description: COMPOSED });
    const { readTourForAutomaton } = await import('@/lib/tours/tour-change');
    const { transaction } = await import('@/lib/database');
    const view = await transaction((client) => readTourForAutomaton(client, tour));
    expect(view?.operatorId).toBe(OP);
    expect(view?.published).toBe(true);
    expect(view?.live.description).toBe(SHORT);
    expect(view?.effective.description).toBe(COMPOSED);
    expect(Number(view?.effective.base_price)).toBe(11000);
    expect(view?.ownerPending).toEqual(['base_price']);
    expect(await transaction((client) => readTourForAutomaton(client, '999999999'))).toBeNull();
    // Удалённого тура для автомата нет.
    await pool.query(`UPDATE operator_tours SET deleted_at = NOW() WHERE id = $1::bigint`, [tour]);
    expect(await transaction((client) => readTourForAutomaton(client, tour))).toBeNull();
  });

  describe('крон описаний: POST /api/cron/tour-describe пишет только дверью', () => {
    const describeTour = async (id: string, text = COMPOSED) => {
      const { proposeTourDescription } = await import('@/lib/tours/describe-door');
      return proposeTourDescription(id, text);
    };

    it('тур на сайте — на проверку; повтор ничего не меняет', async () => {
      const tour = await addTour('Крон: тур на сайте', { published: true });
      expect(await describeTour(tour)).toBe('staged');
      expect((await liveOf(tour)).description).toBe(SHORT);
      expect((await draftOf(tour)).proposed_by).toEqual({ description: 'tour-describe' });
      // Описание уже ждёт проверки и не короткое: второй прогон его не трогает.
      expect(await describeTour(tour, `${COMPOSED} Ещё раз.`)).toBe('skipped_already_long');
      expect((await draftOf(tour)).patch).toEqual({ description: COMPOSED });
    });

    it('тур не на сайте — в строку; пустое описание — тоже короткое', async () => {
      const tour = await addTour('Крон: черновик', { description: null });
      expect(await describeTour(tour)).toBe('written');
      expect((await liveOf(tour)).description).toBe(COMPOSED);
    });

    it('между переписью и записью владелец дописал текст — на витрине или в правке на проверке: не трогаем', async () => {
      const onSite = await addTour('Крон: дописано на витрине', { published: true, description: OWNER_TEXT });
      expect(await describeTour(onSite)).toBe('skipped_already_long');
      expect(await draftOf(onSite)).toBeNull();

      const waiting = await addTour('Крон: дописано в правке', { published: true });
      await ownerSaves(waiting, { description: OWNER_TEXT });
      expect(await describeTour(waiting)).toBe('skipped_owner_pending');
      expect((await draftOf(waiting)).patch).toEqual({ description: OWNER_TEXT });

      // Владелец отправил на проверку короткий текст: это всё равно его слово.
      const shortOwn = await addTour('Крон: короткая правка владельца', { published: true });
      await ownerSaves(shortOwn, { description: 'Короткий текст владельца.' });
      expect(await describeTour(shortOwn)).toBe('skipped_owner_pending');
      expect((await draftOf(shortOwn)).proposed_by).toEqual({});
    });

    it('тура нет или он удалён — «не найден», а не запись', async () => {
      expect(await describeTour('999999998')).toBe('not_found');
      const gone = await addTour('Крон: удалённый', { published: true });
      await pool.query(`UPDATE operator_tours SET deleted_at = NOW() WHERE id = $1::bigint`, [gone]);
      expect(await describeTour(gone)).toBe('not_found');
      expect((await liveOf(gone)).description).toBe(SHORT);
    });

    it('роут: сухой прогон по умолчанию не пишет; боевой называет исход каждого тура', async () => {
      process.env.CRON_SECRET = 'test-cron-secret';
      const { POST } = await import('@/app/api/cron/tour-describe/route');
      const call = async (body: unknown) => {
        const res = await POST(new NextRequest('http://localhost/api/cron/tour-describe', {
          method: 'POST', headers: { authorization: 'Bearer test-cron-secret' }, body: JSON.stringify(body),
        }));
        return { status: res.status, body: await res.json() };
      };
      // Туру хватает своих данных на текст: программа, состав, место.
      const rich = (await pool.query<{ id: string }>(
        `INSERT INTO operator_tours (operator_id, title, description, base_price, price_unit, max_participants, min_participants,
                                     is_active, is_published, activity_type, duration_hours, duration_type, difficulty, location_name,
                                     program, included, what_to_bring, pickup_type, season_start, season_end)
         VALUES ($1, 'Крон: роут', $2, 10000, 'person', 8, 2, TRUE, TRUE, 'hiking', 8, 'single_day', 'medium', 'Вулкан Горелый',
                 $3::jsonb, ARRAY['Гид', 'Обед', 'Трансфер'], ARRAY['Треккинговые ботинки', 'Ветровка'], 'hotel_pickup',
                 '2027-07-01', '2027-09-30')
         RETURNING id::text AS id`,
        [OP, SHORT, JSON.stringify([
          { title: 'Выезд из города', text: 'Забираем из гостиницы в 7 утра и едем к подножию вулкана на вахтовке.' },
          { title: 'Подъём к кратеру', text: 'Поднимаемся по тропе около трёх часов с остановками на отдых и фото.' },
          { title: 'Возвращение', text: 'Спуск той же тропой, обед у машины и дорога обратно в город к вечеру.' },
        ])],
      )).rows[0].id;

      const dry = await call({ reason: 'Проверка сухого прогона в тесте', ids: [rich] });
      expect(dry.status, JSON.stringify(dry.body)).toBe(200);
      expect(dry.body.dry_run).toBe(true);
      expect(dry.body.planned).toBe(1);
      expect(dry.body.outcomes).toEqual([]);
      expect(await draftOf(rich)).toBeNull();
      expect((await liveOf(rich)).description).toBe(SHORT);

      const real = await call({ dry_run: false, reason: 'Боевой прогон в тесте', ids: [rich] });
      expect(real.status, JSON.stringify(real.body)).toBe(200);
      expect(real.body.staged_for_review).toBe(1);
      expect(real.body.written_not_on_site).toBe(0);
      expect(real.body.outcomes).toEqual([{ id: rich, outcome: 'staged' }]);
      // На сайте прежний текст; собранный ждёт проверки с пометкой автомата.
      expect((await liveOf(rich)).description).toBe(SHORT);
      const draft = await draftOf(rich);
      expect(draft.proposed_by).toEqual({ description: 'tour-describe' });
      expect(String(draft.patch.description).length).toBeGreaterThanOrEqual(300);
      expect(real.body.plan[0].before).toBe(SHORT);
    });
  });

  describe('кроны снимков и точки сбора пишут только дверью', () => {
    const photosOf = async (id: string) => (await pool.query<{ photos: string[] | null; meeting_point: string | null }>(
      `SELECT photos, meeting_point FROM operator_tours WHERE id = $1::bigint`, [id],
    )).rows[0];
    const addPhotos = async (id: string, add: string[], dryRun = false) => {
      const { proposeTourPhotos } = await import('@/lib/tours/photos-door');
      return proposeTourPhotos(id, add, { dryRun });
    };
    const setPickup = async (id: string, pickup: string, dryRun = false) => {
      const { proposeTourPickup } = await import('@/lib/tours/photos-door');
      return proposeTourPickup(id, pickup, { dryRun });
    };
    const A = '/images/tours/a.jpg';
    const B = '/images/tours/b.jpg';
    const C = '/images/tours/c.jpg';

    it('снимки туру на сайте — на проверку; второй прогон дописывает к первым, а не теряет их', async () => {
      const tour = await addTour('Снимки: тур на сайте', { published: true });
      // Сухой прогон говорит, что случилось бы, и ничего не пишет.
      const dry = await addPhotos(tour, [B], true);
      expect(dry).toMatchObject({ status: 'would_stage', was: [A], now: [A, B], added: 1, alreadyPresent: 0 });
      expect(await draftOf(tour)).toBeNull();

      const first = await addPhotos(tour, [A, B, B]);
      expect(first).toMatchObject({ status: 'staged', title: 'Снимки: тур на сайте', was: [A], now: [A, B], added: 1, alreadyPresent: 2 });
      expect((await photosOf(tour)).photos).toEqual([A]);
      expect((await draftOf(tour)).proposed_by).toEqual({ photos: 'tour-photos' });
      // «Что уже есть» — витрина плюс правка на проверке: B второй раз не добавится, C встанет после него.
      expect((await addPhotos(tour, [B])).status).toBe('nothing_new');
      const second = await addPhotos(tour, [B, C]);
      expect(second).toMatchObject({ status: 'staged', was: [A, B], now: [A, B, C], added: 1, alreadyPresent: 1 });
      expect((await draftOf(tour)).patch).toEqual({ photos: [A, B, C] });
      expect((await photosOf(tour)).photos).toEqual([A]);

      // Администратор видит, кто предложил; после одобрения снимки на сайте.
      const card = (await adminGet()).data.edits.find((e) => e.tourId === tour)!;
      expect(card.changes.map((c) => [c.field, c.proposedBy])).toEqual([['photos', 'добавление снимков к туру']]);
      const ok = await adminPost(card.id, { action: 'approve', seen: card.seen });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect((await photosOf(tour)).photos).toEqual([A, B, C]);
    });

    it('снимки: владелец уже отправил свою галерею на проверку — крон её не трогает; тур не на сайте — в строку', async () => {
      const waiting = await addTour('Снимки: правка владельца', { published: true });
      await ownerSaves(waiting, { photos: [A, C] });
      const kept = await addPhotos(waiting, [B]);
      expect(kept).toMatchObject({ status: 'skipped_owner_pending', was: [A, C], now: [A, C], added: 0 });
      expect((await draftOf(waiting)).patch).toEqual({ photos: [A, C] });

      const draft = await addTour('Снимки: черновик');
      expect((await addPhotos(draft, [B], true)).status).toBe('would_write');
      expect((await photosOf(draft)).photos).toEqual([A]);
      expect((await addPhotos(draft, [B])).status).toBe('written');
      expect((await photosOf(draft)).photos).toEqual([A, B]);
      expect(await draftOf(draft)).toBeNull();
      expect((await addPhotos('999999997', [B])).status).toBe('not_found');
    });

    it('точка сбора туру на сайте — на проверку под своим именем; то же значение — «нечего менять»', async () => {
      const tour = await addTour('Сбор: тур на сайте', { published: true });
      const dry = await setPickup(tour, 'Забираем от гостиницы в 7:00', true);
      expect(dry).toMatchObject({ status: 'would_stage', was: null, now: 'Забираем от гостиницы в 7:00' });
      expect(await draftOf(tour)).toBeNull();

      const r = await setPickup(tour, 'Забираем от гостиницы в 7:00');
      expect(r).toMatchObject({ status: 'staged', title: 'Сбор: тур на сайте', was: null });
      expect((await photosOf(tour)).meeting_point).toBeNull();
      expect((await draftOf(tour)).proposed_by).toEqual({ meeting_point: 'tour-pickup' });
      expect((await setPickup(tour, 'Забираем от гостиницы в 7:00')).status).toBe('nothing_new');
      // Прежнее значение для отката — то, что ждёт проверки, а не пустая витрина.
      expect((await setPickup(tour, 'Забираем от гостиницы в 8:00')).was).toBe('Забираем от гостиницы в 7:00');

      const card = (await adminGet()).data.edits.find((e) => e.tourId === tour)!;
      expect(card.changes.map((c) => [c.field, c.proposedBy])).toEqual([['meeting_point', 'запись точки сбора']]);
      const ok = await adminPost(card.id, { action: 'approve', seen: card.seen });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect((await photosOf(tour)).meeting_point).toBe('Забираем от гостиницы в 8:00');

      const draft = await addTour('Сбор: черновик');
      expect((await setPickup(draft, 'Встреча у автовокзала')).status).toBe('written');
      expect((await photosOf(draft)).meeting_point).toBe('Встреча у автовокзала');
      expect((await setPickup('999999996', 'Встреча у автовокзала')).status).toBe('not_found');
    });

    it('роуты: сухой прогон по умолчанию не пишет; боевой называет исход', async () => {
      process.env.CRON_SECRET = 'test-cron-secret';
      const call = async (path: 'tour-photos' | 'tour-pickup', body: unknown) => {
        const mod = path === 'tour-photos'
          ? await import('@/app/api/cron/tour-photos/route')
          : await import('@/app/api/cron/tour-pickup/route');
        const res = await mod.POST(new NextRequest(`http://localhost/api/cron/${path}`, {
          method: 'POST', headers: { authorization: 'Bearer test-cron-secret' }, body: JSON.stringify(body),
        }));
        return { status: res.status, body: await res.json() };
      };
      const tour = await addTour('Роуты кронов', { published: true });
      const id = Number(tour);

      const dryPhotos = await call('tour-photos', { source: 'тест', why: 'проверка сухого прогона', tour_id: id, add: [B] });
      expect(dryPhotos.status, JSON.stringify(dryPhotos.body)).toBe(200);
      expect(dryPhotos.body).toMatchObject({ probe: 'tour_photos_v2', dry_run: true, status: 'would_stage', added: 1, staged_for_review: 0, written_not_on_site: 0 });
      expect(await draftOf(tour)).toBeNull();
      const realPhotos = await call('tour-photos', { source: 'тест', why: 'боевой прогон', dry_run: false, tour_id: id, add: [B] });
      expect(realPhotos.body).toMatchObject({ status: 'staged', was: [A], now: [A, B], staged_for_review: 1, written_not_on_site: 0 });
      expect((await photosOf(tour)).photos).toEqual([A]);
      // Чужой хост и выход из каталога ручка не принимает вовсе.
      expect((await call('tour-photos', { source: 'тест', why: 'чужой хост', dry_run: false, tour_id: id, add: ['https://example.test/a.jpg'] })).status).toBe(400);
      expect((await call('tour-photos', { source: 'тест', why: 'нет тура', dry_run: false, tour_id: 999999995, add: [B] })).status).toBe(404);

      const dryPickup = await call('tour-pickup', { source: 'тест', items: [{ id, pickup: 'Забираем от гостиницы', why: 'проверка' }] });
      expect(dryPickup.status, JSON.stringify(dryPickup.body)).toBe(200);
      expect(dryPickup.body).toMatchObject({ probe: 'tour_pickup_v2', dry_run: true, staged_for_review: 0 });
      expect(dryPickup.body.results[0]).toMatchObject({ id, status: 'would_stage', was: null, now: 'Забираем от гостиницы' });
      const realPickup = await call('tour-pickup', {
        source: 'тест', dry_run: false,
        items: [{ id, pickup: 'Забираем от гостиницы', why: 'проверка' }, { id: 999999994, pickup: 'Забираем от гостиницы', why: 'нет тура' }],
      });
      expect(realPickup.body).toMatchObject({ staged_for_review: 1, written_not_on_site: 0, not_found: 1, meaningful: true });
      expect((await photosOf(tour)).meeting_point).toBeNull();
      expect((await draftOf(tour)).proposed_by).toEqual({ photos: 'tour-photos', meeting_point: 'tour-pickup' });
    });
  });
});

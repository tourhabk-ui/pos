/**
 * Готовность партнёра принимать заявки — на настоящем PostgreSQL (план
 * готовности 23.11, этап 3c).
 *
 * Чек-лист в кабинете обязан совпадать с настоящими дверями, а не рисовать
 * галочки. Здесь судится чтение фактов на схеме прода:
 *  - карточка: статус заявки, настройка кабинета, витрина — условием витрины
 *    своей роли (у гида оно строже: приостановленный профиль в реестре не стоит);
 *  - канал: тот же `reachForPartner`, что у двери «поставить на витрину»;
 *  - содержимое: туры, объекты жилья, снаряжение, прайс перевозчика, прайс
 *    проката — теми же шлюзами, что у каталогов;
 *  - тестовый профиль: его опубликованный тур на сайт не выходит;
 *  - отказ базы: пункт «не удалось проверить», итог — не «готов»;
 *  - роут: партнёр берётся из входа; агенту чек-листа нет.
 *
 * Своя база `partner_readiness_test`. Без KERNEL_PG_TEST_URL файл честно
 * пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase, dropTestDatabase } from '../helpers/pg-schema';
import type { ItemKey, PartnerReadiness, ReadinessCategory } from '@/lib/partners/readiness';

const viewer = vi.hoisted(() => ({ userId: '', role: '' }));
vi.mock('next/cache', () => ({ unstable_cache: (fn: () => unknown) => fn }));
vi.mock('@/lib/auth/middleware', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/middleware')>()),
  requireRole: vi.fn(async () => ({ userId: viewer.userId, role: viewer.role })),
  // Дверь профиля оператора входит через requireOperator; кто владелец
  // карточки, а кто менеджер — решает уже база (lib/operators/team-access).
  requireOperator: vi.fn(async () => ({ userId: viewer.userId, role: viewer.role })),
}));

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[partner-readiness.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'partner_readiness_test';

type Card = {
  key: string; category: string; role?: string; profileStatus?: string; isPublic?: boolean; isTest?: boolean;
  onboarded?: boolean; status?: string; max?: number; telegram?: number;
};
const CARDS: Card[] = [
  { key: 'opNew',        category: 'operator' },
  { key: 'opReady',      category: 'operator', profileStatus: 'approved', isPublic: true, max: 710001 },
  { key: 'opPilot',      category: 'operator', profileStatus: 'approved', isPublic: true },
  { key: 'opDeleted',    category: 'operator', profileStatus: 'pending', max: 710002 },
  { key: 'opRejected',   category: 'operator', profileStatus: 'rejected', max: 710003 },
  { key: 'stand',        category: 'operator', profileStatus: 'approved', isTest: true, max: 710004 },
  { key: 'guideOk',      category: 'guide', profileStatus: 'approved', isPublic: true, telegram: 710005 },
  { key: 'guidePaused',  category: 'guide', profileStatus: 'approved', isPublic: true, status: 'suspended', telegram: 710006 },
  { key: 'stayNew',      category: 'stay' },
  { key: 'stayPending',  category: 'stay', onboarded: true, max: 710007 },
  { key: 'gearOk',       category: 'gear', onboarded: true, isPublic: true, max: 710008 },
  { key: 'carDraft',     category: 'transfer', max: 710009 },
  { key: 'carLive',      category: 'transfer', isPublic: true, max: 710010 },
  { key: 'carRental',    category: 'transfer', isPublic: true, max: 710011 },
  { key: 'carsNew',      category: 'cars', max: 710012 },
  { key: 'carsLive',     category: 'cars', isPublic: true, max: 710013 },
  { key: 'agent',        category: 'agent', profileStatus: 'approved' },
  // Карточки для двери «принять оферту» (этап 5): дописаны в конец, чтобы id прежних не сдвинулись.
  { key: 'offerOld',     category: 'gear', max: 710014 },
  { key: 'offerErase',   category: 'stay', max: 710015 },
  // Карточки для повторной подачи заявки (слово владельца 23.11): тоже в конец.
  { key: 'opResubmit',   category: 'operator', profileStatus: 'rejected', max: 710016 },
  { key: 'opApproved',   category: 'operator', profileStatus: 'approved', max: 710017 },
];
const idOf = (i: number) => `c3c00000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`;
const userOf = (i: number) => `c3c00000-0000-4000-8000-0000000002${String(i).padStart(2, '0')}`;
const ID = Object.fromEntries(CARDS.map((c, i) => [c.key, idOf(i)])) as Record<string, string>;
const USER = Object.fromEntries(CARDS.map((c, i) => [c.key, userOf(i)])) as Record<string, string>;
const CATEGORY = Object.fromEntries(CARDS.map((c) => [c.key, c.category])) as Record<string, string>;

withPg('готовность партнёра: факты из базы', () => {
  let pool: import('pg').Pool;

  const read = async (key: string, db?: { query: typeof pool.query }): Promise<PartnerReadiness> => {
    const { readPartnerReadiness } = await import('@/lib/partners/readiness-store');
    return readPartnerReadiness(
      { partnerId: ID[key], category: CATEGORY[key] as ReadinessCategory, viewer: 'owner' },
      db as never,
    );
  };
  const item = (r: PartnerReadiness, key: ItemKey) => r.items.find((i) => i.key === key);

  const addTour = (key: string, title: string, o: { published?: boolean; active?: boolean; deleted?: boolean } = {}) => pool.query(
    `INSERT INTO operator_tours (operator_id, title, base_price, max_participants, is_active, is_published, activity_type, duration_hours, deleted_at)
     VALUES ($1, $2, 10000, 8, $3, $4, 'hiking', 6, CASE WHEN $5::boolean THEN NOW() ELSE NULL END)`,
    [ID[key], title, o.active ?? true, o.published ?? false, o.deleted === true],
  );

  beforeAll(async () => {
    const { Pool } = await import('pg');
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 4 });
    process.env.DATABASE_URL = dbUrl;
    process.env.DATABASE_SSL = 'false';
    delete process.env.RENTAL_OPERATOR_PILOT_SLUGS;

    for (const [i, c] of CARDS.entries()) {
      await pool.query(
        `INSERT INTO users (id, email, name, password_hash, role) VALUES ($1, $2, 'Тест', 'x', $3)`,
        [userOf(i), `ready-${c.key.toLowerCase()}@example.test`, c.role ?? c.category],
      );
      await pool.query(
        `INSERT INTO partners (id, user_id, name, slug, category, contact, profile_status, is_public, is_test,
                               onboarding_completed, status, max_chat_id, telegram_chat_id)
         VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, $6, $7, $8, $9, COALESCE($10, 'pending'), $11, $12)`,
        [
          idOf(i), userOf(i), `Готовность ${c.key}`, `ready-${c.key.toLowerCase()}`, c.category,
          c.profileStatus ?? 'none', c.isPublic === true, c.isTest === true, c.onboarded === true,
          c.status ?? null, c.max ?? null, c.telegram ?? null,
        ],
      );
    }

    await addTour('opReady', 'На витрине', { published: true });
    await addTour('opReady', 'Черновик');
    await addTour('opPilot', 'Тур пилота', { published: true });
    await addTour('opDeleted', 'Удалённый', { published: true, deleted: true });
    await addTour('opRejected', 'Тур отклонённого');
    await addTour('stand', 'Тур стенда', { published: true });

    await pool.query(
      `INSERT INTO accommodations (partner_id, name, type, coordinates, moderation_status)
       VALUES ($1, 'Дом на проверке', 'hotel', '{"lat":53,"lng":158}', 'pending')`, [ID.stayPending],
    );
    await pool.query(
      `INSERT INTO gear_items (partner_id, name, category, price_per_day, moderation_status)
       VALUES ($1, 'Палатка', 'tents', 500, 'approved')`, [ID.gearOk],
    );
    await pool.query(
      `INSERT INTO transfer_charter_prices (partner_id, vehicle_kind, line_kind, from_text, to_text, price_rub)
       VALUES ($1, 'vahtovka', 'destination', 'Петропавловск-Камчатский', 'Вулкан Горелый', 75000)`, [ID.carLive],
    );
    const offer = (key: string, title: string, active: boolean) => pool.query(
      `INSERT INTO car_rental_offers (partner_id, title, body_kind, seats, price_rub_per_day, driver, is_active)
       VALUES ($1, $2, 'suv', 5, 7000, 'self', $3)`, [ID[key], title, active],
    );
    await offer('carRental', 'Внедорожник', true);
    await offer('carsLive', 'Внедорожник', true);
    await offer('carsLive', 'Снят с линии', false);

    const { saveNewPriceDraft } = await import('@/lib/transfers/price-edit-store');
    const draft = await saveNewPriceDraft({
      partnerId: ID.carDraft,
      row: { vehicleKind: 'jeep', lineKind: 'destination', fromText: 'Петропавловск', toText: 'Горелый', priceRub: 45000, priceNote: null, conditions: null, validYear: 2026 },
    });
    expect(draft.outcome).toBe('saved');
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    const { pool: appPool } = await import('@/lib/db-pool');
    await (appPool as unknown as { end?: () => Promise<void> }).end?.();
    await dropTestDatabase(PG_URL, TEST_DB).catch(() => {});
  });

  describe('оператор', () => {
    it('новый: три шага за партнёром, витрина ждёт администратора', async () => {
      const r = await read('opNew');
      expect(r.verdict).toBe('not_ready');
      expect(r.headline).toBe('До приёма заявок осталось шагов: 3');
      expect(item(r, 'profile')).toMatchObject({ state: 'todo', href: '/hub/operator/onboarding' });
      expect(item(r, 'channel')?.state).toBe('todo');
      expect(item(r, 'content')).toMatchObject({ state: 'todo', href: '/hub/operator/tours/new' });
      expect(item(r, 'storefront')?.state).toBe('waiting');
      expect(item(r, 'storefront')?.detail).toContain('Без подключённого MAX или Telegram');
      // Карточка заведена мимо регистрации с отметкой: акцепта оферты в журнале нет.
      // Владельцу — шаг «принять», не обязательный (этап 5 плана готовности, 23.11).
      expect(item(r, 'offer')).toMatchObject({ state: 'todo', required: false, action: 'accept_offer' });
      expect(item(r, 'data_agreement')).toMatchObject({ state: 'waiting', required: false });
    });

    it('на витрине, с каналом и туром — готов; черновик считается, на сайте один', async () => {
      const r = await read('opReady');
      expect(r.verdict).toBe('ready');
      expect(r.headline).toBe('Готовы принимать заявки');
      expect(item(r, 'content')?.detail).toBe('Туров в кабинете: 2, на сайте: 1.');
      expect(r.items.filter((i) => i.required).every((i) => i.state === 'done')).toBe(true);
    });

    it('пилот на витрине без канала — не готов, и сказано почему', async () => {
      const r = await read('opPilot');
      expect(r.verdict).toBe('not_ready');
      expect(r.headline).toBe('Заявки до вас не доходят: не подключён ни MAX, ни Telegram');
      expect(item(r, 'storefront')?.state).toBe('done');
      expect(item(r, 'channel')?.state).toBe('todo');
    });

    it('удалённый тур не считается', async () => {
      const r = await read('opDeleted');
      expect(item(r, 'content')?.state).toBe('todo');
      expect(item(r, 'profile')?.state).toBe('done');
    });

    it('отклонённая заявка: шаг за партнёром — исправить профиль и отправить снова', async () => {
      const r = await read('opRejected');
      expect(item(r, 'profile')).toMatchObject({ state: 'todo', href: '/hub/operator/profile' });
      expect(r.verdict).toBe('not_ready');
    });

    it('тестовый профиль: опубликованный тур на сайт не выходит, витрины нет', async () => {
      const r = await read('stand');
      expect(item(r, 'content')?.detail).toBe('Туров в кабинете: 1, на сайте: 0.');
      expect(item(r, 'storefront')?.detail).toContain('тестовый профиль');
      expect(r.verdict).toBe('not_ready');
    });
  });

  describe('гид', () => {
    it('одобрен, в реестре, с каналом — готов и без своих туров', async () => {
      const r = await read('guideOk');
      expect(r.verdict).toBe('ready');
      expect(item(r, 'content')).toMatchObject({ state: 'todo', required: false });
    });

    it('приостановлен — в реестре не стоит, хотя флаг витрины поднят', async () => {
      const r = await read('guidePaused');
      expect(item(r, 'storefront')?.state).toBe('waiting');
      expect(r.verdict).toBe('not_ready');
    });
  });

  describe('жильё и снаряжение', () => {
    it('новый хозяин: настройка, канал, объект', async () => {
      const r = await read('stayNew');
      expect(item(r, 'profile')).toMatchObject({ state: 'todo', href: '/hub/stay/onboarding' });
      expect(item(r, 'content')).toMatchObject({ state: 'todo', href: '/hub/stay/accommodations/new' });
      expect(r.headline).toBe('До приёма заявок осталось шагов: 3');
    });

    it('объект на проверке: шаги партнёра выполнены, ждём администратора', async () => {
      const r = await read('stayPending');
      expect(item(r, 'content')?.detail).toBe('Объектов: 1, на сайте: 0, на проверке: 1.');
      expect(item(r, 'storefront')?.detail).toBe('На витрину карточку ставит администратор платформы.');
      expect(r.verdict).toBe('not_ready');
      expect(r.headline).toBe('Ваши шаги выполнены. Заявки пойдут, когда карточка выйдет на витрину');
    });

    it('прокат снаряжения с одобренной позицией — готов', async () => {
      const r = await read('gearOk');
      expect(r.verdict).toBe('ready');
      expect(item(r, 'content')?.detail).toBe('Позиций: 1, на сайте: 1.');
    });
  });

  describe('перевозчик и прокат автомобилей', () => {
    it('у перевозчика пункта «профиль» нет: такой двери у роли нет', async () => {
      for (const key of ['carDraft', 'carLive', 'carsNew']) {
        expect(item(await read(key), 'profile'), key).toBeUndefined();
      }
    });

    it('новая строка прайса на проверке — ждём администратора', async () => {
      const r = await read('carDraft');
      expect(item(r, 'content')).toMatchObject({ state: 'waiting' });
      expect(item(r, 'content')?.detail).toContain('строк: 1');
    });

    it('живая строка прайса — готов', async () => {
      const r = await read('carLive');
      expect(r.verdict).toBe('ready');
      expect(item(r, 'content')?.detail).toBe('Строк прайса на сайте: 1.');
    });

    it('перевозчик с одним прайсом проката (как «Лагуна») — прайс заведён', async () => {
      const r = await read('carRental');
      expect(item(r, 'content')?.state).toBe('done');
      expect(r.verdict).toBe('ready');
    });

    it('прокат без прайса и вне пилота: прайс заводит администратор', async () => {
      const r = await read('carsNew');
      expect(item(r, 'content')).toMatchObject({ state: 'waiting' });
      expect(item(r, 'content')?.detail).toContain('администратор платформы');
      expect(item(r, 'content')?.href).toBeUndefined();
    });

    it('участник пилота проката без прайса — шаг за ним', async () => {
      process.env.RENTAL_OPERATOR_PILOT_SLUGS = 'ready-carsnew';
      try {
        const r = await read('carsNew');
        expect(item(r, 'content')).toMatchObject({ state: 'todo', href: '/hub/carrier/rental' });
      } finally {
        delete process.env.RENTAL_OPERATOR_PILOT_SLUGS;
      }
    });

    it('прокат: снятая с линии строка не считается', async () => {
      const r = await read('carsLive');
      expect(item(r, 'content')?.detail).toBe('Строк прайса на сайте: 1.');
      expect(r.verdict).toBe('ready');
    });
  });

  describe('отказ базы — «не удалось проверить», а не «готов» и не «пусто»', () => {
    const broken = {
      query: (async () => { throw Object.assign(new Error('отказ'), { code: '57014' }); }) as never,
    };

    it('готовый партнёр при отказе чтения: итог неизвестен', async () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const r = await read('opReady', broken);
      expect(r.verdict).toBe('unknown');
      expect(r.headline).toBe('Готовность проверить не удалось');
      expect(item(r, 'profile')?.state).toBe('unknown');
      expect(item(r, 'content')?.state).toBe('unknown');
      expect(item(r, 'storefront')?.state).toBe('unknown');
      // Канал читается своим запросом и прочитан.
      expect(item(r, 'channel')?.state).toBe('done');
      // Оба отказа названы в логе по имени чтения и с SQLSTATE — ни один не заглушён.
      const logged = errors.mock.calls.map((c) => c.join(' '));
      expect(logged.some((l) => l.includes('карточка партнёра не прочитана') && l.includes('57014'))).toBe(true);
      expect(logged.some((l) => l.includes('содержимое (operator) не прочитано') && l.includes('57014'))).toBe(true);
      // Журнал акцепта не прочитан — «не удалось проверить», а не «оферта не принята».
      expect(item(r, 'offer')).toMatchObject({ state: 'unknown', required: false });
      expect(item(r, 'offer')?.action).toBeUndefined();
      expect(logged.some((l) => l.includes('акцепт оферты не прочитан') && l.includes('57014'))).toBe(true);
      errors.mockRestore();
    });

    it('известный невыполненный шаг сильнее неизвестного: не готов', async () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const r = await read('opNew', broken);
      expect(r.verdict).toBe('not_ready');
      errors.mockRestore();
    });
  });

  describe('роут GET /api/hub/partner/readiness', () => {
    const get = async (key: string, role?: string) => {
      viewer.userId = USER[key];
      viewer.role = role ?? CATEGORY[key];
      const { GET } = await import('@/app/api/hub/partner/readiness/route');
      const res = await GET(new NextRequest('http://localhost/api/hub/partner/readiness'));
      return { status: res.status, body: await res.json() as { success?: boolean; data?: PartnerReadiness | null; error?: string } };
    };

    it('партнёр берётся из входа: каждый видит свою карточку', async () => {
      const op = await get('opReady');
      expect(op.status).toBe(200);
      expect(op.body.data).toMatchObject({ category: 'operator', verdict: 'ready' });
      const stay = await get('stayNew');
      expect(stay.body.data).toMatchObject({ category: 'stay', verdict: 'not_ready' });
      const cars = await get('carsLive');
      expect(cars.body.data).toMatchObject({ category: 'cars', verdict: 'ready' });
    });

    it('чужую карточку параметром не спросить', async () => {
      const own = (await get('stayNew')).body.data;
      viewer.userId = USER.stayNew;
      viewer.role = 'stay';
      const { GET } = await import('@/app/api/hub/partner/readiness/route');
      // Чужая карточка — жильё с подключённым каналом и пройденной настройкой:
      // прочитай роут её, ответ отличался бы от своего.
      const foreign = ID.stayPending;
      const res = await GET(new NextRequest(
        `http://localhost/api/hub/partner/readiness?partnerId=${foreign}&partner_id=${foreign}&id=${foreign}`,
      ));
      const body = await res.json() as { data?: PartnerReadiness | null };
      expect(body.data).toEqual(own);
      expect(body.data?.items.find((i) => i.key === 'channel')?.state).toBe('todo');
      expect((await read('stayPending')).items.find((i) => i.key === 'channel')?.state).toBe('done');
    });

    it('агенту заявки не приходят — чек-листа нет', async () => {
      const r = await get('agent');
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ success: true, data: null });
    });

    it('в ответе нет ПД: ни почты, ни телефона, ни id чата', async () => {
      const r = await get('opReady');
      const text = JSON.stringify(r.body);
      expect(text).not.toContain('@');
      expect(text).not.toContain('710001');
      expect(text).not.toContain(USER.opReady);
    });
  });

  // Этап 5 плана готовности (23.11): партнёр, заведённый до отметки на
  // регистрации, принимает оферту из кабинета. Дверь судится целиком на схеме
  // прода — подменён только разбор JWT.
  describe('роут POST /api/hub/partner/offer — оферта из кабинета', () => {
    const accept = async (key: string, body: unknown, role?: string) => {
      viewer.userId = USER[key];
      viewer.role = role ?? CATEGORY[key];
      const { POST } = await import('@/app/api/hub/partner/offer/route');
      const res = await POST(new NextRequest('http://localhost/api/hub/partner/offer', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.77' },
        body: JSON.stringify(body),
      }));
      return { status: res.status, body: await res.json() as { success?: boolean; error?: string; data?: { version: string } } };
    };
    const journal = async (key: string) => (await pool.query<{
      offer_version: string; source: string; ip: string | null; user_id: string | null; accepted_at: Date;
    }>(
      `SELECT offer_version, source, ip, user_id::text AS user_id, accepted_at
         FROM partner_offer_acceptances WHERE partner_id = $1 ORDER BY id`, [ID[key]],
    )).rows;

    it('владелец принимает: строка журнала — своей карточке, с версией; чек-лист говорит «готово»', async () => {
      const { OFFER_VERSION } = await import('@/lib/legal/offer');
      expect(item(await read('opPilot'), 'offer')).toMatchObject({ state: 'todo', action: 'accept_offer' });
      expect(await journal('opPilot')).toHaveLength(0);

      const r = await accept('opPilot', { offer_accepted: true });
      expect(r).toEqual({ status: 200, body: { success: true, data: { version: OFFER_VERSION } } });

      const rows = await journal('opPilot');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ offer_version: '2026-10-05', source: 'cabinet', user_id: USER.opPilot, ip: '10.0.0.77' });

      const after = item(await read('opPilot'), 'offer');
      expect(after).toMatchObject({ state: 'done', required: false });
      expect(after?.action).toBeUndefined();
      expect(after?.detail).toContain('5 октября 2026 г.');
      // Готовности акцепт не меняет: пилот без канала как был «не готов», так и остался.
      expect((await read('opPilot')).verdict).toBe('not_ready');
      // Чужая карточка от этого акцепта не «приняла»: у соседа пункт прежний.
      expect(item(await read('opNew'), 'offer')?.state).toBe('todo');
    });

    it('карточку из запроса дверь не берёт: акцепт пишется своей, чужая пуста', async () => {
      const foreign = ID.stayPending;
      const r = await accept('stayNew', { offer_accepted: true, partnerId: foreign, partner_id: foreign, id: foreign });
      expect(r.status).toBe(200);
      expect(await journal('stayNew')).toHaveLength(1);
      expect(await journal('stayPending')).toHaveLength(0);
    });

    it('без отметки строки нет; агенту оферта не нужна — тоже нет', async () => {
      const { OFFER_REQUIRED_TEXT } = await import('@/lib/legal/offer');
      for (const body of [{}, { offer_accepted: false }, { offer_accepted: 'true' }]) {
        const r = await accept('carDraft', body);
        expect(r.status).toBe(400);
        expect(r.body.error).toBe(OFFER_REQUIRED_TEXT);
      }
      expect(await journal('carDraft')).toHaveLength(0);
      const agent = await accept('agent', { offer_accepted: true });
      expect(agent.status).toBe(400);
      expect(await journal('agent')).toHaveLength(0);
    });

    it('в журнале прежняя редакция: чек-лист просит принять действующую; акцепт прежнюю строку не трогает', async () => {
      await pool.query(
        `INSERT INTO partner_offer_acceptances (partner_id, user_id, offer_version, accepted_at, source)
         VALUES ($1, $2, '2025-01-01', NOW() - INTERVAL '300 days', 'registration')`, [ID.offerOld, USER.offerOld],
      );
      const before = item(await read('offerOld'), 'offer');
      expect(before).toMatchObject({ state: 'todo', action: 'accept_offer', required: false });
      expect(before?.detail).toContain('Вы принимали прежнюю редакцию оферты.');
      const kept = (await journal('offerOld'))[0];

      expect((await accept('offerOld', { offer_accepted: true })).status).toBe(200);
      const rows = await journal('offerOld');
      expect(rows.map((x) => x.offer_version)).toEqual(['2025-01-01', '2026-10-05']);
      expect(rows[0]).toEqual(kept);
      expect(item(await read('offerOld'), 'offer')?.state).toBe('done');
    });

    // Слово владельца 24.11: «Партнёры, заведённые до оферты, принимают её при
    // следующем входе в кабинет, до сезона». Кабинет спрашивает состояние
    // просьбы этим чтением — оно судится на той же схеме, что и дверь акцепта.
    it('GET: состояние просьбы — по журналу своей карточки; чтение ничего не пишет', async () => {
      const ask = async (key: string, role?: string) => {
        viewer.userId = USER[key];
        viewer.role = role ?? CATEGORY[key];
        const { GET } = await import('@/app/api/hub/partner/offer/route');
        const res = await GET(new NextRequest('http://localhost/api/hub/partner/offer'));
        const json = await res.json() as { data?: { state: string; previous: boolean; edition: string } };
        return { status: res.status, data: json.data };
      };
      const total = async () => Number((await pool.query(`SELECT COUNT(*)::int AS n FROM partner_offer_acceptances`)).rows[0].n);
      const before = await total();

      // Заведён до отметки: просьба, и не «оферта обновилась».
      expect(await journal('stayPending')).toHaveLength(0);
      expect(await ask('stayPending')).toEqual({
        status: 200, data: { state: 'needed', previous: false, edition: '5 октября 2026 г.' },
      });
      // Принял действующую редакцию (тесты выше): просить не о чем.
      expect((await ask('opPilot')).data?.state).toBe('accepted');
      // В журнале сначала прежняя редакция, потом действующая (тест выше): принято.
      expect((await ask('offerOld')).data?.state).toBe('accepted');
      // Агенту оферта не нужна.
      expect((await ask('agent')).data?.state).toBe('not_needed');
      // Чтение журнал не пополняет.
      expect(await total()).toBe(before);
    });

    it('GET: в журнале только прежняя редакция — просьба с пометкой «оферта обновилась»', async () => {
      viewer.userId = USER.opNew;
      viewer.role = CATEGORY.opNew;
      const { GET } = await import('@/app/api/hub/partner/offer/route');
      const client = await pool.connect();
      try {
        // Строка прежней редакции живёт только внутри этой проверки: соседним тестам журнал opNew нужен пустым.
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO partner_offer_acceptances (partner_id, user_id, offer_version, accepted_at, source)
           VALUES ($1, $2, '2025-01-01', NOW() - INTERVAL '10 days', 'registration') RETURNING id::text AS id`, [ID.opNew, USER.opNew],
        );
        const res = await GET(new NextRequest('http://localhost/api/hub/partner/offer'));
        expect((await res.json() as { data: unknown }).data).toMatchObject({ state: 'needed', previous: true });
        await client.query(`DELETE FROM partner_offer_acceptances WHERE id = $1::bigint`, [inserted.rows[0].id]);
      } finally {
        client.release();
      }
      const again = await GET(new NextRequest('http://localhost/api/hub/partner/offer'));
      expect((await again.json() as { data: unknown }).data).toMatchObject({ state: 'needed', previous: false });
    });

    it('журнал не принимает акцепт без версии и с неизвестным источником', async () => {
      const insert = (version: string | null, source: string) => pool.query(
        `INSERT INTO partner_offer_acceptances (partner_id, user_id, offer_version, source) VALUES ($1, $2, $3, $4)`,
        [ID.carDraft, USER.carDraft, version, source],
      );
      await expect(insert(null, 'cabinet')).rejects.toMatchObject({ code: '23502' });
      await expect(insert('  ', 'cabinet')).rejects.toMatchObject({ code: '23514' });
      await expect(insert('2026-10-05', 'admin')).rejects.toMatchObject({ code: '23514' });
      expect(await journal('carDraft')).toHaveLength(0);
    });

    it('удаление аккаунта: из журнала уходят адрес и ссылка на человека, версия и время акцепта остаются', async () => {
      expect((await accept('offerErase', { offer_accepted: true })).status).toBe(200);
      const [before] = await journal('offerErase');
      expect(before).toMatchObject({ ip: '10.0.0.77', user_id: USER.offerErase });

      const { eraseUser } = await import('@/lib/account/erase');
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const counts = await eraseUser(c as never, USER.offerErase, 'account_deleted');
        await c.query('COMMIT');
        expect(counts.partner_offer_acceptances).toBe(1);
      } catch (err) {
        await c.query('ROLLBACK');
        throw err;
      } finally {
        c.release();
      }
      const rows = await journal('offerErase');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ ip: null, user_id: null, offer_version: '2026-10-05', source: 'cabinet' });
      expect(rows[0].accepted_at.getTime()).toBe(before.accepted_at.getTime());
      // Чужие строки журнала стирание не задело.
      expect((await journal('opPilot'))[0]).toMatchObject({ ip: '10.0.0.77', user_id: USER.opPilot });
    });
  });

  /**
   * Слово владельца 23.11: «отклонённый оператор видит причину отказа и может
   * подать заявку снова, как у гида». Мок принял бы любой SQL; здесь условие
   * «только из отклонённой» и журнал заявок судит сервер.
   */
  describe('дверь профиля оператора: повторная подача после отказа', () => {
    const as = (key: string, role?: string) => { viewer.userId = USER[key]; viewer.role = role ?? CATEGORY[key]; };
    const patch = async (key: string, body: unknown) => {
      as(key);
      const { PATCH } = await import('@/app/api/hub/operator/profile/route');
      const res = await PATCH(new NextRequest('http://localhost/api/hub/operator/profile', { method: 'PATCH', body: JSON.stringify(body) }));
      return { status: res.status, body: await res.json() };
    };
    const open = async (key: string) => {
      as(key);
      const { GET } = await import('@/app/api/hub/operator/profile/route');
      const res = await GET(new NextRequest('http://localhost/api/hub/operator/profile'));
      return { status: res.status, body: await res.json() };
    };
    const cardOf = async (key: string) => (await pool.query<{ profile_status: string; profile_review_comment: string | null; applied_at: Date | null; description: string | null }>(
      `SELECT profile_status, profile_review_comment, applied_at, description FROM partners WHERE id = $1`, [ID[key]],
    )).rows[0];
    const journalOf = async (key: string) => (await pool.query<{ status: string; review_comment: string | null }>(
      `SELECT status, review_comment FROM operator_applications WHERE partner_id = $1 ORDER BY created_at`, [ID[key]],
    )).rows;

    beforeAll(async () => {
      // Отказ администратора, как его пишет роут решения: причина в карточке и в журнале.
      for (const key of ['opResubmit', 'opRejected']) {
        await pool.query(
          `UPDATE partners SET profile_review_comment = 'Не указан телефон компании.', applied_at = NOW() - INTERVAL '3 days' WHERE id = $1`, [ID[key]],
        );
        await pool.query(
          `INSERT INTO operator_applications (partner_id, user_id, status, company_name, review_comment)
           VALUES ($1, $2, 'rejected', 'Готовность', 'Не указан телефон компании.')`, [ID[key], USER[key]],
        );
      }
    });

    it('отклонённый владелец видит причину отказа в ответе профиля', async () => {
      const r = await open('opResubmit');
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({ profile_status: 'rejected', profile_review_comment: 'Не указан телефон компании.', viewer: 'owner' });
    });

    it('подача снова: заявка в очереди, время подачи новое, журнал снова ждёт; причина прошлого отказа остаётся', async () => {
      const before = await cardOf('opResubmit');
      const r = await patch('opResubmit', { submit_for_review: true, description: 'Исправленное описание компании.' });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body).toMatchObject({ success: true, profile_status: 'pending' });
      const after = await cardOf('opResubmit');
      expect(after.profile_status).toBe('pending');
      expect(after.description).toBe('Исправленное описание компании.');
      expect(after.applied_at!.getTime()).toBeGreaterThan(before.applied_at!.getTime());
      expect(after.profile_review_comment).toBe('Не указан телефон компании.');
      expect(await journalOf('opResubmit')).toEqual([{ status: 'pending', review_comment: 'Не указан телефон компании.' }]);
      // Чек-лист: шаг закрыт — заявка отправлена.
      expect(item(await read('opResubmit'), 'profile')).toMatchObject({ state: 'done' });
    });

    it('вторая подача той же заявки — 409 словами, время подачи не переписано', async () => {
      const before = await cardOf('opResubmit');
      const r = await patch('opResubmit', { submit_for_review: true });
      expect(r.status).toBe(409);
      expect(r.body.error).toBe('Заявка уже на проверке — дождитесь решения администратора');
      expect((await cardOf('opResubmit')).applied_at!.getTime()).toBe(before.applied_at!.getTime());
    });

    it('одобренному и не подававшему подавать нечего — 409, карточка прежняя', async () => {
      const approved = await patch('opApproved', { submit_for_review: true });
      expect(approved.status).toBe(409);
      expect(approved.body.error).toBe('Профиль уже одобрен — подавать заявку снова не нужно');
      expect((await cardOf('opApproved')).profile_status).toBe('approved');
      const fresh = await patch('opNew', { submit_for_review: true });
      expect(fresh.status).toBe(409);
      expect((await cardOf('opNew')).profile_status).toBe('none');
    });

    it('обычное сохранение профиля отклонённую заявку в очередь не возвращает', async () => {
      const r = await patch('opRejected', { description: 'Просто правка описания.' });
      expect(r.status).toBe(200);
      expect((await cardOf('opRejected')).profile_status).toBe('rejected');
      expect(await journalOf('opRejected')).toEqual([{ status: 'rejected', review_comment: 'Не указан телефон компании.' }]);
      // Чек-лист отклонённого: шаг за ним, дверь названа.
      expect(item(await read('opRejected'), 'profile')).toMatchObject({ state: 'todo', href: '/hub/operator/profile' });
    });

    it('чужую карточку этой дверью не подать: карточка берётся из входа', async () => {
      // Вошёл одобренный оператор и шлёт флаг — меняется (и отказывает) только его карточка.
      const before = await cardOf('opRejected');
      const r = await patch('opApproved', { submit_for_review: true, partner_id: ID.opRejected, id: ID.opRejected });
      expect(r.status).toBe(409);
      expect((await cardOf('opRejected')).profile_status).toBe(before.profile_status);
    });
  });
});

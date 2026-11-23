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

    it('отклонённая заявка: повторной отправки нет — шаг не за партнёром', async () => {
      const r = await read('opRejected');
      expect(item(r, 'profile')).toMatchObject({ state: 'waiting' });
      expect(item(r, 'profile')?.href).toBeUndefined();
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
});

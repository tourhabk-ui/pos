/**
 * Сквозной цикл «запрос мест» на тестовом операторе — на настоящем PostgreSQL
 * (план готовности 23.11, этап 6).
 *
 * До этого дня цикл тура судился только юнитами на подменённой базе: «заявка
 * создана», «ответ принят» и «турист узнал» проверялись порознь, и ни один
 * тест не проходил путь целиком своим кодом на схеме прода. Жильё и машина
 * перевозчику такой прогон имеют (tests/integration/request-chat.pg.test.ts);
 * здесь — оператор.
 *
 * Путь, каждое звено — настоящая дверь:
 *   турист          POST /api/seat-requests (роут сайта);
 *   оператору       сообщение с кнопками — что и кому передано отправке;
 *   входящие        loadInbox кабинета;
 *   ответ           кнопкой: разбор нажатия → право чата → answerSeatRequest
 *                   (те три функции, что зовёт вебхук MAX), и ссылкой:
 *                   POST /api/seat-requests/[id]/answer;
 *   турист узнаёт   сообщение в его чат и GET /api/seat-requests/status.
 *
 * Это СТЕНД: партнёр — тестовый оператор из `TEST_STAND_PARTNER_IDS`, тур не
 * опубликован, отправка в мессенджеры подменена. Прогон не доказывает, что
 * настоящий партнёр вчера получил сообщение в MAX: доставку до телефона он не
 * трогает. Сети в файле нет — `fetch` подменён и обязан остаться невызванным.
 *
 * Тем же файлом и на той же базе — отчёт очередей администратора
 * (lib/admin/partner-queues): числа сверяются с дверями, которые эти очереди
 * создают, и замеряется время на двадцати партнёрах с правками.
 *
 * Своя база `request_cycle_test`. Без KERNEL_PG_TEST_URL файл честно
 * пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase, dropTestDatabase } from '../helpers/pg-schema';
import { TEST_STAND_PARTNER_IDS } from '@/lib/seat-requests/test-stand';

interface PdSend {
  text: string; stub: string;
  buttons?: Array<{ text: string; payload?: string; url?: string }>;
  to?: { maxChatId?: unknown; telegramChatId?: unknown };
}

const sent = vi.hoisted(() => ({
  /** Сообщения с ПД-дверью: оператору (и его команде, и рабочему чату). */
  pd: [] as PdSend[],
  /** Личные сообщения MAX — сюда уходит исход туристу. */
  dm: [] as Array<{ chatId: unknown; text: string }>,
  /** Личные сообщения Telegram. */
  tg: [] as Array<{ chatId: unknown; text: string }>,
  /** Любая попытка сети: в этом файле её быть не должно. */
  net: [] as string[],
}));

vi.mock('@/lib/notifications/pd-alert', async (orig) => ({
  ...(await orig<typeof import('@/lib/notifications/pd-alert')>()),
  sendPdAlert: vi.fn(async (p: PdSend) => {
    sent.pd.push(p);
    if (p.to?.maxChatId) return { channel: 'max', delivered: true, reason: 'доставлено в MAX' };
    if (p.to?.telegramChatId) return { channel: 'telegram-stub', delivered: false, reason: 'MAX не привязан' };
    // Без адресата сообщение идёт в рабочий чат платформы.
    if (!p.to) return { channel: 'max', delivered: true, reason: 'рабочий чат' };
    return { channel: 'none', delivered: false, reason: 'адресата нет' };
  }),
}));

vi.mock('@/lib/notifications/max-channel', async (orig) => ({
  ...(await orig<typeof import('@/lib/notifications/max-channel')>()),
  maxSendDm: vi.fn(async (chatId: unknown, text: string) => {
    sent.dm.push({ chatId, text });
    return { ok: true };
  }),
}));

vi.mock('@/lib/notifications/telegram', async (orig) => ({
  ...(await orig<typeof import('@/lib/notifications/telegram')>()),
  telegramService: {
    sendMessage: vi.fn(async (m: { chatId: unknown; text: string }) => {
      sent.tg.push({ chatId: m.chatId, text: m.text });
      return { success: true };
    }),
  },
}));

// Отчёт очередей — дверь администратора: подменён только разбор JWT.
const admin = vi.hoisted(() => ({ allowed: true }));
vi.mock('@/lib/auth/middleware', async (orig) => {
  const { NextResponse: Res } = await import('next/server');
  return {
    ...(await orig<typeof import('@/lib/auth/middleware')>()),
    requireAdmin: vi.fn(async () => (admin.allowed
      ? { userId: 'c6000000-0000-4000-8000-0000000000ad', role: 'admin' }
      : Res.json({ success: false, error: 'Требуется вход администратора' }, { status: 401 }))),
  };
});

// Лимит по адресу — не предмет цикла: все запросы файла идут с одного адреса.
vi.mock('@/lib/rate-limit', async (orig) => ({
  ...(await orig<typeof import('@/lib/rate-limit')>()),
  createRateLimiter: () => ({ check: () => true }),
}));

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[request-cycle.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'request_cycle_test';
const STAND = TEST_STAND_PARTNER_IDS[0];
const STAND_USER = 'c6000000-0000-4000-8000-000000000001';
const OTHER = 'c6000000-0000-4000-8000-000000000002';
const SILENT = 'c6000000-0000-4000-8000-000000000003';
const STAND_CHAT = 9101;
const FOREIGN_CHAT = 9102;
const TOURIST_CHAT = 9201;
/** Телефоны теста — заведомо не чьи-то: стендовый и пробный номер MCP. */
const PHONE = '+70000000000';
const PHONE_2 = '+79000000000';
const NAME = 'Тест';
/** Имя туриста отдельным словом: «Тестовый оператор» — название стенда, не имя. */
const hasTouristName = (text: string) => /(?<![А-Яа-яЁё])Тест(?![А-Яа-яЁё])/.test(text);

/** Дата тура — через `days` суток от сегодня по Камчатке. */
function dayAhead(days: number): string {
  const kamchatka = new Date(Date.now() + 12 * 3_600_000 + days * 86_400_000);
  return kamchatka.toISOString().slice(0, 10);
}

withPg('цикл запроса мест на тестовом операторе', () => {
  let pool: import('pg').Pool;
  let standTour = 0;
  let otherTour = 0;
  let silentTour = 0;

  const addTour = async (partner: string, title: string, published: boolean): Promise<number> => (await pool.query<{ id: string }>(
    `INSERT INTO operator_tours (operator_id, title, base_price, price_unit, max_participants, is_active, is_published, activity_type, duration_hours)
     VALUES ($1, $2, 10000, 'per_person', 8, TRUE, $3, 'hiking', 6) RETURNING id::text AS id`,
    [partner, title, published],
  )).rows.map((r) => Number(r.id))[0];

  const ask = async (body: Record<string, unknown>) => {
    const { POST } = await import('@/app/api/seat-requests/route');
    const res = await POST(new NextRequest('http://localhost/api/seat-requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
      body: JSON.stringify({ tourist_name: NAME, tourist_phone: PHONE, reply_channel: 'max', pd_consent: true, participants: 2, ...body }),
    }));
    return { status: res.status, body: await res.json() as {
      success: boolean; error?: string; reason?: string;
      data?: { status_token: string; status_url: string; deadline_at: string };
    } };
  };
  const statusOf = async (token: string) => {
    const { GET } = await import('@/app/api/seat-requests/status/route');
    const res = await GET(new NextRequest(`http://localhost/api/seat-requests/status?t=${token}`));
    return { status: res.status, body: await res.json() as { success: boolean; data?: Record<string, unknown> } };
  };
  const row = async (token: string) => {
    const { hashStatusToken } = await import('@/lib/seat-requests/core');
    return (await pool.query<{
      id: string; status: string; operator_delivery: string | null; booking_id: string | null; failure_kind: string | null; answered_via: string | null;
    }>(
      `SELECT id::text, status, operator_delivery, booking_id::text, failure_kind, answered_via
         FROM tour_seat_requests WHERE status_token_hash = $1`, [hashStatusToken(token)],
    )).rows[0];
  };
  const bookingsOn = async (tour: number, date: string) => (await pool.query<{ booking_status: string; participants: number; created_via: string | null }>(
    `SELECT booking_status, participants::int, created_via FROM operator_bookings
      WHERE operator_tour_id = $1 AND booking_date = $2::date AND deleted_at IS NULL ORDER BY id`, [tour, date],
  )).rows;
  const inbox = async () => {
    const { loadInbox } = await import('@/lib/crm/inbox');
    return loadInbox(STAND, 'operator', STAND_USER);
  };
  /** Последнее сообщение оператору стенда с кнопками ответа. */
  const toStand = (p: PdSend) => String(p.to?.maxChatId ?? '') === String(STAND_CHAT);
  const lastAsk = () => [...sent.pd].reverse().find((p) => toStand(p) && p.buttons?.some((b) => b.text === 'Есть места'));
  /** Нажатие кнопки — теми же тремя шагами, что делает вебхук MAX. */
  const press = async (payload: string, chatId: number) => {
    const { parseAnswerPayload } = await import('@/lib/seat-requests/core');
    const { requestBelongsToMaxChat, answerSeatRequest } = await import('@/lib/seat-requests/service');
    const seat = parseAnswerPayload(payload);
    if (!seat) return { refused: 'не распознана' as const };
    const mine = await requestBelongsToMaxChat(seat.requestId, chatId);
    if (mine !== true) return { refused: 'не ваш запрос' as const };
    return { result: await answerSeatRequest(seat.requestId, { kind: seat.kind }, 'max') };
  };

  beforeAll(async () => {
    // Сеть закрыта: любая попытка записывается и падает.
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      sent.net.push(String(input));
      throw new Error('сеть в тесте закрыта');
    }));
    for (const k of ['MAX_BOT_TOKEN', 'MAX_API_TOKEN', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_OWNER_ID', 'MAX_OPERATOR_CHAT_ID', 'SMTP_USER', 'SMTP_HOST']) {
      delete process.env[k];
    }
    process.env.JWT_SECRET = 'request-cycle-test-secret-0123456789';
    process.env.ENCRYPTION_KEY = 'c'.repeat(64);

    const { Pool } = await import('pg');
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 4 });
    process.env.DATABASE_URL = dbUrl;
    process.env.DATABASE_SSL = 'false';

    await pool.query(
      `INSERT INTO users (id, email, name, password_hash, role) VALUES ($1, 'stand@example.test', 'Тест', 'x', 'operator')`, [STAND_USER],
    );
    // Стенд: тестовый профиль, не на витрине, с подключённым MAX.
    await pool.query(
      `INSERT INTO partners (id, user_id, name, slug, category, contact, profile_status, is_public, is_test, max_chat_id)
       VALUES ($1, $2, 'Тестовый оператор Ведар', 'stand-operator', 'operator', '{}'::jsonb, 'approved', FALSE, TRUE, $3)`,
      [STAND, STAND_USER, STAND_CHAT],
    );
    // Обычный партнёр с каналом — его неопубликованный тур запросам закрыт.
    await pool.query(
      `INSERT INTO partners (id, name, slug, category, contact, profile_status, is_public, max_chat_id)
       VALUES ($1, 'Обычный оператор', 'plain-operator', 'operator', '{}'::jsonb, 'approved', TRUE, $2)`,
      [OTHER, FOREIGN_CHAT],
    );
    // Партнёр на витрине без MAX и Telegram: написать ему некуда.
    await pool.query(
      `INSERT INTO partners (id, name, slug, category, contact, profile_status, is_public)
       VALUES ($1, 'Оператор без канала', 'silent-operator', 'operator', '{}'::jsonb, 'approved', TRUE)`,
      [SILENT],
    );
    standTour = await addTour(STAND, 'Тур стенда', false);
    otherTour = await addTour(OTHER, 'Черновик обычного оператора', false);
    silentTour = await addTour(SILENT, 'Тур оператора без канала', true);
  }, 300_000);

  afterAll(async () => {
    const { pool: appPool } = await import('@/lib/db-pool');
    await Promise.resolve(appPool.end()).catch(() => undefined);
    await pool?.end().catch(() => undefined);
    await dropTestDatabase(PG_URL, TEST_DB).catch(() => {});
    vi.unstubAllGlobals();
  });

  describe('стенд остаётся стендом', () => {
    it('тестовый оператор и его тур на витрину не выходят', async () => {
      const { publicPartnerSql } = await import('@/lib/partners/test-profile');
      const { publicTourSql } = await import('@/lib/tours/public-visibility');
      const partners = await pool.query(`SELECT id::text FROM partners p WHERE ${publicPartnerSql('p')}`);
      expect(partners.rows.map((r) => r.id)).not.toContain(STAND);
      const tours = await pool.query<{ id: string }>(
        `SELECT t.id::text FROM operator_tours t JOIN partners p ON p.id = t.operator_id WHERE ${publicTourSql('t', 'p')}`,
      );
      // В базе теста есть и туры из миграций — судятся только свои три.
      const publicTours = tours.rows.map((r) => Number(r.id));
      expect(publicTours).toContain(silentTour);
      expect(publicTours).not.toContain(standTour);
      expect(publicTours).not.toContain(otherTour);
    });

    it('неопубликованный тур обычного партнёра запросам закрыт: правило стенда — только про стенд', async () => {
      const before = sent.pd.length;
      const r = await ask({ tour_id: otherTour, date: dayAhead(9) });
      expect(r.status).toBe(404);
      expect(r.body.reason).toBe('tour_not_found');
      expect(sent.pd.length).toBe(before);
    });
  });

  describe('«Есть места»: запрос → входящие → кнопка → бронь → турист узнал', () => {
    const date = dayAhead(10);
    let token = '';
    let requestId = '';

    it('турист отправляет запрос: оператору уходит сообщение без его данных, с кнопками ответа', async () => {
      const before = sent.pd.length;
      const r = await ask({ tour_id: standTour, date });
      expect(r.status).toBe(200);
      token = r.body.data!.status_token;
      expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
      // Ключ — во фрагменте адреса: на сервер и в журналы он не уходит.
      expect(r.body.data!.status_url).toContain(`/seat-request#${token}`);

      const saved = await row(token);
      requestId = saved.id;
      expect(saved).toMatchObject({ status: 'pending', operator_delivery: 'max', booking_id: null });

      const msg = lastAsk()!;
      expect(sent.pd.length).toBeGreaterThan(before);
      expect(toStand(msg)).toBe(true);
      expect(msg.text).toContain('Запрос мест');
      expect(msg.text).toContain('«Тур стенда»');
      expect(msg.text).toContain(date);
      expect(msg.text).toContain('2 чел.');
      // Данных туриста в запросе нет — ни в тексте для MAX, ни в заглушке.
      for (const text of [msg.text, msg.stub]) {
        expect(hasTouristName(text)).toBe(false);
        expect(text).not.toContain('70000000000');
      }
      expect(msg.buttons?.map((b) => b.text)).toEqual(['Есть места', 'Мест нет', 'Другая дата / ответить на сайте']);
    });

    it('запрос виден оператору во «Входящих» — без контактов туриста', async () => {
      const box = await inbox();
      const item = box.items.find((i) => i.kind === 'seat_request' && i.id === requestId);
      expect(item).toMatchObject({ title: 'Тур стенда', date, people: 2, contact_id: null, contact_name: null });
      expect(JSON.stringify(box)).not.toContain('70000000000');
    });

    it('турист видит «ждём ответа» на странице статуса и подключает свой чат', async () => {
      const s = await statusOf(token);
      expect(s.status).toBe(200);
      expect(s.body.data).toMatchObject({ status: 'pending', tourTitle: 'Тур стенда', date, participants: 2, bookingUrl: null, touristNotified: false });
      // Свои данные турист знает — в ответе их нет.
      expect(JSON.stringify(s.body)).not.toContain('70000000000');

      const { bindTouristChat } = await import('@/lib/seat-requests/service');
      expect(await bindTouristChat(token, 'max', TOURIST_CHAT)).toEqual({ ok: true, notified: false });
      // Чужой чат к тому же запросу не подключается.
      expect(await bindTouristChat(token, 'max', FOREIGN_CHAT)).toEqual({ ok: false, reason: 'already_bound' });
      expect(sent.dm).toHaveLength(0);
    });

    it('кнопка из чужого чата не засчитывается: запрос ждёт дальше', async () => {
      const yes = lastAsk()!.buttons!.find((b) => b.text === 'Есть места')!.payload!;
      expect(await press(yes, FOREIGN_CHAT)).toEqual({ refused: 'не ваш запрос' });
      expect(await press('sr:мусор', STAND_CHAT)).toEqual({ refused: 'не распознана' });
      expect((await row(token)).status).toBe('pending');
      expect(await bookingsOn(standTour, date)).toEqual([]);
    });

    it('оператор нажимает «Есть места»: бронь заведена и подтверждена, туристу ушёл ответ в его чат', async () => {
      const yes = lastAsk()!.buttons!.find((b) => b.text === 'Есть места')!.payload!;
      const pdBefore = sent.pd.length;
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const r = await press(yes, STAND_CHAT);
      // Сообщение туристу о подтверждении уходит вдогонку, не дожидаясь ответа двери.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(r.result).toMatchObject({ ok: true, status: 'confirmed', touristMessage: 'sent', operatorNotified: true });

      const saved = await row(token);
      expect(saved).toMatchObject({ status: 'confirmed', answered_via: 'max', failure_kind: null });
      expect(saved.booking_id).not.toBeNull();
      expect(await bookingsOn(standTour, date)).toEqual([{ booking_status: 'confirmed', participants: 2, created_via: 'seat_request' }]);

      // Туристу — в ЕГО чат, один раз, со ссылкой на бронь.
      expect(sent.dm).toHaveLength(1);
      expect(sent.dm[0].chatId).toBe(String(TOURIST_CHAT));
      expect(sent.dm[0].text).toContain('Тур стенда');
      expect(sent.dm[0].text).toContain(`/booking-success/${saved.booking_id}?t=`);
      expect(sent.tg).toHaveLength(0);

      // Контакты туриста уходят только теперь — оператору в его MAX и копией в
      // рабочий чат платформы (сообщение без адресата). Чужому партнёру — никогда;
      // в заглушке для Telegram контактов нет.
      const withContacts = sent.pd.slice(pdBefore).filter((p) => p.text.includes('70000000000'));
      expect(withContacts.some(toStand)).toBe(true);
      for (const p of withContacts) {
        expect(toStand(p) || p.to === undefined).toBe(true);
        expect(p.stub).not.toContain('70000000000');
        expect(hasTouristName(p.stub)).toBe(false);
        // А в MAX имя и телефон есть: оператору теперь есть кому звонить.
        expect(hasTouristName(p.text)).toBe(true);
      }
      // У гостя нет аккаунта — это не «контакты не прочитаны»: ложного отказа в логе нет.
      const logged = errors.mock.calls.map((c) => c.map(String).join(' '));
      errors.mockRestore();
      expect(logged.filter((l) => l.includes('чтение контактов туриста'))).toEqual([]);
    });

    it('страница статуса говорит «места есть» и даёт ссылку на бронь; во «Входящих» запрос больше не ждёт', async () => {
      const s = await statusOf(token);
      expect(s.body.data).toMatchObject({ status: 'confirmed', touristNotified: true, touristChatBound: true, failureKind: null });
      expect(String(s.body.data!.bookingUrl)).toContain('/booking-success/');
      const box = await inbox();
      expect(box.items.find((i) => i.kind === 'seat_request' && i.id === requestId)).toBeUndefined();
    });

    it('второе нажатие ничего не заводит и туристу не пишет', async () => {
      const yes = lastAsk()!.buttons!.find((b) => b.text === 'Есть места')!.payload!;
      const no = lastAsk()!.buttons!.find((b) => b.text === 'Мест нет')!.payload!;
      for (const payload of [yes, no]) {
        const r = await press(payload, STAND_CHAT);
        expect(r.result).toMatchObject({ ok: false, reason: 'already_answered' });
      }
      expect(await bookingsOn(standTour, date)).toHaveLength(1);
      expect(sent.dm).toHaveLength(1);
      expect((await row(token)).status).toBe('confirmed');
    });

    it('тот же турист на ту же дату второй запрос не отправит: ответ уже есть', async () => {
      const r = await ask({ tour_id: standTour, date });
      expect(r.body.success).toBe(false);
      expect(r.body.reason).toBe('already_confirmed');
    });
  });

  describe('«Мест нет»: ответ по ссылке с сайта, турист узнаёт на странице статуса', () => {
    const date = dayAhead(12);
    let token = '';
    let requestId = '';
    const answer = async (id: string, body: Record<string, unknown>) => {
      const { POST } = await import('@/app/api/seat-requests/[id]/answer/route');
      const res = await POST(new NextRequest(`http://localhost/api/seat-requests/${id}/answer`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }), { params: Promise.resolve({ id }) });
      return { status: res.status, body: await res.json() as { success: boolean; data?: { status: string }; error?: string } };
    };

    it('турист без мессенджера отправляет запрос; ссылка ответа подписана', async () => {
      const r = await ask({ tour_id: standTour, date, reply_channel: 'phone' });
      expect(r.status).toBe(200);
      token = r.body.data!.status_token;
      requestId = (await row(token)).id;
    });

    it('чужая подпись ответ не открывает', async () => {
      expect((await answer(requestId, { k: 'x'.repeat(32), answer: 'no' })).status).toBe(403);
      expect((await row(token)).status).toBe('pending');
    });

    it('оператор отвечает «Мест нет» по ссылке: брони нет, запрос закрыт', async () => {
      const link = lastAsk()!.buttons!.find((b) => b.url)!.url!;
      expect(link).toContain(`/seat-request/answer/${requestId}?k=`);
      const k = new URL(link).searchParams.get('k')!;
      const dmBefore = sent.dm.length;
      const r = await answer(requestId, { k, answer: 'no' });
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({ status: 'declined' });

      expect(await row(token)).toMatchObject({ status: 'declined', answered_via: 'web', booking_id: null });
      expect(await bookingsOn(standTour, date)).toEqual([]);
      // Чата у туриста нет — сообщения нет, и никто не притворяется, что оно ушло.
      expect(sent.dm.length).toBe(dmBefore);
      // Повтор по той же ссылке ответ не меняет.
      expect((await answer(requestId, { k, answer: 'yes' })).status).toBe(409);
      expect((await row(token)).status).toBe('declined');
    });

    it('страница статуса говорит «мест нет»: сообщение не уходило, ссылки на бронь нет', async () => {
      const s = await statusOf(token);
      expect(s.body.data).toMatchObject({ status: 'declined', touristNotified: false, touristChatBound: false, bookingUrl: null });
    });
  });

  describe('места считаются по живой записи, а не по слепку', () => {
    const date = dayAhead(10); // тот же день, что у подтверждённой брони на двоих; в туре восемь мест

    it('оператор говорит «есть места» группе, которая не помещается: учёт не соглашается, брони нет, туристу сказана правда', async () => {
      const r = await ask({ tour_id: standTour, date, participants: 7, tourist_phone: PHONE_2, reply_channel: 'telegram' });
      expect(r.status).toBe(200);
      const token = r.body.data!.status_token;
      const { bindTouristChat } = await import('@/lib/seat-requests/service');
      await bindTouristChat(token, 'telegram', TOURIST_CHAT + 1);

      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const yes = lastAsk()!.buttons!.find((b) => b.text === 'Есть места')!.payload!;
      const pressed = await press(yes, STAND_CHAT);
      errors.mockRestore();
      expect(pressed.result).toMatchObject({ ok: true, status: 'failed', failureKind: 'accounting', operatorNotified: null });

      expect(await row(token)).toMatchObject({ status: 'failed', failure_kind: 'accounting', booking_id: null });
      // Брони сверх вместимости нет: на дату по-прежнему одна, на двоих.
      expect(await bookingsOn(standTour, date)).toEqual([{ booking_status: 'confirmed', participants: 2, created_via: 'seat_request' }]);
      // Турист узнал в Telegram — и о том, что бронь не завелась, а не «места есть».
      expect(sent.tg).toHaveLength(1);
      expect(sent.tg[0].chatId).toBe(String(TOURIST_CHAT + 1));
      expect(sent.tg[0].text).not.toContain('/booking-success/');
      const s = await statusOf(token);
      expect(s.body.data).toMatchObject({ status: 'failed', failureKind: 'accounting', bookingUrl: null, touristNotified: true });
    });
  });

  describe('оператору некуда написать', () => {
    it('запрос не заводится, и туристу это сказано сразу, а не через два часа', async () => {
      const before = (await pool.query(`SELECT COUNT(*)::int AS n FROM tour_seat_requests`)).rows[0].n;
      const r = await ask({ tour_id: silentTour, date: dayAhead(11) });
      expect(r.body.success).toBe(false);
      expect(r.body.reason).toBe('operator_unreachable');
      expect((await pool.query(`SELECT COUNT(*)::int AS n FROM tour_seat_requests`)).rows[0].n).toBe(before);
    });
  });

  // ── Отчёт очередей администратора ─────────────────────────────────────────
  describe('отчёт очередей администратора', () => {
    type Queues = import('@/lib/admin/partner-queues').PartnerQueues;
    const read = async (): Promise<Queues> => (await import('@/lib/admin/partner-queues')).readPartnerQueues();
    const fake = (i: number) => `c6100000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`;
    const fakeUser = (i: number) => `c6200000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`;
    let before: Queues;

    /**
     * Двадцать партнёров в тех состояниях, которые создают этапы 3–5:
     *   0–5   заявка на одобрении (3 оператора, 2 гида, жильё);
     *   6–8   одобрены, не на витрине, канала нет;
     *   9–10  одобрены, не на витрине, канал есть — в очередь не входят;
     *   11–12 на витрине без канала;
     *   13    на витрине, канал — Telegram аккаунта (вход через Telegram);
     *   14–15 тестовые профили (один ждёт одобрения — в очередь не входит);
     *   16–19 на витрине с MAX; у 16–17 тур ждёт первого выклада, у 18–19 — правка.
     * И три строки, которые в очереди входить НЕ должны: одобренный агент без
     * канала (его на витрину не ставят), правка удалённого тура, отклонённая правка.
     */
    const seed = async () => {
      const state = (i: number) => {
        if (i <= 5) return { category: i <= 2 ? 'operator' : i <= 4 ? 'guide' : 'stay', status: 'pending', pub: false, test: false, max: 9300 + i };
        if (i <= 8) return { category: 'operator', status: 'approved', pub: false, test: false, max: null };
        if (i <= 10) return { category: 'transfer', status: 'approved', pub: false, test: false, max: 9300 + i };
        if (i <= 12) return { category: 'gear', status: 'approved', pub: true, test: false, max: null };
        if (i === 13) return { category: 'operator', status: 'approved', pub: true, test: false, max: null, userTelegram: 9400 };
        if (i <= 15) return { category: 'operator', status: i === 14 ? 'pending' : 'approved', pub: false, test: true, max: 9300 + i };
        return { category: 'operator', status: 'approved', pub: true, test: false, max: 9300 + i };
      };
      for (let i = 0; i < 20; i++) {
        const s = state(i);
        await pool.query(
          `INSERT INTO users (id, email, name, password_hash, role, telegram_id) VALUES ($1, $2, 'Тест', 'x', $3, $4)`,
          [fakeUser(i), `queue-${i}@example.test`, s.category, 'userTelegram' in s ? s.userTelegram : null],
        );
        await pool.query(
          `INSERT INTO partners (id, user_id, name, slug, category, contact, profile_status, is_public, is_test, max_chat_id, applied_at)
           VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, $6, $7, $8, $9, NOW())`,
          [fake(i), fakeUser(i), `Очередь ${i}`, `queue-${i}`, s.category, s.status, s.pub, s.test, s.max],
        );
      }
      // Правка и просьба о публикации — той же дверью владельца, что у кабинета (этап 4).
      const { saveTourChange } = await import('@/lib/tours/tour-change');
      const { transaction } = await import('@/lib/database');
      for (let i = 16; i < 20; i++) {
        const published = i >= 18;
        const tour = await addTour(fake(i), `Тур очереди ${i}`, published);
        const r = await transaction((client) => saveTourChange(client, {
          tourId: String(tour), ownerId: fake(i), userId: fakeUser(i),
          input: (published ? { base_price: 12000 } : { is_published: true }) as never, current: {},
        }));
        expect(r.outcome, `тур ${i}`).toBe('pending');
      }
      // Агент: одобрен, не на витрине, канала нет — но шлюз витрины его не касается.
      await pool.query(
        `INSERT INTO partners (id, name, slug, category, contact, profile_status, is_public)
         VALUES ($1, 'Очередь агент', 'queue-agent', 'agent', '{}'::jsonb, 'approved', FALSE)`, [fake(20)],
      );
      // Правка тура, который владелец потом удалил: проверять нечего.
      const gone = await addTour(fake(19), 'Удалённый тур очереди', true);
      await transaction((client) => saveTourChange(client, {
        tourId: String(gone), ownerId: fake(19), userId: fakeUser(19), input: { base_price: 13000 } as never, current: {},
      }));
      await pool.query(`UPDATE operator_tours SET deleted_at = NOW() WHERE id = $1`, [gone]);
      // Уже решённая правка — в истории, а не в очереди.
      const decided = await addTour(fake(18), 'Тур с отклонённой правкой', true);
      await pool.query(
        `INSERT INTO operator_tour_edits (tour_id, partner_id, patch, moderation_status, moderation_reason, moderated_at)
         VALUES ($1, $2, '{"title":"Другое имя"}'::jsonb, 'rejected', 'Причина отказа для теста', NOW())`, [decided, fake(18)],
      );
      // Оферту приняли двое из тех, кому она положена: 16 и 17.
      for (const i of [16, 17]) {
        const { recordOfferAcceptanceForPartner } = await import('@/lib/legal/offer-acceptance');
        expect(await recordOfferAcceptanceForPartner({ partnerId: fake(i), userId: fakeUser(i), ipAddress: null })).toBe('recorded');
      }
    };

    it('числа растут ровно на то, что завели двери: одобрение, канал, проверка туров, тестовые', async () => {
      before = await read();
      for (const v of [before.awaitingApproval.total, before.storefrontNoChannel, before.approvedNoChannel,
        before.testProfiles, before.tourEdits.newTours, before.tourEdits.edits, before.offerNotAccepted]) {
        expect(typeof v).toBe('number');
      }
      await seed();
      const after = await read();
      const diff = (a: unknown, b: unknown) => Number(a) - Number(b);

      expect(diff(after.awaitingApproval.total, before.awaitingApproval.total)).toBe(6);
      const role = (q: Queues, c: string) => q.awaitingApproval.byCategory.find((r) => r.category === c)?.count ?? 0;
      expect(role(after, 'operator') - role(before, 'operator')).toBe(3);
      expect(role(after, 'guide') - role(before, 'guide')).toBe(2);
      expect(role(after, 'stay') - role(before, 'stay')).toBe(1);

      expect(diff(after.approvedNoChannel, before.approvedNoChannel)).toBe(3);
      // Вход через Telegram — тоже канал: 13-й в «без канала» не попал.
      expect(diff(after.storefrontNoChannel, before.storefrontNoChannel)).toBe(2);
      expect(diff(after.testProfiles, before.testProfiles)).toBe(2);
      expect(diff(after.tourEdits.newTours, before.tourEdits.newTours)).toBe(2);
      expect(diff(after.tourEdits.edits, before.tourEdits.edits)).toBe(2);
      // Стороны оферты без отметки: 18 не тестовых, двое из них приняли.
      expect(diff(after.offerNotAccepted, before.offerNotAccepted)).toBe(16);
    });

    it('«канала нет» в SQL и правило доставки заявок отвечают одинаково — на каждой карточке базы', async () => {
      const { NO_CHANNEL_SQL, reachForPartner } = await import('@/lib/partners/reach');
      const { rows } = await pool.query<{ id: string; no_channel: boolean }>(
        `SELECT p.id::text, ${NO_CHANNEL_SQL} AS no_channel
           FROM partners p LEFT JOIN users u_reach ON u_reach.id = p.user_id`,
      );
      expect(rows.length).toBeGreaterThan(20);
      let withChannel = 0;
      for (const r of rows) {
        const reach = await reachForPartner(r.id);
        expect(reach, r.id).not.toBeNull();
        expect(reach!.reachable, r.id).toBe(!r.no_channel);
        if (reach!.reachable) withChannel++;
      }
      // Сверка не пустая: в базе есть и те, и другие.
      expect(withChannel).toBeGreaterThan(5);
      expect(rows.length - withChannel).toBeGreaterThan(5);
    });

    it('одобрение уменьшает очередь, шлюз канала — нет: одобрен без канала ждёт дальше', async () => {
      const was = await read();
      await pool.query(`UPDATE partners SET profile_status = 'approved', is_public = TRUE WHERE id = $1`, [fake(0)]);
      await pool.query(`UPDATE partners SET max_chat_id = 9350 WHERE id = $1`, [fake(6)]);
      const now = await read();
      expect(Number(now.awaitingApproval.total)).toBe(Number(was.awaitingApproval.total) - 1);
      expect(Number(now.approvedNoChannel)).toBe(Number(was.approvedNoChannel) - 1);
    });

    it('дверь администратора: числа, и ничего кроме чисел и ролей', async () => {
      const { GET } = await import('@/app/api/admin/partners/queues/route');
      const res = await GET(new NextRequest('http://localhost/api/admin/partners/queues'));
      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; data: Queues };
      expect(body.data).toEqual(await read());
      const text = JSON.stringify(body);
      // Ни названий карточек, ни адресов, ни id.
      expect(text).not.toContain('Очередь');
      expect(text).not.toContain('@');
      expect(text).not.toMatch(/c6[12]00000-/);
      expect(text).not.toMatch(/93\d\d/);

      admin.allowed = false;
      try {
        const denied = await GET(new NextRequest('http://localhost/api/admin/partners/queues'));
        expect(denied.status).toBe(401);
        expect(JSON.stringify(await denied.json())).not.toContain('awaitingApproval');
      } finally { admin.allowed = true; }
    });

    it('одно число не прочиталось — оно «не прочитано», остальные на месте, отказ назван в логе', async () => {
      const { readPartnerQueues } = await import('@/lib/admin/partner-queues');
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const failing = (needles: string[]) => ({
        query: (sql: string, params?: unknown[]) => (needles.some((n) => sql.includes(n))
          ? Promise.reject(Object.assign(new Error('отказ'), { code: '57014' }))
          : pool.query(sql, params)),
      });
      const q = await readPartnerQueues(failing(['operator_tour_edits', 'p.is_test IS TRUE', 'GROUP BY p.category']) as never);
      const logged = errors.mock.calls.map((c) => c.join(' '));
      errors.mockRestore();
      // Три числа не прочитаны — и названы так, а не нулём.
      expect(q.tourEdits).toEqual({ newTours: 'unknown', edits: 'unknown' });
      expect(q.testProfiles).toBe('unknown');
      expect(q.awaitingApproval).toEqual({ total: 'unknown', byCategory: [] });
      // Остальные прочитаны.
      expect(typeof q.storefrontNoChannel).toBe('number');
      expect(typeof q.approvedNoChannel).toBe('number');
      expect(typeof q.offerNotAccepted).toBe('number');
      for (const what of ['очередь проверки туров', 'тестовые профили', 'заявки на одобрении']) {
        expect(logged.some((l) => l.includes(what) && l.includes('57014')), what).toBe(true);
      }
    });

    it('очередь проверки туров читается по индексу ждущих правок (1507), а не перебором', async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // На десятках строк планировщик честно выбирает перебор. Вопрос теста —
        // есть ли у очереди индекс, которым она МОЖЕТ читаться: перебор запрещён
        // на время одного запроса.
        await client.query('SET LOCAL enable_seqscan = off');
        const { rows } = await client.query<{ 'QUERY PLAN': string }>(
          `EXPLAIN SELECT e.id FROM operator_tour_edits e WHERE e.moderation_status = 'pending' ORDER BY e.created_at ASC LIMIT 200`,
        );
        await client.query('ROLLBACK');
        expect(rows.map((r) => r['QUERY PLAN']).join('\n')).toContain('operator_tour_edits_pending_created');
      } finally { client.release(); }
    });

    it('на двадцати партнёрах с правками отчёт и очередь проверки отвечают за доли секунды', async () => {
      const { listPendingTourEdits } = await import('@/lib/tours/moderation-review');
      const timed = async <T,>(fn: () => Promise<T>) => {
        const t = performance.now();
        const value = await fn();
        return { value, ms: performance.now() - t };
      };
      // Первый вызов прогревает соединения пула — меряется второй.
      await read();
      const report = await timed(read);
      const queue = await timed(listPendingTourEdits);
      expect(queue.value.outcome).toBe('ok');
      // Порог — секунда на вызов: запас на загруженный раннер CI в сотни раз
      // больше замера на пустой машине (единицы миллисекунд).
      expect(report.ms).toBeLessThan(1000);
      expect(queue.ms).toBeLessThan(1000);
    });
  });

  it('сеть за весь прогон не тронута: ни одного запроса наружу', () => {
    expect(sent.net).toEqual([]);
  });
});

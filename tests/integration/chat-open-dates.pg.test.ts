/**
 * «Открой даты словами» (22.10, этап C) — путь записи на настоящем
 * PostgreSQL, через вебхук MAX целиком: фраза → предложение → нажатие →
 * запись общей функцией этапа B → исход словами.
 *
 * Подменён только транспорт MAX (что бот отправил) и мозг Кузьмича (сюда он
 * не доходит). Партнёр по чату, туры, предложение, захват при нажатии и
 * запись дат — настоящие: мок пула ответил бы на любой SQL, а здесь решает
 * сервер — уникальные индексы, CHECK, блокировки, вывод типов.
 *
 * Держится:
 *   - до нажатия tour_availability не меняется; нажатие пишет ровно
 *     названные даты; повтор — последовательный и одновременный — пишет один
 *     раз и отвечает «уже сделано»;
 *   - чужое предложение (другой чат, другой партнёр), чужой тур, истёкшее,
 *     заменённое, отменённое — ни строки календаря;
 *   - закрытая оператором дата («Шторм») и дата вне сезона из чата не
 *     открываются (решения владельца 22.10); занятость — по броням: бронь на
 *     9 при 8 местах — отказ;
 *   - черновик: тур кнопкой, места числом — и только после тура: номер тура
 *     текстом местами не становится; индекс тура за концом массива —
 *     «кнопка устарела», а не 23514;
 *   - две копии одного сообщения — одна строка и одно сообщение; две копии
 *     ответа числом мест — одно предложение, и помощнику-модели не уходит ни
 *     одна (второй ревью 22.10);
 *   - двойное нажатие той же кнопки тура — предложение, а не «кнопка
 *     устарела», строка меняется один раз (второй ревью 22.10);
 *   - компания без кабинета — отказ, строки нет; перевозчик — помощнику
 *     кабинета, как до этапа C (четвёртый ревью);
 *   - четвёртый ревью: поправка текстом (отказ) снимает действующее
 *     предложение — его «Открыть» не пишет; «отмена» отменяет; та же фраза
 *     ещё раз продлевает срок, и «действует 30 минут» — правда; правило
 *     фразы хранится и показывается после черновика; из группы — ответ
 *     «в личном диалоге», строки нет;
 *   - скрытый тур наравне с живым — вопрос, скрытый назван; фраза только
 *     про скрытые — «скрыты», строки нет (третий ревью 22.10);
 *   - удаление аккаунта уносит предложения из его диалога MAX — id диалога
 *     не остаётся в журнале после того, как канал снят с карточки;
 *   - миграция 1315 применяется повторно без ошибки;
 *   - шестой ревью: фразу принимает язык (lib/operators/chat-dates/grammar):
 *     «весь июль-сб», «3 августа, только 5 августа», «3 и 5 августа, 5
 *     августа — 6 мест» — отказ, строки предложения нет; повтор старого
 *     апдейта MAX (время сообщения старше) не снимает и не заменяет
 *     предложение, заведённое позже, — колонка source_sent_at миграции 1315;
 *   - пятый ревью: поправка, ушедшая помощнику («нет, 4 места», голое
 *     число при готовом предложении), снимает предложение со строкой
 *     «напишите фразу целиком», и его «Открыть» не пишет; «Выставь Горелый
 *     на <дату>» — предложение по турам из базы, а не помощнику; знак вне
 *     списка — отказ;
 *   - гид со своими турами (29.10): признак «продаёт свои туры» — настоящий
 *     (findPartnerByChat, EXISTS по его турам); фраза — предложение с
 *     кнопкой «Открыть» и строкой меню гида, нажатие открывает даты ЕГО тура
 *     (черновик тоже: это его тур), вне сезона — не открывает, ссылки — в
 *     раздел «Свои туры»; чужой тур в его предложении — refused, календарь
 *     чужого тура не тронут; гид команды без своих туров — помощнику, строки
 *     предложения нет.
 *
 * Своя база `chat_open_dates_test` — копия шаблона схемы. Без
 * KERNEL_PG_TEST_URL файл честно пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { createTestDatabase, dropTestDatabase } from '../helpers/pg-schema';

const { sent, partnerMessage } = vi.hoisted(() => ({
  sent: [] as Array<{ chatId: number; text: string; opts: unknown }>,
  partnerMessage: vi.fn(async () => undefined),
}));

// Память процесса о виденных mid (lib/max/update-dedup, 25.10) после
// перезапуска пуста, и тогда копии держит только база: здесь проверяется она.
vi.mock('@/lib/max/update-dedup', () => ({
  isRepeatedMaxMessage: () => false,
  clearMaxMessageDedup: () => undefined,
}));
vi.mock('@/lib/max/max-fetch', () => ({
  maxBot: () => ({
    api: {
      sendMessageToChat: async (chatId: number, text: string, opts: unknown) => {
        sent.push({ chatId, text, opts });
        return {};
      },
      sendMessageToUser: async () => ({}),
      answerOnCallback: async () => ({}),
    },
  }),
}));
// Мозг Кузьмича сюда не доходит: фразы про даты ведёт поток дат.
vi.mock('@/lib/kuzmich/core', () => ({
  // Живого черновика заявки нет: развилка чата судится без него.
  hasLiveBookingFlow: vi.fn(async () => false),
  processMessage: vi.fn(async () => undefined),
  cleanupPending: vi.fn(),
  saveMsg: vi.fn(async () => undefined),
  getHistory: vi.fn(async () => []),
}));

// Помощник кабинета (модель) — подменён: здесь важно, дошло ли до него
// сообщение, а не что он ответил. Проверка чата партнёра — настоящая.
vi.mock('@/lib/kuzmich/operator-chat', async (orig) => ({
  ...(await orig<typeof import('@/lib/kuzmich/operator-chat')>()),
  processPartnerMessage: partnerMessage,
}));

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[chat-open-dates.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'chat_open_dates_test';
const KEY = 'chat-open-dates-pg-key-22-10';
const CHAT_A = 810_001;
const CHAT_B = 810_002;
const CHAT_NO_ACCOUNT = 810_003;
const CHAT_CARRIER = 810_004;
const CHAT_A2 = 810_005;
const CHAT_GUIDE = 810_011;
const CHAT_TEAM_GUIDE = 810_012;

interface Button { type: string; text: string; payload: string }

let seq = 0;
async function bot(update: Record<string, unknown>, url = `https://vedarai.ru/api/max/kuzmich?s=${KEY}`): Promise<void> {
  const { POST } = await import('@/app/api/max/kuzmich/route');
  const res = await POST(new NextRequest(url, { method: 'POST', body: JSON.stringify(update) }));
  expect(res.status).toBe(200);
}
const say = (chatId: number, text: string, mid = `mid-${++seq}`, timestamp = Date.now()) => bot({
  update_type: 'message_created', timestamp,
  message: {
    sender: { user_id: chatId, name: 'Оператор' },
    recipient: { chat_id: chatId, chat_type: 'dialog' },
    body: { mid, seq: 1, text },
  },
});
const sayInGroup = (chatId: number, text: string) => bot({
  update_type: 'message_created', timestamp: Date.now(),
  message: {
    sender: { user_id: chatId, name: 'Оператор' },
    recipient: { chat_id: chatId, chat_type: 'chat' },
    body: { mid: `mid-${++seq}`, seq: 1, text },
  },
});
const press = (chatId: number, payload: string, url?: string) => bot({
  update_type: 'message_callback', timestamp: Date.now(),
  callback: { timestamp: Date.now(), callback_id: `cb-${++seq}`, payload, user: { user_id: chatId, name: 'Оператор' } },
  message: { recipient: { chat_id: chatId, chat_type: 'dialog' }, body: { mid: 'm', seq: 1, text: null } },
}, url);

const to = (chatId: number) => sent.filter((s) => s.chatId === chatId);
const lastTo = (chatId: number) => to(chatId).at(-1);
function buttons(msg: { opts: unknown } | undefined): Button[] {
  const opts = msg?.opts as { attachments?: Array<{ payload?: { buttons?: Button[][] } }> } | undefined;
  return (opts?.attachments?.[0]?.payload?.buttons ?? []).flat();
}
/** id предложения из кнопок последнего сообщения. */
function proposalId(chatId: number): string {
  const p = buttons(lastTo(chatId)).map((b) => b.payload).find((x) => x.startsWith('od:'));
  if (!p) throw new Error(`нет кнопки od: в последнем сообщении чату ${chatId}: ${lastTo(chatId)?.text}`);
  return p.split(':')[2]!;
}

/** Камчатское сегодня плюс n дней, YYYY-MM-DD. */
function day(n: number): string {
  return new Date(Date.now() + 12 * 3_600_000 + n * 86_400_000).toISOString().slice(0, 10);
}

withPg('«открой даты словами» на настоящем PostgreSQL', () => {
  let pool: import('pg').Pool;
  const partner = { a: '', b: '', noAccount: '', carrier: '', guide: '', teamGuide: '' };
  const tour = { gorely: '', fish: '', foreign: '', hidden: '', guideDraft: '' };

  async function rows(tourId: string): Promise<Array<{ date: string; slots: number; cancelled: boolean | null; reason: string | null; updated_at: string }>> {
    const r = await pool.query(
      `SELECT date::text AS date, available_slots AS slots, is_cancelled AS cancelled, cancellation_reason AS reason,
              updated_at::text AS updated_at
         FROM tour_availability WHERE operator_tour_id = $1 ORDER BY date`,
      [tourId],
    );
    return r.rows;
  }
  async function proposal(id: string): Promise<{ status: string; outcome: { kind?: string; written?: number } | null; used_at: Date | null }> {
    const r = await pool.query(`SELECT status, outcome, used_at FROM operator_chat_date_proposals WHERE id = $1`, [id]);
    return r.rows[0];
  }
  async function addTour(operatorId: string, title: string, extra: Record<string, unknown> = {}): Promise<string> {
    const cols = {
      operator_id: operatorId, title, slug: `cd-${Math.random().toString(36).slice(2, 10)}`,
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
  async function addPartner(name: string, category: string, chatId: number, withAccount: boolean): Promise<string> {
    let userId: string | null = null;
    if (withAccount) {
      userId = (await pool.query<{ id: string }>(
        `INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, 'x', $3) RETURNING id::text AS id`,
        [`${chatId}@chat-dates.test`, name, category === 'guide' ? 'guide' : 'operator'],
      )).rows[0]!.id;
    }
    return (await pool.query<{ id: string }>(
      `INSERT INTO partners (name, category, contact, user_id, max_chat_id) VALUES ($1, $2, '{}'::jsonb, $3, $4) RETURNING id::text AS id`,
      [name, category, userId, chatId],
    )).rows[0]!.id;
  }

  beforeAll(async () => {
    const { Pool } = await import('pg');
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 4 });
    process.env.DATABASE_URL = dbUrl;
    process.env.DATABASE_SSL = 'false';
    process.env.MAX_BOT_TOKEN = 'test-max-token';
    process.env.MAX_WEBHOOK_SECRET = KEY;

    partner.a = await addPartner('Оператор А', 'operator', CHAT_A, true);
    partner.b = await addPartner('Оператор Б', 'operator', CHAT_B, true);
    partner.noAccount = await addPartner('Без кабинета', 'operator', CHAT_NO_ACCOUNT, false);
    partner.carrier = await addPartner('Перевозчик', 'transfer', CHAT_CARRIER, true);
    tour.gorely = await addTour(partner.a, 'Вулкан Горелый');
    tour.fish = await addTour(partner.a, 'Летняя рыбалка', { season_start: day(30), season_end: day(60) });
    tour.hidden = await addTour(partner.a, 'Скрытый сплав', { is_active: false });
    tour.foreign = await addTour(partner.b, 'Чужой тур');
    // Гид с авторским туром (1338): черновик (не опубликован) с сезоном — его тур.
    partner.guide = await addPartner('Гид со своими турами', 'guide', CHAT_GUIDE, true);
    partner.teamGuide = await addPartner('Гид команды', 'guide', CHAT_TEAM_GUIDE, true);
    tour.guideDraft = await addTour(partner.guide, 'Толбачик гида', {
      is_published: false, season_start: day(20), season_end: day(80), max_participants: 4,
    });
  }, 300_000);

  afterAll(async () => {
    const { pool: appPool } = await import('@/lib/db-pool');
    await Promise.resolve(appPool.end()).catch(() => undefined);
    await pool?.end().catch(() => undefined);
    if (PG_URL) await dropTestDatabase(PG_URL, TEST_DB);
  });

  beforeEach(() => {
    sent.length = 0;
    partnerMessage.mockClear();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('фраза — предложение без записи; «Открыть» — ровно названные даты; повтор — ничего', async () => {
    const [d1, d2] = [day(10), day(12)];
    await say(CHAT_A, `открой ${d1} и ${d2} на Горелый, 8 мест`);
    expect(lastTo(CHAT_A)?.text).toMatch(/Понял так:[\s\S]*Вулкан Горелый[\s\S]*Мест на каждый выезд: 8[\s\S]*Откроются \(2\)/);
    expect(await rows(tour.gorely)).toEqual([]);
    const id = proposalId(CHAT_A);
    expect(buttons(lastTo(CHAT_A)).map((b) => b.payload)).toEqual([
      `od:o:${id}`, `od:x:${id}`, 'rm:op:in', 'rm:op:tk', 'rm:op:cl', 'rm:op:mn',
    ]);

    await press(CHAT_A, `od:o:${id}`);
    expect(lastTo(CHAT_A)?.text).toMatch(/^Готово, «Вулкан Горелый», 8 мест на выезд\.\nОткрыты \(2\)/);
    const written = await rows(tour.gorely);
    expect(written.map((r) => [r.date, r.slots, r.cancelled])).toEqual([[d1, 8, false], [d2, 8, false]]);
    expect(await proposal(id)).toMatchObject({ status: 'done', outcome: { kind: 'done', written: 2 } });

    // Повтор: строка не тронута, ответ — прежний итог.
    await press(CHAT_A, `od:o:${id}`);
    expect(lastTo(CHAT_A)?.text).toMatch(/^Уже сделано в \d\d:\d\d \(по Камчатке\)/);
    expect((await rows(tour.gorely)).map((r) => r.updated_at)).toEqual(written.map((r) => r.updated_at));
  });

  it('одновременное двойное нажатие — одна запись, второй видит «уже сделано»', async () => {
    const d = day(14);
    await say(CHAT_A, `открой ${d} на Горелый, 5 мест`);
    const id = proposalId(CHAT_A);
    sent.length = 0;
    await Promise.all([press(CHAT_A, `od:o:${id}`), press(CHAT_A, `od:o:${id}`)]);
    const texts = to(CHAT_A).map((m) => m.text);
    expect(texts.filter((t) => t.startsWith('Готово'))).toHaveLength(1);
    expect(texts.filter((t) => t.startsWith('Уже сделано'))).toHaveLength(1);
    expect((await rows(tour.gorely)).filter((r) => r.date === d)).toHaveLength(1);
  });

  it('нажатие без ключа подписки при заданном ключе — не обработано, ничего не записано', async () => {
    await say(CHAT_A, `открой ${day(16)} на Горелый, 5 мест`);
    const id = proposalId(CHAT_A);
    sent.length = 0;
    await press(CHAT_A, `od:o:${id}`, 'https://vedarai.ru/api/max/kuzmich');
    await press(CHAT_A, `od:o:${id}`, 'https://vedarai.ru/api/max/kuzmich?s=guess');
    expect(sent).toEqual([]);
    expect((await proposal(id)).status).toBe('ready');
    expect((await rows(tour.gorely)).some((r) => r.date === day(16))).toBe(false);
  });

  it('чужой чат и чужой партнёр — «не найдено в этом чате», ничего не записано', async () => {
    await say(CHAT_A, `открой ${day(18)} на Горелый, 5 мест`);
    const id = proposalId(CHAT_A);
    await press(CHAT_B, `od:o:${id}`);
    expect(lastTo(CHAT_B)?.text).toBe('Это предложение не найдено в этом чате — ничего не изменено.');
    expect((await proposal(id)).status).toBe('ready');
    expect((await rows(tour.gorely)).some((r) => r.date === day(18))).toBe(false);
  });

  it('чужой тур в предложении (вставлено руками) — refused, календарь чужого тура не тронут', async () => {
    const id = (await pool.query<{ id: string }>(
      `INSERT INTO operator_chat_date_proposals (partner_id, chat_id, tour_id, dates, seats, status, expires_at)
       VALUES ($1, $2, $3, ARRAY[$4::date], 5, 'ready', NOW() + INTERVAL '30 minutes') RETURNING id::text AS id`,
      [partner.a, CHAT_A2, tour.foreign, day(20)],
    )).rows[0]!.id;
    await pool.query(`UPDATE partners SET max_chat_id = $1 WHERE id = $2`, [CHAT_A2, partner.a]);
    try {
      await press(CHAT_A2, `od:o:${id}`);
      expect(lastTo(CHAT_A2)?.text).toBe('Тур снят с продажи или больше не ваш — даты не открыты.');
      expect(await proposal(id)).toMatchObject({ status: 'refused', outcome: { kind: 'refused' } });
      expect(await rows(tour.foreign)).toEqual([]);
    } finally {
      await pool.query(`UPDATE partners SET max_chat_id = $1 WHERE id = $2`, [CHAT_A, partner.a]);
    }
  });

  it('предложение, пережившее полночь: вчерашняя дата при нажатии не открывается, сегодняшняя и дальше — да', async () => {
    // Разбор фразы прошлое отсекает сам; запись проверяет «сегодня» ещё раз —
    // предложение живёт 30 минут и может пережить полночь по Камчатке.
    const [past, next] = [day(-1), day(5)];
    await pool.query(`UPDATE operator_chat_date_proposals SET status = 'superseded' WHERE chat_id = $1 AND status IN ('draft', 'ready')`, [CHAT_A]);
    const id = (await pool.query<{ id: string }>(
      `INSERT INTO operator_chat_date_proposals (partner_id, chat_id, tour_id, dates, seats, status, expires_at)
       VALUES ($1, $2, $3, ARRAY[$4::date, $5::date], 4, 'ready', NOW() + INTERVAL '30 minutes') RETURNING id::text AS id`,
      [partner.a, CHAT_A, tour.gorely, past, next],
    )).rows[0]!.id;
    await press(CHAT_A, `od:o:${id}`);
    expect(lastTo(CHAT_A)?.text).toMatch(/Открыты \(1\)[\s\S]*Не открыты — прошли \(1\)/);
    const dates = (await rows(tour.gorely)).map((r) => r.date);
    expect(dates).toContain(next);
    expect(dates).not.toContain(past);
  });

  it('истёкшее, заменённое и отменённое — ничего не записано', async () => {
    await say(CHAT_A, `открой ${day(22)} на Горелый, 5 мест`);
    const old = proposalId(CHAT_A);
    await say(CHAT_A, `открой ${day(23)} на Горелый, 5 мест`);
    const fresh = proposalId(CHAT_A);
    await press(CHAT_A, `od:o:${old}`);
    expect(lastTo(CHAT_A)?.text).toBe('Это предложение снято вашим следующим сообщением — по нему ничего не открыто. '
      + 'Нажмите кнопку под последним предложением, если оно есть, или напишите фразу ещё раз.');

    await press(CHAT_A, `od:x:${fresh}`);
    expect(lastTo(CHAT_A)?.text).toBe('Хорошо, ничего не открываю.');
    await press(CHAT_A, `od:o:${fresh}`);
    expect(lastTo(CHAT_A)?.text).toBe('Вы отменили это предложение — ничего не открыто.');

    await say(CHAT_A, `открой ${day(24)} на Горелый, 5 мест`);
    const stale = proposalId(CHAT_A);
    await pool.query(`UPDATE operator_chat_date_proposals SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [stale]);
    await press(CHAT_A, `od:o:${stale}`);
    expect(lastTo(CHAT_A)?.text).toMatch(/^Предложение устарело/);

    const dates = (await rows(tour.gorely)).map((r) => r.date);
    for (const d of [day(22), day(23), day(24)]) expect(dates).not.toContain(d);
  });

  it('закрытая «Шторм», вне сезона и записанные сверх мест — не открываются; остальное — да', async () => {
    const closed = day(35);
    const outOfSeason = day(90);
    const busy = day(40);
    const free = day(45);
    await pool.query(
      `INSERT INTO tour_availability (operator_tour_id, date, available_slots, is_cancelled, cancellation_reason)
       VALUES ($1, $2::date, 0, TRUE, 'Шторм')`,
      [tour.fish, closed],
    );
    // Бронь на дату БЕЗ строки календаря: booked_slots = 0, а записано 9.
    await pool.query(
      `INSERT INTO operator_bookings (operator_tour_id, booking_date, participants, booking_status) VALUES ($1, $2::date, 9, 'new')`,
      [tour.fish, busy],
    );
    await say(CHAT_A, `открой ${closed}, ${outOfSeason}, ${busy} и ${free} на рыбалку, 8 мест`);
    const preview = lastTo(CHAT_A)!.text;
    expect(preview).toMatch(/Откроются \(1\)/);
    expect(preview).toMatch(/Закрыты вами, не открываю \(1\): .*«Шторм»/);
    expect(preview).toMatch(/Вне сезона тура, не открою \(1\)/);
    expect(preview).toMatch(/Не открою — уже записано больше, чем 8 мест \(1\): .*записано 9 человек/);
    const id = proposalId(CHAT_A);

    await press(CHAT_A, `od:o:${id}`);
    const after = await rows(tour.fish);
    expect(after.map((r) => [r.date, r.slots, r.cancelled, r.reason])).toEqual([
      [closed, 0, true, 'Шторм'],
      [free, 8, false, null],
    ]);
    expect(lastTo(CHAT_A)?.text).toMatch(/Открыты \(1\)[\s\S]*Не открыты — закрыты вами \(1\)/);
  });

  it('черновик: тур кнопкой, места числом; индекс за концом массива — «кнопка устарела»', async () => {
    const d = day(26);
    await say(CHAT_A, `открой ${d}`);
    // Тур не назван, живых два — выбор; мест нет — спросим после.
    const id = proposalId(CHAT_A);
    expect(lastTo(CHAT_A)?.text).toMatch(/На какой тур открыть 1 дату/);
    const tourButtons = buttons(lastTo(CHAT_A)).filter((b) => b.payload.startsWith('od:t:'));
    expect(tourButtons).toHaveLength(2);

    // Номер тура текстом — не места (ревью 22.10): о местах ещё не спрашивали.
    await say(CHAT_A, '2');
    expect(lastTo(CHAT_A)?.text).toBe('Тур выберите кнопкой под сообщением, места спрошу следом. Ничего не изменено.');
    const draft = await pool.query(`SELECT status, seats, tour_id FROM operator_chat_date_proposals WHERE id = $1`, [id]);
    expect(draft.rows[0]).toEqual({ status: 'draft', seats: null, tour_id: null });

    await press(CHAT_A, `od:t:${id}:7`);
    expect(lastTo(CHAT_A)?.text).toBe('Кнопка устарела — напишите фразу ещё раз. Ничего не изменено.');
    expect((await proposal(id)).status).toBe('draft');

    const gorelyIndex = tourButtons.findIndex((b) => b.text.includes('Горелый'));
    await press(CHAT_A, `od:t:${id}:${gorelyIndex}`);
    expect(lastTo(CHAT_A)?.text).toMatch(/Сколько мест открыть на каждый выезд/);
    await press(CHAT_A, `od:o:${id}`);
    expect(lastTo(CHAT_A)?.text).toBe('Сначала напишите число мест на выезд, например: 8. Ничего не открыто.');

    await say(CHAT_A, '6');
    expect(lastTo(CHAT_A)?.text).toMatch(/Понял так:[\s\S]*Мест на каждый выезд: 6/);
    await press(CHAT_A, `od:o:${id}`);
    expect((await rows(tour.gorely)).find((r) => r.date === d)?.slots).toBe(6);
  });

  it('двойное нажатие той же кнопки тура — предложение, а не «кнопка устарела»; строка меняется один раз', async () => {
    const d = day(27);
    await say(CHAT_A, `открой ${d}, 5 мест`);
    const id = proposalId(CHAT_A);
    const gi = buttons(lastTo(CHAT_A)).filter((b) => b.payload.startsWith('od:t:')).findIndex((b) => b.text.includes('Горелый'));
    expect(gi).toBeGreaterThanOrEqual(0);
    sent.length = 0;
    await Promise.all([press(CHAT_A, `od:t:${id}:${gi}`), press(CHAT_A, `od:t:${id}:${gi}`)]);
    const texts = to(CHAT_A).map((m) => m.text);
    expect(texts).toHaveLength(2);
    for (const t of texts) expect(t).toMatch(/^Понял так:\nТур: «Вулкан Горелый»[\s\S]*Мест на каждый выезд: 5/);
    const read = async () => (await pool.query(
      `SELECT status, tour_id::text AS tour_id, expires_at::text AS expires_at FROM operator_chat_date_proposals WHERE id = $1`, [id],
    )).rows[0];
    const after = await read();
    expect(after).toMatchObject({ status: 'ready', tour_id: tour.gorely });

    // Ещё раз позже — то же предложение, срок не продлён, строка не тронута.
    await press(CHAT_A, `od:t:${id}:${gi}`);
    expect(lastTo(CHAT_A)?.text).toMatch(/^Понял так:/);
    expect(await read()).toEqual(after);
    // Другой тур после выбора — «кнопка устарела»: под показанным предложением тур не меняется.
    await press(CHAT_A, `od:t:${id}:${1 - gi}`);
    expect(lastTo(CHAT_A)?.text).toBe('Кнопка устарела — напишите фразу ещё раз. Ничего не изменено.');
    expect(await read()).toEqual(after);
    const active = await pool.query(
      `SELECT COUNT(*)::int AS n FROM operator_chat_date_proposals WHERE chat_id = $1 AND status IN ('draft', 'ready')`, [CHAT_A],
    );
    expect(active.rows[0].n).toBe(1);
  });

  it('две копии ответа числом мест — одно предложение, помощнику не уходит ни одна', async () => {
    const d = day(29);
    await say(CHAT_A, `открой ${d} на Горелый`);
    expect(lastTo(CHAT_A)?.text).toMatch(/Сколько мест открыть на каждый выезд/);
    const id = proposalId(CHAT_A);
    sent.length = 0;
    await Promise.all([say(CHAT_A, '8', 'seats-mid-1'), say(CHAT_A, '8', 'seats-mid-1')]);
    expect(partnerMessage).not.toHaveBeenCalled();
    expect(to(CHAT_A)).toHaveLength(1);
    expect(lastTo(CHAT_A)?.text).toMatch(/^Понял так:[\s\S]*Мест на каждый выезд: 8/);
    const row = await pool.query(`SELECT status, seats, seats_source_mid FROM operator_chat_date_proposals WHERE id = $1`, [id]);
    expect(row.rows[0]).toEqual({ status: 'ready', seats: 8, seats_source_mid: 'seats-mid-1' });

    // Та же копия позже — тоже ничего, даже когда в чате ждёт мест НОВЫЙ
    // черновик: старое «8» — ответ на прежний вопрос.
    await say(CHAT_A, `открой ${day(31)} на Горелый`);
    const fresh = proposalId(CHAT_A);
    sent.length = 0;
    await say(CHAT_A, '8', 'seats-mid-1');
    expect(to(CHAT_A)).toHaveLength(0);
    expect(partnerMessage).not.toHaveBeenCalled();
    const waiting = await pool.query(`SELECT status, seats FROM operator_chat_date_proposals WHERE id = $1`, [fresh]);
    expect(waiting.rows[0]).toEqual({ status: 'draft', seats: null });
    await say(CHAT_A, '4', 'seats-mid-3');
    expect(lastTo(CHAT_A)?.text).toMatch(/^Понял так:[\s\S]*Мест на каждый выезд: 4/);
    // Новое число без ждущего черновика — помощнику, как раньше.
    await say(CHAT_A, '8', 'seats-mid-2');
    expect(partnerMessage).toHaveBeenCalledTimes(1);
  });

  it('две копии одного сообщения — одна строка и одно сообщение', async () => {
    sent.length = 0;
    await Promise.all([
      say(CHAT_A, `открой ${day(28)} на Горелый, 5 мест`, 'same-mid-1'),
      say(CHAT_A, `открой ${day(28)} на Горелый, 5 мест`, 'same-mid-1'),
    ]);
    const n = await pool.query(`SELECT COUNT(*)::int AS n FROM operator_chat_date_proposals WHERE source_mid = 'same-mid-1'`);
    expect(n.rows[0].n).toBe(1);
    expect(to(CHAT_A)).toHaveLength(1);
  });

  it('компания без кабинета — отказ; перевозчик — помощнику кабинета; строки предложения нет', async () => {
    await say(CHAT_NO_ACCOUNT, `открой ${day(30)}, 5 мест`);
    expect(lastTo(CHAT_NO_ACCOUNT)?.text).toMatch(/только компания с кабинетом/);
    await say(CHAT_CARRIER, `открой ${day(30)}, 5 мест`);
    expect(to(CHAT_CARRIER)).toEqual([]);
    expect(partnerMessage).toHaveBeenCalledTimes(1);
    const n = await pool.query(
      `SELECT COUNT(*)::int AS n FROM operator_chat_date_proposals WHERE partner_id = ANY($1::uuid[])`,
      [[partner.noAccount, partner.carrier]],
    );
    expect(n.rows[0].n).toBe(0);
  });

  it('скрытый тур назван скрытым; естественная фраза с годом разбирается', async () => {
    await say(CHAT_A, `открой ${day(32)} на сплав, 5 мест`);
    expect(lastTo(CHAT_A)?.text).toMatch(/Тур «Скрытый сплав» скрыт/);

    const d = day(33);
    const [y, m, dd] = d.split('-').map(Number) as [number, number, number];
    const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
    await say(CHAT_A, `открой ${dd} ${months[m - 1]} ${y} на Горелого, 7 мест`);
    expect(lastTo(CHAT_A)?.text).toMatch(/Тур: «Вулкан Горелый»[\s\S]*Мест на каждый выезд: 7/);
  });

  it('миграция 1315 применяется повторно без ошибки', async () => {
    const sql = readFileSync(join(process.cwd(), 'migrations', '1315_operator_chat_date_proposals.sql'), 'utf8');
    await pool.query(sql);
    await pool.query(sql);
  });

  it('третий ревью: скрытый тур наравне с живым — вопрос со скрытым названным; только скрытые — «скрыты», строки нет', async () => {
    const summer = await addTour(partner.a, 'Каньон Ветровой (летний)', { is_active: false });
    const winter = await addTour(partner.a, 'Каньон Ветровой (зимний)');
    await say(CHAT_A, `открой ${day(40)} на каньон, 5 мест`);
    const msg = lastTo(CHAT_A);
    expect(msg?.text).toMatch(/^На какой тур открыть 1 дату[\s\S]*1\. Каньон Ветровой \(зимний\)/);
    expect(msg?.text).toContain('«Каньон Ветровой (летний)» скрыт — даты ему из чата не открываются, кнопки у него нет.');
    const tourButtons = buttons(msg).filter((b) => b.payload.startsWith('od:t:'));
    expect(tourButtons.map((b) => b.text)).toEqual(['1. Каньон Ветровой (зимний)']);
    // Молча зимнему ничего не записано — до кнопки тура и «Открыть» календаря нет.
    expect(await rows(winter)).toEqual([]);

    await pool.query(`UPDATE operator_tours SET is_active = false WHERE id = $1`, [winter]);
    const before = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM operator_chat_date_proposals WHERE chat_id = $1`, [CHAT_A])).rows[0]!.n;
    await say(CHAT_A, `открой ${day(41)} на каньон, 5 мест`);
    const hiddenText = lastTo(CHAT_A)?.text ?? '';
    expect(hiddenText).toMatch(/^Туры «Каньон Ветровой \((?:летний|зимний)\)», «Каньон Ветровой \((?:летний|зимний)\)» скрыты[\s\S]*Ничего не открыто\.$/);
    for (const t of ['«Каньон Ветровой (летний)»', '«Каньон Ветровой (зимний)»']) expect(hiddenText).toContain(t);
    expect(buttons(lastTo(CHAT_A)).map((b) => b.payload)).toEqual(['rm:op:in', 'rm:op:tk', 'rm:op:cl', 'rm:op:mn']);
    const after = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM operator_chat_date_proposals WHERE chat_id = $1`, [CHAT_A])).rows[0]!.n;
    expect(after).toBe(before);
    expect(await rows(summer)).toEqual([]);
    expect(await rows(winter)).toEqual([]);
  });

  it('третий ревью: удаление аккаунта уносит предложения из его диалога MAX, чужие остаются', async () => {
    const CHAT_E = 810_006;
    const MAX_USER = 77_001;
    const uid = (await pool.query<{ id: string }>(
      `INSERT INTO users (email, name, password_hash, role, max_user_id) VALUES ('erase@chat-dates.test', 'Уходящий', 'x', 'operator', $1)
       RETURNING id::text AS id`, [MAX_USER],
    )).rows[0]!.id;
    // Диалог MAX доказан перепиской: строка tg_conversations с его max_user_id (так пишет lib/kuzmich/core).
    await pool.query(
      `INSERT INTO tg_conversations (chat_id, role, content, user_id, platform) VALUES ($1, 'user', 'привет', $2, 'max')`,
      [CHAT_E, MAX_USER],
    );
    const pe = (await pool.query<{ id: string }>(
      `INSERT INTO partners (name, category, contact, user_id, max_chat_id) VALUES ('Уходящий оператор', 'operator', '{}'::jsonb, $1, $2)
       RETURNING id::text AS id`, [uid, CHAT_E],
    )).rows[0]!.id;
    await addTour(pe, 'Озеро Дальнее');
    await say(CHAT_E, `открой ${day(42)} на Дальнее, 4 места`);
    expect(lastTo(CHAT_E)?.text).toMatch(/^Понял так:/);
    const count = async (chat: number) =>
      (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM operator_chat_date_proposals WHERE chat_id = $1`, [chat])).rows[0]!.n;
    expect(await count(CHAT_E)).toBe(1);
    const others = await count(CHAT_A);
    expect(others).toBeGreaterThan(0);

    const { eraseUser } = await import('@/lib/account/erase');
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const counts = await eraseUser(c as never, uid, 'account_deleted');
      await c.query('COMMIT');
      expect(counts.operator_chat_date_proposals).toBe(1);
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      c.release();
    }
    expect(await count(CHAT_E)).toBe(0);
    expect(await count(CHAT_A)).toBe(others);
    const p = (await pool.query<{ max_chat_id: string | null }>(`SELECT max_chat_id::text FROM partners WHERE id = $1`, [pe])).rows[0]!;
    expect(p.max_chat_id).toBeNull();
  });

  describe('четвёртый ревью 22.10', () => {
    const GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
    /** Месяц через два от сегодняшнего (по Камчатке), родительный падеж: его дни впереди и в горизонте. */
    const monthAhead = (): string => GEN[(Number(day(0).slice(5, 7)) + 1) % 12]!;
    const status = async (id: string) => (await proposal(id)).status;

    it('поправка текстом (отказ) снимает предложение: его «Открыть» больше не пишет', async () => {
      await say(CHAT_A, `открой ${day(50)} на Горелый, 5 мест`);
      const id = proposalId(CHAT_A);
      await say(CHAT_A, `открой ${day(50)} на Горелый утром, 5 мест`);
      expect(lastTo(CHAT_A)?.text).toMatch(/^Не понял: «утром»/);
      expect(await status(id)).toBe('superseded');
      await press(CHAT_A, `od:o:${id}`);
      expect(lastTo(CHAT_A)?.text).toMatch(/^Это предложение снято вашим следующим сообщением/);
      expect((await rows(tour.gorely)).some((r) => r.date === day(50))).toBe(false);
    });

    it('«отмена» отменяет действующее предложение; без предложения «отмена» — помощнику', async () => {
      await say(CHAT_A, `открой ${day(51)} на Горелый, 5 мест`);
      const id = proposalId(CHAT_A);
      await say(CHAT_A, 'отмена');
      expect(lastTo(CHAT_A)?.text).toBe('Хорошо, предложение снято — ничего не открыто.');
      expect(await status(id)).toBe('cancelled');
      await press(CHAT_A, `od:o:${id}`);
      expect(lastTo(CHAT_A)?.text).toBe('Вы отменили это предложение — ничего не открыто.');
      sent.length = 0;
      await say(CHAT_A, 'стоп');
      expect(to(CHAT_A)).toEqual([]);
      expect(partnerMessage).toHaveBeenCalledTimes(1);
      expect((await rows(tour.gorely)).some((r) => r.date === day(51))).toBe(false);
    });

    it('та же фраза ещё раз — то же предложение, и срок продлён: «действует 30 минут» — правда', async () => {
      const phrase = `открой ${day(52)} на Горелый, 5 мест`;
      await say(CHAT_A, phrase);
      const id = proposalId(CHAT_A);
      await pool.query(`UPDATE operator_chat_date_proposals SET expires_at = NOW() + INTERVAL '1 minute' WHERE id = $1`, [id]);
      await say(CHAT_A, phrase);
      expect(proposalId(CHAT_A)).toBe(id);
      expect(lastTo(CHAT_A)?.text).toMatch(/Предложение действует 30 минут\.$/);
      const left = await pool.query<{ min: number }>(
        `SELECT EXTRACT(EPOCH FROM (expires_at - NOW())) / 60 AS min FROM operator_chat_date_proposals WHERE id = $1`, [id],
      );
      expect(Number(left.rows[0]!.min)).toBeGreaterThan(29);
    });

    it('правило фразы хранится: после черновика (места числом) превью показывает его так же, а даты — с днями недели', async () => {
      const m = monthAhead();
      await say(CHAT_A, `открой будни ${m} на Горелый`);
      expect(lastTo(CHAT_A)?.text).toMatch(new RegExp(`Правило: будни ${m} \\d{4}\\nДаты \\(\\d+\\): пн \\d`));
      const id = proposalId(CHAT_A);
      const row = await pool.query<{ rule_words: string | null }>(`SELECT rule_words FROM operator_chat_date_proposals WHERE id = $1`, [id]);
      expect(row.rows[0]!.rule_words).toMatch(new RegExp(`^будни ${m} \\d{4}$`));
      await say(CHAT_A, '4');
      const text = lastTo(CHAT_A)?.text ?? '';
      expect(text).toMatch(new RegExp(`^Понял так:\\nТур: «Вулкан Горелый»\\nМест на каждый выезд: 4\\nПравило: будни ${m} \\d{4}\\nДаты`));
      expect(text).not.toMatch(/(?:сб|вс) \d/);
      await press(CHAT_A, `od:x:${id}`);
    });

    it('из группы — ответ «в личном диалоге», строки предложения нет', async () => {
      const before = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM operator_chat_date_proposals WHERE chat_id = $1`, [CHAT_A])).rows[0]!.n;
      await sayInGroup(CHAT_A, `открой ${day(53)} на Горелый, 5 мест`);
      expect(lastTo(CHAT_A)?.text).toMatch(/^Открывать даты словами можно только в личном диалоге со мной/);
      expect(buttons(lastTo(CHAT_A))).toEqual([]);
      const after = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM operator_chat_date_proposals WHERE chat_id = $1`, [CHAT_A])).rows[0]!.n;
      expect(after).toBe(before);
      expect(partnerMessage).not.toHaveBeenCalled();
    });
  });
  describe('пятый ревью 22.10', () => {
    const status = async (id: string) => (await proposal(id)).status;
    const CORRECTED = 'Прежнее предложение дат снято — по нему ничего не открыто. Если хотели его поправить, '
      + 'напишите фразу целиком: даты, тур и места.';

    it.each(['нет, 4 места', '4', 'не тот тур'])('«%s» после готового предложения — снято, помощник получил текст, старое «Открыть» не пишет', async (text) => {
      const d = day(54);
      await say(CHAT_A, `открой ${d} на Горелый, 5 мест`);
      const id = proposalId(CHAT_A);
      expect(await status(id)).toBe('ready');
      await say(CHAT_A, text);
      expect(await status(id)).toBe('superseded');
      expect(lastTo(CHAT_A)?.text).toBe(CORRECTED);
      expect(partnerMessage).toHaveBeenCalledTimes(1);
      await press(CHAT_A, `od:o:${id}`);
      expect(lastTo(CHAT_A)?.text).toMatch(/^Это предложение снято вашим следующим сообщением/);
      expect((await rows(tour.gorely)).some((r) => r.date === d)).toBe(false);
    });

    it('без действующего предложения поправка — помощнику, без строки о снятии', async () => {
      await say(CHAT_A, 'нет, 4 места');
      expect(to(CHAT_A)).toEqual([]);
      expect(partnerMessage).toHaveBeenCalledTimes(1);
    });

    it('«Выставь Горелый на <дату>» — предложение по турам из базы (раньше уходило помощнику)', async () => {
      const d = day(55);
      await say(CHAT_A, `Выставь Горелый на ${d}, 5 мест`);
      expect(lastTo(CHAT_A)?.text).toMatch(/^Понял так:\nТур: «Вулкан Горелый»\nМест на каждый выезд: 5/);
      expect(partnerMessage).not.toHaveBeenCalled();
      await press(CHAT_A, `od:x:${proposalId(CHAT_A)}`);
    });

    it('знак вне списка («🚫», «-сб») — отказ, строки предложения нет, календарь не тронут', async () => {
      const before = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM operator_chat_date_proposals WHERE chat_id = $1`, [CHAT_A])).rows[0]!.n;
      await say(CHAT_A, `открой ${day(56)} 🚫 ${day(57)} на Горелый, 5 мест`);
      expect(lastTo(CHAT_A)?.text).toMatch(/^Не понял знак «🚫»/);
      const after = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM operator_chat_date_proposals WHERE chat_id = $1`, [CHAT_A])).rows[0]!.n;
      expect(after).toBe(before);
      expect((await rows(tour.gorely)).some((r) => r.date === day(56) || r.date === day(57))).toBe(false);
    });
  });
  describe('шестой ревью 22.10', () => {
    const status = async (id: string) => (await proposal(id)).status;
    const count = async () => (await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM operator_chat_date_proposals WHERE chat_id = $1`, [CHAT_A],
    )).rows[0]!.n;

    it.each([
      `открой весь июль-сб на Горелый, 5 мест`,
      `открой ${day(60)}, только ${day(61)}, на Горелый, 5 мест`,
      `открой ${day(60)} и ${day(61)}, ${day(61)} на Горелый, 5 мест`,
      `открой ${day(60)}... ${day(61)} на Горелый, 5 мест`,
    ])('«%s» — отказ, строки предложения нет, календарь не тронут', async (text) => {
      const before = await count();
      await say(CHAT_A, text);
      expect(buttons(lastTo(CHAT_A)).map((b) => b.payload)).toEqual(['rm:op:in', 'rm:op:tk', 'rm:op:cl', 'rm:op:mn']);
      expect(await count()).toBe(before);
      expect((await rows(tour.gorely)).some((r) => r.date === day(60) || r.date === day(61))).toBe(false);
    });

    it('повтор старого апдейта MAX не снимает предложение, заведённое позже', async () => {
      const t0 = Date.now();
      await say(CHAT_A, `открой ${day(62)} на Горелый, 5 мест`, `old-1-${t0}`, t0);
      const first = proposalId(CHAT_A);
      await say(CHAT_A, 'нет, 4 места', `old-2-${t0}`, t0 + 1_000);
      expect(await status(first)).toBe('superseded');
      await say(CHAT_A, `открой ${day(63)} на Горелый, 4 места`, `old-3-${t0}`, t0 + 2_000);
      const second = proposalId(CHAT_A);
      sent.length = 0;
      // MAX прислал второе сообщение ещё раз — оно старше нового предложения.
      await say(CHAT_A, 'нет, 4 места', `old-2-${t0}`, t0 + 1_000);
      expect(await status(second)).toBe('ready');
      expect(to(CHAT_A)).toEqual([]);
      // Фраза, которая старше действующего предложения, его не заменяет.
      await say(CHAT_A, `открой ${day(64)} на Горелый, 4 места`, `old-4-${t0}`, t0 + 1_500);
      expect(await status(second)).toBe('ready');
      expect(lastTo(CHAT_A)?.text).toBe('Это сообщение пришло позже нового предложения дат — по нему ничего не меняю, действует последнее.');
      await press(CHAT_A, `od:x:${second}`);
    });

    it('«ошибся», «погоди», «неправильно» — тоже поправка: предложение снято', async () => {
      for (const word of ['ошибся', 'погоди', 'неправильно']) {
        await say(CHAT_A, `открой ${day(65)} на Горелый, 5 мест`);
        const id = proposalId(CHAT_A);
        await say(CHAT_A, word);
        expect(await status(id), word).toBe('superseded');
      }
    });

    it('миграция 1315 с колонкой source_sent_at применяется повторно без ошибки', async () => {
      const sql = readFileSync(join(process.cwd(), 'migrations', '1315_operator_chat_date_proposals.sql'), 'utf8');
      await pool.query(sql);
      const col = await pool.query(
        `SELECT data_type FROM information_schema.columns WHERE table_name = 'operator_chat_date_proposals' AND column_name = 'source_sent_at'`,
      );
      expect(col.rows[0]).toEqual({ data_type: 'timestamp with time zone' });
    });
  });

  describe('гид со своими турами (29.10)', () => {
    const allTo = (chatId: number) => to(chatId).map((m) => m.text);

    it('фраза — предложение с «Открыть» и строкой меню гида; нажатие — даты его черновика, вне сезона — нет; ссылки — «Свои туры»', async () => {
      const [inSeason, outSeason] = [day(30), day(90)];
      await say(CHAT_GUIDE, `открой ${inSeason} и ${outSeason} на Толбачик, 3 места`);
      expect(partnerMessage).not.toHaveBeenCalled();
      const preview = lastTo(CHAT_GUIDE)!.text;
      expect(preview).toMatch(/Понял так:[\s\S]*Тур: «Толбачик гида»[\s\S]*Мест на каждый выезд: 3/);
      expect(preview).toMatch(/Откроются \(1\)/);
      expect(preview).toMatch(/Вне сезона тура, не открою \(1\): .*сезон тура меняет менеджер Ведара\./);
      expect(preview).toMatch(/Тур — черновик, туристы даты пока не видят: пришлите описание менеджеру Ведара/);
      expect(await rows(tour.guideDraft)).toEqual([]);
      const id = proposalId(CHAT_GUIDE);
      expect(buttons(lastTo(CHAT_GUIDE)).map((b) => b.payload)).toEqual([
        `od:o:${id}`, `od:x:${id}`, 'rm:gd:in', 'rm:gd:tk', 'rm:gd:cl', 'rm:gd:mn',
      ]);

      await press(CHAT_GUIDE, `od:o:${id}`);
      expect(lastTo(CHAT_GUIDE)?.text).toMatch(/^Готово, «Толбачик гида», 3 места на выезд\.\nОткрыты \(1\)/);
      expect(lastTo(CHAT_GUIDE)?.text).toMatch(/Проверить: https?:\/\/\S+\/hub\/guide\/own$/);
      expect((await rows(tour.guideDraft)).map((r) => [r.date, r.slots, r.cancelled])).toEqual([[inSeason, 3, false]]);
      expect(await proposal(id)).toMatchObject({ status: 'done', outcome: { kind: 'done', written: 1 } });
      // Ни одной ссылки в кабинет оператора: гида он не пустит.
      for (const t of allTo(CHAT_GUIDE)) expect(t).not.toMatch(/\/hub\/operator/);
    });

    it('чужой тур в предложении гида (вставлено руками) — refused, календарь чужого тура не тронут', async () => {
      const d = day(25);
      await pool.query(`UPDATE operator_chat_date_proposals SET status = 'superseded' WHERE chat_id = $1 AND status IN ('draft', 'ready')`, [CHAT_GUIDE]);
      const id = (await pool.query<{ id: string }>(
        `INSERT INTO operator_chat_date_proposals (partner_id, chat_id, tour_id, dates, seats, status, expires_at)
         VALUES ($1, $2, $3, ARRAY[$4::date], 5, 'ready', NOW() + INTERVAL '30 minutes') RETURNING id::text AS id`,
        [partner.guide, CHAT_GUIDE, tour.foreign, d],
      )).rows[0]!.id;
      await press(CHAT_GUIDE, `od:o:${id}`);
      expect(lastTo(CHAT_GUIDE)?.text).toBe('Тур снят с продажи или больше не ваш — даты не открыты.');
      expect(await proposal(id)).toMatchObject({ status: 'refused', outcome: { kind: 'refused' } });
      expect((await rows(tour.foreign)).some((r) => r.date === d)).toBe(false);
    });

    it('предложение туроператора из чата гида — «не найдено в этом чате», ничего не записано', async () => {
      const d = day(71);
      await say(CHAT_A, `открой ${d} на Горелый, 5 мест`);
      const id = proposalId(CHAT_A);
      await press(CHAT_GUIDE, `od:o:${id}`);
      expect(lastTo(CHAT_GUIDE)?.text).toBe('Это предложение не найдено в этом чате — ничего не изменено.');
      expect((await proposal(id)).status).toBe('ready');
      expect((await rows(tour.gorely)).some((r) => r.date === d)).toBe(false);
    });

    it('гид команды без своих туров — фраза помощнику кабинета, строки предложения нет', async () => {
      await say(CHAT_TEAM_GUIDE, `открой ${day(30)}, 5 мест`);
      expect(to(CHAT_TEAM_GUIDE)).toEqual([]);
      expect(partnerMessage).toHaveBeenCalledTimes(1);
      const n = await pool.query(`SELECT COUNT(*)::int AS n FROM operator_chat_date_proposals WHERE partner_id = $1::uuid`, [partner.teamGuide]);
      expect(n.rows[0].n).toBe(0);
    });
  });
  it('даты кнопками (31.10): «Обновить места» → тур → месяц → выходные → 6 мест — предложение без записи, «Открыть» пишет ровно их', async () => {
    const { kamchatkaDate } = await import('@/lib/analytics/kamchatka-day');
    const { dw, wizardDates, wizardMonths } = await import('@/lib/operators/chat-dates/wizard');
    const wizardTour = await addTour(partner.a, 'Мутновский кнопками');
    const today = kamchatkaDate(new Date());
    const month = wizardMonths(today)[2]!;
    const expected = wizardDates(month, 'e', today);
    expect(expected.length).toBeGreaterThanOrEqual(8);

    await press(CHAT_A, 'opd:seats');
    const start = buttons(lastTo(CHAT_A)).map((b) => b.payload);
    expect(start).toContain(dw.month(wizardTour));
    expect(start).toContain(dw.month(tour.gorely));
    expect(start).not.toContain(dw.month(tour.hidden));
    expect(start).not.toContain(dw.month(tour.foreign));
    // Чужой тур кнопкой — «тура нет», предложения нет.
    await press(CHAT_A, dw.go(tour.foreign, month, 'e', 6));
    expect(lastTo(CHAT_A)?.text).toContain('Этого тура больше нет среди ваших живых');

    await press(CHAT_A, dw.month(wizardTour));
    await press(CHAT_A, dw.days(wizardTour, month));
    expect(buttons(lastTo(CHAT_A)).map((b) => b.payload)).toContain(dw.seats(wizardTour, month, 'e'));
    await press(CHAT_A, dw.seats(wizardTour, month, 'e'));
    await press(CHAT_A, dw.go(wizardTour, month, 'e', 6));
    expect(lastTo(CHAT_A)?.text).toMatch(/Понял так:[\s\S]*Мутновский кнопками[\s\S]*Мест на каждый выезд: 6[\s\S]*Правило: выходные/);
    expect(await rows(wizardTour)).toEqual([]);
    const id = proposalId(CHAT_A);
    const stored = (await pool.query<{ dates: string[]; seats: number; rule_words: string | null; source_mid: string | null }>(
      `SELECT dates::text[] AS dates, seats, rule_words, source_mid FROM operator_chat_date_proposals WHERE id = $1`, [id],
    )).rows[0]!;
    expect(stored).toMatchObject({ dates: expected, seats: 6, source_mid: null });
    expect(stored.rule_words).toMatch(/^выходные /);
    // Повтор той же кнопки — то же предложение, второй строки нет.
    await press(CHAT_A, dw.go(wizardTour, month, 'e', 6));
    expect(proposalId(CHAT_A)).toBe(id);

    await press(CHAT_A, `od:o:${id}`);
    const written = await rows(wizardTour);
    expect(written.map((r) => r.date)).toEqual(expected);
    expect(written.every((r) => r.slots === 6)).toBe(true);
    expect((await proposal(id)).status).toBe('done');
  });
});

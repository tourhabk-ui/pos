/**
 * «Открой даты словами» (22.10, этап C) — двери вебхука MAX вызовом
 * POST /api/max/kuzmich с настоящим модулем потока (lib/operators/chat-dates):
 * подменены пул, транспорт MAX и проверка партнёра по чату.
 *
 * Держится: ни одной записи (ни INSERT, ни UPDATE, ни вызова записи дат)
 *   - на незаверенное нажатие `od:` — без ключа бот говорит «не засчитано»,
 *     при заданном ключе запрос без него не обрабатывается вовсе;
 *   - на нажатие без сообщения с кнопкой и не из личного диалога;
 *   - когда партнёр по чату не найден, не проверен (база не ответила), не
 *     туроператор или без кабинета — каждому свой ответ, «не смог» не равно
 *     «нельзя»;
 *   - на фразу про даты из незаверенного апдейта, из группы и из чата, чей
 *     партнёр не проверен (в туристский поток она не уходит); из группы —
 *     ответ «даты — в личном диалоге», а не молчание (четвёртый ревью);
 *   - гид команды без своих туров, перевозчик, владелец жилья: фраза с
 *     «открой» и датой — помощнику кабинета, как до этапа C, а не готовый
 *     отказ (четвёртый ревью);
 *   - гид со своими турами (29.10, шаг 8 плана «гид в мессенджере»): тот же
 *     поток, что у туроператора — фраза доходит до потока, а не до
 *     помощника; поправка снимает его предложение; нажатие `od:` ищет
 *     предложение его карточки; каждая ссылка ответа — раздел «Свои туры», а
 *     не кабинет оператора;
 *   - поправка текстом (отказ, вопрос) и «отмена» снимают действующее
 *     предложение чата: старая кнопка «Открыть» больше не пишет; поправка,
 *     ушедшая помощнику («нет, 4 места», «4», «не тот тур»), — тоже, со
 *     строкой «напишите фразу целиком» (пятый ревью);
 *   - при выключателе — ни на фразу, ни на нажатие, ответ со ссылкой;
 *   - дела помощника кабинета (задача, касание, клиент, счёт — ревью 22.10;
 *     контакт, лид, переписка, статистика, доступ, «добавь 2 человека в
 *     группу» — второй ревью) у туроператора, гида и перевозчика доходят до
 *     помощника, а не до потока дат: ни отказа «открывать даты можно…», ни
 *     строки предложения.
 * Путь записи на настоящем PostgreSQL — tests/integration/chat-open-dates.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { PRESS_WITHOUT_MESSAGE_REPLY, UNVERIFIED_CHAT_REPLY, UNVERIFIED_PRESS_REPLY } from '@/lib/max/verified-press';

const m = vi.hoisted(() => ({
  maxSend: vi.fn(),
  maxSendUser: vi.fn(),
  answerCb: vi.fn(),
  pool: vi.fn(),
  client: vi.fn(),
  processMessage: vi.fn(),
  saveMsg: vi.fn(),
  findPartner: vi.fn(),
  partnerMessage: vi.fn(),
  openTx: vi.fn(),
  preview: vi.fn(),
  switchOn: { value: true },
}));

vi.mock('@/lib/max/max-fetch', () => ({
  maxBot: () => ({ api: { sendMessageToChat: m.maxSend, sendMessageToUser: m.maxSendUser, answerOnCallback: m.answerCb } }),
}));
vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: m.pool,
    connect: async () => ({ query: m.client, release: () => undefined }),
  },
}));
vi.mock('@/lib/kuzmich/core', () => ({
  // Живого черновика заявки нет: развилка чата судится без него.
  hasLiveBookingFlow: vi.fn(async () => false),
  processMessage: m.processMessage, cleanupPending: vi.fn(), saveMsg: m.saveMsg, getHistory: vi.fn(async () => []),
}));
vi.mock('@/lib/kuzmich/operator-chat', () => ({
  PARTNER_EMAIL_BIND_CLOSED: 'привязка по почте закрыта',
  findPartnerByChat: m.findPartner,
  processPartnerMessage: m.partnerMessage,
}));
vi.mock('@/lib/tours/availability-open', async (orig) => ({
  ...(await orig<typeof import('@/lib/tours/availability-open')>()),
  openTourDatesTx: m.openTx,
  previewTourDates: m.preview,
}));
// Администратор в MAX (23.10) узнаётся раньше чата партнёра; здесь пишет
// партнёр, не администратор, — база администраторов не участвует.
vi.mock('@/lib/max/admin-link', () => ({
  findMaxAdmin: async () => ({ outcome: 'none' }),
  handleAdminStart: async () => false,
}));
vi.mock('@/lib/operators/chat-dates/switch', () => ({
  get CHAT_OPEN_DATES_ENABLED() { return m.switchOn.value; },
}));

const max = await import('@/app/api/max/kuzmich/route');
// Тесты шлют одни и те же mid: повтор сообщения отсекается (25.10), память — заново на тест.
const { clearMaxMessageDedup } = await import('@/lib/max/update-dedup');

const KEY = 'test-webhook-key-chat-dates';
const CHAT = 4_401;
const PROPOSAL = '0b8c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3';
const VERIFIED = `http://localhost/api/max/kuzmich?s=${KEY}`;
const UNVERIFIED = ['http://localhost/api/max/kuzmich', 'http://localhost/api/max/kuzmich?s=guess'];
const OD_PAYLOADS = [`od:o:${PROPOSAL}`, `od:x:${PROPOSAL}`, `od:t:${PROPOSAL}:1`];

const operator = { partnerId: 'p-op', partnerName: 'Оператор', category: 'operator', crmCategory: 'operator', userId: 'u-op' };
/** Гид со своими турами (1338): признак `sellsTours` приносит `findPartnerByChat`. */
const guideSeller = { ...operator, partnerId: 'p-gd', partnerName: 'Гид', category: 'guide', crmCategory: 'guide', userId: 'u-gd', sellsTours: true };
/** Гид из команды оператора — своих туров нет. */
const teamGuide = { ...operator, partnerId: 'p-tg', partnerName: 'Гид команды', category: 'guide', crmCategory: 'guide', userId: 'u-tg', sellsTours: false };
/** Ни одной ссылки в кабинет оператора: гида он не пустит. */
const expectGuideLinks = (texts: string[]): void => {
  for (const t of texts) expect(t).not.toMatch(/\/hub\/operator/);
  expect(texts.some((t) => /https?:\/\/\S+\/hub\/guide\/own/.test(t))).toBe(true);
};

const post = (url: string, body: unknown) => max.POST(new NextRequest(url, { method: 'POST', body: JSON.stringify(body) }));
const keyless = (): void => { vi.stubEnv('MAX_WEBHOOK_SECRET', ''); };

const press = (payload: string, opts: { chatId?: number | null; chatType?: string } = {}) => ({
  update_type: 'message_callback',
  timestamp: 1,
  callback: { timestamp: 1, callback_id: 'cb-1', payload, user: { user_id: CHAT, name: 'Оператор' } },
  ...(opts.chatId === null ? {} : {
    message: { recipient: { chat_id: opts.chatId ?? CHAT, chat_type: opts.chatType ?? 'dialog' }, body: { mid: 'm', seq: 1, text: null } },
  }),
});
/** Каждое сообщение — своё: одинаковый mid отсёкся бы как повтор доставки. */
let midSeq = 0;
const message = (text: string, chatType = 'dialog') => ({
  update_type: 'message_created',
  timestamp: 1,
  message: {
    sender: { user_id: CHAT, name: 'Оператор' },
    recipient: { chat_id: CHAT, chat_type: chatType },
    body: { mid: `mid-${++midSeq}`, seq: 1, text },
  },
});

const repliesTo = (chatId: number) => m.maxSend.mock.calls.filter((c) => c[0] === chatId).map((c) => String(c[1]));

/** Ни записи в базу (пулом или клиентом транзакции), ни вызова записи дат. */
function expectNothingWritten(): void {
  // «FOR UPDATE» — блокировка чтения, не запись.
  const writes = [...m.pool.mock.calls, ...m.client.mock.calls]
    .filter((c) => /\b(?:INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i.test(String(c[0])));
  expect(writes).toEqual([]);
  expect(m.openTx).not.toHaveBeenCalled();
}
/** Снятие действующего предложения чата поправкой: `[статус, чат]` каждого вызова. */
const RETIRE = /UPDATE operator_chat_date_proposals SET status = \$2\s+WHERE channel = \$3 AND chat_id = \$1::bigint AND status IN \('draft', 'ready'\)/;
function retires(): Array<[string, string]> {
  return m.pool.mock.calls.filter((c) => RETIRE.test(String(c[0])))
    .map((c) => { const p = c[1] as [string, string, string]; return [p[1], p[0]]; });
}
/** Ни записи дат и предложений; снятие прежнего предложения поправкой — можно, это не запись дат. */
function expectNoDatesWritten(): void {
  const writes = [...m.pool.mock.calls, ...m.client.mock.calls]
    .filter((c) => /\b(?:INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i.test(String(c[0])) && !RETIRE.test(String(c[0])));
  expect(writes).toEqual([]);
  expect(m.openTx).not.toHaveBeenCalled();
}

let errorLog: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  clearMaxMessageDedup();
  for (const f of [m.maxSend, m.maxSendUser, m.answerCb, m.pool, m.client, m.processMessage, m.saveMsg, m.findPartner, m.partnerMessage, m.openTx, m.preview]) f.mockReset();
  m.switchOn.value = true;
  m.maxSend.mockResolvedValue({});
  m.maxSendUser.mockResolvedValue({});
  m.answerCb.mockResolvedValue({});
  m.pool.mockResolvedValue({ rows: [], rowCount: 0 });
  m.client.mockResolvedValue({ rows: [], rowCount: 0 });
  m.findPartner.mockResolvedValue({ outcome: 'found', partner: operator });
  vi.stubEnv('MAX_BOT_TOKEN', 'test-token');
  vi.stubEnv('MAX_WEBHOOK_SECRET', KEY);
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('нажатие od: — только заверенное, из диалога, из чата кабинета туроператора', () => {
  for (const payload of OD_PAYLOADS) {
    const name = payload.slice(0, 4);

    it(`${name}: ключ задан, запрос без него — не обработан вовсе`, async () => {
      for (const url of UNVERIFIED) await post(url, press(payload));
      expectNothingWritten();
      expect(m.findPartner).not.toHaveBeenCalled();
      expect(m.maxSend).not.toHaveBeenCalled();
    });

    it(`${name}: ключа нет — не засчитано, и бот это говорит; партнёр даже не ищется`, async () => {
      keyless();
      for (const url of [...UNVERIFIED, VERIFIED]) {
        m.maxSend.mockClear();
        await post(url, press(payload));
        expect(repliesTo(CHAT)).toEqual([UNVERIFIED_PRESS_REPLY.dates]);
      }
      expectNothingWritten();
      expect(m.findPartner).not.toHaveBeenCalled();
    });

    it(`${name}: без сообщения с кнопкой — не применено; нажавший узнаёт лично`, async () => {
      await post(VERIFIED, press(payload, { chatId: null }));
      expectNothingWritten();
      expect(m.maxSend).not.toHaveBeenCalled();
      expect(m.maxSendUser.mock.calls).toEqual([[CHAT, PRESS_WITHOUT_MESSAGE_REPLY.dates, expect.anything()]]);
    });

    it(`${name}: не из личного диалога — не применено, без ответа, в логе причина`, async () => {
      await post(VERIFIED, press(payload, { chatType: 'chat' }));
      expectNothingWritten();
      expect(m.maxSend).not.toHaveBeenCalled();
      expect(errorLog.mock.calls.some((c) => String(c[0]).includes('не из личного диалога'))).toBe(true);
    });
  }

  it('партнёр по чату: не проверен / не найден / перевозчик / без кабинета — свой ответ, записи нет', async () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ outcome: 'unavailable' }, /^Не смог проверить нажатие — ничего не изменено/],
      [{ outcome: 'none' }, /^Эта кнопка работает только в чате кабинета оператора/],
      [{ outcome: 'found', partner: { ...operator, category: 'transfer' } }, /^Эта кнопка работает только в чате кабинета оператора/],
      // Гид команды без своих туров — не продавец: кнопка дат не его.
      [{ outcome: 'found', partner: teamGuide }, /^Эта кнопка работает только в чате кабинета оператора или гида со своими турами/],
      [{ outcome: 'found', partner: { ...operator, userId: null } }, /только компания с кабинетом/],
    ];
    for (const [lookup, reply] of cases) {
      m.maxSend.mockClear();
      m.findPartner.mockResolvedValueOnce(lookup);
      await post(VERIFIED, press(`od:o:${PROPOSAL}`));
      expect(repliesTo(CHAT)).toHaveLength(1);
      expect(repliesTo(CHAT)[0]).toMatch(reply);
    }
    expectNothingWritten();
  });

  it('заверенное нажатие чужого предложения — «не найдено в этом чате», записи нет', async () => {
    // SELECT … FOR UPDATE по id, чату и партнёру не нашёл строки.
    await post(VERIFIED, press(`od:o:${PROPOSAL}`));
    expect(repliesTo(CHAT)).toEqual(['Это предложение не найдено в этом чате — ничего не изменено.']);
    const lock = m.client.mock.calls.map((c) => String(c[0])).find((s) => /FOR UPDATE/.test(s)) ?? '';
    expect(lock).toMatch(/chat_id = \$2::bigint AND partner_id = \$3::uuid/);
    const params = m.client.mock.calls.find((c) => /FOR UPDATE/.test(String(c[0])))?.[1];
    expect(params).toEqual([PROPOSAL, String(CHAT), operator.partnerId]);
    expectNothingWritten();
  });

  it('кнопка не той формы (od:t с индексом 9, не uuid) — «не распознана», записи нет', async () => {
    for (const payload of [`od:t:${PROPOSAL}:9`, 'od:o:not-a-uuid', 'od:z:' + PROPOSAL]) {
      m.maxSend.mockClear();
      await post(VERIFIED, press(payload));
      expect(repliesTo(CHAT)).toEqual(['Кнопка не распознана — ничего не изменено. Напишите фразу ещё раз.']);
    }
    expectNothingWritten();
  });
});

describe('фраза про даты в чате партнёра', () => {
  const PHRASE = 'открой субботы июля, 8 мест';

  it('ключа нет — помощник кабинета и поток дат не запускаются, предложения нет', async () => {
    keyless();
    await post(UNVERIFIED[0]!, message(PHRASE));
    expect(repliesTo(CHAT)).toEqual([UNVERIFIED_CHAT_REPLY.partner]);
    expectNothingWritten();
    expect(m.partnerMessage).not.toHaveBeenCalled();
    expect(m.processMessage).not.toHaveBeenCalled();
  });

  it('партнёр не проверен (база не ответила) — «сбой, ничего не изменено», в туристский поток не уходит', async () => {
    m.findPartner.mockResolvedValueOnce({ outcome: 'unavailable' });
    await post(VERIFIED, message(PHRASE));
    // Слова — для любого: проверка чата не прошла, и неизвестно, турист это или оператор.
    expect(repliesTo(CHAT)).toEqual(['Сбой на нашей стороне — ничего не изменено, попробуйте через минуту.']);
    expect(m.processMessage).not.toHaveBeenCalled();
    expectNothingWritten();
  });

  it('не из личного диалога — ответ «даты — в личном диалоге»: ни предложения, ни помощника; в логе причина (четвёртый ревью: раньше молчание)', async () => {
    await post(VERIFIED, message(PHRASE, 'chat'));
    expect(repliesTo(CHAT)).toEqual([
      'Открывать даты словами можно только в личном диалоге со мной: в группе кнопку «Открыть» нажал бы любой участник. '
      + 'Напишите эту фразу мне в личные сообщения. Ничего не открыто.',
    ]);
    expect(m.partnerMessage).not.toHaveBeenCalled();
    expect([...m.pool.mock.calls, ...m.client.mock.calls].filter((c) => /operator_chat_date_proposals/.test(String(c[0])))).toEqual([]);
    expectNothingWritten();
    expect(errorLog.mock.calls.some((c) => String(c[0]).includes('не из личного диалога'))).toBe(true);
  });

  it('группа: дело помощника с датой и местами («Добавь на 5 августа Иванову 2 места») — помощнику, а не «в личном диалоге»', async () => {
    await post(VERIFIED, message('Добавь на 5 августа Иванову 2 места', 'chat'));
    expect(m.partnerMessage).toHaveBeenCalledTimes(1);
    expect(m.maxSend).not.toHaveBeenCalled();
    expectNothingWritten();
  });

  it('группа: «отмена» и голое число — помощнику, предложения в группе не бывает', async () => {
    await post(VERIFIED, message('отмена', 'chat'));
    await post(VERIFIED, message('8', 'chat'));
    expect(m.partnerMessage).toHaveBeenCalledTimes(2);
    expect(m.maxSend).not.toHaveBeenCalled();
    expectNothingWritten();
  });

  it('вид чата из тела в лог — только узнаваемой формой: перевод строки и чужая запись не проходят (ревью 22.10)', async () => {
    const forged = 'chat\n[max/kuzmich] FAKE: оператор +7 900 000-00-00 подтвердил оплату' + 'x'.repeat(5000);
    // Без ключа фраза доходит до проверки группы раньше, чем до проверки заверенности.
    keyless();
    await post(UNVERIFIED[0]!, message(PHRASE, forged));
    // С ключом — нажатие кнопки дат из «группы» с тем же видом чата.
    vi.stubEnv('MAX_WEBHOOK_SECRET', KEY);
    await post(VERIFIED, press(`od:o:${PROPOSAL}`, { chatType: forged }));
    const logged = errorLog.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(logged).toContain('фраза про даты не из личного диалога (вид чата не узнан)');
    expect(logged).toContain('нажатие (dates) не из личного диалога (вид чата не узнан)');
    expect(logged).not.toContain('FAKE');
    expect(logged).not.toContain('+7 900');
    expect(logged.length).toBeLessThan(2000);
    expectNothingWritten();
  });

  it('туристу вид чата ничего не меняет: фраза с «открой» уходит Кузьмичу', async () => {
    m.findPartner.mockResolvedValue({ outcome: 'none' });
    await post(VERIFIED, message(PHRASE, 'chat'));
    expect(m.processMessage).toHaveBeenCalledTimes(1);
    expectNothingWritten();
  });

  it('компания без кабинета — отказ словами, туры не читаются, записи нет', async () => {
    m.findPartner.mockResolvedValueOnce({ outcome: 'found', partner: { ...operator, userId: null } });
    await post(VERIFIED, message(PHRASE));
    const said = repliesTo(CHAT);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/только компания с кабинетом/);
    expect(m.pool).not.toHaveBeenCalled();
    expect(m.partnerMessage).not.toHaveBeenCalled();
  });

  it('гид команды без своих туров, перевозчик, владелец жилья: фраза про даты — помощнику кабинета, как до этапа C, а не отказ «это для туроператора»', async () => {
    const phrases = [PHRASE, 'открой 3 августа, 8 мест', 'открой весь июль без выходных', 'отмена', '8'];
    const partners = [
      teamGuide,
      // Старый вызов без признака — не продавец, как до 29.10.
      { ...operator, category: 'guide', crmCategory: 'guide' },
      { ...operator, category: 'transfer', crmCategory: 'transfer' },
      { ...operator, category: 'stay', crmCategory: 'stay' },
    ];
    for (const partner of partners) {
      m.partnerMessage.mockClear();
      m.findPartner.mockResolvedValue({ outcome: 'found', partner });
      for (const text of phrases) await post(VERIFIED, message(text));
      expect(m.partnerMessage.mock.calls.map((c) => (c[0] as { text: string }).text), partner.category).toEqual(phrases);
    }
    expect(m.maxSend).not.toHaveBeenCalled();
    expect(m.pool).not.toHaveBeenCalled();
    expectNothingWritten();
  });

  it('не про даты — помощнику кабинета, как раньше', async () => {
    await post(VERIFIED, message('кто ждёт ответа?'));
    expect(m.partnerMessage).toHaveBeenCalledTimes(1);
    expectNothingWritten();
  });

  it('туры не прочитались — «не смог прочитать туры», это не «туров нет»; прежнее предложение снято', async () => {
    m.pool.mockRejectedValueOnce(Object.assign(new Error('сбой'), { code: '57014' }));
    await post(VERIFIED, message(PHRASE));
    expect(repliesTo(CHAT)).toEqual(['Не смог прочитать ваши туры — ничего не открыто, попробуйте через минуту.']);
    expect(retires()).toEqual([['superseded', String(CHAT)]]);
    expectNoDatesWritten();
    expect(errorLog.mock.calls.some((c) => c.map(String).join(' ').includes('SQLSTATE 57014'))).toBe(true);
  });
});

describe('гид со своими турами (29.10): даты словами — тот же поток, ссылки — «Свои туры»', () => {
  const PHRASE = 'открой субботы июля, 8 мест';
  /** Запросы к турам партнёра (поток дат читает их перед разбором). */
  const tourReads = () => m.pool.mock.calls.filter((c) => /FROM operator_tours/.test(String(c[0])));
  beforeEach(() => { m.findPartner.mockResolvedValue({ outcome: 'found', partner: guideSeller }); });

  it('фраза доходит до потока, а не до помощника: туры читаются по его карточке; нет активных — ответ со ссылкой в «Свои туры»', async () => {
    await post(VERIFIED, message(PHRASE));
    expect(m.partnerMessage).not.toHaveBeenCalled();
    expect(m.processMessage).not.toHaveBeenCalled();
    expect(tourReads().map((c) => (c[1] as unknown[])[0])).toEqual(['p-gd']);
    const said = repliesTo(CHAT);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/^У вас нет активных туров — открывать даты некуда\. Скрытый тур включает менеджер Ведара\. Ваши туры: /);
    expectGuideLinks(said);
    expectNoDatesWritten();
  });

  it('отказ и вопрос разбора — ссылка в «Свои туры», прежнее предложение снято', async () => {
    for (const text of ['закрой субботы июля', 'открой июль, 8 мест']) await post(VERIFIED, message(text));
    const said = repliesTo(CHAT);
    expect(said).toHaveLength(2);
    expect(said[0]).toMatch(/^Закрыть даты из чата пока нельзя\. В кабинете: https?:\/\/\S+\/hub\/guide\/own$/);
    expect(said[1]).toMatch(/^Весь июль/);
    for (const t of said) expectGuideLinks([t]);
    expect(retires()).toEqual([['superseded', String(CHAT)], ['superseded', String(CHAT)]]);
    expect(m.partnerMessage).not.toHaveBeenCalled();
    expectNoDatesWritten();
  });

  it('карточка без кабинета — отказ словами гида; туры не читаются, записи нет', async () => {
    m.findPartner.mockResolvedValue({ outcome: 'found', partner: { ...guideSeller, userId: null } });
    await post(VERIFIED, message(PHRASE));
    const said = repliesTo(CHAT);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/^Открывать даты из чата может только гид с кабинетом на Ведаре/);
    expectGuideLinks(said);
    expect(tourReads()).toEqual([]);
    expect(m.partnerMessage).not.toHaveBeenCalled();
    expectNothingWritten();
  });

  it('из группы — «в личном диалоге», предложения нет', async () => {
    await post(VERIFIED, message(PHRASE, 'chat'));
    expect(repliesTo(CHAT)).toEqual([expect.stringMatching(/^Открывать даты словами можно только в личном диалоге со мной/)]);
    expect(m.partnerMessage).not.toHaveBeenCalled();
    expectNothingWritten();
  });

  it('нажатие od: — предложение ищется по карточке гида и его чату; чужое — «не найдено», записи нет', async () => {
    await post(VERIFIED, press(`od:o:${PROPOSAL}`));
    expect(repliesTo(CHAT)).toEqual(['Это предложение не найдено в этом чате — ничего не изменено.']);
    const params = m.client.mock.calls.find((c) => /FOR UPDATE/.test(String(c[0])))?.[1];
    expect(params).toEqual([PROPOSAL, String(CHAT), 'p-gd']);
    expectNothingWritten();
  });

  it('нажатие гида без кабинета — отказ словами гида; выключатель — ссылка в «Свои туры»', async () => {
    m.findPartner.mockResolvedValue({ outcome: 'found', partner: { ...guideSeller, userId: null } });
    await post(VERIFIED, press(`od:o:${PROPOSAL}`));
    m.findPartner.mockResolvedValue({ outcome: 'found', partner: guideSeller });
    m.switchOn.value = false;
    await post(VERIFIED, message(PHRASE));
    await post(VERIFIED, press(`od:o:${PROPOSAL}`));
    const said = repliesTo(CHAT);
    expect(said).toHaveLength(3);
    expect(said[0]).toMatch(/^Открывать даты из чата может только гид с кабинетом/);
    expect(said[1]).toMatch(/^Открывать даты из чата сейчас нельзя\. В кабинете: https?:\/\/\S+\/hub\/guide\/own$/);
    expect(said[2]).toBe(said[1]);
    for (const t of said) expectGuideLinks([t]);
    expectNothingWritten();
  });
});

describe('четвёртый ревью 22.10: поправка текстом гасит предложение', () => {
  it.each([
    ['открой весь июль без выходных, 8 мест', /^Исключения дней недели/],
    ['открой сб или вс июля, 8 мест', /^«или» не разбираю/],
    ['открой 3 августа утром, 8 мест', /^Не понял: «утром»/],
    ['открой июль, 8 мест', /^Весь июль/],
    ['закрой субботы июля', /^Закрыть даты из чата пока нельзя/],
  ])('«%s» — ответ потока, и действующее предложение чата — в superseded', async (text, reply) => {
    await post(VERIFIED, message(text));
    expect(repliesTo(CHAT)).toHaveLength(1);
    expect(repliesTo(CHAT)[0]).toMatch(reply);
    expect(retires()).toEqual([['superseded', String(CHAT)]]);
    expectNoDatesWritten();
  });

  it('снять не смог (база не ответила) — ответ говорит, что старую кнопку нажимать нельзя', async () => {
    m.pool.mockImplementation(async (sql: string) => {
      if (RETIRE.test(String(sql))) throw Object.assign(new Error('сбой'), { code: '57014' });
      return { rows: [], rowCount: 0 };
    });
    await post(VERIFIED, message('открой 3 августа утром, 8 мест'));
    expect(repliesTo(CHAT)[0]).toMatch(/\nПрежнее предложение снять не смог — его кнопку «Открыть» не нажимайте\.$/);
  });

  it('«отмена», «стоп», «не надо» при действующем предложении — оно отменено; без предложения — помощнику', async () => {
    m.pool.mockImplementation(async (sql: string) => (RETIRE.test(String(sql)) ? { rows: [], rowCount: 1 } : { rows: [], rowCount: 0 }));
    for (const text of ['отмена', 'Стоп', 'не надо']) await post(VERIFIED, message(text));
    expect(repliesTo(CHAT)).toEqual(Array(3).fill('Хорошо, предложение снято — ничего не открыто.'));
    expect(retires()).toEqual(Array(3).fill(['cancelled', String(CHAT)]));
    expect(m.partnerMessage).not.toHaveBeenCalled();

    m.maxSend.mockClear();
    m.pool.mockResolvedValue({ rows: [], rowCount: 0 });
    await post(VERIFIED, message('отмена'));
    expect(m.maxSend).not.toHaveBeenCalled();
    expect(m.partnerMessage).toHaveBeenCalledTimes(1);
    expectNoDatesWritten();
  });
});

describe('пятый ревью 22.10: поправка, ушедшая помощнику, тоже снимает предложение', () => {
  // Старая «Открыть» жила до 30 минут рядом с «нет, 4 места»: нажатие
  // продавало 8 мест, которых нет. Признак поправки — цифры, слово даты,
  // «мест», «не»/«нет» или слово тура; помощник получает сообщение как раньше.
  const CORRECTIONS = [
    '4 места', '4', 'нет, 4 места', 'не 8, а 4 места', 'не тот тур', 'не Горелый, а Авачинский',
    'ой, не 5, а 6 августа', 'мест 4', 'лучше 4 места', 'поменяй на 4 места',
    // Шестой ревью: поправка словами без цифр.
    'ошибся', 'погоди', 'подожди', 'стой', 'неправильно', 'неверно',
  ];
  /** Ни новой строки предложения, ни записи дат: черновик без мест «4» не заполнил (строк 0), снятие — можно. */
  const expectNoInsertNoOpen = (): void => {
    const inserts = [...m.pool.mock.calls, ...m.client.mock.calls].filter((c) => /\b(?:INSERT\s+INTO|DELETE\s+FROM)\b/i.test(String(c[0])));
    expect(inserts).toEqual([]);
    expect(m.openTx).not.toHaveBeenCalled();
  };
  const active = (): void => {
    m.pool.mockImplementation(async (sql: string) => (RETIRE.test(String(sql)) ? { rows: [], rowCount: 1 } : { rows: [], rowCount: 0 }));
  };

  it('план поездки с числом — Кузьмичу туриста, действующее предложение дат снято', async () => {
    active();
    await post(VERIFIED, message('спланируй поездку на 5 дней'));
    expect(retires()).toEqual([['superseded', String(CHAT)]]);
    expect(repliesTo(CHAT)).toEqual([
      'Прежнее предложение дат снято — по нему ничего не открыто. Если хотели его поправить, напишите фразу целиком: даты, тур и места.',
    ]);
    expect(m.partnerMessage).not.toHaveBeenCalled();
    expect(m.processMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: 'спланируй поездку на 5 дней', mode: 'max',
    }));
    expectNoInsertNoOpen();
  });

  it.each(CORRECTIONS)('«%s» при действующем предложении — снято со строкой «напишите фразу целиком», текст — помощнику', async (text) => {
    active();
    await post(VERIFIED, message(text));
    expect(retires()).toEqual([['superseded', String(CHAT)]]);
    expect(repliesTo(CHAT)).toEqual([
      'Прежнее предложение дат снято — по нему ничего не открыто. Если хотели его поправить, напишите фразу целиком: даты, тур и места.',
    ]);
    expect(m.partnerMessage).toHaveBeenCalledTimes(1);
    expect((m.partnerMessage.mock.calls[0]![0] as { text: string }).text).toBe(text);
    expectNoInsertNoOpen();
  });

  it('снятие несёт время сообщения MAX: повтор старого апдейта не снимает предложение новее него (шестой ревью)', async () => {
    active();
    await post(VERIFIED, message('нет, 4 места'));
    const call = m.pool.mock.calls.find((c) => RETIRE.test(String(c[0])))!;
    expect(String(call[0])).toMatch(/source_sent_at < to_timestamp\(\$4::double precision \/ 1000\)/);
    // `message()` шлёт апдейт с timestamp: 1.
    expect((call[1] as unknown[])[3]).toBe(1);
  });

  it('предложения нет — ни строки, ни снятия на словах; помощник получает сообщение', async () => {
    for (const text of CORRECTIONS) await post(VERIFIED, message(text));
    expect(m.maxSend).not.toHaveBeenCalled();
    expect(m.partnerMessage).toHaveBeenCalledTimes(CORRECTIONS.length);
    expectNoInsertNoOpen();
  });

  it('снять не смог — «его кнопку «Открыть» не нажимайте», и помощник получает сообщение', async () => {
    m.pool.mockImplementation(async (sql: string) => {
      if (RETIRE.test(String(sql))) throw Object.assign(new Error('сбой'), { code: '57014' });
      return { rows: [], rowCount: 0 };
    });
    await post(VERIFIED, message('нет, 4 места'));
    expect(repliesTo(CHAT)).toEqual(['Прежнее предложение снять не смог — его кнопку «Открыть» не нажимайте.']);
    expect(m.partnerMessage).toHaveBeenCalledTimes(1);
    expectNoInsertNoOpen();
  });

  it('без признака поправки («кто ждёт ответа?») предложение не трогается', async () => {
    active();
    await post(VERIFIED, message('кто ждёт ответа?'));
    expect(retires()).toEqual([]);
    expect(m.maxSend).not.toHaveBeenCalled();
    expect(m.partnerMessage).toHaveBeenCalledTimes(1);
  });

  it('гид команды без своих туров и перевозчик — предложений дат у них нет, снимать нечего', async () => {
    active();
    for (const partner of [teamGuide, { ...operator, category: 'transfer', crmCategory: 'transfer' }]) {
      m.findPartner.mockResolvedValue({ outcome: 'found', partner });
      await post(VERIFIED, message('нет, 4 места'));
    }
    expect(retires()).toEqual([]);
    expect(m.maxSend).not.toHaveBeenCalled();
  });

  it('гид со своими турами — поправка снимает его предложение, как у туроператора; текст — помощнику', async () => {
    active();
    m.findPartner.mockResolvedValue({ outcome: 'found', partner: guideSeller });
    await post(VERIFIED, message('нет, 4 места'));
    expect(retires()).toEqual([['superseded', String(CHAT)]]);
    expect(repliesTo(CHAT)).toEqual([
      'Прежнее предложение дат снято — по нему ничего не открыто. Если хотели его поправить, напишите фразу целиком: даты, тур и места.',
    ]);
    expect(m.partnerMessage).toHaveBeenCalledTimes(1);
    expectNoInsertNoOpen();
  });

  it('из группы — не трогается: предложение живёт в личном диалоге', async () => {
    active();
    await post(VERIFIED, message('нет, 4 места', 'chat'));
    expect(retires()).toEqual([]);
  });
});

describe('выключатель', () => {
  it('выключен — ни на фразу, ни на нажатие записи нет, ответ со ссылкой на календарь', async () => {
    m.switchOn.value = false;
    await post(VERIFIED, message('открой субботы июля, 8 мест'));
    await post(VERIFIED, press(`od:o:${PROPOSAL}`));
    const said = repliesTo(CHAT);
    expect(said).toHaveLength(2);
    for (const s of said) expect(s).toMatch(/^Открывать даты из чата сейчас нельзя\. В кабинете: https?:\/\/\S+\/hub\/operator\/calendar$/);
    expect(m.pool).not.toHaveBeenCalled();
    expect(m.client).not.toHaveBeenCalled();
    expectNothingWritten();
  });

  it('выключен — голое число уходит помощнику, а не в черновик', async () => {
    m.switchOn.value = false;
    await post(VERIFIED, message('8'));
    expect(m.partnerMessage).toHaveBeenCalledTimes(1);
    expectNothingWritten();
  });
});

describe('ревью 22.10: дела помощника кабинета поток дат не перехватывает', () => {
  const CRM = [
    'Добавь задачу на завтра: позвонить Анне',
    'Выполнил задачу сегодня, закрой её',
    'Клиент отменил бронь на завтра, поставь задачу перезвонить',
    'Запиши касание: Иван звонил сегодня, снимки тура понравились',
    'Добавь касание: звонила Анна, хочет в июле на Мутновский',
    'Удали задачу на пятницу',
    'Выставь счёт Анне на завтра',
    'Сделал, сними задачу на сегодня',
    'напомни перезвонить завтра',
    // Второй ревью 22.10: инструменты помощника и чужой предмет «открой».
    'Открой контакт Анны, она писала 3 августа',
    'Открой переписку с Иваном за 3 августа',
    'Открой лид от 3 августа',
    'Добавь лид Анна на 3 августа, 4 человека',
    'Открой статистику за июль',
    'Открой расписание на июль',
    'Открой список туристов на 3 августа',
    'открой доступ менеджеру с завтра',
    'добавь 2 человека в группу на 10 августа',
    // Третий ревью 22.10: клиент в CRM, а не 5 августа на 2 места.
    'Добавь Иванова на 5 августа, 2 места',
  ];
  const roles: Array<[string, typeof operator & { sellsTours?: boolean }]> = [
    ['туроператор', operator],
    ['гид команды', teamGuide],
    ['гид со своими турами', guideSeller],
    ['перевозчик', { ...operator, category: 'transfer', crmCategory: 'transfer' }],
  ];
  for (const [role, partner] of roles) {
    it(`${role}: каждая фраза — помощнику кабинета; отказа потока дат и строки предложения нет`, async () => {
      m.findPartner.mockResolvedValue({ outcome: 'found', partner });
      for (const text of CRM) await post(VERIFIED, message(text));
      expect(m.partnerMessage).toHaveBeenCalledTimes(CRM.length);
      expect(m.partnerMessage.mock.calls.map((c) => (c[0] as { text: string }).text)).toEqual(CRM);
      // Действующего предложения нет — сказать нечего.
      expect(m.maxSend).not.toHaveBeenCalled();
      // У туроператора фраза с датой или числом снимает действующее
      // предложение (пятый ревью); новых предложений нет ни у кого.
      const proposalSql = [...m.pool.mock.calls, ...m.client.mock.calls]
        .filter((c) => /operator_chat_date_proposals/.test(String(c[0])) && !RETIRE.test(String(c[0])));
      expect(proposalSql).toEqual([]);
      if (partner.category !== 'operator' && partner.sellsTours !== true) expect(retires()).toEqual([]);
      expectNoDatesWritten();
    });
  }

  it('выключатель выключен — дела помощника тоже доходят до помощника', async () => {
    m.switchOn.value = false;
    for (const text of CRM) await post(VERIFIED, message(text));
    expect(m.partnerMessage).toHaveBeenCalledTimes(CRM.length);
    expect(m.maxSend).not.toHaveBeenCalled();
  });

  it('база не ответила на проверку чата — дело помощника не получает «сбой» от потока дат', async () => {
    m.findPartner.mockResolvedValue({ outcome: 'unavailable' });
    await post(VERIFIED, message('Добавь задачу на завтра: позвонить Анне'));
    // Как раньше: «не смогли проверить» ведёт в туристский поток, а не в ответ потока дат.
    expect(repliesTo(CHAT)).toEqual([]);
    expect(m.processMessage).toHaveBeenCalledTimes(1);
  });
});

/**
 * Приём нажатий MAX (план мини-приложения, §6.5, этап 0; слово владельца
 * 22.10 «а да») — вызовом вебхука POST /api/max/kuzmich, а не поиском строки
 * в файле (CLAUDE.md §4, «Сторож судит поведение»).
 *
 * Что держит:
 *  - ключ подписки задан — запрос без него не обрабатывается вовсе: ни
 *    действия, ни вопроса Кузьмичу, ни ответа в чат (он спорил бы с ответом
 *    настоящей копии), ни подтверждения нажатия; в логе — хост и путь, без
 *    ключа. Пачка в тысячи апдейтов не стоит ни одного хода модели;
 *  - ключа нет — вопросы Кузьмичу и кнопки тем из любого источника, но по
 *    одному апдейту на запрос; каждое действие с последствием — кнопки мест
 *    (`sr:`) и лида (`lead_*`), ссылки старта (`login-`, `sr_`, `op_`, `om_`),
 *    присланный номер, чат партнёра — не применяется, и бот говорит, что это
 *    не засчитано, не утверждая окончательного исхода;
 *  - заверенное (адрес с ключом, который сверяет настоящий
 *    `isVerifiedMaxWebhook`) применяется;
 *  - чат кнопки-действия — только из сообщения с кнопкой: без сообщения
 *    нажатие не применяется, даже если `user_id` равен рабочему чату; о
 *    заверенном таком нажатии нажавшему говорится в личном чате;
 *  - без ключа тексты отказа не зовут повторить (повтор дал бы тот же отказ),
 *    а «Оформить заявку» не предлагается: оба пути после неё закрыты;
 *  - сбой одного апдейта не роняет ответ 200 и не съедает остальные.
 *
 * Чего здесь НЕ держится, сказано прямо: без ключа бот отвечает в чат,
 * названный телом (шапка `lib/max/verified-press`). Отказ отвечать на
 * `user_id` у незаверенного — не защита, а отказ добавлять второе поле,
 * которым тело выбирает адресата.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
  PRESS_WITHOUT_MESSAGE_REPLY, UNVERIFIED_CHAT_REPLY, UNVERIFIED_PRESS_REPLY, UNVERIFIED_START_REPLY,
} from '@/lib/max/verified-press';

const m = vi.hoisted(() => ({
  maxSend: vi.fn(),
  maxSendUser: vi.fn(),
  answerCb: vi.fn(),
  pool: vi.fn(),
  processMessage: vi.fn(),
  findPartner: vi.fn(),
  partnerMessage: vi.fn(),
  createLead: vi.fn(),
  login: vi.fn(),
  loginConfirm: vi.fn(),
  loginReject: vi.fn(),
  partnerStart: vi.fn(),
  memberStart: vi.fn(),
  adminStart: vi.fn(),
  findAdmin: vi.fn(),
  bindTourist: vi.fn(),
  seatMine: vi.fn(),
  seatAnswer: vi.fn(),
  applyLead: vi.fn(),
  leadProcess: vi.fn(),
  notifyProposal: vi.fn(),
  sendProposal: vi.fn(),
  ownerPress: vi.fn(),
  taskPress: vi.fn(),
}));

vi.mock('@/lib/max/max-fetch', () => ({
  maxBot: () => ({ api: { sendMessageToChat: m.maxSend, sendMessageToUser: m.maxSendUser, answerOnCallback: m.answerCb } }),
}));
// Учёт входящих (#3433) — своя таблица, проверен в chat-inbound-seen.test.ts;
// здесь считаются только записи действий, поэтому повтор решает память процесса.
vi.mock('@/lib/chat/inbound-seen', () => ({
  isRepeatedInbound: async (_source: string, _key: string, memoryRepeat: () => boolean) => memoryRepeat(),
  admitInbound: async (_source: string, _key: string, memoryRepeat: () => boolean) => (memoryRepeat() ? 'repeat' : 'unknown'),
  markInboundDone: async () => undefined,
}));
vi.mock('@/lib/db-pool', () => ({ pool: { query: m.pool } }));
vi.mock('@/lib/kuzmich/core', () => ({ hasLiveBookingFlow: vi.fn(async () => false), processMessage: m.processMessage, cleanupPending: vi.fn() }));
vi.mock('@/lib/kuzmich/operator-chat', () => ({
  PARTNER_EMAIL_BIND_CLOSED: 'привязка по почте закрыта',
  findPartnerByChat: m.findPartner,
  processPartnerMessage: m.partnerMessage,
}));
vi.mock('@/lib/leads/create', () => ({ createLead: m.createLead }));
// «Старт» по ссылке входа закрепляет сессию (m.login), вход выдаёт кнопка
// «Да, это я» (m.loginConfirm), «Нет, не я» гасит (m.loginReject) — аудит 22.10.
vi.mock('@/lib/auth/max-login', () => ({
  claimMaxLoginSession: m.login,
  confirmMaxLoginSession: m.loginConfirm,
  rejectMaxLoginSession: m.loginReject,
}));
vi.mock('@/lib/partners/bind-channel', () => ({ handlePartnerStart: m.partnerStart }));
vi.mock('@/lib/operators/member-channel', () => ({ handleMemberStart: m.memberStart }));
// MAX администратора (23.10): ссылка `adm_` и опознание на каждом сообщении.
vi.mock('@/lib/max/admin-link', () => ({ handleAdminStart: m.adminStart, findMaxAdmin: m.findAdmin }));
vi.mock('@/lib/seat-requests/service', () => ({
  bindTouristChat: m.bindTourist, requestBelongsToMaxChat: m.seatMine, answerSeatRequest: m.seatAnswer,
}));
vi.mock('@/lib/leads/status-action', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/leads/status-action')>()),
  applyLeadStatus: m.applyLead,
}));
vi.mock('@/lib/services/operators/lead-processor.service', () => ({ leadProcessor: { process: m.leadProcess } }));
vi.mock('@/lib/notifications/lead-notify', () => ({ notifyOperatorProposal: m.notifyProposal }));
vi.mock('@/lib/leads/proposal-delivery', () => ({ sendProposalToClient: m.sendProposal }));
// Бронь своего тура кнопкой (гид, 29.10): вопрос `bk:` и «Да» / «Не надо» `oc:`.
vi.mock('@/lib/bookings/chat-owner-action', () => ({
  handleOwnerPress: m.ownerPress,
  captureOwnerReason: vi.fn(async () => null),
  awaitsOwnerReason: vi.fn(async () => false),
}));
// «Выполнено» под напоминанием о задаче (29.10): `tk:d:`.
vi.mock('@/lib/crm/chat-task-action', () => ({ handleTaskPress: m.taskPress }));

const max = await import('@/app/api/max/kuzmich/route');
// Тесты шлют одни и те же mid: повтор сообщения отсекается (25.10), память — заново на тест.
const { clearMaxMessageDedup } = await import('@/lib/max/update-dedup');

const KEY = 'test-webhook-key-22-10';
const OPERATOR_CHAT = 555;
const LEAD = '11111111-2222-4333-8444-555555555555';
const SEAT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const NONCE = 'abcdefgh12345678abcdefgh';

/** Заверенный адрес — с ключом подписки; незаверенный — без него или с чужим. */
const VERIFIED = `http://localhost/api/max/kuzmich?s=${KEY}`;
const UNVERIFIED = ['http://localhost/api/max/kuzmich', 'http://localhost/api/max/kuzmich?s=guess'];

const post = (url: string, body: unknown, headers?: Record<string, string>) =>
  max.POST(new NextRequest(url, { method: 'POST', body: JSON.stringify(body), headers }));

/** Ключа подписки нет: заверенным не бывает ничего, вопросы — из любого источника. */
const keyless = (): void => { vi.stubEnv('MAX_WEBHOOK_SECRET', ''); };

/** У каждого нажатия MAX свой callback_id; повтор того же номера отсекается (#3433). */
let callbackSeq = 0;
const press = (payload: string, chatId: number | null = OPERATOR_CHAT, userId = OPERATOR_CHAT) => ({
  update_type: 'message_callback',
  timestamp: 1,
  callback: { timestamp: 1, callback_id: `cb-${++callbackSeq}`, payload, user: { user_id: userId, name: 'Оператор' } },
  ...(chatId === null ? {} : { message: { recipient: { chat_id: chatId, chat_type: 'chat' }, body: { mid: 'm', seq: 1, text: 'x' } } }),
});

const started = (payload: string) => ({
  update_type: 'bot_started', timestamp: 1, chat_id: 77, payload, user: { user_id: 77, name: 'Анна' },
});

/** Каждое сообщение — своё: одинаковый mid отсёкся бы как повтор доставки. */
let midSeq = 0;
const message = (text: string, attachments: unknown[] = []) => ({
  update_type: 'message_created',
  timestamp: 1,
  message: {
    sender: { user_id: 77, name: 'Анна' },
    recipient: { chat_id: 77, chat_type: 'dialog' },
    body: { mid: `m-${++midSeq}`, seq: 1, text, attachments },
  },
});

/** Что бот ответил в чат chatId (тексты по порядку). */
const repliesTo = (chatId: number) =>
  m.maxSend.mock.calls.filter((c) => c[0] === chatId).map((c) => String(c[1]));

/** Обработчики действий — ни один не должен быть вызван на незаверенном. */
const ACTION_HANDLERS = [
  m.seatMine, m.seatAnswer, m.applyLead, m.leadProcess, m.notifyProposal, m.sendProposal, m.ownerPress, m.taskPress,
  m.login, m.loginConfirm, m.loginReject,
  m.partnerStart, m.memberStart, m.adminStart, m.findAdmin, m.bindTourist, m.createLead, m.partnerMessage,
];

function expectNothingChanged(): void {
  for (const f of ACTION_HANDLERS) expect(f).not.toHaveBeenCalled();
  const writes = m.pool.mock.calls.filter((c) => /\b(INSERT|UPDATE|DELETE)\b/i.test(String(c[0])));
  expect(writes).toEqual([]);
}

let errorLog: ReturnType<typeof vi.spyOn>;

/**
 * С 21.11 (проверка по посту Reddit) без MAX_WEBHOOK_SECRET вебхук — fail-closed:
 * ни ответа, ни записи, ни хода модели, только строка в логе, что задать.
 * Прежде бот без ключа отвечал на вопросы из любого источника.
 */
function expectFailClosed(): void {
  expectNothingChanged();
  expect(m.maxSend).not.toHaveBeenCalled();
  expect(m.maxSendUser).not.toHaveBeenCalled();
  expect(m.answerCb).not.toHaveBeenCalled();
  expect(m.processMessage).not.toHaveBeenCalled();
  expect(errorLog.mock.calls.some((c) => String(c[0]).includes('MAX_WEBHOOK_SECRET не задан'))).toBe(true);
}


beforeEach(() => {
  clearMaxMessageDedup();
  for (const f of Object.values(m)) f.mockReset();
  m.maxSend.mockResolvedValue({});
  m.answerCb.mockResolvedValue({});
  m.pool.mockResolvedValue({ rows: [] });
  m.findPartner.mockResolvedValue({ outcome: 'none' });
  m.seatMine.mockResolvedValue(true);
  m.seatAnswer.mockResolvedValue({ ok: true, status: 'declined', tourTitle: 'Рыбалка', date: '2026-11-01' });
  m.applyLead.mockResolvedValue({ outcome: 'updated', status: 'contacted', label: 'Связались', name: 'Турист' });
  m.leadProcess.mockResolvedValue({ lead_id: LEAD });
  m.sendProposal.mockResolvedValue({ ok: true, message: 'Ушло в Telegram.' });
  m.login.mockResolvedValue(true);
  m.loginConfirm.mockResolvedValue(true);
  m.loginReject.mockResolvedValue(true);
  m.partnerStart.mockResolvedValue(true);
  m.memberStart.mockResolvedValue(true);
  m.adminStart.mockImplementation(async (arg: string) => arg.startsWith('adm_'));
  m.findAdmin.mockResolvedValue({ outcome: 'none' });
  m.bindTourist.mockResolvedValue({ ok: true, notified: false });
  m.createLead.mockResolvedValue('lead-id-1');
  m.ownerPress.mockResolvedValue({ text: 'Подтвердить бронь №7001?', buttons: [] });
  m.taskPress.mockResolvedValue('Задача «Перезвонить» отмечена выполненной.');
  vi.stubEnv('MAX_BOT_TOKEN', 'test-token');
  vi.stubEnv('MAX_WEBHOOK_SECRET', KEY);
  vi.stubEnv('MAX_OPERATOR_CHAT_ID', String(OPERATOR_CHAT));
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

// ── Кнопки-действия ─────────────────────────────────────────────────────────

const OWNER_ACTION = '00000000-0000-4000-8000-000000000001';
const PRESSES: Array<{ payload: string; kind: 'seat' | 'lead' | 'login' | 'owner' | 'task'; applied: () => unknown }> = [
  // Бронь своего тура кнопкой: право (личный диалог, карточка, человек
  // привязки, владение) решает lib/bookings/chat-owner-action; здесь — что
  // туда доходит только заверенное нажатие, с чатом сообщения и нажавшим.
  // Заявка своего тура кнопкой (`ld:`, шаг 7) — тот же вид нажатия.
  ...[`bk:c:7001`, `bk:x:7001`, `ld:k:${LEAD}`, `ld:l:${LEAD}`, `oc:y:${OWNER_ACTION}`, `oc:x:${OWNER_ACTION}`].map((payload) => ({
    payload, kind: 'owner' as const,
    applied: () => expect(m.ownerPress).toHaveBeenCalledWith({
      channel: 'max', chatId: OPERATOR_CHAT, privateChat: false, presserId: OPERATOR_CHAT, payload,
    }),
  })),
  // «Выполнено» под напоминанием о задаче: личный диалог и партнёра чата
  // проверяет lib/crm/chat-task-action; сюда доходит чат сообщения.
  {
    payload: `tk:d:${OWNER_ACTION}`, kind: 'task',
    applied: () => expect(m.taskPress).toHaveBeenCalledWith({ chatId: OPERATOR_CHAT, privateChat: false, payload: `tk:d:${OWNER_ACTION}` }),
  },
  { payload: `sr:y:${SEAT}`, kind: 'seat', applied: () => expect(m.seatAnswer).toHaveBeenCalledWith(SEAT, { kind: 'yes' }, 'max') },
  { payload: `sr:n:${SEAT}`, kind: 'seat', applied: () => expect(m.seatAnswer).toHaveBeenCalledWith(SEAT, { kind: 'no' }, 'max') },
  ...['lead_contacted', 'lead_qualified', 'lead_converted', 'lead_lost'].map((p) => ({
    payload: `${p}:${LEAD}`, kind: 'lead' as const,
    applied: () => expect(m.applyLead).toHaveBeenCalledWith(p, LEAD),
  })),
  { payload: `lead_ai:${LEAD}`, kind: 'lead', applied: () => expect(m.leadProcess).toHaveBeenCalledWith(LEAD) },
  { payload: `lead_send:${LEAD}`, kind: 'lead', applied: () => expect(m.sendProposal).toHaveBeenCalledWith(LEAD) },
  // Вопрос о входе на сайт: право нажатия — пользователь, нажавший «Старт»
  // (условие в SQL); здесь — что нажатие доходит с его user_id и только
  // заверенным.
  { payload: `maxlogin_ok:${NONCE}`, kind: 'login', applied: () => expect(m.loginConfirm).toHaveBeenCalledWith(NONCE, OPERATOR_CHAT) },
  { payload: `maxlogin_no:${NONCE}`, kind: 'login', applied: () => expect(m.loginReject).toHaveBeenCalledWith(NONCE, OPERATOR_CHAT) },
];

describe('кнопки-действия: только из заверенного апдейта', () => {
  for (const { payload, kind, applied } of PRESSES) {
    const name = payload.split(':').slice(0, 2).join(':');

    it(`${name}: без ключа при заданном ключе — не обработано вовсе, ответа нет`, async () => {
      for (const url of UNVERIFIED) {
        const res = await post(url, press(payload));
        expect(await res.json()).toEqual({ ok: true });
      }
      expectNothingChanged();
      expect(m.maxSend).not.toHaveBeenCalled();
      expect(m.maxSendUser).not.toHaveBeenCalled();
      expect(m.answerCb).not.toHaveBeenCalled();
    });

    it(`fail-closed без ключа (21.11), было: ${name}: ключа нет — нажатие не засчитано, и бот это говорит, не утверждая исхода`, async () => {
      keyless();
      for (const url of [...UNVERIFIED, VERIFIED]) {
        const res = await post(url, press(payload));
        expect(await res.json()).toEqual({ ok: true });
      }
      expectFailClosed();
    });

    it(`${name}: заверенное нажатие из чата сообщения применяется`, async () => {
      await post(VERIFIED, press(payload));
      applied();
      expect(repliesTo(OPERATOR_CHAT).join('\n')).not.toContain('не засчитано');
    });

    it(`${name}: без сообщения не применяется — user_id тела не заменяет чат; нажавший узнаёт об этом лично`, async () => {
      // user_id совпадает с рабочим чатом и с чатом оператора запроса — прежний
      // откат на него пропустил бы нажатие.
      await post(VERIFIED, press(payload, null, OPERATOR_CHAT));
      expectNothingChanged();
      expect(m.maxSend).not.toHaveBeenCalled();
      expect(m.maxSendUser.mock.calls).toEqual([[OPERATOR_CHAT, PRESS_WITHOUT_MESSAGE_REPLY[kind], expect.anything()]]);
      expect(errorLog.mock.calls.some((c) => String(c[0]).includes('без чата сообщения'))).toBe(true);
    });

    it(`${name}: без сообщения и без ключа — ни применения, ни ответа на user_id тела`, async () => {
      keyless();
      await post(UNVERIFIED[0]!, press(payload, null, OPERATOR_CHAT));
      expectNothingChanged();
      expect(m.maxSend).not.toHaveBeenCalled();
      expect(m.maxSendUser).not.toHaveBeenCalled();
    });
  }

  it('лид: заверенное нажатие не из рабочего чата не применяется', async () => {
    await post(VERIFIED, press(`lead_contacted:${LEAD}`, 9_000));
    expect(m.applyLead).not.toHaveBeenCalled();
    expect(repliesTo(9_000)).toEqual(['Действие по лиду доступно только в рабочем чате.']);
  });

  it('лид: заявку отменил клиент — рабочему чату сказано именно это, а не «сбой» и не «не найден» (1427)', async () => {
    m.applyLead.mockResolvedValue({ outcome: 'cancelled_by_client' });
    await post(VERIFIED, press(`lead_contacted:${LEAD}`));
    expect(repliesTo(OPERATOR_CHAT)).toEqual([`Заявку отменил клиент — статус не изменён.\n<code>${LEAD}</code>`]);
  });

  it('места: заверенное нажатие из чужого чата не применяется', async () => {
    m.seatMine.mockResolvedValue(false);
    await post(VERIFIED, press(`sr:y:${SEAT}`, 9_000));
    expect(m.seatMine).toHaveBeenCalledWith(SEAT, 9_000);
    expect(m.seatAnswer).not.toHaveBeenCalled();
  });

  it('fail-closed без ключа (21.11), было: без ключа в окружении не заверено ничего, даже адрес с ?s=', async () => {
    keyless();
    for (const url of [...UNVERIFIED, VERIFIED]) {
      const res = await post(url, press(`lead_lost:${LEAD}`));
      expect(await res.json()).toEqual({ ok: true });
    }
    expectFailClosed();
  });
});

// ── Запрос без ключа при заданном ключе ─────────────────────────────────────

describe('повтор нажатия (#3433): тот же callback_id исполняется один раз', () => {
  const PAYLOAD = `oc:y:${OWNER_ACTION}`;
  const same = (body: ReturnType<typeof press>) => ({ ...body, callback: { ...body.callback, callback_id: 'cb-repeat' } });

  it('заверенное нажатие, доставленное дважды, — одно действие', async () => {
    await post(VERIFIED, same(press(PAYLOAD)));
    await post(VERIFIED, same(press(PAYLOAD)));
    expect(m.ownerPress).toHaveBeenCalledTimes(1);
  });

  it('незаверенный запрос с тем же callback_id не отсекает настоящее нажатие', async () => {
    keyless();
    await post(UNVERIFIED[0], { ...press(PAYLOAD), callback: { ...press(PAYLOAD).callback, callback_id: 'cb-forged' } });
    vi.stubEnv('MAX_WEBHOOK_SECRET', KEY);
    await post(VERIFIED, { ...press(PAYLOAD), callback: { ...press(PAYLOAD).callback, callback_id: 'cb-forged' } });
    expect(m.ownerPress).toHaveBeenCalledTimes(1);
  });
});

describe('ключ задан: запрос без него не обрабатывается вовсе', () => {
  const ALL_KINDS: Array<[string, unknown]> = [
    ['кнопка мест', press(`sr:y:${SEAT}`)],
    ['ссылка входа', started('login-abcdefgh12345678')],
    ['ссылка подключения', started('op_signed-token')],
    ['обычный /start', started('')],
    ['вопрос Кузьмичу', message('Когда идти на Авачинский?')],
    ['присланный номер', message('', [{ type: 'contact', payload: { vcf_info: 'BEGIN:VCARD\nTEL:+79140000000\nEND:VCARD' } }])],
    ['кнопка темы', press('topic_volcanoes', 77, 77)],
  ];

  for (const [name, update] of ALL_KINDS) {
    it(`${name}: ни ответа, ни модели, ни записи`, async () => {
      m.findPartner.mockResolvedValue({ outcome: 'found', partner: { partnerId: 'p1' } });
      const res = await post(UNVERIFIED[0]!, update);
      expect(res.status).toBe(200);
      expectNothingChanged();
      expect(m.processMessage).not.toHaveBeenCalled();
      expect(m.findPartner).not.toHaveBeenCalled();
      expect(m.maxSend).not.toHaveBeenCalled();
    });
  }

  it('пачка в 5000 апдейтов — ни одного хода модели', async () => {
    const batch = Array.from({ length: 5000 }, (_, i) => ({
      ...message('Какие туры на вулканы в июле?'),
      message: { ...message('Какие туры на вулканы в июле?').message, recipient: { chat_id: i + 1, chat_type: 'dialog' } },
    }));
    const res = await post(UNVERIFIED[0]!, batch);
    expect(res.status).toBe(200);
    expect(m.processMessage).not.toHaveBeenCalled();
    expect(m.maxSend).not.toHaveBeenCalled();
  });

  it('в логе — откуда пришёл запрос (хост, путь, x-forwarded-host), без ключа и без текста', async () => {
    await post('http://localhost/api/max/kuzmich?s=wrong-key-xyz', message('Мне 70 лет, телефон +79140000000'), {
      'x-forwarded-host': 'tourhab.ru',
    });
    const line = errorLog.mock.calls.map((c) => c.map(String).join(' ')).find((l) => l.includes('без ключа подписки'));
    expect(line).toBeDefined();
    expect(line).toContain('localhost');
    expect(line).toContain('/api/max/kuzmich');
    expect(line).toContain('tourhab.ru');
    expect(line).toContain('message_created');
    expect(line).not.toContain('wrong-key-xyz');
    expect(line).not.toContain(KEY);
    expect(line).not.toContain('79140000000');
  });

  it('заверенная копия того же апдейта обрабатывается', async () => {
    await post(VERIFIED, message('Когда идти на Авачинский?'));
    expect(m.processMessage).toHaveBeenCalledWith(expect.objectContaining({ chatId: 77, verifiedOrigin: true }));
  });
});

// ── Ссылки старта ───────────────────────────────────────────────────────────

const STARTS: Array<{ payload: string; kind: 'login' | 'link' | 'admin'; applied: () => unknown }> = [
  { payload: 'login-abcdefgh12345678', kind: 'login', applied: () => expect(m.login).toHaveBeenCalledTimes(1) },
  { payload: `sr_${'a'.repeat(32)}`, kind: 'link', applied: () => expect(m.bindTourist).toHaveBeenCalledWith('a'.repeat(32), 'max', 77) },
  { payload: 'op_signed-token', kind: 'link', applied: () => expect(m.partnerStart).toHaveBeenCalledWith('op_signed-token', 'max', 77, expect.any(Function), 77) },
  { payload: 'om_signed-token', kind: 'link', applied: () => expect(m.memberStart).toHaveBeenCalledWith('om_signed-token', 'max', 77, expect.any(Function)) },
  { payload: `adm_${'b'.repeat(32)}`, kind: 'admin', applied: () => expect(m.adminStart).toHaveBeenCalledWith(`adm_${'b'.repeat(32)}`, 77, expect.any(Function)) },
];

describe('ссылки старта: вход и подключение чата — только из заверенного апдейта', () => {
  for (const { payload, kind, applied } of STARTS) {
    const name = payload.slice(0, 3);

    it(`fail-closed без ключа (21.11), было: ${name}: ключа нет — ссылка ничего не подключает и называет это, а не здоровается`, async () => {
      keyless();
      for (const url of [...UNVERIFIED, VERIFIED]) {
        const res = await post(url, started(payload));
        expect(await res.json()).toEqual({ ok: true });
      }
      expectFailClosed();
    });

    it(`${name}: заверенная ссылка применяется`, async () => {
      // op_ не узнан разборщиком партнёра — дальше идёт разборщик менеджера.
      if (name === 'om_') m.partnerStart.mockResolvedValue(false);
      await post(VERIFIED, started(payload));
      applied();
    });
  }

  it('заверенное сообщение «/start op_» и голое «op_» привязывают тот же чат, что payload', async () => {
    for (const text of ['/start op_signed-token', 'op_signed-token']) {
      m.partnerStart.mockClear();
      m.processMessage.mockClear();
      m.maxSend.mockClear();
      await post(VERIFIED, message(text));
      expect(m.partnerStart).toHaveBeenCalledWith('op_signed-token', 'max', 77, expect.any(Function), 77);
      expect(m.processMessage).not.toHaveBeenCalled();
      const reply = m.partnerStart.mock.calls[0]?.[3] as (t: string) => Promise<void>;
      await reply('Вы подключены как туроператор.');
      expect(repliesTo(77).join('\n')).toContain('Вы подключены как туроператор.');
    }
  });

  it('fail-closed без ключа (21.11), было: незаверенное сообщение op_ чат не назначает и не здоровается', async () => {
    keyless();
    for (const url of [...UNVERIFIED, VERIFIED]) {
      const res = await post(url, message('op_signed-token'));
      expect(await res.json()).toEqual({ ok: true });
    }
    expectFailClosed();
  });

  it('op_ внутри фразы и код в группе привязку не начинают', async () => {
    await post(VERIFIED, message('хочу на тур, код op_signed-token'));
    expect(m.partnerStart).not.toHaveBeenCalled();
    m.partnerStart.mockClear();
    const grouped = message('op_signed-token');
    grouped.message.recipient.chat_type = 'chat';
    await post(VERIFIED, grouped);
    expect(m.partnerStart).not.toHaveBeenCalled();
  });

  it('fail-closed без ключа (21.11), было: ключа нет — обычный /start без ссылки здоровается из любого источника', async () => {
    keyless();
    for (const url of [...UNVERIFIED, VERIFIED]) {
      const res = await post(url, started(''));
      expect(await res.json()).toEqual({ ok: true });
    }
    expectFailClosed();
  });
});

// ── Действия в чате ─────────────────────────────────────────────────────────

const CONTACT = { type: 'contact', payload: { vcf_info: 'BEGIN:VCARD\nTEL:+79140000000\nEND:VCARD', tam_info: { user_id: 77, name: 'Анна' } } };

describe('присланный номер: заявка — только из заверенного апдейта', () => {
  it('fail-closed без ключа (21.11), было: ключа нет — заявки из номера нет, бот говорит, что номер не засчитан', async () => {
    keyless();
    for (const url of [...UNVERIFIED, VERIFIED]) {
      const res = await post(url, message('', [CONTACT]));
      expect(await res.json()).toEqual({ ok: true });
    }
    expectFailClosed();
  });

  it('заверенный номер — заявка создана, человеку «номер получен»', async () => {
    await post(VERIFIED, message('', [CONTACT]));
    expect(m.createLead).toHaveBeenCalledWith(expect.objectContaining({ phone: '+79140000000' }));
    expect(repliesTo(77).join('\n')).toContain('Номер получен');
  });

  it('заявка не записалась — «номер получен» не говорим', async () => {
    m.createLead.mockResolvedValue(null);
    await post(VERIFIED, message('', [CONTACT]));
    const said = repliesTo(77).join('\n');
    expect(said).not.toContain('Номер получен');
    expect(said).toContain('не сохранился');
  });

  it('createLead упал — отказ в логе без телефона и имени', async () => {
    m.createLead.mockRejectedValue(Object.assign(new Error('сбой для +79140000000'), { code: '23505' }));
    await post(VERIFIED, message('', [CONTACT]));
    const line = errorLog.mock.calls.find((c) => String(c[0]).includes('заявка из присланного номера'));
    expect(line).toBeDefined();
    expect(JSON.stringify(line)).toContain('23505');
    expect(JSON.stringify(line)).not.toContain('79140000000');
    expect(JSON.stringify(line)).not.toContain('Анна');
  });
});

describe('чат партнёра: помощник кабинета — только из заверенного апдейта', () => {
  const partner = { partnerId: 'p1', partnerName: 'Оператор', category: 'operator', crmCategory: 'operator', userId: 'u1' };

  it('fail-closed без ключа (21.11), было: ключа нет — помощник кабинета не запущен, бот говорит, что сообщение не передано', async () => {
    keyless();
    m.findPartner.mockResolvedValue({ outcome: 'found', partner });
    for (const url of [...UNVERIFIED, VERIFIED]) {
      const res = await post(url, message('запиши касание с Иваном'));
      expect(await res.json()).toEqual({ ok: true });
    }
    expectFailClosed();
  });

  it('заверенное — помощник кабинета запущен', async () => {
    m.findPartner.mockResolvedValue({ outcome: 'found', partner });
    await post(VERIFIED, message('запиши касание с Иваном'));
    expect(m.partnerMessage).toHaveBeenCalledWith(expect.objectContaining({ chatId: 77, partner }));
  });

  it('просьба туриста в привязанном чате идёт Кузьмичу туриста, не помощнику CRM', async () => {
    m.findPartner.mockResolvedValue({ outcome: 'found', partner });
    await post(VERIFIED, message('найди мне в аренду автомобиль'));
    expect(m.partnerMessage).not.toHaveBeenCalled();
    expect(m.processMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 77, text: 'найди мне в аренду автомобиль', mode: 'max', verifiedOrigin: true,
    }));
  });

  it('fail-closed без ключа (21.11), было: незаверенная просьба туриста в привязанном чате — Кузьмич, без помощника CRM', async () => {
    keyless();
    m.findPartner.mockResolvedValue({ outcome: 'found', partner });
    for (const url of [...UNVERIFIED, VERIFIED]) {
      const res = await post(url, message('найди мне в аренду автомобиль'));
      expect(await res.json()).toEqual({ ok: true });
    }
    expectFailClosed();
  });
});

describe('ключа нет (с 21.11 fail-closed): ни вопросов Кузьмичу, ни кнопок тем', () => {
  beforeEach(keyless);

  it('fail-closed без ключа (21.11), было: вопрос туриста доходит до Кузьмича с флагом «не заверено»', async () => {
    keyless();
    for (const url of [...UNVERIFIED, VERIFIED]) {
      const res = await post(url, message('Когда идти на Авачинский?'));
      expect(await res.json()).toEqual({ ok: true });
    }
    expectFailClosed();
  });

  it('fail-closed без ключа (21.11), было: один апдейт массивом — обработан', async () => {
    keyless();
    for (const url of [...UNVERIFIED, VERIFIED]) {
      const res = await post(url, [message('Когда идти на Авачинский?')]);
      expect(await res.json()).toEqual({ ok: true });
    }
    expectFailClosed();
  });

  it('fail-closed без ключа (21.11), было: пачка из нескольких апдейтов — не обработана ни одна, в логе число', async () => {
    keyless();
    for (const url of [...UNVERIFIED, VERIFIED]) {
      const res = await post(url, Array.from({ length: 50 }, () => message('Какие туры?')));
      expect(await res.json()).toEqual({ ok: true });
    }
    expectFailClosed();
  });

  it('fail-closed без ключа (21.11), было: кнопка темы отвечает в чат сообщения', async () => {
    keyless();
    for (const url of [...UNVERIFIED, VERIFIED]) {
      const res = await post(url, press('topic_volcanoes', 77, 77));
      expect(await res.json()).toEqual({ ok: true });
    }
    expectFailClosed();
  });

  it('fail-closed без ключа (21.11), было: «Регистрация в МЧС» (10.11) — готовый текст со сроком и ссылками, модель не зовётся', async () => {
    keyless();
    for (const url of [...UNVERIFIED, VERIFIED]) {
      const res = await post(url, press('mchs_info', 77, 77));
      expect(await res.json()).toEqual({ ok: true });
    }
    expectFailClosed();
  });

  it('кнопка темы без сообщения — адресат только чат сообщения, user_id вторым полем не служит', async () => {
    // Не защита: чат сообщения подделывается так же. Это отказ добавлять
    // ещё одно поле тела, которым выбирается адресат ответа.
    await post(UNVERIFIED[0]!, press('topic_volcanoes', null, 4242));
    expect(m.processMessage).not.toHaveBeenCalled();
    expect(m.maxSend).not.toHaveBeenCalled();
  });

  it('fail-closed без ключа (21.11), было: ответ Кузьмича про тур — без кнопки «Оформить заявку»: номер и бронь в чате закрыты', async () => {
    keyless();
    for (const url of [...UNVERIFIED, VERIFIED]) {
      const res = await post(url, message('Какие туры на вулкан?'));
      expect(await res.json()).toEqual({ ok: true });
    }
    for (const url of [...UNVERIFIED, VERIFIED]) {
      const res = await post(url, press('topic_tour', 77, 77));
      expect(await res.json()).toEqual({ ok: true });
    }
    expectFailClosed();
  });

  it('fail-closed без ключа (21.11), было: «Оформить заявку» со старой клавиатуры — сразу «не оформляю, на сайте», номер не просим', async () => {
    keyless();
    for (const url of [...UNVERIFIED, VERIFIED]) {
      const res = await post(url, press('book_now', 77, 77));
      expect(await res.json()).toEqual({ ok: true });
    }
    expectFailClosed();
  });

  it('кнопка темы из группы (отрицательный чат) — мимо, как сообщения', async () => {
    await post(UNVERIFIED[0]!, press('topic_volcanoes', -100500, 77));
    expect(m.processMessage).not.toHaveBeenCalled();
  });
});

describe('заверенное — «Оформить заявку» предлагается и ведёт в заявку в чате', () => {
  it('ответ про тур — кнопка есть; book_now — заявка в чате, как на сайте', async () => {
    m.processMessage.mockImplementation(async (o: { chatId: number; reply: (id: number, t: string) => Promise<void> }) => {
      await o.reply(o.chatId, 'Есть тур на Авачинский вулкан, программа на день.');
    });
    await post(VERIFIED, message('Какие туры на вулкан?'));
    expect(repliesTo(77)).toContain('Хотите оформить заявку?');
    m.maxSend.mockClear();
    await post(VERIFIED, press('book_now', 77, 77));
    expect(m.processMessage).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'Хочу оформить заявку на тур', verifiedOrigin: true }));
    expect(repliesTo(77).join('\n')).not.toContain('Поделитесь номером');
  });
});

describe('тексты отказа без ключа: не зовут повторить', () => {
  // Без ключа заверенным не бывает ни один апдейт вебхука: «начните заново»,
  // «откройте ещё раз», «если подтверждения не было» обещали бы исход,
  // которого повтор не даст.
  const ALL = [
    ...Object.values(UNVERIFIED_PRESS_REPLY), ...Object.values(UNVERIFIED_START_REPLY), ...Object.values(UNVERIFIED_CHAT_REPLY),
  ];
  for (const text of ALL) {
    it(text.slice(0, 50), () => {
      expect(text).not.toMatch(/заново|ещё раз|еще раз|попробуйте снова|Если подтверждения не было|отдельным сообщением/i);
    });
  }

  it('fail-closed без ключа (21.11), было: ссылка входа без ключа — ответ говорит, что вход через MAX недоступен, и куда идти', async () => {
    keyless();
    for (const url of [...UNVERIFIED, VERIFIED]) {
      const res = await post(url, started('login-abcdefgh12345678'));
      expect(await res.json()).toEqual({ ok: true });
    }
    expectFailClosed();
  });
});

describe('заверенная кнопка темы без сообщения — ответ в личный чат нажавшего', () => {
  it('user_id заверенного апдейта прислал MAX', async () => {
    await post(VERIFIED, press('topic_volcanoes', null, 4242));
    expect(m.processMessage).toHaveBeenCalledWith(expect.objectContaining({ chatId: 4242, verifiedOrigin: true }));
  });
});

describe('POST: всегда 200, отказ — в логе', () => {
  it('сбой одного апдейта не съедает следующий в пачке', async () => {
    m.processMessage.mockRejectedValueOnce(Object.assign(new Error('нет соединения'), { code: '08006' }));
    const res = await post(VERIFIED, [message('первый'), message('второй')]);
    expect(res.status).toBe(200);
    expect(m.processMessage).toHaveBeenCalledTimes(2);
    const line = errorLog.mock.calls.find((c) => String(c[0]).includes('обработка апдейта message_created'));
    expect(line).toBeDefined();
    expect(JSON.stringify(line)).toContain('08006');
  });

  it('битое тело — 200 и строка в логе', async () => {
    const res = await max.POST(new NextRequest(VERIFIED, { method: 'POST', body: '{не json' }));
    expect(res.status).toBe(200);
    expect(errorLog.mock.calls.some((c) => String(c[0]).includes('разбор тела апдейта'))).toBe(true);
  });

  it('отказ доставки ответа в MAX назван в логе', async () => {
    m.maxSend.mockRejectedValue(Object.assign(new Error('chat.not.found'), { code: 'not.found' }));
    await post(VERIFIED, press(`lead_lost:${LEAD}`, 9_000));
    expect(errorLog.mock.calls.some((c) => String(c[0]).includes('ответ в чат MAX'))).toBe(true);
  });
});

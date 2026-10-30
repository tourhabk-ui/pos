// @vitest-environment node
/**
 * Ответ хозяина жилья на заявку одной кнопкой (слово владельца 30.10: хозяин
 * «Кутхи» «сейчас на бумажке посмотрю, когда занято» и с MAX не разберётся).
 *
 * Сторож держит вызовом:
 *   · три кнопки «Свободно, беру» / «Занято» / «Позвоню сам»: payload короче
 *     64 байт, разбирается только uuid, своя и только своя запись в заявку
 *     (скоуп — объект принадлежит карточке партнёра), один раз;
 *   · после записи: гостю — словами хозяина в переписку заявки, менеджеру —
 *     факт без имени и телефона гостя; отказ следствий ответ не отменяет;
 *   · слова гостю не обещают брони и оплаты, слова хозяину — одно предложение
 *     и «больше ничего делать не нужно»;
 *   · нажатие в MAX правит сообщение заявки и оставляет «Ответить гостю»;
 *     в Telegram — новым сообщением без кнопок переписки;
 *   · классификатор MAX знает `sa:`, тексты отказов — тоже;
 *   · привязка: хозяину жилья — простые слова и две кнопки, не «подключён к
 *     оператору»; справка — по шагам, без кабинета, задач и клиентов.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { pool, postMock, tgMock } = vi.hoisted(() => ({ pool: vi.fn(), postMock: vi.fn(), tgMock: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => pool(...a) } }));
vi.mock('@/lib/requests/request-chat-service', () => ({ postOwnerMessage: (...a: unknown[]) => postMock(...a) }));
vi.mock('@/lib/notifications/tg-send', () => ({ tgSend: (...a: unknown[]) => tgMock(...a) }));

import {
  stayAnswerButtons, parseStayAnswerPress, isStayAnswerPayload, guestStayAnswerText, ownerStayAnswerText,
  managerStayAnswerText, STAY_ANSWER_WORDS,
} from '@/lib/stay/owner-answer';
import { answerStayRequest, handleStayAnswerPress, ANSWER_STAY_SQL } from '@/lib/stay/owner-answer-flow';
import { pressActionOf, UNVERIFIED_PRESS_REPLY, PRESS_WITHOUT_MESSAGE_REPLY } from '@/lib/max/verified-press';
import { channelBoundText, boundMenuRow, stayBoundText } from '@/lib/partners/bind-channel';
import { partnerMenuHelp, partnerMenu } from '@/lib/roles/role-menu';

const REQ = '3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f607';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const KUTKHA = { partnerId: PARTNER, partnerName: 'Кутха' };
const FACTS = { accommodation_name: 'Кутха', check_in: '2026-11-05', check_out: '2026-11-09', guests: 2 };
const PD = ['Анна', '+79140001122'];

beforeEach(() => {
  pool.mockReset(); postMock.mockReset(); tgMock.mockReset();
  tgMock.mockResolvedValue({ ok: true });
  postMock.mockResolvedValue({ outcome: 'sent', delivery: 'max' });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('кнопки', () => {
  it('три кнопки, payload короче 64 байт, разбираются; не-uuid — кнопок нет и разбора нет', () => {
    const b = stayAnswerButtons(REQ)!;
    expect(b.map((x) => x.text)).toEqual(['Свободно, беру', 'Занято', 'Позвоню сам']);
    for (const x of b) {
      expect(Buffer.byteLength(x.payload)).toBeLessThan(64);
      expect(isStayAnswerPayload(x.payload)).toBe(true);
      expect(pressActionOf(x.payload)).toBe('stay_answer');
    }
    expect(parseStayAnswerPress(b[0]!.payload)).toEqual({ answer: 'free', requestId: REQ });
    expect(parseStayAnswerPress(b[1]!.payload)).toEqual({ answer: 'busy', requestId: REQ });
    expect(parseStayAnswerPress(b[2]!.payload)).toEqual({ answer: 'call', requestId: REQ });
    expect(stayAnswerButtons('abc')).toBeUndefined();
    expect(parseStayAnswerPress('sa:f:abc')).toBeNull();
    expect(parseStayAnswerPress(`sa:x:${REQ}`)).toBeNull();
    expect(UNVERIFIED_PRESS_REPLY.stay_answer).toMatch(/не записан/);
    expect(PRESS_WITHOUT_MESSAGE_REPLY.stay_answer).toMatch(/не записан/);
  });
});

describe('слова', () => {
  const facts = { accommodationName: 'Кутха', checkIn: '2026-11-05', checkOut: '2026-11-09', guests: 2 };
  it('гостю — словами хозяина, с датами, без «забронировано» и без оплаты через платформу', () => {
    const free = guestStayAnswerText(facts, 'free');
    expect(free).toContain('«Кутха»: свободно, ждём вас с 05.11.2026 по 09.11.2026');
    expect(free).toContain('Через Ведар оплаты нет');
    expect(guestStayAnswerText(facts, 'busy')).toContain('на даты с 05.11.2026 по 09.11.2026 занято');
    expect(guestStayAnswerText(facts, 'call')).toContain('позвонит вам сам');
    for (const a of ['free', 'busy', 'call'] as const) expect(guestStayAnswerText(facts, a)).not.toMatch(/заброниров|оплатить/i);
  });

  it('хозяину — его ответ одной строкой и что делать дальше; менеджеру — без имени и телефона гостя', () => {
    expect(ownerStayAnswerText({ kind: 'answered', answer: 'free', guestTold: true })).toBe('<b>Ваш ответ:</b> свободно, беру. Гостю сообщил. Позвоните гостю, чтобы договориться о цене и заезде.');
    expect(ownerStayAnswerText({ kind: 'answered', answer: 'busy', guestTold: true })).toContain('Больше ничего делать не нужно.');
    expect(ownerStayAnswerText({ kind: 'answered', answer: 'call', guestTold: false })).toContain('Сообщение гостю не ушло — позвоните ему');
    expect(ownerStayAnswerText({ kind: 'already', answer: 'busy' })).toContain('уже записан: занято');
    const m = managerStayAnswerText({ partnerName: 'Кутха', requestId: REQ, answer: 'busy', facts });
    expect(m).toContain('ответил «занято»');
    expect(m).toContain('гостей: 2');
    for (const p of PD) expect(m).not.toContain(p);
    expect(Object.keys(STAY_ANSWER_WORDS)).toEqual(['free', 'busy', 'call']);
  });
});

describe('запись и следствия', () => {
  it('своя заявка: UPDATE со скоупом партнёра и WHERE owner_answer IS NULL, затем гостю и менеджеру', async () => {
    pool.mockResolvedValueOnce({ rows: [FACTS] });
    const r = await answerStayRequest({ partner: KUTKHA, requestId: REQ, answer: 'free', via: 'max' });
    expect(r.tell).toEqual({ kind: 'answered', answer: 'free', guestTold: true });
    expect(r.facts).toEqual({ accommodationName: 'Кутха', checkIn: '2026-11-05', checkOut: '2026-11-09', guests: 2 });
    const [sql, params] = pool.mock.calls[0] as [string, unknown[]];
    expect(sql).toBe(ANSWER_STAY_SQL);
    expect(sql).toMatch(/a\.partner_id = \$2::uuid/);
    expect(sql).toMatch(/s\.owner_answer IS NULL/);
    expect(params).toEqual([REQ, PARTNER, 'free', 'max']);
    expect(postMock).toHaveBeenCalledWith({ kind: 'stay', id: REQ }, expect.stringContaining('«Кутха»: свободно'));
    expect(tgMock).toHaveBeenCalledWith('stay-request-answer', expect.stringContaining('ответил «свободно, беру»'));
  });

  it('повтор — «уже записан» без следствий; чужая — «не ваша»; нет такой — «не нашёл»; база упала — «нажмите ещё раз»', async () => {
    pool.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ mine: true, owner_answer: 'free' }] });
    expect((await answerStayRequest({ partner: KUTKHA, requestId: REQ, answer: 'busy', via: 'max' })).tell).toEqual({ kind: 'already', answer: 'free' });
    pool.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ mine: false, owner_answer: null }] });
    expect((await answerStayRequest({ partner: KUTKHA, requestId: REQ, answer: 'busy', via: 'max' })).tell).toEqual({ kind: 'not_yours' });
    pool.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    expect((await answerStayRequest({ partner: KUTKHA, requestId: REQ, answer: 'busy', via: 'max' })).tell).toEqual({ kind: 'missing' });
    pool.mockRejectedValueOnce(Object.assign(new Error('down'), { code: '57P01' }));
    expect((await answerStayRequest({ partner: KUTKHA, requestId: REQ, answer: 'busy', via: 'max' })).tell).toEqual({ kind: 'retry' });
    expect(postMock).not.toHaveBeenCalled();
    expect(tgMock).not.toHaveBeenCalled();
  });

  it('гостю не ушло — ответ записан, хозяину сказано позвонить; менеджер упал — ответ записан', async () => {
    pool.mockResolvedValueOnce({ rows: [FACTS] });
    postMock.mockResolvedValueOnce({ outcome: 'sent', delivery: 'no_address', pageVisible: false });
    tgMock.mockResolvedValueOnce({ ok: false, reason: 'нет токена' });
    const r = await answerStayRequest({ partner: KUTKHA, requestId: REQ, answer: 'call', via: 'telegram' });
    expect(r.tell).toEqual({ kind: 'answered', answer: 'call', guestTold: false });
    expect(ownerStayAnswerText(r.tell)).toContain('позвоните ему по телефону из заявки');
  });
});

describe('нажатие в чате', () => {
  const found = { outcome: 'found' as const, partner: { partnerId: PARTNER, partnerName: 'Кутха', category: 'stay', crmCategory: 'stay' as const, userId: null } };

  it('MAX: сообщение заявки правится, под ним остаётся «Ответить гостю»', async () => {
    pool.mockResolvedValueOnce({ rows: [FACTS] });
    const send = vi.fn(async () => undefined);
    await handleStayAnswerPress({ lookup: found, payload: `sa:f:${REQ}`, editMid: 'm1', originalText: 'Заявка на жильё: Кутха', via: 'max', send });
    const [text, editMid, keep] = send.mock.calls[0] as unknown as [string, string | null, Array<{ text: string; payload: string }>];
    expect(editMid).toBe('m1');
    expect(text).toContain('Заявка на жильё: Кутха');
    expect(text).toContain('<b>Ваш ответ:</b> свободно, беру.');
    expect(keep).toEqual([{ text: 'Ответить гостю', payload: `sq:o:${REQ}` }]);
  });

  it('Telegram: новым сообщением, без кнопок переписки; чужой и нечитаемый чат — ответ не записан', async () => {
    pool.mockResolvedValueOnce({ rows: [FACTS] });
    const send = vi.fn(async () => undefined);
    await handleStayAnswerPress({ lookup: found, payload: `sa:b:${REQ}`, editMid: null, originalText: null, via: 'telegram', send });
    expect((send.mock.calls[0] as unknown as [string, string | null, unknown])[2]).toBeUndefined();
    send.mockClear(); pool.mockClear();
    await handleStayAnswerPress({ lookup: { outcome: 'none' }, payload: `sa:b:${REQ}`, editMid: null, originalText: null, via: 'telegram', send });
    expect((send.mock.calls[0] as unknown as [string])[0]).toContain('не ваша');
    await handleStayAnswerPress({ lookup: { outcome: 'unavailable' }, payload: `sa:b:${REQ}`, editMid: null, originalText: null, via: 'max', send });
    expect((send.mock.calls[1] as unknown as [string])[0]).toContain('Не удалось прочитать');
    await handleStayAnswerPress({ lookup: found, payload: 'sa:b:nope', editMid: null, originalText: null, via: 'max', send });
    expect((send.mock.calls[2] as unknown as [string])[0]).toContain('не распознана');
    expect(pool).not.toHaveBeenCalled();
  });
});

describe('привязка и справка хозяина жилья — простыми словами', () => {
  const bound = {
    ok: true as const, partnerName: 'Кутха', displayName: 'Кутха', category: 'stay', slug: null, previousChatId: null, rebound: false,
    cabinetOf: null, others: [], partnerId: PARTNER, sellsTours: false,
  };

  it('после привязки — кто он, что придёт, три кнопки, три кнопки строки; не «подключён к оператору» и без кабинета', () => {
    const row = boundMenuRow(bound as never);
    expect(row?.map((b) => b.text)).toEqual(['Заявки', 'Занято', 'Помощь']);
    const text = channelBoundText('max', bound as never);
    expect(text).toContain('Вы подключены как хозяин жилья «Кутха»');
    expect(text).toContain('«Свободно, беру», «Занято», «Позвоню сам»');
    expect(text).toContain('Кнопки под этим сообщением: «Заявки», «Занято», «Помощь»');
    expect(text).toContain('«занято с 5 по 9 ноября»');
    expect(text).not.toMatch(/подключён к оператору|кабинет/i);
    expect(stayBoundText('Кутха', 'telegram', null)).toContain('только в MAX');
  });

  it('справка — по шагам, без «Задач», «Клиентов» и кабинета на сайте', () => {
    const help = partnerMenuHelp('stay', { partnerId: PARTNER, category: 'stay', slug: null });
    expect(help).toMatch(/^Как это работает:/);
    expect(help).toContain('1. Гость оставляет заявку');
    expect(help).toContain('2. Под сообщением три кнопки');
    expect(help).toContain('3. Если за два часа ответа нет');
    expect(help).toContain('4. Когда у вас занято, напишите сюда одним сообщением: «занято с 5 по 9 ноября»');
    expect(help).not.toMatch(/Задачи|Клиенты|кабинет на сайте|vedarai\.ru\/hub/);
    expect(partnerMenu({ partnerId: PARTNER, category: 'stay', slug: null })?.map((b) => b.text)).toEqual(['Заявки', 'Занято', 'Помощь']);
  });
});

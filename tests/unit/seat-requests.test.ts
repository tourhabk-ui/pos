/**
 * Запрос свободных мест у оператора (решения владельца 29.09): ответ одним
 * нажатием, «Есть места» → сразу подтверждённая бронь, 2 часа на ответ,
 * исход — туристу в его мессенджер. Сторож держит связку целиком (§10.09):
 * форма планера → API → оператору с кнопками → ответ → бронь → туристу,
 * и уборщик в расписании. Каждый пункт обзора 29.09 закреплён отдельной
 * проверкой.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Handler { match: RegExp; rows?: unknown[]; rowCount?: number; error?: { code?: string; message?: string } }

const poolQueryMock = vi.hoisted(() => vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>>());
const reachMock = vi.hoisted(() => vi.fn());
const pdAlertMock = vi.hoisted(() => vi.fn());
const reserveMock = vi.hoisted(() => vi.fn());
const confirmMock = vi.hoisted(() => vi.fn());
const notifyOpMock = vi.hoisted(() => vi.fn());
const tgSendMock = vi.hoisted(() => vi.fn<(m: { chatId: string; text: string }) => Promise<{ success: boolean }>>());
const maxSendMock = vi.hoisted(() => vi.fn<(chatId: string | number, text: string) => Promise<{ ok: boolean }>>());

vi.mock('@/lib/db-pool', () => ({ pool: { query: (sql: string, params?: unknown[]) => poolQueryMock(sql, params) } }));
vi.mock('@/lib/partners/reach', () => ({ reachForPartner: (id: string) => reachMock(id) }));
vi.mock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: (p: unknown) => pdAlertMock(p) }));
vi.mock('@/lib/notifications/telegram', () => ({ telegramService: { sendMessage: (m: { chatId: string; text: string }) => tgSendMock(m) } }));
vi.mock('@/lib/notifications/max-channel', () => ({ maxSendDm: (c: string | number, t: string) => maxSendMock(c, t) }));
vi.mock('@/lib/bookings/booking.service', () => ({ confirmBooking: (...a: unknown[]) => confirmMock(...a) }));
vi.mock('@/lib/bookings/notify-operator', () => ({ notifyOperatorOfNewBooking: (b: unknown) => notifyOpMock(b) }));
vi.mock('@/lib/bookings/reserve', async () => {
  class ReserveError extends Error { constructor(public code: string, m: string) { super(m); } }
  return { reserveBooking: (i: unknown) => reserveMock(i), ReserveError };
});

import {
  SEAT_REQUEST_DEADLINE_MS, SEAT_REQUEST_STATUSES, FAILURE_KINDS, effectiveStatus, answerPayload, parseAnswerPayload,
  statusTokenFromStart, newStatusToken, hashStatusToken, operatorAnswerKey, verifyOperatorAnswerKey,
  isFutureOrToday, isRealDate, kamchatkaToday, touristOutcomeText, operatorReplyText,
} from '@/lib/seat-requests/core';
import {
  createSeatRequest, answerSeatRequest, recoverUnfinished, expireOverdue, notifyTourist, statusUrl, bindTouristChat, tourKeepsSchedule,
  MAX_PENDING_PER_OPERATOR, MAX_TOURIST_NOTIFY_ATTEMPTS,
} from '@/lib/seat-requests/service';
import { ReserveError } from '@/lib/bookings/reserve';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const RID = '3f2b8c1a-9d4e-4b7a-8c21-0e5f6a7b8c9d';

/** SQL-маршрутизация вместо очереди ответов: порядок запросов не важен. */
function setDb(handlers: Handler[]): void {
  poolQueryMock.mockImplementation(async (sql: string) => {
    for (const h of handlers) {
      if (h.match.test(sql)) {
        if (h.error) throw Object.assign(new Error(h.error.message ?? 'db'), { code: h.error.code });
        return { rows: h.rows ?? [], rowCount: h.rowCount ?? (h.rows?.length ?? 0) };
      }
    }
    return { rows: [], rowCount: 0 };
  });
}
const sqlCalls = () => poolQueryMock.mock.calls.map(([sql]) => sql);
const findCall = (re: RegExp) => poolQueryMock.mock.calls.find(([sql]) => re.test(sql));

beforeEach(() => {
  vi.stubEnv('JWT_SECRET', 'test-secret-long-enough-0123456789');
  vi.stubEnv('CONNECT_TOKEN_SECRET', '');
  vi.stubEnv('ENCRYPTION_KEY', 'a'.repeat(64));
  for (const m of [poolQueryMock, reachMock, pdAlertMock, reserveMock, confirmMock, notifyOpMock, tgSendMock, maxSendMock]) m.mockReset();
  tgSendMock.mockResolvedValue({ success: true });
  maxSendMock.mockResolvedValue({ ok: true });
  notifyOpMock.mockResolvedValue({ state: 'notified', outcome: { state: 'delivered', channel: 'max' } });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

/* ─── Правила владельца ─────────────────────────────────────────────────── */

describe('правила владельца', () => {
  it('срок ответа — 2 часа', () => {
    expect(SEAT_REQUEST_DEADLINE_MS).toBe(2 * 3600 * 1000);
  });

  it('статусы и причины отказа кода совпадают с CHECK миграции 1108', () => {
    const sql = read('migrations/1108_tour_seat_requests.sql');
    const list = (re: RegExp) => (re.exec(sql)?.[1] ?? '').split(',').map(x => x.trim().replace(/'/g, '')).sort();
    expect(list(/status IN \(([^)]+)\)/)).toEqual([...SEAT_REQUEST_STATUSES].sort());
    expect(list(/failure_kind IN \(([^)]+)\)/)).toEqual([...FAILURE_KINDS].sort());
  });

  it('миграция 1108: один ждущий запрос на (тур, дата, телефон) — на уровне базы, а не только кода', () => {
    const sql = read('migrations/1108_tour_seat_requests.sql');
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_tour_seat_requests_pending_same\s+ON tour_seat_requests \(tour_id, tour_date, tourist_phone\) WHERE status = 'pending'/);
    // Ключ страницы для позднего сообщения, попытки, код агента, причина отказа.
    for (const col of ['status_token_enc', 'tourist_notify_attempts', 'referral_code', 'failure_kind']) {
      expect(sql, col).toContain(col);
    }
    // 'failed' без названной причины — «мы разбираемся» без предмета.
    expect(sql).toMatch(/status <> 'failed' OR failure_kind IS NOT NULL/);
  });

  it('«не ответил» — не «мест нет»: после срока статус expired, текст говорит это вслух', () => {
    const now = Date.UTC(2026, 8, 29, 10);
    expect(effectiveStatus({ status: 'pending', deadline_at: new Date(now - 1), answered_at: null }, now)).toBe('expired');
    expect(effectiveStatus({ status: 'pending', deadline_at: new Date(now + 1), answered_at: null }, now)).toBe('pending');
    // Ответ принят в работу до срока — не просрочивается, пока заводится бронь.
    expect(effectiveStatus({ status: 'pending', deadline_at: new Date(now - 1), answered_at: new Date(now - 5) }, now)).toBe('pending');
    const t = touristOutcomeText(
      { status: 'expired', tour_title: 'X', tour_date: '2099-07-10', participants: 2, alt_date: null },
      { statusUrl: null, bookingUrl: null },
    );
    expect(t).toMatch(/не значит, что мест нет/);
  });
});

/* ─── Ключи, кнопки, даты ───────────────────────────────────────────────── */

describe('ключи и кнопки', () => {
  it('кнопка оператора: туда и обратно, чужое не угадывается', () => {
    expect(parseAnswerPayload(answerPayload('yes', RID))).toEqual({ requestId: RID, kind: 'yes' });
    expect(parseAnswerPayload(answerPayload('no', RID))).toEqual({ requestId: RID, kind: 'no' });
    for (const bad of ['sr:x:' + RID, 'sr:y:123', 'lead_contacted:1', '']) expect(parseAnswerPayload(bad)).toBeNull();
  });

  it('ключ статуса влезает в start Telegram и хранится хэшем', () => {
    const { token, hash } = newStatusToken();
    expect(`sr_${token}`.length).toBeLessThanOrEqual(64);
    expect(statusTokenFromStart(`sr_${token}`)).toBe(token);
    expect(hash).toBe(hashStatusToken(token));
    expect(hash).not.toContain(token);
    expect(statusTokenFromStart('op_' + token)).toBeNull();
  });

  it('подпись страницы ответа: своя проходит, чужая и без секрета — нет', () => {
    const k = operatorAnswerKey(RID)!;
    expect(verifyOperatorAnswerKey(RID, k)).toBe(true);
    expect(verifyOperatorAnswerKey('00000000-0000-0000-0000-000000000000', k)).toBe(false);
    expect(verifyOperatorAnswerKey(RID, 'x'.repeat(k.length))).toBe(false);
    vi.stubEnv('JWT_SECRET', '');
    expect(operatorAnswerKey(RID)).toBeNull();
    expect(verifyOperatorAnswerKey(RID, k)).toBe(false);
  });

  it('ключ из многобайтных символов той же длины — отказ, а не исключение (анонимному 500)', () => {
    const k = operatorAnswerKey(RID)!;
    const multibyte = 'я'.repeat(k.length);
    expect(multibyte.length).toBe(k.length);
    expect(() => verifyOperatorAnswerKey(RID, multibyte)).not.toThrow();
    expect(verifyOperatorAnswerKey(RID, multibyte)).toBe(false);
  });

  it('«сегодня» — камчатское: в 20:00 UTC на Камчатке уже завтра', () => {
    const now = Date.UTC(2026, 8, 29, 20);
    expect(kamchatkaToday(now)).toBe('2026-09-30');
    expect(isFutureOrToday('2026-09-29', now)).toBe(false);
    expect(isFutureOrToday('2026-09-30', now)).toBe(true);
  });

  it('несуществующая календарная дата не проходит', () => {
    expect(isRealDate('2099-07-10')).toBe(true);
    for (const bad of ['2099-02-31', '2099-13-01', '2099-00-10', '2099-7-1', 'вчера']) expect(isRealDate(bad)).toBe(false);
    expect(isFutureOrToday('2099-02-31')).toBe(false);
  });
});

/* ─── Тексты ────────────────────────────────────────────────────────────── */

describe('тексты говорят только то, что известно', () => {
  const base = { tour_title: 'Тур <b>X</b>', tour_date: '2099-07-10', participants: 2, alt_date: null };

  it('название тура экранируется: оба канала шлют HTML', () => {
    const t = touristOutcomeText({ ...base, status: 'declined' }, { statusUrl: null, bookingUrl: null });
    expect(t).toContain('Тур &lt;b&gt;X&lt;/b&gt;');
    expect(t).not.toContain('<b>X');
    expect(operatorReplyText({ ok: true, status: 'declined', tourTitle: 'A<i>', date: '2099-07-10' })).toContain('A&lt;i&gt;');
  });

  it('подтверждено, ссылки на бронь нет — не отсылает «на страницу брони», которой не назвали', () => {
    const noLinks = touristOutcomeText({ ...base, status: 'confirmed' }, { statusUrl: null, bookingUrl: null });
    expect(noLinks).not.toMatch(/https?:\/\//);
    expect(noLinks).toMatch(/свяжется с вами по указанному телефону/);
    const withStatus = touristOutcomeText({ ...base, status: 'confirmed' }, { statusUrl: 'https://x.test/seat-request#k', bookingUrl: null });
    expect(withStatus).toContain('https://x.test/seat-request#k');
    expect(withStatus).not.toContain('/planner');
  });

  it('оператору: «турист получил ссылку» — только если сообщение действительно ушло', () => {
    const ok = { ok: true as const, status: 'confirmed' as const, tourTitle: 'Т', date: '2099-07-10' };
    expect(operatorReplyText({ ...ok, touristMessage: 'sent' })).toMatch(/Турист получил ссылку на оплату/);
    for (const m of ['no_chat', 'failed'] as const) {
      const t = operatorReplyText({ ...ok, touristMessage: m });
      expect(t).not.toMatch(/Турист получил ссылку/);
      expect(t).toMatch(/в мессенджер сообщение не ушло/);
    }
  });

  it('«не завелась»: разногласие с календарём и сбой у нас названы по-разному', () => {
    const f = { ok: true as const, status: 'failed' as const, tourTitle: 'Т', date: '2099-07-10' };
    expect(operatorReplyText({ ...f, failureKind: 'accounting' })).toMatch(/календарь и вместимость/);
    const sys = operatorReplyText({ ...f, failureKind: 'system' });
    expect(sys).toMatch(/сбоя на нашей стороне/);
    expect(sys).not.toMatch(/дату закрытой или занятой/);
  });

  it('на веб-странице ответа название не экранируется (React выводит строку как текст), в мессенджер — экранируется', () => {
    const r = { ok: true as const, status: 'declined' as const, tourTitle: 'Тур & <Море>', date: '2099-07-10' };
    expect(operatorReplyText(r, { html: false })).toContain('«Тур & <Море>»');
    expect(operatorReplyText(r)).toContain('Тур &amp; &lt;Море&gt;');
  });

  it('оператору: доставка контактов туриста не обещается, если уведомление не дошло', () => {
    const ok = { ok: true as const, status: 'confirmed' as const, tourTitle: 'Т', date: '2099-07-10', touristMessage: 'sent' as const };
    expect(operatorReplyText({ ...ok, operatorNotified: false })).toMatch(/доставить не удалось — их передаст администратор/);
    expect(operatorReplyText({ ...ok, operatorNotified: true })).toMatch(/Контакты туриста придут отдельным уведомлением/);
  });

  it('туристу: «ответ неизвестен» и «запрос не дошёл» не выдаются за «оператор сказал, что места есть»', () => {
    const f = { tour_title: 'Т', tour_date: '2099-07-10', participants: 2, alt_date: null, status: 'failed' as const };
    const links = { statusUrl: null, bookingUrl: null };
    const unfinished = touristOutcomeText({ ...f, failure_kind: 'unfinished' }, links);
    expect(unfinished).toMatch(/уточняем ответ оператора/);
    expect(unfinished).not.toMatch(/места есть/);
    const delivery = touristOutcomeText({ ...f, failure_kind: 'delivery' }, links);
    expect(delivery).toMatch(/до оператора не дошёл/);
    expect(delivery).not.toMatch(/места есть/);
    expect(touristOutcomeText({ ...f, failure_kind: 'accounting' }, links)).toMatch(/места есть/);
  });

  it('«ответ принят, исход не записан» — не зовёт нажимать ещё раз', () => {
    const t = operatorReplyText({ ok: false, reason: 'accepted_unfinished' });
    expect(t).toMatch(/Повторно не нажимайте/);
    expect(operatorReplyText({ ok: false, reason: 'db_error' })).toMatch(/Нажмите ещё раз/);
  });
});

/* ─── Создание ──────────────────────────────────────────────────────────── */

describe('создание запроса', () => {
  const input = {
    tourId: 7, date: '2099-07-10', participants: 2, touristName: 'Иван Петров', touristPhone: '8 900 000-00-00',
    replyChannel: 'max' as const, pdConsent: { at: new Date(), ip: '1.1.1.1', source: 'seat-request', version: 'v1' },
  };
  const TOUR = { match: /FROM operator_tours\s+WHERE id/, rows: [{ operator_id: 'op', title: 'Тур' }] };
  const reachOk = { reachable: true, maxChatId: '1', telegramChatId: '2' };

  it('расписание тура: есть будущая неотменённая дата / нет / не смогли проверить — три разных исхода', async () => {
    setDb([{ match: /FROM tour_availability/, rows: [{ has: true }] }]);
    expect(await tourKeepsSchedule(7)).toBe(true);
    const q = findCall(/FROM tour_availability/)!;
    expect(q[0]).toMatch(/date >= \(NOW\(\) AT TIME ZONE 'Asia\/Kamchatka'\)::date/);
    expect(q[0]).toMatch(/is_cancelled = FALSE/);
    expect(q[0]).toMatch(/deleted_at IS NULL/);
    expect(q[1]).toEqual([7]);
    setDb([{ match: /FROM tour_availability/, rows: [{ has: false }] }]);
    expect(await tourKeepsSchedule(7)).toBe(false);
    setDb([{ match: /FROM tour_availability/, error: { code: '57P01' } }]);
    expect(await tourKeepsSchedule(7)).toBeNull();
  });

  it('прошлая дата и мусорный телефон отсекаются до базы', async () => {
    expect(await createSeatRequest({ ...input, date: '2000-01-01' })).toEqual({ ok: false, reason: 'date_past' });
    expect(await createSeatRequest({ ...input, date: '2099-02-31' })).toEqual({ ok: false, reason: 'bad_date' });
    expect(await createSeatRequest({ ...input, touristPhone: 'привет' })).toEqual({ ok: false, reason: 'bad_phone' });
    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it('оператору некуда написать — запрос не заводится (иначе «не ответил» было бы ложью)', async () => {
    setDb([TOUR]);
    reachMock.mockResolvedValue({ reachable: false, maxChatId: null, telegramChatId: null });
    expect(await createSeatRequest(input)).toEqual({ ok: false, reason: 'operator_unreachable' });
    expect(sqlCalls().some(s => /INSERT INTO tour_seat_requests/.test(s))).toBe(false);
  });

  it('не смогли проверить канал — «не смог», а не «недоступен»', async () => {
    setDb([TOUR]);
    reachMock.mockResolvedValue(null);
    expect(await createSeatRequest(input)).toEqual({ ok: false, reason: 'check_failed' });
  });

  it('дубль: тот же тур, дата и телефон — не вторая строка, не второе сообщение оператору и НЕ ключ чужого запроса', async () => {
    const { token } = newStatusToken();
    const { encrypt } = await import('@/lib/encryption');
    setDb([TOUR, { match: /r\.status = 'pending' AND r\.deadline_at > NOW\(\)/, rows: [{ status: 'pending', status_token_enc: encrypt(token) }] }]);
    reachMock.mockResolvedValue(reachOk);
    const r = await createSeatRequest(input);
    // Телефон — не секрет: ответ на дубль не может нести ссылку на страницу
    // статуса (а с ней и на бронь) того, кто знает лишь номер.
    expect(r).toEqual({ ok: false, reason: 'duplicate' });
    expect(JSON.stringify(r)).not.toContain(token);
    expect(sqlCalls().some(s => /INSERT INTO tour_seat_requests/.test(s))).toBe(false);
    expect(pdAlertMock).not.toHaveBeenCalled();
    // Телефон сравнивается нормализованным: 8… и +7… — один человек.
    expect(findCall(/r\.tourist_phone = \$3/)![1]).toEqual([7, '2099-07-10', '+79000000000']);
    // Запрос не читает и не расшифровывает ключ страницы вовсе.
    expect(findCall(/r\.status = 'pending' AND r\.deadline_at > NOW\(\)/)![0]).not.toMatch(/status_token_enc/);
  });

  it('просроченный, но не убранный ждущий запрос закрывается ДО проверки дубля — иначе «отправьте ещё раз» упирается в ложное «уже отправлен»', async () => {
    setDb([TOUR, { match: /AS op_pending/, rows: [{ op_pending: 0, phone_pending: 0, phone_day: 0 }] },
      { match: /INSERT INTO tour_seat_requests/, rows: [{ id: RID }] }]);
    reachMock.mockResolvedValue(reachOk);
    pdAlertMock.mockResolvedValue({ channel: 'max', delivered: true, reason: 'ok' });
    expect(await createSeatRequest(input)).toMatchObject({ ok: true });
    const calls = sqlCalls();
    const close = calls.findIndex(q => /SET status = 'expired'/.test(q) && /deadline_at <= NOW\(\)/.test(q) && /answered_at IS NULL/.test(q));
    const dup = calls.findIndex(q => /r\.status = 'pending' AND r\.deadline_at > NOW\(\)/.test(q));
    expect(close).toBeGreaterThanOrEqual(0);
    expect(close).toBeLessThan(dup);
    // Закрывается ровно тот запрос, что мешает, а не чужие: тур, дата, телефон.
    expect(poolQueryMock.mock.calls[close]![1]).toEqual([7, '2099-07-10', '+79000000000']);
  });

  it('десять цифр без кода страны — российский номер, и «+7 900…» того же человека даёт тот же телефон', async () => {
    reachMock.mockResolvedValue(reachOk);
    for (const raw of ['900 123-45-67', '+7 900 123-45-67', '8 900 123 45 67']) {
      setDb([TOUR, { match: /AS op_pending/, rows: [{ op_pending: 0, phone_pending: 3, phone_day: 0 }] }]);
      poolQueryMock.mockClear();
      await createSeatRequest({ ...input, touristPhone: raw });
      expect(findCall(/r\.tourist_phone = \$3/)![1], raw).toEqual([7, '2099-07-10', '+79001234567']);
    }
  });

  it('потолки: у оператора, у телефона, в сутки', async () => {
    reachMock.mockResolvedValue(reachOk);
    for (const caps of [
      { op_pending: MAX_PENDING_PER_OPERATOR, phone_pending: 0, phone_day: 0 },
      { op_pending: 0, phone_pending: 3, phone_day: 0 },
      { op_pending: 0, phone_pending: 0, phone_day: 10 },
    ]) {
      setDb([TOUR, { match: /AS op_pending/, rows: [caps] }]);
      expect(await createSeatRequest(input)).toEqual({ ok: false, reason: 'too_many' });
    }
  });

  it('гонка двух одинаковых запросов: вставку выиграл один, второй получает duplicate', async () => {
    setDb([TOUR, { match: /AS op_pending/, rows: [{ op_pending: 0, phone_pending: 0, phone_day: 0 }] },
      { match: /INSERT INTO tour_seat_requests/, error: { code: '23505' } }]);
    reachMock.mockResolvedValue(reachOk);
    expect(await createSeatRequest(input)).toMatchObject({ ok: false, reason: 'duplicate' });
  });

  it('сообщение оператору БЕЗ имени и телефона; адресат назван; кнопки есть; код агента сохранён', async () => {
    setDb([TOUR, { match: /AS op_pending/, rows: [{ op_pending: 0, phone_pending: 0, phone_day: 0 }] },
      { match: /INSERT INTO tour_seat_requests/, rows: [{ id: RID }] }]);
    reachMock.mockResolvedValue(reachOk);
    pdAlertMock.mockResolvedValue({ channel: 'max', delivered: true, reason: 'ok' });
    const r = await createSeatRequest({ ...input, referralCode: 'KH-AGT-ABCDEF' });
    expect(r.ok).toBe(true);
    const p = pdAlertMock.mock.calls[0]![0] as { text: string; stub: string; buttons: Array<{ payload?: string; url?: string }>; to: unknown };
    for (const t of [p.text, p.stub]) {
      expect(t).not.toMatch(/Иван|Петров|79000000000|8 900/);
    }
    expect(p.buttons.map(b => b.payload).filter(Boolean)).toEqual([answerPayload('yes', RID), answerPayload('no', RID)]);
    expect(p.buttons.some(b => b.url?.includes(`/seat-request/answer/${RID}?k=`))).toBe(true);
    expect(p.to).toEqual({ maxChatId: '1', telegramChatId: '2' });
    const ins = findCall(/INSERT INTO tour_seat_requests/)!;
    expect(ins[1]).toContain('KH-AGT-ABCDEF');
    expect(ins[1]).toContain('+79000000000');
  });

  it('не дошло никуда — запрос закрыт сразу как failed/delivery', async () => {
    setDb([TOUR, { match: /AS op_pending/, rows: [{ op_pending: 0, phone_pending: 0, phone_day: 0 }] },
      { match: /INSERT INTO tour_seat_requests/, rows: [{ id: RID }] }]);
    reachMock.mockResolvedValue(reachOk);
    pdAlertMock.mockResolvedValue({ channel: 'none', delivered: false, reason: 'MAX отказал' });
    expect(await createSeatRequest(input)).toEqual({ ok: false, reason: 'delivery_failed' });
    const upd = findCall(/SET operator_delivery/)!;
    expect(upd[0]).toMatch(/failure_kind = CASE WHEN \$3::boolean THEN 'delivery'/);
    expect(upd[1]).toEqual([RID, 'none', true, expect.stringContaining('MAX отказал')]);
  });
});

/* ─── Ответ оператора ───────────────────────────────────────────────────── */

describe('ответ оператора', () => {
  const claimed = {
    id: RID, tour_id: '7', operator_id: 'op', tour_date: '2099-07-10', participants: 2,
    tourist_name: 'Иван', tourist_phone: '+79000000000', title: 'Тур', referral_code: 'KH-AGT-ABCDEF',
    pd_consent_at: new Date(), pd_consent_ip: '1.1.1.1', pd_consent_source: 'seat-request', pd_consent_version: 'v1',
  };
  const CLAIM = { match: /SET answered_at = NOW\(\)/, rows: [claimed] };
  const FINAL = { match: /SET status = \$2, booking_id = \$3/, rowCount: 1 };
  const reserved = { bookingId: 42, accessToken: 'tok', totalPrice: 9000, operatorId: 'op', tourTitle: 'Тур' };

  it('захват атомарный: ждёт, никто не ответил, срок не вышел, дата тура не прошла (по Камчатке)', async () => {
    setDb([]);
    await answerSeatRequest(RID, { kind: 'no' }, 'web');
    const sql = findCall(/SET answered_at = NOW\(\)/)![0];
    expect(sql).toMatch(/r\.status = 'pending' AND r\.answered_at IS NULL AND r\.deadline_at > NOW\(\)/);
    expect(sql).toMatch(/r\.tour_date >= \(NOW\(\) AT TIME ZONE 'Asia\/Kamchatka'\)::date/);
  });

  it('дата тура прошла после полуночи по Камчатке — ответ не заводит бронь в прошлое', async () => {
    setDb([{ match: /SELECT status, deadline_at, answered_at, tour_date::text/, rows: [
      { status: 'pending', deadline_at: new Date(Date.now() + 3600_000), answered_at: null, tour_date: '2000-01-01' }] }]);
    expect(await answerSeatRequest(RID, { kind: 'yes' }, 'max')).toEqual({ ok: false, reason: 'date_past', status: 'pending' });
    expect(reserveMock).not.toHaveBeenCalled();
  });

  it('«Есть места»: бронь той же дверью, код агента переезжает, подтверждение, уведомление оператору', async () => {
    setDb([CLAIM, FINAL]);
    reserveMock.mockResolvedValue(reserved);
    confirmMock.mockResolvedValue({});
    const r = await answerSeatRequest(RID, { kind: 'yes' }, 'max');
    expect(r).toMatchObject({ ok: true, status: 'confirmed', failureKind: null });
    expect(reserveMock.mock.calls[0]![0]).toMatchObject({
      tourId: 7, participants: 2, date: '2099-07-10', createdVia: 'seat_request', referralCode: 'KH-AGT-ABCDEF',
    });
    expect(confirmMock).toHaveBeenCalledWith('42', null, expect.any(String));
    // Оператор подтвердил бронь — и узнаёт контакты туриста обычным уведомлением.
    expect(notifyOpMock).toHaveBeenCalledTimes(1);
    expect(notifyOpMock.mock.calls[0]![0]).toMatchObject({ bookingId: 42, touristName: 'Иван', touristPhone: '+79000000000', via: 'seat_request' });
    expect(findCall(/SET status = \$2, booking_id = \$3/)![1]).toEqual([RID, 'confirmed', 42, expect.any(String), null, null, null]);
  });

  it('учёт платформы не согласен — failed/accounting, а не бронь сверх вместимости; оператору уведомления о брони нет', async () => {
    setDb([CLAIM, FINAL]);
    reserveMock.mockRejectedValue(new ReserveError('NO_SLOTS', 'Нет свободных мест на эту дату.'));
    const r = await answerSeatRequest(RID, { kind: 'yes' }, 'max');
    expect(r).toMatchObject({ ok: true, status: 'failed', failureKind: 'accounting' });
    expect(confirmMock).not.toHaveBeenCalled();
    expect(notifyOpMock).not.toHaveBeenCalled();
    expect(findCall(/SET status = \$2, booking_id = \$3/)![1]).toEqual([RID, 'failed', null, null, 'accounting', expect.stringMatching(/Нет свободных мест/), null]);
  });

  it('сбой подтверждения — failed/system, бронь #N сохранена в запросе, а не «дата закрыта»', async () => {
    setDb([CLAIM, FINAL]);
    reserveMock.mockResolvedValue(reserved);
    confirmMock.mockRejectedValue(new Error('deadlock detected'));
    const r = await answerSeatRequest(RID, { kind: 'yes' }, 'max');
    expect(r).toMatchObject({ ok: true, status: 'failed', failureKind: 'system' });
    const fin = findCall(/SET status = \$2, booking_id = \$3/)!;
    expect(fin[1]![2]).toBe(42);
    expect(fin[1]![4]).toBe('system');
    expect(fin[1]![5]).toMatch(/бронь #42 создана, подтверждение не прошло/);
    expect(notifyOpMock).not.toHaveBeenCalled();
  });

  it('несвязанный сбой при заведении брони — тоже system, не accounting', async () => {
    setDb([CLAIM, FINAL]);
    reserveMock.mockRejectedValue(new Error('connection reset'));
    expect(await answerSeatRequest(RID, { kind: 'yes' }, 'max')).toMatchObject({ status: 'failed', failureKind: 'system' });
  });

  it('итоговая запись упала — «принято, не записано», без призыва нажимать ещё раз', async () => {
    setDb([CLAIM, { match: /SET status = \$2, booking_id = \$3/, error: { code: '57P01' } }]);
    reserveMock.mockResolvedValue(reserved);
    confirmMock.mockResolvedValue({});
    expect(await answerSeatRequest(RID, { kind: 'yes' }, 'max')).toEqual({ ok: false, reason: 'accepted_unfinished' });
    // Оператор о подтверждённой брони узнаёт ДО итоговой записи: оборвись
    // процесс между ними, бронь была бы, а он о ней не знал бы. Уборщик
    // уведомит ещё раз — дубль безвреден, тишина нет.
    expect(notifyOpMock).toHaveBeenCalledTimes(1);
    expect(tgSendMock).not.toHaveBeenCalled();
    expect(maxSendMock).not.toHaveBeenCalled();
  });

  it('уборщик успел раньше нас — исход второй раз не пишем и туристу второй раз не сообщаем', async () => {
    setDb([CLAIM, { match: /SET status = \$2, booking_id = \$3/, rowCount: 0 }]);
    reserveMock.mockResolvedValue(reserved);
    confirmMock.mockResolvedValue({});
    expect(await answerSeatRequest(RID, { kind: 'yes' }, 'max')).toMatchObject({ ok: false, reason: 'already_answered' });
    expect(maxSendMock).not.toHaveBeenCalled();
    expect(tgSendMock).not.toHaveBeenCalled();
  });

  it('уведомление оператору уходит РАНЬШЕ итоговой записи, а его исход попадает в ответ', async () => {
    const order: string[] = [];
    poolQueryMock.mockImplementation(async (sql: string) => {
      if (/SET answered_at = NOW\(\)/.test(sql)) return { rows: [claimed], rowCount: 1 };
      if (/SET status = \$2, booking_id = \$3/.test(sql)) { order.push('final'); return { rows: [], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    });
    reserveMock.mockResolvedValue(reserved);
    confirmMock.mockResolvedValue({});
    notifyOpMock.mockImplementation(async () => { order.push('notify'); return { state: 'notified', outcome: { state: 'delivered', channel: 'max' } }; });
    expect(await answerSeatRequest(RID, { kind: 'yes' }, 'max')).toMatchObject({ ok: true, operatorNotified: true });
    expect(order.slice(0, 2)).toEqual(['notify', 'final']);

    // Доставить не вышло — ответ оператору не обещает, что контакты пришли.
    notifyOpMock.mockResolvedValue({ state: 'failed', reason: 'нет канала' });
    poolQueryMock.mockClear();
    setDb([CLAIM, FINAL]);
    expect(await answerSeatRequest(RID, { kind: 'yes' }, 'max')).toMatchObject({ ok: true, operatorNotified: false });
  });

  it('дата «другой даты» в прошлом отклоняется ДО захвата', async () => {
    expect(await answerSeatRequest(RID, { kind: 'other_date', date: '2000-01-01' }, 'web')).toEqual({ ok: false, reason: 'bad_date' });
    expect(await answerSeatRequest(RID, { kind: 'other_date', date: '2099-02-31' }, 'web')).toEqual({ ok: false, reason: 'bad_date' });
    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it('исход «мест нет» и сообщение туристу: оператору говорится, ушло ли оно', async () => {
    setDb([CLAIM, FINAL, { match: /FROM tour_seat_requests r JOIN operator_tours t ON t\.id = r\.tour_id\s+WHERE r\.id = \$1::uuid/, rows: [{
      id: RID, status: 'declined', deadline_at: new Date(Date.now() + 3600_000), answered_at: new Date(), reply_channel: 'telegram',
      tourist_chat_id: '555', tourist_notified_at: null, tourist_notify_attempts: 0, tour_title: 'Тур', tour_date: '2099-07-10',
      participants: 2, alt_date: null, booking_id: null, booking_access_token_enc: null, status_token_enc: null }] }]);
    const r = await answerSeatRequest(RID, { kind: 'no' }, 'max');
    expect(r).toMatchObject({ ok: true, status: 'declined', touristMessage: 'sent' });
    expect(tgSendMock).toHaveBeenCalledTimes(1);
  });
});

/* ─── Уведомление туристу и уборщик ─────────────────────────────────────── */

describe('туристу и уборщик', () => {
  const rowFor = (over: Record<string, unknown> = {}) => ({
    id: RID, status: 'declined', deadline_at: new Date(Date.now() + 3600_000), answered_at: new Date(), reply_channel: 'max',
    tourist_chat_id: '555', tourist_notified_at: null, tourist_notify_attempts: 0, tour_title: 'Тур', tour_date: '2099-07-10',
    participants: 2, alt_date: null, booking_id: null, booking_access_token_enc: null, status_token_enc: null, ...over,
  });
  const NOTIFY_ROW = /FROM tour_seat_requests r JOIN operator_tours t ON t\.id = r\.tour_id\s+WHERE r\.id = \$1::uuid/;

  it('сообщение не ушло — растёт счётчик попыток, отметки об отправке нет', async () => {
    setDb([{ match: NOTIFY_ROW, rows: [rowFor()] }]);
    maxSendMock.mockResolvedValue({ ok: false });
    expect(await notifyTourist(RID)).toBe('failed');
    expect(findCall(/tourist_notify_attempts = tourist_notify_attempts \+ 1/)).toBeTruthy();
    expect(sqlCalls().some(s => /SET tourist_notified_at = NOW\(\)/.test(s))).toBe(false);
  });

  it('уже отправлено — повторно не шлём', async () => {
    setDb([{ match: NOTIFY_ROW, rows: [rowFor({ tourist_notified_at: new Date() })] }]);
    expect(await notifyTourist(RID)).toBe('sent');
    expect(maxSendMock).not.toHaveBeenCalled();
  });

  it('ссылка на страницу запроса собирается из зашифрованного ключа и несёт фрагмент, не путь', async () => {
    const { token } = newStatusToken();
    const { encrypt } = await import('@/lib/encryption');
    setDb([{ match: NOTIFY_ROW, rows: [rowFor({ status_token_enc: encrypt(token) })] }]);
    await notifyTourist(RID);
    expect(maxSendMock.mock.calls[0]![1]).toContain(`/seat-request#${token}`);
    expect(maxSendMock.mock.calls[0]![1]).not.toContain(`/seat-request/${token}`);
  });

  it('чат туриста: чужой уже подключённый чат не перезаписывается; ключ неверный и ключ верный, но чат занят, — разные исходы', async () => {
    const { token } = newStatusToken();
    // UPDATE не подошёл ни одной строке, запрос по ключу есть — чат занят.
    setDb([{ match: /SET tourist_chat_id = \$2::bigint/, rows: [] }, { match: /SELECT 1 FROM tour_seat_requests WHERE status_token_hash/, rows: [{ '?column?': 1 }] }]);
    expect(await bindTouristChat(token, 'max', 555)).toEqual({ ok: false, reason: 'already_bound' });
    const upd = findCall(/SET tourist_chat_id = \$2::bigint/)!;
    expect(upd[0]).toMatch(/tourist_chat_id IS NULL OR tourist_chat_id = \$2::bigint/);
    // Ключа нет вовсе.
    setDb([]);
    expect(await bindTouristChat(token, 'max', 555)).toEqual({ ok: false, reason: 'not_found' });
    // База упала — «не смог», а не «не найден».
    setDb([{ match: /SET tourist_chat_id/, error: { code: '57P01' } }]);
    expect(await bindTouristChat(token, 'max', 555)).toEqual({ ok: false, reason: 'db_error' });
  });

  it('уборщик: бронь подтверждена → confirmed и уведомление оператору', async () => {
    setDb([
      { match: /FROM tour_seat_requests r JOIN operator_tours t ON t\.id = r\.tour_id\s+WHERE r\.status = 'pending' AND r\.answered_at IS NOT NULL/, rows: [
        { id: RID, tour_date: '2099-07-10', participants: 2, tourist_name: 'Иван', tourist_phone: '+7900', operator_id: 'op', title: 'Тур' }] },
      { match: /FROM operator_bookings\s+WHERE metadata->>'seat_request_id'/, rows: [{ id: '42', booking_status: 'confirmed', final_price: '9000' }] },
      { match: /UPDATE tour_seat_requests\s+SET status = \$2, booking_id = \$3::bigint/, rowCount: 1 },
    ]);
    expect(await recoverUnfinished()).toEqual({ recovered: 1, failed: 0 });
    expect(findCall(/SET status = \$2, booking_id = \$3::bigint/)![1]).toEqual([RID, 'confirmed', '42', null, null, null]);
    expect(notifyOpMock).toHaveBeenCalledTimes(1);
  });

  it('уборщик сохраняет ключ брони зашифрованным — иначе ссылка на оплату теряется вместе с процессом', async () => {
    setDb([
      { match: /FROM tour_seat_requests r JOIN operator_tours t ON t\.id = r\.tour_id\s+WHERE r\.status = 'pending' AND r\.answered_at IS NOT NULL/, rows: [
        { id: RID, tour_date: '2099-07-10', participants: 2, tourist_name: 'Иван', tourist_phone: '+7900', operator_id: 'op', title: 'Тур' }] },
      { match: /FROM operator_bookings\s+WHERE metadata->>'seat_request_id'/, rows: [{ id: '42', booking_status: 'confirmed', final_price: '9000', access_token: 'live-booking-key' }] },
      { match: /UPDATE tour_seat_requests\s+SET status = \$2, booking_id = \$3::bigint/, rowCount: 1 },
    ]);
    await recoverUnfinished();
    const upd = findCall(/SET status = \$2, booking_id = \$3::bigint/)!;
    expect(upd[0]).toMatch(/booking_access_token_enc = COALESCE\(\$6, booking_access_token_enc\)/);
    const enc = upd[1]![5] as string;
    expect(enc).toEqual(expect.any(String));
    expect(enc).not.toContain('live-booking-key');
    const { decrypt } = await import('@/lib/encryption');
    expect(decrypt(enc)).toBe('live-booking-key');
  });

  it('уборщик: бронь есть, но не подтверждена → failed/system; брони нет → failed/unfinished', async () => {
    const pending = { match: /WHERE r\.status = 'pending' AND r\.answered_at IS NOT NULL/, rows: [
      { id: RID, tour_date: '2099-07-10', participants: 2, tourist_name: 'Иван', tourist_phone: '+7900', operator_id: 'op', title: 'Тур' }] };
    const upd = { match: /SET status = \$2, booking_id = \$3::bigint/, rowCount: 1 };
    setDb([pending, { match: /WHERE metadata->>'seat_request_id'/, rows: [{ id: '42', booking_status: 'new', final_price: '1' }] }, upd]);
    expect(await recoverUnfinished()).toEqual({ recovered: 0, failed: 1 });
    expect(findCall(/SET status = \$2, booking_id = \$3::bigint/)![1]![3]).toBe('system');

    poolQueryMock.mockReset();
    setDb([pending, { match: /WHERE metadata->>'seat_request_id'/, rows: [] }, upd]);
    expect(await recoverUnfinished()).toEqual({ recovered: 0, failed: 1 });
    const call = findCall(/SET status = \$2, booking_id = \$3::bigint/)!;
    expect(call[1]![3]).toBe('unfinished');
    expect(call[1]![4]).toMatch(/что именно ответил оператор, восстановить нечем/);
    expect(notifyOpMock).not.toHaveBeenCalled();
  });

  it('прогон уборщика подбирает «принятые, но не доведённые» — иначе они висят «ждём ответа» вечно', async () => {
    setDb([
      { match: /SET status = 'expired'/, rows: [] },
      { match: /WHERE r\.status = 'pending' AND r\.answered_at IS NOT NULL/, rows: [
        { id: RID, tour_date: '2099-07-10', participants: 2, tourist_name: 'Иван', tourist_phone: '+7900', operator_id: 'op', title: 'Тур' }] },
      { match: /WHERE metadata->>'seat_request_id'/, rows: [{ id: '42', booking_status: 'confirmed', final_price: '1' }] },
      { match: /SET status = \$2, booking_id = \$3::bigint/, rowCount: 1 },
      { match: /tourist_notify_attempts < \$1/, rows: [] },
    ]);
    const r = await expireOverdue();
    expect(r).toMatchObject({ expired: 0, recovered: 1, unfinished_failed: 0 });
    // «Принят» отсчитывается от answered_at, а не от дедлайна: окно живой обработки не трогаем.
    expect(findCall(/WHERE r\.status = 'pending' AND r\.answered_at IS NOT NULL/)![0]).toMatch(/r\.answered_at < NOW\(\) - \(\$1 \|\| ' minutes'\)::INTERVAL/);
  });

  it('уборщик повторяет неотправленные исходы в пределах суток и потолка попыток', async () => {
    setDb([
      { match: /SET status = 'expired'/, rows: [{ id: 'a' }] },
      { match: /WHERE r\.status = 'pending' AND r\.answered_at IS NOT NULL/, rows: [] },
      { match: /tourist_notify_attempts < \$1/, rows: [] },
    ]);
    const r = await expireOverdue();
    expect(r.expired).toBe(1);
    const q = findCall(/tourist_notify_attempts < \$1/)!;
    expect(q[0]).toMatch(/tourist_notified_at IS NULL AND tourist_chat_id IS NOT NULL/);
    expect(q[0]).toMatch(/updated_at > NOW\(\) - INTERVAL '24 hours'/);
    expect(q[1]).toEqual([MAX_TOURIST_NOTIFY_ATTEMPTS]);
  });
});

/* ─── Провода ───────────────────────────────────────────────────────────── */

describe('провода', () => {
  it('MAX: кнопка засчитывается только из заверенного апдейта и из чата оператора запроса', () => {
    const src = read('app/api/max/kuzmich/route.ts');
    const i = src.indexOf('const seat = parseAnswerPayload(payload);');
    expect(i).toBeGreaterThan(0);
    const branch = src.slice(i, src.indexOf('answerSeatRequest(seat.requestId', i));
    expect(branch).toMatch(/if \(opts\?\.verifiedOrigin !== true\) return;/);
    expect(branch).toMatch(/requestBelongsToMaxChat\(seat\.requestId, resolvedChatId\)/);
  });

  it('турист подключает чат в обоих ботах; в MAX — под гейтом заверенного апдейта', () => {
    expect(read('app/api/telegram/webhook/route.ts')).toMatch(/bindTouristChat\(seatToken, 'telegram', update\.message\.chat\.id\)/);
    const max = read('app/api/max/kuzmich/route.ts');
    const k = max.indexOf('statusTokenFromStart(startArg)');
    const gate = max.lastIndexOf('if (opts?.verifiedOrigin === true', k);
    expect(gate).toBeGreaterThan(0);
    expect(max.slice(gate, k)).not.toMatch(/\n    \}\n/);
    // Гейт — ровно тот, за которым разбирается payload, а не более ранний.
    expect(max).toMatch(/if \(opts\?\.verifiedOrigin === true\) \{\s*\n\s*const startArg = typeof update\.payload === 'string'/);
  });

  it('планер показывает кнопку и форму; форма шлёт код агента и состояние согласия', () => {
    const p = read('app/planner/_PlannerClient.tsx');
    expect(p).toMatch(/onAskSeats=\{\(t\) => setSeatModal/);
    expect(p).toMatch(/<SeatRequestForm/);
    const f = read('components/planner/SeatRequestForm.tsx');
    expect(f).toMatch(/fetch\('\/api\/seat-requests'/);
    expect(f).toMatch(/referral_code: agentReferralForBooking/);
    expect(f).toMatch(/pd_consent: consent/);
    // Escape закрывает окно, фокус уходит внутрь.
    expect(f).toMatch(/e\.key === 'Escape'/);
  });

  it('окно запроса: пока идёт отправка, закрыть нельзя; поверх нижней навигации; прокрутка страницы под ним заперта', () => {
    const f = read('components/planner/SeatRequestForm.tsx');
    // Закрытие во время отправки отвязало бы страницу от запроса, который уже
    // ушёл оператору, — ключа статуса турист бы не увидел.
    expect(f).toMatch(/e\.key === 'Escape' && !sendingRef\.current/);
    expect(f).toMatch(/onClick=\{onClose\} disabled=\{sending\}/);
    expect(f).toMatch(/z-\[1100\]/);
    expect(f).toMatch(/max-h-\[92dvh\]/);
    expect(f).toMatch(/document\.body\.style\.overflow = 'hidden'/);
    expect(f).toMatch(/document\.body\.style\.overflow = prevOverflow/);
    // Ссылка на запрос переживает закрытие окна и перезагрузку — но только в браузере зрителя.
    expect(f).toMatch(/localStorage\.setItem\(STORE_KEY/);
  });

  it('страница статуса: неверная ссылка — окончательный ответ, смена фрагмента подхватывается, поздний ответ не затирает новый', () => {
    const c = read('app/seat-request/_SeatRequestStatusClient.tsx');
    expect(c).toMatch(/res\.status === 400 \|\| res\.status === 404/);
    expect(c).toMatch(/if \(!token \|\| fatal \|\| !keepPolling\) return;/);
    expect(c).toMatch(/addEventListener\('hashchange'/);
    expect(c).toMatch(/removeEventListener\('hashchange'/);
    expect(c).toMatch(/activeToken\.current !== asked/);
    // Причина «failed» приходит из API и меняет слова.
    expect(c).toMatch(/failedText\(view\.failureKind\)/);
  });

  it('плавающий помощник не перекрывает окно запроса', () => {
    const p = read('app/planner/_PlannerClient.tsx');
    expect(p).not.toMatch(/fixed bottom-6 right-6 z-50/);
  });

  it('API публичны на Edge, форма требует согласия на ПД, IP — надёжный', () => {
    expect(read('lib/auth/public-api-routes.ts')).toMatch(/'\/api\/seat-requests': \['GET', 'POST'\]/);
    const route = read('app/api/seat-requests/route.ts');
    expect(route).toMatch(/pd_consent:\s+z\.literal\(true/);
    expect(route).toMatch(/getTrustedClientIp\(req\.headers\)/);
    expect(route).not.toMatch(/getClientIp\(/);
    expect(read('lib/rate-limit.ts')).toMatch(/headers\.get\('x-real-ip'\)/);
  });

  it('страница статуса: ключ во фрагменте, не в пути (не оседает в page_views)', () => {
    expect(statusUrl('K'.repeat(32))).toMatch(/\/seat-request#K{32}$/);
    const client = read('app/seat-request/_SeatRequestStatusClient.tsx');
    expect(client).toMatch(/window\.location\.hash/);
    // Первая загрузка, не удавшаяся, повторяется — не застывает на ошибке.
    expect(client).toMatch(/view === null && error !== null/);
    expect(() => read('app/seat-request/[token]/page.tsx')).toThrow();
  });

  it('уборщик — в получасовом кроне, в реестре, и у статуса failed есть читатель в Watchdog', () => {
    expect(read('.github/workflows/cron-safety-heartbeat.yml')).toMatch(/\/api\/cron\/seat-requests-expire/);
    expect(read('lib/agents/cron-registry.ts')).toMatch(/key: 'seat-requests-expire'/);
    const wd = read('lib/agents/watchdog.ts');
    expect(wd).toMatch(/FROM tour_seat_requests/);
    expect(wd).toMatch(/status = 'failed'/);
    expect(wd).toMatch(/\n\s+checkFailedSeatRequests,/);
  });

  it('веб-дверь и запрос мест делят один хвост «уведомить оператора»', () => {
    expect(read('app/api/hub/bookings/create/route.ts')).toMatch(/notifyOperatorOfNewBooking\(/);
    expect(read('lib/seat-requests/service.ts')).toMatch(/notifyOperatorOfNewBooking\(/);
    expect(read('app/api/hub/bookings/create/route.ts')).not.toMatch(/createUonRequest/);
  });
});

describe('сервис броней', () => {
  it('запирает только строку брони (0A000, найдено 29.09) и не имеет второго WHERE (42601)', () => {
    const src = read('lib/bookings/booking.service.ts');
    expect(src).not.toMatch(/\$\{BOOKING_SELECT\}[^`]*FOR UPDATE`/);
    expect((src.match(/\$\{BOOKING_SELECT\} AND b\.id = \$1 FOR UPDATE OF b`/g) ?? []).length).toBe(3);
    // BOOKING_SELECT уже кончается на WHERE: любое продолжение — через AND.
    expect(src).not.toMatch(/\$\{BOOKING_SELECT\}\s+WHERE/);
  });

  it('запись журнала без человека: changed_by = NULL остаётся null, а не строкой «null»', () => {
    const src = read('lib/bookings/booking.service.ts');
    expect(src).toMatch(/changedBy: row\.changed_by != null \? String\(row\.changed_by\) : null/);
  });
});

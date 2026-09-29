/**
 * Запрос свободных мест у оператора (решения владельца 29.09): ответ одним
 * нажатием, «Есть места» → сразу подтверждённая бронь, 2 часа на ответ,
 * исход — туристу в его мессенджер. Сторож держит связку целиком (§10.09):
 * форма планера → API → оператору с кнопками → ответ → бронь → туристу,
 * и уборщик просрочки в расписании.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const poolQueryMock = vi.hoisted(() => vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>>());
const reachMock = vi.hoisted(() => vi.fn());
const pdAlertMock = vi.hoisted(() => vi.fn());
const reserveMock = vi.hoisted(() => vi.fn());
const confirmMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/db-pool', () => ({ pool: { query: (sql: string, params?: unknown[]) => poolQueryMock(sql, params) } }));
vi.mock('@/lib/partners/reach', () => ({ reachForPartner: (id: string) => reachMock(id) }));
vi.mock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: (p: unknown) => pdAlertMock(p) }));
vi.mock('@/lib/notifications/telegram', () => ({ telegramService: { sendMessage: async () => ({ success: true }) } }));
vi.mock('@/lib/notifications/max-channel', () => ({ maxSendDm: async () => ({ ok: true }) }));
vi.mock('@/lib/bookings/booking.service', () => ({ confirmBooking: (...a: unknown[]) => confirmMock(...a) }));
vi.mock('@/lib/bookings/reserve', async () => {
  class ReserveError extends Error { constructor(public code: string, m: string) { super(m); } }
  return { reserveBooking: (i: unknown) => reserveMock(i), ReserveError };
});

import {
  SEAT_REQUEST_DEADLINE_MS, SEAT_REQUEST_STATUSES, effectiveStatus, answerPayload, parseAnswerPayload,
  statusTokenFromStart, newStatusToken, hashStatusToken, operatorAnswerKey, verifyOperatorAnswerKey,
  isFutureOrToday, kamchatkaToday, touristOutcomeText,
} from '@/lib/seat-requests/core';
import { createSeatRequest, answerSeatRequest } from '@/lib/seat-requests/service';
import { ReserveError } from '@/lib/bookings/reserve';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const RID = '3f2b8c1a-9d4e-4b7a-8c21-0e5f6a7b8c9d';

beforeEach(() => {
  vi.stubEnv('JWT_SECRET', 'test-secret-long-enough-0123456789');
  vi.stubEnv('CONNECT_TOKEN_SECRET', '');
  for (const m of [poolQueryMock, reachMock, pdAlertMock, reserveMock, confirmMock]) m.mockReset();
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('правила владельца', () => {
  it('срок ответа — 2 часа', () => {
    expect(SEAT_REQUEST_DEADLINE_MS).toBe(2 * 3600 * 1000);
  });

  it('статусы кода и CHECK миграции 1105 совпадают', () => {
    const sql = read('migrations/1105_tour_seat_requests.sql');
    const m = /status IN \(([^)]+)\)/.exec(sql);
    const inSql = (m?.[1] ?? '').split(',').map(s => s.trim().replace(/'/g, '')).sort();
    expect(inSql).toEqual([...SEAT_REQUEST_STATUSES].sort());
  });

  it('«не ответил» — не «мест нет»: после срока статус expired, текст говорит это вслух', () => {
    const now = Date.UTC(2026, 8, 29, 10);
    expect(effectiveStatus({ status: 'pending', deadline_at: new Date(now - 1), answered_at: null }, now)).toBe('expired');
    expect(effectiveStatus({ status: 'pending', deadline_at: new Date(now + 1), answered_at: null }, now)).toBe('pending');
    // Ответ принят в работу до срока — не просрочивается, пока заводится бронь.
    expect(effectiveStatus({ status: 'pending', deadline_at: new Date(now - 1), answered_at: new Date(now - 5) }, now)).toBe('pending');
    const t = touristOutcomeText(
      { status: 'expired', tour_title: 'X', tour_date: '2099-07-10', participants: 2, alt_date: null },
      { statusUrl: 'u', bookingUrl: null },
    );
    expect(t).toMatch(/не значит, что мест нет/);
  });
});

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

  it('«сегодня» — камчатское: в 20:00 UTC на Камчатке уже завтра', () => {
    const now = Date.UTC(2026, 8, 29, 20);
    expect(kamchatkaToday(now)).toBe('2026-09-30');
    expect(isFutureOrToday('2026-09-29', now)).toBe(false);
    expect(isFutureOrToday('2026-09-30', now)).toBe(true);
  });
});

describe('создание', () => {
  const input = {
    tourId: 7, date: '2099-07-10', participants: 2, touristName: 'Иван', touristPhone: '+79000000000',
    replyChannel: 'max' as const, pdConsent: { at: new Date(), ip: '1.1.1.1', source: 'seat-request', version: 'v1' },
  };

  it('оператору некуда написать — запрос не заводится (иначе «не ответил» было бы ложью)', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [{ operator_id: 'op', title: 'Тур' }] });
    reachMock.mockResolvedValue({ reachable: false, maxChatId: null, telegramChatId: null });
    expect(await createSeatRequest(input)).toEqual({ ok: false, reason: 'operator_unreachable' });
    expect(poolQueryMock.mock.calls.some(([sql]) => /INSERT INTO tour_seat_requests/.test(sql))).toBe(false);
  });

  it('не смогли проверить канал — «не смог», а не «недоступен»', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [{ operator_id: 'op', title: 'Тур' }] });
    reachMock.mockResolvedValue(null);
    expect(await createSeatRequest(input)).toEqual({ ok: false, reason: 'check_failed' });
  });

  it('ПД — через pd-alert: в MAX с именем и телефоном, заглушка без них; кнопки есть', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [{ operator_id: 'op', title: 'Тур' }] })
      .mockResolvedValueOnce({ rows: [{ id: RID }] })
      .mockResolvedValue({ rows: [] });
    reachMock.mockResolvedValue({ reachable: true, maxChatId: '1', telegramChatId: '2' });
    pdAlertMock.mockResolvedValue({ channel: 'max', delivered: true, reason: 'ok' });
    const r = await createSeatRequest(input);
    expect(r.ok).toBe(true);
    const p = pdAlertMock.mock.calls[0]![0] as { text: string; stub: string; buttons: Array<{ payload?: string; url?: string }>; to: unknown };
    expect(p.text).toMatch(/Иван/);
    expect(p.stub).not.toMatch(/Иван|79000000000/);
    expect(p.buttons.map(b => b.payload).filter(Boolean)).toEqual([answerPayload('yes', RID), answerPayload('no', RID)]);
    expect(p.buttons.some(b => b.url?.includes(`/seat-request/answer/${RID}?k=`))).toBe(true);
    expect(p.to).toEqual({ maxChatId: '1', telegramChatId: '2' });
  });

  it('не дошло никуда — запрос закрыт сразу, туристу сказано сейчас', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [{ operator_id: 'op', title: 'Тур' }] })
      .mockResolvedValueOnce({ rows: [{ id: RID }] })
      .mockResolvedValue({ rows: [] });
    reachMock.mockResolvedValue({ reachable: true, maxChatId: '1', telegramChatId: null });
    pdAlertMock.mockResolvedValue({ channel: 'none', delivered: false, reason: 'MAX отказал' });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await createSeatRequest(input)).toEqual({ ok: false, reason: 'delivery_failed' });
    const upd = poolQueryMock.mock.calls.find(([sql]) => /SET operator_delivery/.test(sql))!;
    expect(upd[1]).toEqual([RID, 'none', true, expect.stringContaining('MAX отказал')]);
  });
});

describe('ответ оператора', () => {
  const claimed = {
    id: RID, tour_id: '7', operator_id: 'op', tour_date: '2099-07-10', participants: 2,
    tourist_name: 'Иван', tourist_phone: '+79000000000', title: 'Тур',
    pd_consent_at: new Date(), pd_consent_ip: '1.1.1.1', pd_consent_source: 'seat-request', pd_consent_version: 'v1',
  };

  it('захват атомарный: ждёт, никто не ответил, срок не вышел', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    await answerSeatRequest(RID, { kind: 'no' }, 'web');
    const sql = poolQueryMock.mock.calls[0]![0];
    expect(sql).toMatch(/r\.status = 'pending' AND r\.answered_at IS NULL AND r\.deadline_at > NOW\(\)/);
  });

  it('«Есть места» — бронь той же дверью (reserveBooking) и сразу подтверждение', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [claimed] }).mockResolvedValue({ rows: [] });
    reserveMock.mockResolvedValue({ bookingId: 42, accessToken: 'tok', totalPrice: 1, operatorId: 'op', tourTitle: 'Тур' });
    confirmMock.mockResolvedValue({});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await answerSeatRequest(RID, { kind: 'yes' }, 'max');
    expect(r).toMatchObject({ ok: true, status: 'confirmed' });
    expect(reserveMock.mock.calls[0]![0]).toMatchObject({ tourId: 7, participants: 2, date: '2099-07-10', createdVia: 'seat_request' });
    expect(confirmMock).toHaveBeenCalledWith('42', null, expect.any(String));
    const fin = poolQueryMock.mock.calls.find(([sql]) => /SET status = \$2, booking_id = \$3/.test(sql))!;
    expect(fin[1]![1]).toBe('confirmed');
    expect(fin[1]![2]).toBe(42);
  });

  it('учёт платформы не согласен — failed с причиной, а не бронь сверх вместимости', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [claimed] }).mockResolvedValue({ rows: [] });
    reserveMock.mockRejectedValue(new ReserveError('NO_SLOTS', 'Нет свободных мест на эту дату.'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await answerSeatRequest(RID, { kind: 'yes' }, 'max');
    expect(r).toMatchObject({ ok: true, status: 'failed' });
    expect(confirmMock).not.toHaveBeenCalled();
    const fin = poolQueryMock.mock.calls.find(([sql]) => /SET status = \$2, booking_id = \$3/.test(sql))!;
    expect(fin[1]![4]).toMatch(/Нет свободных мест/);
  });

  it('дата «другой даты» в прошлом отклоняется ДО захвата', async () => {
    expect(await answerSeatRequest(RID, { kind: 'other_date', date: '2000-01-01' }, 'web')).toEqual({ ok: false, reason: 'bad_date' });
    expect(poolQueryMock).not.toHaveBeenCalled();
  });
});

describe('провода', () => {
  it('MAX: кнопка засчитывается только из заверенного апдейта и из чата оператора запроса', () => {
    const src = read('app/api/max/kuzmich/route.ts');
    const i = src.indexOf('const seat = parseAnswerPayload(payload);');
    expect(i).toBeGreaterThan(0);
    const branch = src.slice(i, src.indexOf("answerSeatRequest(seat.requestId", i));
    expect(branch).toMatch(/if \(opts\?\.verifiedOrigin !== true\) return;/);
    expect(branch).toMatch(/requestBelongsToMaxChat\(seat\.requestId, resolvedChatId\)/);
  });

  it('турист подключает чат в обоих ботах; в MAX — под гейтом заверенного апдейта', () => {
    expect(read('app/api/telegram/webhook/route.ts')).toMatch(/bindTouristChat\(seatToken, 'telegram', update\.message\.chat\.id\)/);
    const max = read('app/api/max/kuzmich/route.ts');
    const k = max.indexOf('statusTokenFromStart(update.payload)');
    const gate = max.lastIndexOf('if (opts?.verifiedOrigin === true', k);
    expect(gate).toBeGreaterThan(0);
    expect(max.slice(gate, k)).not.toMatch(/\n  \}\n/);
  });

  it('планер показывает кнопку и форму', () => {
    const p = read('app/planner/_PlannerClient.tsx');
    expect(p).toMatch(/onAskSeats=\{\(t\) => setSeatModal/);
    expect(p).toMatch(/<SeatRequestForm/);
    expect(read('components/planner/SeatRequestForm.tsx')).toMatch(/fetch\('\/api\/seat-requests'/);
  });

  it('API публичны на Edge, форма требует согласия на ПД', () => {
    expect(read('lib/auth/public-api-routes.ts')).toMatch(/'\/api\/seat-requests': \['GET', 'POST'\]/);
    expect(read('app/api/seat-requests/route.ts')).toMatch(/pd_consent:\s+z\.literal\(true/);
  });

  it('уборщик просрочки — в получасовом кроне и в реестре', () => {
    expect(read('.github/workflows/cron-safety-heartbeat.yml')).toMatch(/\/api\/cron\/seat-requests-expire/);
    expect(read('lib/agents/cron-registry.ts')).toMatch(/key: 'seat-requests-expire'/);
  });
});

describe('сервис броней запирает только строку брони (0A000, найдено 29.09)', () => {
  it('ни одного голого FOR UPDATE после BOOKING_SELECT с LEFT JOIN', () => {
    const src = read('lib/bookings/booking.service.ts');
    expect(src).not.toMatch(/\$\{BOOKING_SELECT\}[^`]*FOR UPDATE`/);
    expect((src.match(/\$\{BOOKING_SELECT\} AND b\.id = \$1 FOR UPDATE OF b`/g) ?? []).length).toBe(3);
  });
});

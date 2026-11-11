/**
 * tests/unit/my-trip-write.test.ts
 *
 * «Написать оператору» под «Моей поездкой» (#2970, шаг 3, слово владельца
 * 11.11 «п1 делай»). Заявка, созданная в чате Кузьмича, в «Моей поездке»
 * была видна, а написать по ней было нельзя: переписку открывала только
 * ссылка `sq_`.
 *
 * Что держит — вызовом:
 *  - кнопка: разбор туда-обратно, подпись влезает в 64 байта, нажатие MAX
 *    идёт полосой переписки (личный диалог, заверенный апдейт);
 *  - кнопки под списком: только у заявок с перепиской, номер — при двух и
 *    больше; в Telegram кнопки нет, строка «где написать» — есть;
 *  - нажатие: нет связи чата с заявкой — «не подключена»; ключ без
 *    переписки — «переписки нет»; к заявке подключён другой чат — «не
 *    подключена», чужой чат не перезаписан; отказ базы — «не удалось
 *    проверить», не «не ваша»; своя — ожидание сообщения.
 * Сам SQL на настоящем PostgreSQL — tests/integration/request-chat.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ query: vi.fn(), arm: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (sql: string, params?: unknown[]) => h.query(sql, params ?? []) } }));
vi.mock('@/lib/requests/request-chat-service', () => ({ armChatWait: (...a: unknown[]) => h.arm(...a) }));

import {
  isMyTripWritePayload, myTripWritePayload, parseMyTripWrite, pressMyTripWrite,
  MY_TRIP_WRITE_LINK_SQL, MY_TRIP_BIND_LEAD_SQL, MY_TRIP_BIND_STAY_SQL,
} from '@/lib/requests/my-trip-write';
import { myTripButtons, myTripText, MY_TRIP_WRITE_ELSEWHERE_TEXT, type MyTrip } from '@/lib/requests/my-trip';
import { CALLBACK_MAX_BYTES, isWritePayload, signPayload, unwrapPress } from '@/lib/chat-cabinet/signed-payload';
import { pressActionOf } from '@/lib/max/verified-press';
import { CHAT_TEXT } from '@/lib/requests/request-chat';

const LEAD = '0f1e2d3c-4b5a-4968-8776-655443322110';
const STAY = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CHAT = 9_400_001;

beforeEach(() => {
  h.query.mockReset();
  h.arm.mockReset();
  h.arm.mockResolvedValue({ text: 'Напишите сообщение оператору', buttons: [] });
  vi.stubEnv('CALLBACK_SIGNING_SECRET', 'unit-signing');
});

describe('кнопка «Написать оператору»', () => {
  it('разбор туда-обратно; подписанная влезает в 64 байта; это кнопка-запись полосы переписки', () => {
    for (const target of [{ kind: 'lead' as const, id: LEAD }, { kind: 'stay' as const, id: STAY }]) {
      const raw = myTripWritePayload(target);
      expect(parseMyTripWrite(raw)).toEqual(target);
      expect(isMyTripWritePayload(raw)).toBe(true);
      expect(isWritePayload(raw)).toBe(true);
      expect(pressActionOf(raw)).toBe('request_chat');
      const signed = signPayload(raw);
      expect(signed).not.toBe(raw);
      expect(Buffer.byteLength(signed)).toBeLessThanOrEqual(CALLBACK_MAX_BYTES);
      expect(unwrapPress(signed)).toEqual({ ok: true, payload: raw });
    }
    expect(parseMyTripWrite('mw:x123')).toBeNull();
    expect(parseMyTripWrite(`mw:l${'z'.repeat(32)}`)).toBeNull();
  });
});

describe('кнопки под «Моей поездкой»', () => {
  const trip = (writes: ({ kind: 'lead' | 'stay'; id: string } | null)[]): MyTrip => ({
    outcome: 'ok',
    items: writes.map((w, i) => ({ what: `Тур ${i + 1}`, date: '2027-07-15', human: 'Ждёт ответа оператора', situation: { kind: 'later' as const }, write: w })),
  });

  it('только у заявок с перепиской; номер — когда заявок больше одной', () => {
    expect(myTripButtons(trip([{ kind: 'lead', id: LEAD }])).map((b) => b.text)).toEqual(['Написать оператору']);
    const many = myTripButtons(trip([null, { kind: 'stay', id: STAY }, { kind: 'lead', id: LEAD }]));
    expect(many.map((b) => b.text)).toEqual(['Написать хозяину · 2', 'Написать оператору · 3']);
    expect(many.map((b) => unwrapPress(b.payload))).toEqual([
      { ok: true, payload: myTripWritePayload({ kind: 'stay', id: STAY }) },
      { ok: true, payload: myTripWritePayload({ kind: 'lead', id: LEAD }) },
    ]);
    expect(myTripButtons({ outcome: 'none' })).toEqual([]);
    expect(myTripButtons({ outcome: 'failed' })).toEqual([]);
  });

  it('Telegram: кнопки нет — строка «где написать», и только если писать есть кому', () => {
    expect(myTripText(trip([{ kind: 'lead', id: LEAD }]), { channel: 'telegram' })).toContain(MY_TRIP_WRITE_ELSEWHERE_TEXT);
    expect(myTripText(trip([null]), { channel: 'telegram' })).not.toContain(MY_TRIP_WRITE_ELSEWHERE_TEXT);
    expect(myTripText(trip([{ kind: 'lead', id: LEAD }]), { channel: 'max' })).not.toContain(MY_TRIP_WRITE_ELSEWHERE_TEXT);
  });
});

describe('нажатие «Написать оператору»', () => {
  const payload = myTripWritePayload({ kind: 'lead', id: LEAD });
  function answer(link: { opens_chat: boolean | null } | Error, bound: boolean | Error = true) {
    h.query.mockImplementation(async (sql: string) => {
      if (sql === MY_TRIP_WRITE_LINK_SQL) {
        if (link instanceof Error) throw link;
        return { rows: [link] };
      }
      if (sql === MY_TRIP_BIND_LEAD_SQL || sql === MY_TRIP_BIND_STAY_SQL) {
        if (bound instanceof Error) throw bound;
        return { rows: bound ? [{ id: LEAD }] : [] };
      }
      throw new Error(`неожиданный запрос: ${sql.slice(0, 60)}`);
    });
  }

  it('своя заявка с перепиской — чат подключается, дальше общее ожидание сообщения', async () => {
    answer({ opens_chat: true });
    expect((await pressMyTripWrite(payload, CHAT)).text).toBe('Напишите сообщение оператору');
    expect(h.query.mock.calls.find(([sql]) => sql === MY_TRIP_WRITE_LINK_SQL)?.[1]).toEqual([String(CHAT), LEAD]);
    expect(h.query.mock.calls.find(([sql]) => sql === MY_TRIP_BIND_LEAD_SQL)?.[1]).toEqual([LEAD, String(CHAT)]);
    expect(h.arm).toHaveBeenCalledWith('guest', { kind: 'lead', id: LEAD }, CHAT, 'max');
  });

  it('заявка не этого чата — «не подключена», ничего не подключено и не заведено', async () => {
    answer({ opens_chat: null });
    expect((await pressMyTripWrite(payload, CHAT)).text).toBe(CHAT_TEXT.notYoursGuest);
    expect(h.query.mock.calls.some(([sql]) => sql === MY_TRIP_BIND_LEAD_SQL)).toBe(false);
    expect(h.arm).not.toHaveBeenCalled();
  });

  it('ключ без переписки (повтор заявки) — «переписки нет»', async () => {
    answer({ opens_chat: false });
    expect((await pressMyTripWrite(payload, CHAT)).text).toBe(CHAT_TEXT.bindNoChat);
    expect(h.arm).not.toHaveBeenCalled();
  });

  it('к заявке подключён другой чат — «не подключена», ожидание не заводится', async () => {
    answer({ opens_chat: true }, false);
    expect((await pressMyTripWrite(payload, CHAT)).text).toBe(CHAT_TEXT.notYoursGuest);
    expect(h.arm).not.toHaveBeenCalled();
  });

  it('база не ответила — «не удалось проверить», а не «не ваша»; причина в логе', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    answer(Object.assign(new Error('connection terminated'), { code: '08006' }));
    expect((await pressMyTripWrite(payload, CHAT)).text).toBe(CHAT_TEXT.unchecked);
    expect(err).toHaveBeenCalledWith('[my-trip-write] связь чата с заявкой не проверена:', 'SQLSTATE=08006', 'connection terminated');
    expect(h.arm).not.toHaveBeenCalled();
  });

  it('битая кнопка — «не распознана», база не трогается', async () => {
    expect((await pressMyTripWrite('mw:q', CHAT)).text).toMatch(/не распознана/);
    expect(h.query).not.toHaveBeenCalled();
  });
});

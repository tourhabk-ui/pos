/**
 * Сторож: MCP-инструмент create_stay_request — заявка хозяину жилья
 * (решение владельца 10.10: «да делай» на «то же, что новая форма: даты,
 * гости, телефон, сообщение хозяину в MAX»).
 *
 * Поведенчески, через POST роута:
 *   - путь тот же, что у формы (lib/stay/stay-request-service): строка
 *     stay_requests с согласием варианта «владельцу жилья» и источником mcp,
 *     сообщение хозяину строго в его адрес и оператору платформы всегда;
 *   - три исхода доставки называются агенту по-разному, «не дошло никому» —
 *     отказ, а не «владелец перезвонит»;
 *   - без согласия ничего не пишется и не отправляется;
 *   - объект с сайтом брони или своими номерами заявку не принимает, и ответ
 *     называет его путь; «не найдено» и «база не ответила» — разные ответы;
 *   - даты проверяются до записи; телефон человека в ответ модели не уходит.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { query, sendPdAlertMock } = vi.hoisted(() => ({
  query: vi.fn(),
  sendPdAlertMock: vi.fn(),
}));

vi.mock('@/lib/kuzmich/core', () => ({ executeKuzmichTool: async () => 'ok' }));
vi.mock('@/lib/db-pool', () => ({
  pool: { query, connect: async () => ({ query, release: () => {} }) },
}));
vi.mock('@/lib/notifications/pd-alert', () => ({
  sendPdAlert: (p: unknown) => sendPdAlertMock(p),
}));

import { POST } from '@/app/api/mcp/route';
import { STAY_REQUEST_TOOL, WRITE_TOOL_NAMES, PUBLIC_MCP_TOOL_NAMES } from '@/lib/mcp/public-tools';
import { PD_CONSENT_STAY_VERSION } from '@/lib/legal/pd-consent';

const KUTHA_ID = '3b2551c7-ed5c-47c8-bb93-41ca6a278c1e';

type Found = { id: string; name: string; has_site: boolean; has_rooms: boolean; has_phone: boolean };
let lookup: Found[] | Error;
let owner: { max_chat_id: string | null; telegram_chat_id: string | null } | null;

let ip = 0;
function call(args: Record<string, unknown>) {
  ip += 1;
  return POST(new NextRequest('http://localhost/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': `10.9.${Math.floor(ip / 250)}.${ip % 250}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_stay_request', arguments: args } }),
  }));
}
const result = async (res: Response) => (await res.json()).result as { isError?: boolean; content: Array<{ text: string }> };

const ARGS = {
  accommodation: 'Кутха', check_in: '2027-07-10', check_out: '2027-07-12', guests: 9,
  name: 'Иван Петров', phone: '8 900 123-45-67', comment: 'Баня вечером', consent: true,
};

const inserts = () => query.mock.calls.filter(([sql]) => /INSERT INTO stay_requests/.test(String(sql)));

beforeEach(() => {
  process.env.MCP_HASH_SALT = 'соль-для-теста';
  lookup = [{ id: KUTHA_ID, name: 'Кутха', has_site: false, has_rooms: false, has_phone: true }];
  owner = { max_chat_id: '777', telegram_chat_id: null };
  sendPdAlertMock.mockReset().mockResolvedValue({ delivered: true, channel: 'max', reason: 'доставлено в MAX' });
  query.mockReset().mockImplementation(async (sql: string) => {
    if (/COUNT\(\*\)/.test(sql)) return { rows: [{ a: '0', b: '0', c: '0' }] };
    if (/AS has_site/.test(sql)) {
      if (lookup instanceof Error) throw lookup;
      return { rows: lookup };
    }
    if (/AS max_chat_id/.test(sql)) {
      return { rows: owner ? [{ name: 'Кутха', price_from: '24000', price_to: '28000', ...owner }] : [] };
    }
    if (/INSERT INTO stay_requests/.test(sql)) return { rows: [{ id: 'sr-1' }] };
    return { rows: [] };
  });
});

describe('инструмент объявлен как заявка', () => {
  it('пишущий, требует объект, даты, имя, телефон и согласие', () => {
    expect(PUBLIC_MCP_TOOL_NAMES.has('create_stay_request')).toBe(true);
    expect(WRITE_TOOL_NAMES.has('create_stay_request')).toBe(true);
    expect([...STAY_REQUEST_TOOL.inputSchema.required]).toEqual(['accommodation', 'check_in', 'check_out', 'name', 'phone', 'consent']);
    // Согласие называет настоящего получателя — владельца жилья.
    expect(STAY_REQUEST_TOOL.inputSchema.properties.consent.description).toMatch(/передачу владельцу жилья/);
    expect(STAY_REQUEST_TOOL.description).toMatch(/не бронь и не оплата/);
  });
});

describe('путь формы: запись, согласие, доставка', () => {
  it('хозяин подключён: строка с согласием «жильё» от mcp, хозяину в его адрес и оператору', async () => {
    const r = await result(await call(ARGS));
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toMatch(/Заявка передана владельцу в мессенджер: "Кутха", заезд 2027-07-10, выезд 2027-07-12 \(ночей: 2\), гостей 9/);
    expect(r.content[0].text).toMatch(/не бронь и не оплата/);

    expect(inserts()).toHaveLength(1);
    const params = inserts()[0][1] as unknown[];
    expect(params[0]).toBe(KUTHA_ID);
    expect(params.slice(1, 7)).toEqual(['2027-07-10', '2027-07-12', 9, 'Иван Петров', '+79001234567', 'Баня вечером']);
    expect(params[9]).toBe('mcp');
    expect(params[10]).toBe(PD_CONSENT_STAY_VERSION);
    // Дверь (1213) — в той же вставке.
    expect(params[11]).toBe('mcp');
    // Исход записан: хозяину и платформе — в MAX.
    const upd = query.mock.calls.filter(([sql]) => /UPDATE stay_requests/.test(String(sql)));
    expect(upd).toHaveLength(1);
    expect(upd[0][1]).toEqual(['sr-1', 'max', 'доставлено в MAX', 'max', 'доставлено в MAX']);

    expect(sendPdAlertMock).toHaveBeenCalledTimes(2);
    const [toOwner, toAdmin] = sendPdAlertMock.mock.calls.map(([p]) => p as { to?: unknown; text: string; stub: string });
    expect(toOwner.to).toEqual({ maxChatId: '777', telegramChatId: null });
    expect(toAdmin.to).toBeUndefined();
    // ПД — в тексте для MAX, заглушка без них.
    expect(toOwner.text).toContain('+79001234567');
    expect(toOwner.stub).not.toContain('+79001234567');
  });

  it('телефон человека в ответ модели не уходит', async () => {
    const r = await result(await call(ARGS));
    expect(JSON.stringify(r)).not.toMatch(/9001234567|123-45-67/);
  });

  it('хозяин не подключён: только оператору, и агент слышит это', async () => {
    owner = { max_chat_id: null, telegram_chat_id: null };
    const r = await result(await call(ARGS));
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toMatch(/Заявка передана оператору Ведара/);
    expect(sendPdAlertMock).toHaveBeenCalledTimes(1);
    // Слать хозяину было некуда — это и записано, а не «не дошло».
    const upd = query.mock.calls.filter(([sql]) => /UPDATE stay_requests/.test(String(sql)));
    expect((upd[0][1] as unknown[]).slice(1, 2)).toEqual(['no_address']);
  });

  it('не дошло никому — отказ, а не «владелец перезвонит»', async () => {
    sendPdAlertMock.mockResolvedValue({ delivered: false, channel: 'max', reason: 'сбой' });
    const r = await result(await call(ARGS));
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/передать её владельцу сейчас не удалось/);
    expect(r.content[0].text).not.toMatch(/Владелец перезвонит/);
  });
});

describe('без согласия — ничего', () => {
  it('consent: false — не пишется и не отправляется', async () => {
    const r = await result(await call({ ...ARGS, consent: false }));
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/нет согласия/);
    expect(inserts()).toHaveLength(0);
    expect(sendPdAlertMock).not.toHaveBeenCalled();
  });

  it('поля consent нет — отказ «поля нет»', async () => {
    const { consent: _drop, ...noConsent } = ARGS;
    const r = await result(await call(noConsent));
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/нет поля consent/);
  });
});

describe('какой объект принимает заявку', () => {
  it('объект с сайтом брони — путь назван, заявки нет', async () => {
    lookup = [{ id: KUTHA_ID, name: 'Гостиница', has_site: true, has_rooms: false, has_phone: true }];
    const r = await result(await call(ARGS));
    expect(r.content[0].text).toMatch(/не принимает: бронь и свободные даты — на сайте объекта/);
    expect(inserts()).toHaveLength(0);
  });

  it('объект со своими номерами — бронь номера на карточке', async () => {
    lookup = [{ id: KUTHA_ID, name: 'База', has_site: false, has_rooms: true, has_phone: true }];
    const r = await result(await call(ARGS));
    expect(r.content[0].text).toMatch(/свои номера на платформе/);
    expect(inserts()).toHaveLength(0);
  });

  it('не найдено и несколько подходящих — разные ответы', async () => {
    lookup = [];
    expect((await result(await call(ARGS))).content[0].text).toMatch(/не найдено среди опубликованных/);
    lookup = [
      { id: KUTHA_ID, name: 'Кутха у реки', has_site: false, has_rooms: false, has_phone: true },
      { id: 'b', name: 'Кутха на горе', has_site: false, has_rooms: false, has_phone: true },
    ];
    expect((await result(await call(ARGS))).content[0].text).toMatch(/подходит несколько объектов: Кутха у реки; Кутха на горе/);
    expect(inserts()).toHaveLength(0);
  });

  it('база не ответила — отказ проверки, а не «не найдено»', async () => {
    lookup = Object.assign(new Error('connection refused'), { code: '08006' });
    const r = await result(await call(ARGS));
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/Не удалось проверить объект/);
    expect(r.content[0].text).not.toMatch(/не найдено/);
  });
});

describe('даты проверяются до записи', () => {
  it.each([
    [{ check_out: '2027-07-10' }, /Дата выезда должна быть позже даты заезда/],
    [{ check_out: '2027-10-10' }, /Не больше 60 ночей/],
    [{ check_in: '2020-01-01', check_out: '2020-01-03' }, /Дата заезда уже прошла/],
    [{ check_in: '2027-02-30', check_out: '2027-03-02' }, /нет в календаре/],
  ])('%o — отказ', async (patch, text) => {
    const r = await result(await call({ ...ARGS, ...patch }));
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(text);
    expect(inserts()).toHaveLength(0);
  });
});

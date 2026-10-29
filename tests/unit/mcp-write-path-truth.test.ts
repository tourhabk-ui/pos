/**
 * Пишущий путь MCP говорит правду о заявке (проверка MCP 29.09, D6).
 *
 * Находки скептиков, каждая — поведенчески, через POST роута:
 *   W1 — заявка на бронь ложилась без оператора: он её не видел;
 *   W2 — «900 123-45-67» становился «+9001234567»;
 *   W4 — заявка ниже порога качества закрывалась createLead молча, а агенту
 *        отвечали «менеджер свяжется»;
 *   W5 — номер тура, которого нет на витрине, проваливался в поиск «%7%» и
 *        заявка уходила по другому туру;
 *   W8 — несуществующая дата падала в базе общим «внутренняя ошибка»;
 *   W9 — отказ лимита записи обещал «подождите минуту» при окне в 10 минут;
 *   W12 — перевод строки в имени подделывал строку телефона в уведомлении;
 *   W14 — consent строкой получал текст «поля нет»; zod отвечал по-английски.
 *   notify_url (29.10) — адрес приёмника уведомлений: неверный по форме —
 *        заявка не создаётся у каждого из четырёх инструментов, и отказ
 *        называет поле; верный — в ответе номер подписки и ключ подписи; сбой
 *        подписки или нет ENCRYPTION_KEY — заявка и ключ статуса есть, агенту
 *        «не заведены»; у прокатного шага 1 адрес проверен, подписки нет.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { createLeadMock, query } = vi.hoisted(() => ({
  createLeadMock: vi.fn(async (_: Record<string, unknown>) => 'lead-1'),
  query: vi.fn(),
}));

vi.mock('@/lib/leads/create', () => ({
  createLead: (p: Record<string, unknown>) => createLeadMock(p),
  findRecentLeadByCommentPrefix: async () => null,
}));
vi.mock('@/lib/kuzmich/core', () => ({ executeKuzmichTool: async () => 'ok' }));
vi.mock('@/lib/planner', () => ({
  createPlannerCache: () => ({}),
  fetchAvailabilityForTour: async (_id: string, from: string) => [{ date: from, remaining: 10, priceOverride: null }],
}));
vi.mock('@/lib/db-pool', () => ({
  pool: { query, connect: async () => ({ query, release: () => {} }) },
}));
vi.mock('@/lib/rental/rental', () => ({
  loadRentalCompanies: async () => [{
    slug: 'test-prokat', name: 'Тест Прокат',
    offers: [{ title: 'Suzuki Jimny', priceRubPerDay: 5000, priceIsFrom: false, depositRub: 10000 }],
  }],
}));

import { POST, runPublicTool } from '@/app/api/mcp/route';
import { normalizePhone } from '@/lib/mcp/normalize-phone';
import { resolveTourByQuery } from '@/lib/kuzmich/tour-availability-tool';

const TOUR = { id: 27, title: 'Сплав по реке Быстрая', operator_id: 'op-uuid-1', base_price: 13000, price_unit: 'person' };

let ip = 0;
function call(name: string, args: Record<string, unknown>, sameIp?: string) {
  ip += 1;
  return POST(new NextRequest('http://localhost/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': sameIp ?? `10.7.${Math.floor(ip / 250)}.${ip % 250}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }));
}
const result = async (res: Response) => (await res.json()).result as { isError?: boolean; content: Array<{ text: string }> };

const BOOKING = { tour: 'Сплав', date: '2027-07-10', participants: 2, name: 'Иван Петров', phone: '+79001234567', consent: true };
const LEAD = { name: 'Иван Петров', phone: '+79001234567', comment: 'Хотим на вулкан в августе, 4 человека, бюджет 200000 руб', consent: true };

beforeEach(() => {
  process.env.MCP_HASH_SALT = 'соль-для-теста';
  createLeadMock.mockClear();
  query.mockReset().mockImplementation(async (sql: string) => {
    if (/COUNT\(\*\)/.test(sql)) return { rows: [{ a: '0', b: '0', c: '0' }] };
    if (/FROM operator_tours/.test(sql)) return { rows: [TOUR] };
    return { rows: [] };
  });
});

describe('W1: заявка на бронь ложится оператору тура', () => {
  it('createLead получает operator_id тура', async () => {
    const r = await result(await call('create_booking_request', BOOKING));
    expect(r.isError).toBeUndefined();
    expect(createLeadMock).toHaveBeenCalledWith(expect.objectContaining({ operator_id: 'op-uuid-1' }));
  });
});

describe('туры разных компаний по одному названию — заявки нет (слово владельца 29.10)', () => {
  const tourRow = (id: number, operator: string, name: string) => ({
    ...TOUR, id, title: `Вулкан Горелый ${id}`, operator_id: operator, operator_name: name, rank: 2, nearest_free_date: null,
  });

  it('«Горелый» у двух компаний — заявка не создана, в ответе оба номера и обе компании', async () => {
    query.mockImplementation(async (sql: string) => {
      if (/COUNT\(\*\)/.test(sql)) return { rows: [{ a: '0', b: '0', c: '0' }] };
      if (/FROM operator_tours/.test(sql)) return { rows: [tourRow(61, 'op-a', 'Местечко Камчатка'), tourRow(72, 'op-b', 'Лагуна Экспедиция')] };
      return { rows: [] };
    });
    const r = await result(await call('create_booking_request', { ...BOOKING, tour: 'Горелый' }));
    const text = r.content[0]!.text;
    expect(text).toContain('заявка не создана');
    expect(text).toContain('ID61');
    expect(text).toContain('Местечко Камчатка');
    expect(text).toContain('ID72');
    expect(text).toContain('Лагуна Экспедиция');
    expect(createLeadMock).not.toHaveBeenCalled();
    expect(query.mock.calls.some((c) => /INSERT INTO leads/.test(String(c[0])))).toBe(false);
  });

  it('с номером тура — заявка создаётся этому туру', async () => {
    query.mockImplementation(async (sql: string) => {
      if (/COUNT\(\*\)/.test(sql)) return { rows: [{ a: '0', b: '0', c: '0' }] };
      if (/FROM operator_tours/.test(sql)) return { rows: [tourRow(61, 'op-a', 'Местечко Камчатка')] };
      return { rows: [] };
    });
    const r = await result(await call('create_booking_request', { ...BOOKING, tour: '61' }));
    expect(r.isError).toBeUndefined();
    expect(createLeadMock).toHaveBeenCalledWith(expect.objectContaining({ operator_id: 'op-a' }));
  });
});

describe('W2: десять цифр без кода страны — российский номер', () => {
  it('900 123-45-67 → +79001234567; с плюсом — как есть', () => {
    expect(normalizePhone('900 123-45-67')).toBe('+79001234567');
    expect(normalizePhone('+1 212 555 1234')).toBe('+12125551234');
  });
});

describe('W4: заявка, которую никто не увидит, — отказ до записи', () => {
  it('имя из двух букв — «слишком неполная», createLead не зовётся', async () => {
    const r = await result(await call('create_lead', { ...LEAD, name: 'Ян' }));
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/слишком неполная/);
    expect(createLeadMock).not.toHaveBeenCalled();
  });

  it('обычная заявка проходит, номер заявки не называется', async () => {
    const r = await result(await call('create_lead', LEAD));
    expect(r.isError).toBeUndefined();
    expect(r.content[0]!.text).toMatch(/Заявка принята/);
    expect(r.content[0]!.text).not.toMatch(/lead-1|номер/);
  });
});

describe('W5: номер тура не проваливается в поиск по названию', () => {
  it('ID без тура на витрине — null, без ILIKE', async () => {
    query.mockImplementation(async () => ({ rows: [] }));
    expect(await resolveTourByQuery('7')).toBeNull();
    expect(query.mock.calls.some((c) => /ILIKE/.test(String(c[0])))).toBe(false);
  });
});

describe('W8/W12/W14: отказы — внятные и по-русски', () => {
  it('несуществующая дата — «нет в календаре»', async () => {
    const r = await result(await call('create_booking_request', { ...BOOKING, date: '2027-02-30' }));
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/нет в календаре/);
  });

  it('перевод строки в имени не проходит', async () => {
    const r = await result(await call('create_lead', { ...LEAD, name: 'Иван\nТел: +79990000000' }));
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/одной строкой/);
    expect(createLeadMock).not.toHaveBeenCalled();
  });

  it('consent строкой — свой текст, не «поля нет»', async () => {
    const r = await result(await call('create_lead', { ...LEAD, consent: 'true' }));
    expect(r.content[0]!.text).toMatch(/логическим значением/);
    expect(r.content[0]!.text).not.toMatch(/нет поля consent/);
  });

  it('участники словом — русское сообщение', async () => {
    const r = await result(await call('create_booking_request', { ...BOOKING, participants: 'два' }));
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/Число участников/);
  });
});

describe('W9: лимит записи называет своё окно', () => {
  // Окно — час (решение владельца 01.10: 5 заявок в час с адреса).
  it('шестая заявка с адреса — «подождите час»', async () => {
    let last: { isError?: boolean; content: Array<{ text: string }> } | null = null;
    for (let i = 0; i < 6; i++) last = await result(await call('create_lead', LEAD, '10.66.66.66'));
    expect(last!.isError).toBe(true);
    expect(last!.content[0]!.text).toMatch(/подождите час/);
  });
});

describe('notify_url — адрес приёмника уведомлений (29.10)', () => {
  const BAD = 'http://127.0.0.1:8080/hook';
  const GOOD = 'https://hooks.agent-example.ru/vedar?sig=abc';
  const CHARTER = { destination: 'Горелый', date_from: '2027-07-15', passengers: 8, name: 'Иван Петров', phone: '+79001234567', consent: true };
  const RENTAL = { car: 'Suzuki Jimny', date_from: '2027-07-10', date_to: '2027-07-12', name: 'Иван Петров', phone: '+79001234567', consent: false };

  const keyAndNotify = () => query.mockImplementation(async (sql: string) => {
    if (/COUNT\(\*\)/.test(sql)) return { rows: [{ a: '0', b: '0', c: '0' }] };
    if (/FROM operator_tours/.test(sql)) return { rows: [TOUR] };
    if (/INSERT INTO agent_request_keys/.test(sql)) return { rows: [{ id: '22222222-2222-2222-2222-222222222222' }] };
    if (/INSERT INTO agent_request_notify/.test(sql)) return { rows: [{ id: '33333333-3333-3333-3333-333333333333' }] };
    return { rows: [] };
  });
  const notifyInserts = () => query.mock.calls.filter((c) => /INSERT INTO agent_request_notify/.test(String(c[0])));

  it.each([
    ['create_lead', LEAD],
    ['create_booking_request', BOOKING],
    ['request_charter', CHARTER],
    ['create_car_rental_request', RENTAL],
  ])('%s: неверный адрес — заявки нет, отказ называет поле', async (tool, args) => {
    const r = await result(await call(tool, { ...args, notify_url: BAD }));
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/^notify_url: /);
    expect(r.content[0]!.text).toMatch(/Заявка не создана/);
    expect(createLeadMock).not.toHaveBeenCalled();
    expect(query.mock.calls.some((c) => /INSERT INTO (leads|tour_seat_requests|agent_request)/.test(String(c[0])))).toBe(false);
  });

  it('IP-литерал IPv6 и свой хост — тоже отказ по полю', async () => {
    // Имя длиннее 253 знаков (ревью 29.10): раньше проходило форму, заявка
    // создавалась, а подписка падала в базе с 22001 — «сбой на стороне Ведара».
    const longHost = `https://${Array(5).fill('b'.repeat(60)).join('.')}.ru/in`;
    for (const url of ['https://[::ffff:7f00:1]/x', 'https://pospkam-pospktry-c1f3.twc1.net/api/mcp', longHost]) {
      const r = await result(await call('create_lead', { ...LEAD, notify_url: url }));
      expect(r.isError, url).toBe(true);
      expect(r.content[0]!.text).toMatch(/^notify_url: /);
    }
    expect(createLeadMock).not.toHaveBeenCalled();
  });

  it('пустая строка — «не передан»: заявка как обычно, подписки нет', async () => {
    const r = await result(await call('create_lead', { ...LEAD, notify_url: '' }));
    expect(r.isError).toBeUndefined();
    expect(createLeadMock).toHaveBeenCalled();
    expect(notifyInserts()).toHaveLength(0);
  });

  it('верный адрес — в ответе ключ статуса, номер подписки и ключ подписи; в базе адрес только шифртекстом', async () => {
    process.env.ENCRYPTION_KEY = 'c'.repeat(64);
    try {
      keyAndNotify();
      for (const tool of ['create_lead', 'create_booking_request'] as const) {
        query.mockClear();
        const r = await result(await call(tool, { ...(tool === 'create_lead' ? LEAD : BOOKING), notify_url: GOOD }));
        expect(r.isError, tool).toBeUndefined();
        const text = r.content[0]!.text;
        expect(text).toMatch(/Ключ статуса заявки: [A-Za-z0-9_-]{20,}/);
        expect(text).toMatch(/номер подписки nr_[A-Za-z0-9_-]{22}/);
        expect(text).toMatch(/ключ подписи whsec_[A-Za-z0-9+/=]{40,}/);
        expect(notifyInserts()).toHaveLength(1);
        expect(JSON.stringify(notifyInserts()[0]![1])).not.toContain('sig=abc');
      }
    } finally {
      delete process.env.ENCRYPTION_KEY;
    }
  });

  it('нет ENCRYPTION_KEY — заявка и ключ статуса есть, агенту «уведомления не заведены», записи подписки нет', async () => {
    delete process.env.ENCRYPTION_KEY;
    keyAndNotify();
    const r = await result(await call('create_lead', { ...LEAD, notify_url: GOOD }));
    expect(r.isError).toBeUndefined();
    expect(createLeadMock).toHaveBeenCalled();
    expect(r.content[0]!.text).toMatch(/Ключ статуса заявки: /);
    expect(r.content[0]!.text).toMatch(/не заведены: сбой на стороне Ведара/);
    expect(notifyInserts()).toHaveLength(0);
  });

  it('запись подписки упала — заявка и ключ статуса остаются, агенту «не заведены»', async () => {
    process.env.ENCRYPTION_KEY = 'c'.repeat(64);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      query.mockImplementation(async (sql: string) => {
        if (/COUNT\(\*\)/.test(sql)) return { rows: [{ a: '0', b: '0', c: '0' }] };
        if (/INSERT INTO agent_request_keys/.test(sql)) return { rows: [{ id: '22222222-2222-2222-2222-222222222222' }] };
        if (/INSERT INTO agent_request_notify/.test(sql)) throw Object.assign(new Error('violates check'), { code: '23514' });
        return { rows: [] };
      });
      const r = await result(await call('create_lead', { ...LEAD, notify_url: GOOD }));
      expect(r.isError).toBeUndefined();
      expect(r.content[0]!.text).toMatch(/Ключ статуса заявки: /);
      expect(r.content[0]!.text).toMatch(/не заведены/);
      expect(spy.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('SQLSTATE=23514');
    } finally {
      spy.mockRestore();
      delete process.env.ENCRYPTION_KEY;
    }
  });

  it('прокат, шаг 1: адрес проверен, черновик выдан, заявки и подписки нет', async () => {
    process.env.ENCRYPTION_KEY = 'c'.repeat(64);
    try {
      keyAndNotify();
      const r = await result(await call('create_car_rental_request', { ...RENTAL, notify_url: GOOD }));
      expect(r.isError).toBeUndefined();
      expect(r.content[0]!.text).toMatch(/Черновик, заявка ещё НЕ создана/);
      expect(notifyInserts()).toHaveLength(0);
    } finally {
      delete process.env.ENCRYPTION_KEY;
    }
  });

  it('дверь A2A (runPublicTool — та же, что у навыков A2A и схем OpenAPI): неверный адрес — отказ по полю', async () => {
    const o = await runPublicTool({ toolName: 'create_lead', rawArguments: { ...LEAD, notify_url: BAD }, ip: '10.77.0.1', userAgent: 'a2a-test', self: false });
    expect(o.kind).toBe('refused');
    expect(o.kind === 'refused' && o.text).toMatch(/^notify_url: /);
    expect(createLeadMock).not.toHaveBeenCalled();
  });
});

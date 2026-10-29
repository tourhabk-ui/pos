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

import { POST } from '@/app/api/mcp/route';
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

// Ловушка MCP 29.10, name-search: имя компании вместо тура или совпадение
// части слов. До 29.10 запасной путь по основам пропускал тур при ОДНОЙ
// совпавшей основе из N и при одной компании давал «один тур» — заявка с
// телефоном человека уходила продавцу, которого он не называл. Имена
// вымышленные; база отвечает по смыслу запроса резолвера.
describe('имя продавца или часть слов — заявки нет (ловушка name-search, 29.10)', () => {
  const tourRow = (id: number, title: string, operator: string, extra: Record<string, unknown> = {}) => ({
    ...TOUR, id, title, operator_id: operator, operator_name: operator === 'op-z' ? 'Тихая Заимка' : 'Савва Кедровец',
    nearest_free_date: null, ...extra,
  });
  function base(stemRows: unknown[]) {
    query.mockImplementation(async (sql: string) => {
      if (/COUNT\(\*\)/.test(sql)) return { rows: [{ a: '0', b: '0', c: '0' }] };
      if (/FROM partners p/.test(sql) && /seller_name/.test(sql)) {
        return { rows: [
          { seller_id: 'op-z', seller_name: 'Тихая Заимка', seller_category: 'operator', seller_slug: 'tikhaya-zaimka', seller_is_public: true },
          { seller_id: 'op-g', seller_name: 'Савва Кедровец', seller_category: 'guide', seller_slug: null, seller_is_public: false },
        ] };
      }
      if (/unnest\(\$1::uuid\[\]/.test(sql)) return { rows: [{ seller_id: 'op-z', key: 'тиха', elsewhere: false }, { seller_id: 'op-z', key: 'заим', elsewhere: false }] };
      if (/stem_hits/.test(sql)) return { rows: stemRows };
      if (/AS rank/.test(sql)) return { rows: [] };
      if (/ot\.operator_id = ANY\(\$1::uuid\[\]\)/.test(sql)) return { rows: [tourRow(201, 'Бухта Тюленья', 'op-z'), tourRow(202, 'Мыс Скалистый', 'op-z')] };
      return { rows: [] };
    });
  }
  const noLead = () => {
    expect(createLeadMock).not.toHaveBeenCalled();
    expect(query.mock.calls.some((c) => /INSERT INTO leads/.test(String(c[0])))).toBe(false);
  };

  it('в поле tour — имя компании: заявка не создана, её туры с номерами и страница', async () => {
    base([]);
    const r = await result(await call('create_booking_request', { ...BOOKING, tour: 'Тихая Заимка' }));
    const text = r.content[0]!.text;
    expect(text).toContain('найден продавец, а не тур — заявка не создана');
    expect(text).toContain('ID201');
    expect(text).toContain('ID202');
    expect(text).toContain('https://vedarai.ru/operators/tikhaya-zaimka');
    noLead();
  });

  it('совпала часть слов у туров ОДНОЙ компании — заявка не создана, а не ушла этой компании', async () => {
    base([tourRow(101, 'Перевал Ольховый', 'op-g', { stem_hits: [true, false] })]);
    const r = await result(await call('create_booking_request', { ...BOOKING, tour: 'Ольховый Несуществующий' }));
    const text = r.content[0]!.text;
    expect(text).toContain('нет тура со всеми словами — заявка не создана');
    expect(text).toContain('совпали только слова «Ольховый»; «Несуществующий» не найдено');
    expect(text).toContain('ID101');
    noLead();
  });

  it('все слова у одного тура — заявка уходит этому туру, как раньше', async () => {
    base([tourRow(101, 'Перевал Ольховый', 'op-g', { stem_hits: [true, true] })]);
    const r = await result(await call('create_booking_request', { ...BOOKING, tour: 'Ольховый перевал' }));
    expect(r.isError).toBeUndefined();
    expect(createLeadMock).toHaveBeenCalledWith(expect.objectContaining({ operator_id: 'op-g' }));
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

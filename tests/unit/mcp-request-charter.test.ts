// @vitest-environment node
/**
 * MCP request_charter — заявка на вахтовку целой машиной (решение владельца
 * 10.10: «трансфер работает не по маршруту, а по заказам»).
 *
 * У перевозчика «под заказ» нет календаря: направление и дни задаёт
 * заказчик, цена — за машину по прайсу. Границы, которые держит сторож:
 *   - заявка — лид менеджеру с operator_id перевозчика (createLead), не бронь
 *     и не оплата; занятость машин НЕ проверяется (система её не ведёт) и
 *     «нет машин» не отвечается;
 *   - цена называется только строкой прайса, итоговой суммы нет; направления
 *     нет в прайсе — заказ принимается, цену называет перевозчик;
 *   - согласие, квота и дедуп — те же, что у обеих прежних заявок;
 *   - отказ чтения перевозчиков — «не смог проверить», не «перевозчиков нет»;
 *   - ответ на повтор заявки неотличим от ответа на новую.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const createLeadMock = vi.hoisted(() => vi.fn(async () => 'lead-1'));
const recentLeadMock = vi.hoisted(() => vi.fn(async () => null as string | null));
const carriersMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/leads/create', () => ({
  createLead: (...a: unknown[]) => createLeadMock(...(a as [])),
  findRecentLeadByCommentPrefix: (...a: unknown[]) => recentLeadMock(...(a as [])),
}));
vi.mock('@/lib/kuzmich/tool-schemas', () => ({
  TOOL_REGISTRY: {},
  validateToolArgs: () => ({ ok: true, args: {} }),
}));
vi.mock('@/lib/kuzmich/core', () => ({ executeKuzmichTool: async () => 'ok' }));
vi.mock('@/lib/transfers/charter', () => ({
  loadCharterCarriers: (...a: unknown[]) => carriersMock(...a),
}));
vi.mock('@/lib/db-pool', () => {
  const q = async (sql: string) =>
    /COUNT\(\*\)/.test(sql) ? { rows: [{ a: '0', b: '0', c: '0' }] } : { rows: [] };
  return { pool: { query: q, connect: async () => ({ query: q, release: () => {} }) } };
});

import { POST } from '@/app/api/mcp/route';
import { matchDestinations, vehiclesNeeded, fleetCapacity, type CharterCarrier } from '@/lib/transfers/charter-format';
import { pickCarrier, planCharterRequest } from '@/lib/transfers/charter-request';

const ROOT = process.cwd();
const ROUTE = readFileSync(join(ROOT, 'app/api/mcp/route.ts'), 'utf-8');

const line = (to: string, priceRub: number, note: string | null = null) => ({
  from: 'Петропавловск-Камчатский', to, priceRub, note, conditions: 'при расчёте наличными', validYear: 2026,
});

function carrier(over: Partial<CharterCarrier> = {}): CharterCarrier {
  return {
    partnerId: 'partner-1', slug: 'shatun', name: 'Шатун', shortDescription: null,
    vehicles: [
      { kind: 'vahtovka', title: 'КамАЗ-1', seats: 26 },
      { kind: 'vahtovka', title: 'КамАЗ-2', seats: 26 },
    ],
    destinations: [
      line('Вулкан Авачинский', 65000),
      line('Вулкан Горелый', 75000),
      line('Вачкажец', 70000),
      line('Курильское озеро', 450000, 'плюс переправы'),
      line('Толбачик (Мёртвый лес)', 360000),
    ],
    extraDay: { priceRub: 30000, note: 'при эксплуатации транспорта на местности', conditions: 'при расчёте наличными', validYear: 2026 },
    photos: [], clips: [], legal: null, video: null,
    phone: '+79001112233', telegramHref: null, whatsappHref: null,
    ...over,
  };
}

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

let ipCounter = 0;
function call(args: Record<string, unknown>) {
  ipCounter += 1;
  return new Request('http://localhost/api/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-real-ip': `10.20.${Math.floor(ipCounter / 250)}.${ipCounter % 250}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'request_charter', arguments: args } }),
  }) as unknown as Parameters<typeof POST>[0];
}
const text = async (r: Response) => {
  const j = await r.json();
  return { isError: Boolean(j.result?.isError), text: String(j.result?.content?.[0]?.text ?? j.error?.message ?? '') };
};

const base = () => ({
  destination: 'Горелый', date_from: inDays(30), passengers: 8,
  name: 'Иван Петров', phone: '+7 900 123-45-67', consent: true,
});

beforeEach(() => {
  process.env.MCP_HASH_SALT = 'соль-для-теста';
  createLeadMock.mockReset();
  createLeadMock.mockResolvedValue('lead-1');
  recentLeadMock.mockReset();
  recentLeadMock.mockResolvedValue(null);
  carriersMock.mockReset();
  carriersMock.mockResolvedValue([carrier()]);
});

describe('сопоставление направления с прайсом', () => {
  const lines = carrier().destinations;

  it('слово из названия находит ровно свою строку, падежи не мешают', () => {
    expect(matchDestinations(lines, 'Горелый').map((l) => l.to)).toEqual(['Вулкан Горелый']);
    expect(matchDestinations(lines, 'на Горелого').map((l) => l.to)).toEqual(['Вулкан Горелый']);
    expect(matchDestinations(lines, 'Толбачика').map((l) => l.to)).toEqual(['Толбачик (Мёртвый лес)']);
    expect(matchDestinations(lines, 'мертвый лес').map((l) => l.to)).toEqual(['Толбачик (Мёртвый лес)']);
  });

  it('общее слово даёт несколько строк (неоднозначно), чужое направление — ни одной', () => {
    expect(matchDestinations(lines, 'Вулкан').map((l) => l.to)).toEqual(['Вулкан Авачинский', 'Вулкан Горелый']);
    expect(matchDestinations(lines, 'аэропорт')).toEqual([]);
    // Мутновский не в прайсе: общее слово «вулкан» не должно подставить чужую цену.
    expect(matchDestinations(lines, 'Мутновский вулкан')).toEqual([]);
  });

  it('слова короче четырёх букв ничего не значат; пустой запрос — ничего', () => {
    expect(matchDestinations(lines, 'на к в')).toEqual([]);
    expect(matchDestinations(lines, '')).toEqual([]);
  });

  it('точное название побеждает частичные совпадения', () => {
    const l = [...lines, line('Горелый — Мутновский', 90000)];
    expect(matchDestinations(l, 'Вулкан Горелый').map((x) => x.to)).toEqual(['Вулкан Горелый']);
  });

  it('«откуда» учитывается только по просьбе поиска, заявка спрашивает «куда»', () => {
    expect(matchDestinations(lines, 'Петропавловск')).toEqual([]);
    expect(matchDestinations(lines, 'Петропавловск', { includeFrom: true })).toHaveLength(lines.length);
  });
});

describe('машины по числу мест — арифметика вместимости, не обещание', () => {
  const fleet = carrier().vehicles;
  it('вместимость и число машин', () => {
    expect(fleetCapacity(fleet)).toEqual({ total: 52, largest: 26, count: 2 });
    expect(fleetCapacity([])).toBeNull();
    expect(vehiclesNeeded(fleet, 8)).toBe(1);
    expect(vehiclesNeeded(fleet, 26)).toBe(1);
    expect(vehiclesNeeded(fleet, 27)).toBe(2);
    expect(vehiclesNeeded(fleet, 53)).toBeNull();
    expect(vehiclesNeeded([], 5)).toBeNull();
  });
});

describe('выбор перевозчика', () => {
  const a = carrier();
  const b = carrier({ partnerId: 'partner-2', slug: 'kamaz-tur', name: 'КамАЗ-Тур' });
  it('один — он и есть; несколько без указания — вопрос, не жребий', () => {
    expect(pickCarrier([a], undefined)).toEqual({ kind: 'picked', carrier: a });
    expect(pickCarrier([a, b], undefined)).toEqual({ kind: 'ambiguous', names: ['Шатун', 'КамАЗ-Тур'] });
    expect(pickCarrier([], undefined)).toEqual({ kind: 'none' });
  });
  it('по slug, по названию без регистра, по части названия; чужого нет', () => {
    expect(pickCarrier([a, b], 'shatun')).toEqual({ kind: 'picked', carrier: a });
    expect(pickCarrier([a, b], 'КАМАЗ-тур')).toEqual({ kind: 'picked', carrier: b });
    expect(pickCarrier([a, b], 'шату')).toEqual({ kind: 'picked', carrier: a });
    expect(pickCarrier([a, b], 'вахта').kind).toBe('unknown');
  });
});

describe('план заявки: порядок проверок', () => {
  it('вместимость отказывает раньше всего, неоднозначное направление — вопрос, остальное — цена или заказ вне прайса', () => {
    expect(planCharterRequest(carrier(), 'Горелый', 60)).toEqual({ kind: 'too_many', seatsTotal: 52 });
    expect(planCharterRequest(carrier(), 'Вулкан', 8).kind).toBe('ambiguous');
    expect(planCharterRequest(carrier(), 'Горелый', 8).kind).toBe('priced');
    expect(planCharterRequest(carrier(), 'аэропорт', 8)).toEqual({ kind: 'custom', vehicles: 1 });
  });
  it('парк не записан — вместимость неизвестна, заявка не отказывается выдуманным пределом', () => {
    expect(planCharterRequest(carrier({ vehicles: [] }), 'Горелый', 500)).toMatchObject({ kind: 'priced', vehicles: null });
  });
});

describe('request_charter через MCP: заявка принята', () => {
  it('направление из прайса: цена за машину строкой прайса, лид менеджеру с operator_id перевозчика', async () => {
    const r = await text(await POST(call(base())));
    expect(r.isError).toBe(false);
    expect(r.text).toContain('Заявка на машину принята');
    expect(r.text).toContain('«Шатун»');
    expect(r.text).toContain('Вулкан Горелый 75000 руб за машину');
    expect(r.text).toContain('Доплата 30000 руб в день');
    // Не бронь, не оплата, машина не закреплена, итоговой суммы нет.
    expect(r.text).toContain('НЕ закреплена');
    expect(r.text).toContain('Это заявка, не оплата');
    expect(r.text).toContain('итоговой суммы платформа не называет');
    expect(r.text).toContain('/operators/shatun');
    // Телефон перевозчика агенту не отдаётся — он уходит менеджеру.
    expect(r.text).not.toContain('79001112233');

    expect(createLeadMock).toHaveBeenCalledTimes(1);
    const lead = (createLeadMock.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(lead.operator_id).toBe('partner-1');
    expect(lead.source_url).toBe('mcp://vedar/charter');
    expect(lead.phone).toBe('+79001234567');
    expect(lead.pd_consent).toBeTruthy();
    // Не подбор тура: AI-конвейер лидов (квалификация, туры, PDF) ему не нужен.
    expect(lead.skip_ai_processing).toBe(true);
    expect(String(lead.comment)).toContain('[Заявка на машину] «Шатун», с ');
    expect(String(lead.comment)).toContain('по прайсу: Вулкан Горелый 75000 руб за машину');
    expect(String(lead.comment)).toContain('телефон перевозчика: +79001112233');
    expect(lead.source_data).toMatchObject({
      source: 'mcp', tool: 'request_charter', kind: 'charter', carrier_id: 'partner-1',
      passengers: 8, price_line_rub: 75000, in_price_list: true, vehicles_needed: 1,
    });
  });

  it('направления нет в прайсе — заказ принимается без цены, прайс показан целиком', async () => {
    const r = await text(await POST(call({ ...base(), destination: 'аэропорт Елизово' })));
    expect(r.isError).toBe(false);
    expect(r.text).toContain('в прайсе нет — это заказ вне прайса, цену называет перевозчик');
    expect(r.text).toContain('Вулкан Авачинский 65000 руб за машину');
    expect(r.text).not.toMatch(/По прайсу: аэропорт/);
    const lead = (createLeadMock.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(lead.source_data).toMatchObject({ in_price_list: false, price_line_rub: null });
    expect(String(lead.comment)).toContain('в прайсе такого направления нет');
  });

  it('группа больше одной машины — сказано, сколько машин нужно по местам, цена не умножается', async () => {
    const r = await text(await POST(call({ ...base(), passengers: 30 })));
    expect(r.text).toContain('не меньше 2 машин');
    expect(r.text).toContain('цена в прайсе — за одну машину');
    expect(r.text).not.toContain('150 000');
  });

  it('даты возвращения нет — так и сказано, а не выдумана', async () => {
    const r = await text(await POST(call(base())));
    expect(r.text).toContain('дата возвращения не указана');
    const withTo = await text(await POST(call({ ...base(), date_to: inDays(32) })));
    expect(withTo.text).toContain(`по ${inDays(32)}`);
  });

  it('повтор заявки: ответ тот же, второго лида нет', async () => {
    const first = await text(await POST(call(base())));
    recentLeadMock.mockResolvedValue('lead-1');
    createLeadMock.mockClear();
    const again = await text(await POST(call(base())));
    expect(again.text).toBe(first.text);
    expect(createLeadMock).not.toHaveBeenCalled();
    expect(String((recentLeadMock.mock.calls.at(-1) as unknown as [string, string])[1])).toBe(`[Заявка на машину] «Шатун», с ${base().date_from},`);
  });
});

describe('request_charter: заявка НЕ создаётся', () => {
  const noLead = () => expect(createLeadMock).not.toHaveBeenCalled();

  it('без согласия — отказ, ничего не записано', async () => {
    const r = await text(await POST(call({ ...base(), consent: false })));
    expect(r.isError).toBe(true);
    noLead();
  });

  it('в аргументах нет согласия — отказ про поле, а не про отказ человека', async () => {
    const { consent: _c, ...rest } = base();
    void _c;
    const r = await text(await POST(call(rest)));
    expect(r.isError).toBe(true);
    expect(r.text).toContain('нет поля consent');
    noLead();
  });

  it('больше людей, чем мест во всех машинах — отказ с цифрой парка', async () => {
    const r = await text(await POST(call({ ...base(), passengers: 60 })));
    expect(r.isError).toBe(false);
    expect(r.text).toContain('всего 52 мест, а нужно 60');
    noLead();
  });

  it('неоднозначное направление — вопрос со списком, заявки нет', async () => {
    const r = await text(await POST(call({ ...base(), destination: 'Вулкан' })));
    expect(r.text).toContain('Вулкан Авачинский; Вулкан Горелый');
    noLead();
  });

  it('даты: прошедшая, слишком далёкая, возвращение раньше выезда, несуществующая', async () => {
    expect((await text(await POST(call({ ...base(), date_from: inDays(-3) })))).text).toContain('уже прошла');
    expect((await text(await POST(call({ ...base(), date_from: inDays(900) })))).text).toContain('слишком далека');
    expect((await text(await POST(call({ ...base(), date_to: inDays(20) })))).text).toContain('не может быть раньше выезда');
    expect((await text(await POST(call({ ...base(), date_from: '2099-02-30' })))).isError).toBe(true);
    noLead();
  });

  it('телефон-мусор и пустое направление — отказ по-русски', async () => {
    expect((await text(await POST(call({ ...base(), phone: 'привет' })))).text).toContain('Телефон не похож на номер');
    expect((await text(await POST(call({ ...base(), destination: '' })))).isError).toBe(true);
    noLead();
  });

  it('отказ чтения перевозчиков — «не смог проверить», а не «перевозчиков нет»', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    carriersMock.mockRejectedValue(Object.assign(new Error('connection terminated'), { code: '57P01' }));
    const r = await text(await POST(call(base())));
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Не удалось проверить перевозчиков');
    expect(r.text).not.toMatch(/нет в системе/);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('request_charter'), '57P01', 'connection terminated');
    err.mockRestore();
    noLead();
  });

  it('перевозчиков с прайсом нет вовсе — честный ответ, путь через create_lead', async () => {
    carriersMock.mockResolvedValue([]);
    const r = await text(await POST(call(base())));
    expect(r.isError).toBe(false);
    expect(r.text).toContain('нет в системе');
    expect(r.text).toContain('create_lead');
    noLead();
  });

  it('перевозчиков несколько и ни один не назван — вопрос; названный чужой — отказ', async () => {
    carriersMock.mockResolvedValue([carrier(), carrier({ partnerId: 'partner-2', slug: 'kamaz-tur', name: 'КамАЗ-Тур' })]);
    expect((await text(await POST(call(base())))).text).toContain('укажите, кому адресовать заявку');
    expect((await text(await POST(call({ ...base(), carrier: 'вездеходы' })))).text).toContain('не найден среди тех, у кого есть прайс');
    noLead();
    const ok = await text(await POST(call({ ...base(), carrier: 'kamaz-tur' })));
    expect(ok.text).toContain('«КамАЗ-Тур»');
    expect((createLeadMock.mock.calls[0] as unknown as [Record<string, unknown>])[0].operator_id).toBe('partner-2');
  });

  it('createLead не сохранил — отказ, а не «принята»', async () => {
    createLeadMock.mockResolvedValue(null as unknown as string);
    const r = await text(await POST(call(base())));
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Не удалось сохранить заявку');
  });
});

describe('request_charter: границы по коду', () => {
  it('в MCP только заявка: ни броней, ни платежей, ни своего SQL к лидам', () => {
    const fn = ROUTE.slice(ROUTE.indexOf('async function executeRequestCharter'), ROUTE.indexOf('async function executeCreateLead'));
    expect(fn.length).toBeGreaterThan(500);
    expect(fn).not.toMatch(/INSERT INTO|UPDATE |DELETE FROM/i);
    expect(fn).not.toMatch(/operator_bookings|lib\/payments|recordCommission/);
    expect(fn).toMatch(/createLead\(\{/);
    // Согласие проверяется ДО записи, дедуп — после согласия (не оракул без допуска).
    expect(fn.indexOf('admitWrite(')).toBeLessThan(fn.indexOf('findRecentLeadByCommentPrefix('));
    expect(fn.indexOf('findRecentLeadByCommentPrefix(')).toBeLessThan(fn.indexOf('createLead({'));
  });
});

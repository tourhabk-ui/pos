// @vitest-environment node
/**
 * search_transfers у Кузьмича и MCP — машина целиком под заказ (владелец
 * 13.10: «бронируют целую машину а не место в ней»).
 *
 * Три исхода (§4.0): прайс есть — прайс за машину; перевозчиков с прайсом
 * нет — факт витрины словами; не смог прочитать — «не смог проверить», без
 * «таких нет». Мест в поездках (схема 926) инструмент не называет вовсе: до
 * 13.10 ответ начинался с «никто не едет» по витрине, которую не заполнял
 * никто, а прайс машины шёл приложением к нему.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const listMock = vi.fn();
const charterMock = vi.fn();
// Витрина мест подменена и заполнена: инструмент не должен до неё дотянуться.
vi.mock('@/lib/transfers/service', () => ({ listPublishedTrips: (...a: unknown[]) => listMock(...a) }));
// Прайс «под заказ» (1185): загрузчик подменён, чистое форматирование — настоящее.
vi.mock('@/lib/transfers/charter', async () => {
  const actual = await vi.importActual<typeof import('@/lib/transfers/charter-format')>('@/lib/transfers/charter-format');
  return { ...actual, loadCharterCarriers: (...a: unknown[]) => charterMock(...a) };
});
vi.mock('@/lib/config', () => ({ getPublicBaseUrl: () => 'https://vedarai.ru' }));

import { searchTransfersForKuzmich } from '@/lib/kuzmich/transfer-search';
import { validateToolArgs, KUZMICH_TOOLS } from '@/lib/kuzmich/tool-schemas';
import { PUBLIC_MCP_TOOLS } from '@/lib/mcp/public-tools';

const TRIP = {
  id: 't1', vehicle_id: 'v1', trip_date: '2026-09-10', from_text: 'Петропавловск', to_text: 'Вулкан Горелый',
  to_place_id: null, to_route_id: null, departure_note: 'к шести утра', seats_total: 10, price_per_seat: '3500.00',
  is_published: true, status: 'planned', comment: null, partner_id: 'p1', partner_name: 'Камчатка-Трек',
  vehicle_kind: 'vahtovka', vehicle_title: 'КАМАЗ', seats_taken: 4, seats_free: 6,
};

const CARRIER = {
  partnerId: 'c1', slug: 'shatun', name: 'Шатун', shortDescription: null,
  vehicles: [
    { kind: 'vahtovka', title: 'КамАЗ синяя', seats: 26 },
    { kind: 'vahtovka', title: 'КамАЗ оранжевая', seats: 26 },
  ],
  destinations: [
    { from: 'Петропавловск-Камчатский', to: 'Вулкан Авачинский', priceRub: 65000, note: null, conditions: 'при расчёте наличными', validYear: 2026 },
    { from: 'Петропавловск-Камчатский', to: 'Вулкан Горелый', priceRub: 75000, note: null, conditions: 'при расчёте наличными', validYear: 2026 },
    { from: 'Петропавловск-Камчатский', to: 'Курильское озеро', priceRub: 450000, note: 'плюс переправы', conditions: 'при расчёте наличными', validYear: 2026 },
  ],
  extraDay: { priceRub: 30000, note: 'при эксплуатации транспорта на местности', conditions: 'при расчёте наличными', validYear: 2026 }, rates: [],
  photos: ['/images/shatun/shatun-01.jpg'],
  phone: '+79294560102', telegramHref: 'https://t.me/+79294560102', whatsappHref: 'https://wa.me/79294560102',
};

/** Слова продажи места — в ответе о трансфере их быть не должно ни в каком исходе. */
const SEAT_SALE = /руб\/место|свободно \d+ из|никто не едет|Запросить место|мест от \d|место в поездке/;

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  listMock.mockReset();
  listMock.mockResolvedValue([TRIP]);
  charterMock.mockReset();
  charterMock.mockResolvedValue([CARRIER]);
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('три исхода — и ни в одном нет мест', () => {
  it('прайс есть — цена за машину целиком, парк, доплата, ссылка на страницу перевозчика', async () => {
    const out = await searchTransfersForKuzmich({});
    expect(out).toMatch(/^Трансфер — машина целиком под заказ/);
    expect(out).toContain('цена за машину, не за место');
    expect(out).toContain('Шатун');
    expect(out).toContain('2 × вахтовка, 26 мест');
    expect(out).toContain('Вулкан Авачинский 65000 руб');
    expect(out).toContain('Курильское озеро 450000 руб (плюс переправы)');
    expect(out).toContain('доплата 30000 руб в день (при эксплуатации транспорта на местности)');
    expect(out).toContain('Цена за машину целиком');
    expect(out).toContain('https://vedarai.ru/transfers/shatun');
    expect(out).toMatch(/Прайс 2026 года/);
    expect(out).not.toMatch(SEAT_SALE);
    // Опубликованная поездка с местами существует — и всё равно не названа.
    expect(out).not.toContain('Камчатка-Трек');
    expect(listMock).not.toHaveBeenCalled();
  });

  it('перевозчиков с прайсом нет — факт витрины словами, не сбой и не повод выдумывать', async () => {
    charterMock.mockResolvedValue([]);
    const out = await searchTransfersForKuzmich({ place: 'Горелый' });
    expect(out).toMatch(/Перевозчиков с прайсом под заказ на платформе пока нет/);
    expect(out).toContain('не сбой');
    expect(out).toMatch(/не выдумывай/);
    expect(out).not.toMatch(/Не смог/);
    expect(out).not.toMatch(SEAT_SALE);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('прайс не прочитался — «не смог проверить», без «таких нет», имя проверки и SQLSTATE в логе', async () => {
    charterMock.mockRejectedValue(Object.assign(new Error('relation does not exist'), { code: '42P01' }));
    const out = await searchTransfersForKuzmich({});
    expect(out).toMatch(/Не смог проверить прайс машин под заказ/);
    expect(out).toMatch(/Не говори, что таких перевозчиков нет/);
    expect(out).not.toMatch(/пока нет/);
    expect(out).not.toMatch(SEAT_SALE);
    expect(errSpy).toHaveBeenCalledWith('[kuzmich/search_transfers]', '42P01', 'relation does not exist');
  });
});

describe('прайс', () => {
  it('телефон перевозчика в ответ модели не уходит — только ссылка на страницу (pd-guard)', async () => {
    const out = await searchTransfersForKuzmich({});
    expect(out).not.toMatch(/9294560102|\+7 ?929|wa\.me|t\.me/);
  });

  it('направление фильтрует прайс; если его в прайсе нет — так и сказано и дан весь прайс', async () => {
    const gor = await searchTransfersForKuzmich({ place: 'Горелый' });
    expect(gor).toContain('Вулкан Горелый 75000 руб');
    expect(gor).not.toContain('Вулкан Авачинский 65000');
    const none = await searchTransfersForKuzmich({ place: 'аэропорт' });
    expect(none).toContain('Направления «аэропорт» в прайсе нет');
    expect(none).toContain('Вулкан Авачинский 65000 руб');
  });

  it('request_charter назван только внешнему агенту (MCP): у Кузьмича в чате такого инструмента нет', async () => {
    const mcp = await searchTransfersForKuzmich({}, { surface: 'mcp' });
    expect(mcp).toContain('request_charter');
    // Какой перевозчик адресуется — названо словом, а не выводится агентом из ссылки.
    expect(mcp).toContain('Параметр carrier — shatun (Шатун)');
    expect(mcp).toContain('можно не передавать');
    const chat = await searchTransfersForKuzmich({}, { surface: 'chat' });
    expect(chat).not.toContain('request_charter');
    expect(await searchTransfersForKuzmich({})).not.toContain('request_charter');
  });

  it('перевозчиков несколько — параметр carrier перечислен поимённо, «можно не передавать» не говорится', async () => {
    charterMock.mockResolvedValue([CARRIER, { ...CARRIER, partnerId: 'c2', slug: 'kamaz-tur', name: 'КамАЗ-Тур' }]);
    const mcp = await searchTransfersForKuzmich({}, { surface: 'mcp' });
    expect(mcp).toContain('Параметр carrier — shatun (Шатун); kamaz-tur (КамАЗ-Тур)');
    expect(mcp).not.toContain('можно не передавать');
  });
});

describe('схема инструмента', () => {
  it('фильтр один — направление; окна дат и числа мест нет ни у Кузьмича, ни в MCP', () => {
    const kuzmich = KUZMICH_TOOLS.find(t => t.function.name === 'search_transfers')!;
    expect(Object.keys(kuzmich.function.parameters.properties)).toEqual(['place']);
    expect(kuzmich.function.parameters.required).toEqual([]);
    const mcp = PUBLIC_MCP_TOOLS.find(t => t.name === 'search_transfers')!;
    expect(Object.keys((mcp.inputSchema as { properties: Record<string, unknown> }).properties)).toEqual(['place']);
    for (const description of [kuzmich.function.description, mcp.description]) {
      expect(description).toMatch(/машин[аы] целиком/);
      expect(description).toMatch(/не за место/);
      expect(description).not.toMatch(/свободные места|free seats|dated carrier trips|цена места/);
    }
  });

  it('агент со старой схемой (from, to, seats) получает прайс, а не отказ: лишние поля отброшены', () => {
    const v = validateToolArgs('search_transfers', { from: '2026-09-08', to: '2026-09-15', seats: '2', place: 'Горелый' });
    expect(v).toEqual({ ok: true, args: { place: 'Горелый' } });
  });
});

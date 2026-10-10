// @vitest-environment node
/**
 * search_transfers у Кузьмича (02.09) — три исхода, не два.
 *
 * Прежний инструмент (удалён 01.09) читал таблицы, которых на проде не было,
 * и отвечал «трансферов не нашлось» на каждый вопрос — выдавал поломку за
 * факт. Новый читает ТОЛЬКО через listPublishedTrips (то же, что витрина) и
 * различает: нашли / искали и никто не едет / не смог проверить.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const listMock = vi.fn();
const charterMock = vi.fn();
vi.mock('@/lib/transfers/service', () => ({ listPublishedTrips: (...a: unknown[]) => listMock(...a) }));
// Прайс «под заказ» (1185): загрузчик подменён, чистое форматирование — настоящее.
vi.mock('@/lib/transfers/charter', async () => {
  const actual = await vi.importActual<typeof import('@/lib/transfers/charter-format')>('@/lib/transfers/charter-format');
  return { ...actual, loadCharterCarriers: (...a: unknown[]) => charterMock(...a) };
});
vi.mock('@/lib/config', () => ({ getPublicBaseUrl: () => 'https://vedarai.ru' }));

import { searchTransfersForKuzmich, resolveWindow } from '@/lib/kuzmich/transfer-search';

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
  extraDay: { priceRub: 30000, note: 'при эксплуатации транспорта на местности', conditions: 'при расчёте наличными', validYear: 2026 },
  photos: ['/images/shatun/shatun-01.jpg'],
  phone: '+79294560102', telegramHref: 'https://t.me/+79294560102', whatsappHref: 'https://wa.me/79294560102',
};

beforeEach(() => {
  listMock.mockReset();
  charterMock.mockReset();
  charterMock.mockResolvedValue([]);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('три исхода', () => {
  it('нашли — список с остатком, ценой, перевозчиком и ссылкой на витрину', async () => {
    listMock.mockResolvedValue([TRIP]);
    const out = await searchTransfersForKuzmich({ from: '2026-09-08', to: '2026-09-15', seats: '2', place: 'Горелый' });
    expect(out).toContain('Вулкан Горелый');
    expect(out).toContain('свободно 6 из 10');
    expect(out).toContain('3500 руб/место');
    expect(out).toContain('Камчатка-Трек');
    expect(out).toContain('https://vedarai.ru/transfers');
    expect(listMock).toHaveBeenCalledWith({ fromDate: '2026-09-08', toDate: '2026-09-15', minSeats: 2, placeId: null });
  });

  it('искали и никто не едет — факт с окном дат, не сбой', async () => {
    listMock.mockResolvedValue([]);
    const out = await searchTransfersForKuzmich({ from: '2026-09-08', to: '2026-09-15' });
    expect(out).toMatch(/никто не едет/);
    expect(out).toContain('2026-09-08');
    expect(out).toContain('не сбой');
  });

  it('направление не совпало — тоже «никто не едет в сторону», а не список чужих поездок', async () => {
    listMock.mockResolvedValue([TRIP]);
    const out = await searchTransfersForKuzmich({ place: 'Толбачик' });
    expect(out).toMatch(/никто не едет/);
    expect(out).toContain('Толбачик');
    expect(out).not.toContain('Горелый');
  });

  it('база упала — «не смог проверить», без слова «нет мест»', async () => {
    listMock.mockRejectedValue(new Error('42P01'));
    const out = await searchTransfersForKuzmich({});
    expect(out).toMatch(/Не смог проверить/);
    expect(out).not.toMatch(/никто не едет/);
  });
});

describe('вахтовки под заказ (1185): прайс на целую машину', () => {
  it('поездок нет, а прайс есть — «никто не едет» остаётся фактом, ниже прайс за машину и ссылка на карточку', async () => {
    listMock.mockResolvedValue([]);
    charterMock.mockResolvedValue([CARRIER]);
    const out = await searchTransfersForKuzmich({});
    expect(out).toMatch(/никто не едет/);
    expect(out).toContain('Шатун');
    expect(out).toContain('2 × вахтовка, 26 мест');
    expect(out).toContain('Вулкан Авачинский 65000 руб');
    expect(out).toContain('Курильское озеро 450000 руб (плюс переправы)');
    expect(out).toContain('доплата 30000 руб в день (при эксплуатации транспорта на местности)');
    expect(out).toContain('Цена за машину целиком');
    expect(out).toContain('https://vedarai.ru/operators/shatun');
    expect(out).toMatch(/Прайс 2026 года/);
  });

  it('телефон перевозчика в ответ модели не уходит — только ссылка на карточку (pd-guard)', async () => {
    listMock.mockResolvedValue([TRIP]);
    charterMock.mockResolvedValue([CARRIER]);
    const out = await searchTransfersForKuzmich({});
    expect(out).not.toMatch(/9294560102|\+7 ?929|wa\.me|t\.me/);
    // «за место» в прайсе машины не называется: перевозчик цену места не давал.
    const charterPart = out.slice(out.indexOf('Под заказ'));
    expect(charterPart).not.toMatch(/руб\/место/);
  });

  it('направление фильтрует прайс; если его в прайсе нет — так и сказано и дан весь прайс', async () => {
    listMock.mockResolvedValue([]);
    charterMock.mockResolvedValue([CARRIER]);
    const gor = await searchTransfersForKuzmich({ place: 'Горелый' });
    const part = gor.slice(gor.indexOf('Под заказ'));
    expect(part).toContain('Вулкан Горелый 75000 руб');
    expect(part).not.toContain('Вулкан Авачинский 65000');
    const none = await searchTransfersForKuzmich({ place: 'аэропорт' });
    expect(none).toContain('Направления «аэропорт» в прайсе нет');
    expect(none).toContain('Вулкан Авачинский 65000 руб');
  });

  it('request_charter назван только внешнему агенту (MCP): у Кузьмича в чате такого инструмента нет', async () => {
    listMock.mockResolvedValue([]);
    charterMock.mockResolvedValue([CARRIER]);
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
    listMock.mockResolvedValue([]);
    charterMock.mockResolvedValue([CARRIER, { ...CARRIER, partnerId: 'c2', slug: 'kamaz-tur', name: 'КамАЗ-Тур' }]);
    const mcp = await searchTransfersForKuzmich({}, { surface: 'mcp' });
    expect(mcp).toContain('Параметр carrier — shatun (Шатун); kamaz-tur (КамАЗ-Тур)');
    expect(mcp).not.toContain('можно не передавать');
  });

  it('прайс не прочитался — «не смог проверить», поездки при этом не пропадают и «таких нет» не говорится', async () => {
    listMock.mockResolvedValue([TRIP]);
    charterMock.mockRejectedValue(Object.assign(new Error('42P01'), { code: '42P01' }));
    const out = await searchTransfersForKuzmich({});
    expect(out).toContain('Вулкан Горелый');
    expect(out).toMatch(/Не смог проверить прайс вахтовок под заказ/);
    expect(out).toMatch(/Не говори, что таких перевозчиков нет/);
  });

  it('витрина поездок упала, прайс жив — оба факта в ответе, каждый под своим именем', async () => {
    listMock.mockRejectedValue(new Error('42P01'));
    charterMock.mockResolvedValue([CARRIER]);
    const out = await searchTransfersForKuzmich({});
    expect(out).toMatch(/Не смог проверить витрину поездок/);
    expect(out).toContain('Вулкан Авачинский 65000 руб');
  });

  it('перевозчиков под заказ нет — раздела нет вовсе, а не «под заказ никого нет»', async () => {
    listMock.mockResolvedValue([TRIP]);
    charterMock.mockResolvedValue([]);
    const out = await searchTransfersForKuzmich({});
    expect(out).not.toMatch(/Под заказ|под заказ/);
  });
});

describe('окно дат', () => {
  it('без аргументов — сегодня плюс 14 дней; кривые даты не ломают', () => {
    const now = new Date('2026-09-02T10:00:00Z');
    expect(resolveWindow({}, now)).toEqual({ from: '2026-09-02', to: '2026-09-16' });
    expect(resolveWindow({ from: 'завтра', to: '2026-13-99' }, now)).toEqual({ from: '2026-09-02', to: '2026-09-16' });
  });
  it('«сегодня» по Камчатке: в 22:05 UTC окно начинается со следующего числа', () => {
    expect(resolveWindow({}, new Date('2026-09-29T22:05:00Z'))).toEqual({ from: '2026-09-30', to: '2026-10-14' });
  });
  it('окно шире 60 дней или «до» раньше «от» — сжимается к 14 дням от «от»', () => {
    expect(resolveWindow({ from: '2026-09-01', to: '2026-12-31' })).toEqual({ from: '2026-09-01', to: '2026-09-15' });
    expect(resolveWindow({ from: '2026-09-10', to: '2026-09-01' })).toEqual({ from: '2026-09-10', to: '2026-09-24' });
  });
});

describe('единственный путь чтения', () => {
  it('инструмент не ходит в таблицы сам и зовётся из executeTool', () => {
    const src = readFileSync(join(process.cwd(), 'lib/kuzmich/transfer-search.ts'), 'utf8');
    expect(src).not.toMatch(/FROM transfer_|db-pool|@\/lib\/database/);
    expect(src).toMatch(/listPublishedTrips/);
    const core = readFileSync(join(process.cwd(), 'lib/kuzmich/core.ts'), 'utf8');
    expect(core).toMatch(/name === 'search_transfers'/);
  });
});

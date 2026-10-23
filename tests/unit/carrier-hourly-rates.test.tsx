/**
 * Перевозчик с ценой за час и за день — «ИП Желтухин» (миграция 1292).
 *
 * Владелец 15.10 переслал слова перевозчика: «Час 4.500 рублей, полный день
 * 45.000 рублей. Направлений нет, отдельно оговариваются дальние поездки» и
 * ответил на вопросы: вывеска «ИП Желтухин», отметки «проверенный» нет —
 * «только факты», снимки — «только живые», «вахтовок нет».
 *
 * Сторож судит рендером и вызовом (правило 13.10):
 *   · прайс называет цену за час и за день за МАШИНУ, «Заказать» у неё ведёт
 *     к форме без выбранного направления, «направления нет в прайсе» нигде не
 *     говорится — прайс не про направления;
 *   · сколько мест в какой машине, не записано — так и сказано; вместимости
 *     парка без привязки к машине (владелец 16.10: «есть автобусы по 12 мест
 *     и есть по 24 места») — «на 12 и на 24 места», «12 или 24 в машине»;
 *     «мест не хватит» не говорится: сколько машин каждого размера, неизвестно;
 *   · лицензия — по выписке, со статусом на ДАТУ выписки; страхование — «со
 *     слов перевозчика, полис не показан»; «Проверенный перевозчик» нет;
 *   · Кузьмич, MCP и заявка менеджеру называют ту же цену теми же словами;
 *   · витрина называет правило порядка (§0);
 *   · миграция пишет только факты: ни паспорта, ни адреса из выписки.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, cleanup, fireEvent } from '@testing-library/react';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const { dbQuery } = vi.hoisted(() => ({ dbQuery: vi.fn() }));
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => dbQuery(...a) }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));
vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/components/layout/Footer', () => ({ Footer: () => null }));
vi.mock('@/components/shared/BottomNav', () => ({ default: () => null }));

import { CarrierPage } from '@/components/transfers/CarrierPage';
import { CharterCard } from '@/components/transfers/CharterCard';
import { CharterRequestForm } from '@/components/transfers/CharterRequestForm';
import { TransfersPage } from '@/components/transfers/TransfersPage';
import {
  charterFootnote, describeFleet, fleetCapacity, fleetKindTitle, licenseLine, priceUnknownsText,
  rateOnScreen, rateWords, seatClassesWords, sortRates, vehiclesNeeded,
  type CarrierProfile, type CharterCarrier, type CharterRate,
} from '@/lib/transfers/charter-format';
import {
  loadCarrierBySlug, loadCharterCarriers, parseLicense, parsePassengerInsurance, parseSeatClasses,
} from '@/lib/transfers/charter';
import { carrierInstrument, carrierJsonLd } from '@/lib/transfers/carrier-view';
import { charterAnswer } from '@/lib/kuzmich/transfer-search';
import {
  charterAcceptedText, charterLeadComment, charterSourceData, pickCarrier, planCharterRequest,
} from '@/lib/transfers/charter-request';
import { CARRIERS_ORDER_NOTE } from '@/lib/operators/order-note';
import type { CarrierPageData } from '@/lib/transfers/carrier-page';

const ROOT = process.cwd();
/** Деньги на экране пишутся с неразрывными пробелами (formatRub) — сравнение по смыслу, не по байту пробела. */
const plain = (s: string | null | undefined): string => (s ?? '').replace(/[\u00a0\u202f]/g, ' ');

const RATES: CharterRate[] = [
  { unit: 'hour', vehicleKind: 'minibus', priceRub: 4500, note: null, conditions: 'фиксированных направлений нет; дальние поездки — по договорённости', validYear: null },
  { unit: 'day', vehicleKind: 'minibus', priceRub: 45000, note: null, conditions: 'фиксированных направлений нет; дальние поездки — по договорённости', validYear: null },
];

const ZH: CarrierProfile = {
  partnerId: 'p-zh', slug: 'zheltukhin', name: 'ИП Желтухин',
  shortDescription: 'Микроавтобусы под заказ', description: 'Перевозчик: три микроавтобуса.', verified: false,
  vehicles: [
    { kind: 'minibus', title: 'Mercedes-Benz Sprinter, В688НУ41', seats: null },
    { kind: 'minibus', title: 'Mercedes-Benz Sprinter, В333АС41', seats: null },
    { kind: 'minibus', title: 'Ford Transit, К002ОВ41', seats: null },
  ],
  destinations: [], extraDay: null, rates: RATES, seatClasses: [12, 24],
  photos: [{ url: '/images/zheltukhin/zheltukhin-01.jpg', credit: null }, { url: '/images/zheltukhin/zheltukhin-02.jpg', credit: null }],
  clips: [], video: null,
  legal: { name: 'ИП Желтухин Михаил Анатольевич', inn: '410209072036', ogrn: '313417727300072' },
  license: {
    kind: 'registry', number: 'Л022-00112-41/00927020', issuedOn: '2023-11-29',
    authority: 'Территориальный отдел государственного автодорожного надзора по Камчатскому краю',
    status: 'действует', checkedOn: '2026-05-04',
  },
  passengerInsurance: 'words',
  phone: '+79619620826', telegramHref: null, whatsappHref: null,
};

const SHATUN: CharterCarrier = {
  partnerId: 'p-sh', slug: 'shatun', name: 'Шатун', shortDescription: null,
  vehicles: [{ kind: 'vahtovka', title: 'КамАЗ-1', seats: 26 }, { kind: 'vahtovka', title: 'КамАЗ-2', seats: 26 }],
  destinations: [{ from: 'Петропавловск-Камчатский', to: 'Вулкан Горелый', priceRub: 75000, note: null, conditions: 'при расчёте наличными', validYear: 2026, place: null }],
  extraDay: null, rates: [], seatClasses: [], photos: [], clips: [], legal: null, video: null,
  phone: '+79294560102', telegramHref: null, whatsappHref: null,
};

const DATA: CarrierPageData = {
  carrier: ZH,
  safety: { state: 'ok', byPlace: {} },
  reviews: { state: 'ok', items: [], count: 0, average: null },
};

beforeEach(() => {
  cleanup();
  dbQuery.mockReset();
});

describe('правила прайса и парка', () => {
  it('цена за час и за день — словами экрана и агента, час первым', () => {
    expect(plain(rateOnScreen(RATES[0]!))).toBe('4 500 ₽ в час');
    expect(plain(rateOnScreen(RATES[1]!))).toBe('45 000 ₽ за день');
    expect(rateWords(RATES[0]!)).toBe('4500 руб за час работы машины');
    expect(rateWords(RATES[1]!)).toBe('45000 руб за полный день работы машины');
    expect(sortRates([RATES[1]!, RATES[0]!]).map((r) => r.unit)).toEqual(['hour', 'day']);
  });

  it('число мест у машины не записано — так и сказано; вместимости и «сколько машин нужно» нет', () => {
    expect(describeFleet(ZH.vehicles)).toBe('3 × микроавтобус, число мест не записано');
    // Вместимости парка без привязки к машине — названы, а какая машина на сколько, нет.
    expect(describeFleet(ZH.vehicles, ZH.seatClasses)).toBe('3 × микроавтобус: на 12 и на 24 места');
    expect(describeFleet([], [12, 24])).toBe('машины на 12 и на 24 места');
    // У машин места записаны — вместимости парка не нужны и не подмешиваются.
    expect(describeFleet(SHATUN.vehicles, [12])).toBe('2 × вахтовка, 26 мест');
    expect(fleetCapacity(ZH.vehicles)).toBeNull();
    expect(vehiclesNeeded(ZH.vehicles, 8)).toBeNull();
    // Записано не у всех — сумма по части машин соврала бы.
    const mixed = [{ kind: 'minibus' as const, title: 'A', seats: 18 }, { kind: 'minibus' as const, title: 'B', seats: null }];
    expect(fleetCapacity(mixed)).toBeNull();
    expect(describeFleet(mixed)).toBe('1 × микроавтобус, 18 мест; 1 × микроавтобус, число мест не записано');
    // Записано у всех — как прежде.
    expect(fleetCapacity(SHATUN.vehicles)).toEqual({ total: 52, largest: 26, count: 2 });
  });

  it('вместимости словами: падеж по последнему числу', () => {
    expect(seatClassesWords([12, 24])).toBe('на 12 и на 24 места');
    expect(seatClassesWords([12, 20])).toBe('на 12 и на 20 мест');
    expect(seatClassesWords([21])).toBe('на 21 место');
    expect(seatClassesWords([8, 12, 24])).toBe('на 8, на 12 и на 24 места');
    expect(seatClassesWords([])).toBeNull();
  });

  it('вид машины в заголовке заявки — из парка, а не «вахтовка» для всех', () => {
    expect(fleetKindTitle(ZH.vehicles)).toBe('Микроавтобус');
    expect(fleetKindTitle(SHATUN.vehicles)).toBe('Вахтовка');
    expect(fleetKindTitle([])).toBe('Машина');
  });

  it('сноска называет условие перевозчика; чего прайс не говорит — сказано, а не додумано', () => {
    expect(charterFootnote(ZH)).toBe('Фиксированных направлений нет; дальние поездки — по договорённости.');
    expect(priceUnknownsText(ZH)).toBe('Минимальный заказ, сколько часов в полном дне и что входит в цену');
    expect(priceUnknownsText(SHATUN)).toBe('Сколько дней в поездке и что входит в цену');
  });

  it('лицензия: по выписке — со статусом на дату выписки; «есть» без номера — так и сказано', () => {
    expect(licenseLine(ZH.license!)).toBe(
      'Лицензия № Л022-00112-41/00927020 от 29.11.2023; лицензирующий орган — территориальный отдел государственного '
      + 'автодорожного надзора по Камчатскому краю; статус по выписке из реестра лицензий на 04.05.2026 — «действует»',
    );
    expect(licenseLine({ kind: 'words' })).toBe('Лицензия: есть — номер на платформе не записан, по реестру не сверялась');
  });
});

describe('разбор legal_info', () => {
  it('лицензия: объект выписки с номером, слово «есть» (1187) или ничего; кривая дата не выглядит датой', () => {
    expect(parseLicense({ license: { number: ' Л022-1 ', issuedOn: '2023-11-29', authority: 'Отдел', registryStatus: 'действует', registryCheckedOn: '04.05.2026' } }))
      .toEqual({ kind: 'registry', number: 'Л022-1', issuedOn: '2023-11-29', authority: 'Отдел', status: 'действует', checkedOn: null });
    expect(parseLicense({ license: 'есть' })).toEqual({ kind: 'words' });
    expect(parseLicense({ license: { issuedOn: '2023-11-29' } })).toBeNull();
    expect(parseLicense({ license: 'нет' })).toBeNull();
    expect(parseLicense({ inn: '410209072036' })).toBeNull();
    expect(parseLicense(null)).toBeNull();
  });

  it('вместимости парка: только целые больше нуля, без повторов, по возрастанию; мусор — «не записаны»', () => {
    expect(parseSeatClasses([24, 12, 24])).toEqual([12, 24]);
    expect(parseSeatClasses([12, 0, -3, 2.5, '20', null])).toEqual([12]);
    expect(parseSeatClasses(null)).toEqual([]);
    expect(parseSeatClasses('12,24')).toEqual([]);
  });

  it('страхование — только «со слов перевозчика»; иное не выдаётся за полис', () => {
    expect(parsePassengerInsurance({ passengerInsurance: 'со слов перевозчика' })).toBe('words');
    expect(parsePassengerInsurance({ passengerInsurance: 'полис № 1' })).toBeNull();
    expect(parsePassengerInsurance({})).toBeNull();
  });
});

describe('загрузчик: строки per_hour/per_day и машины без мест', () => {
  const partner = {
    id: 'p-zh', slug: 'zheltukhin', name: 'ИП Желтухин', short_description: null, hero_image: '/images/zheltukhin/zheltukhin-01.jpg',
    gallery: ['/images/zheltukhin/zheltukhin-02.jpg'], video_url: null, video_poster_url: null, gallery_credits: null, video_clips: null,
    legal_info: { companyName: 'ИП Желтухин Михаил Анатольевич', inn: '410209072036', ogrn: '313417727300072', license: { number: 'Л022-00112-41/00927020' }, passengerInsurance: 'со слов перевозчика' },
    contacts: { phone: '+79619620826' }, is_verified: false, description: 'Перевозчик',
    fleet_seat_classes: [24, 12],
  };
  const price = (line_kind: string, price_rub: number) => ({
    partner_id: 'p-zh', vehicle_kind: 'minibus', line_kind, from_text: null, to_text: null, price_rub,
    price_note: null, conditions: 'дальние поездки — по договорённости', valid_year: null, place_id: null, place_slug: null, place_name: null,
  });

  it('день раньше часа в базе — на экране час первым; места NULL — null, а не ноль', async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [partner] })
      .mockResolvedValueOnce({ rows: [price('per_day', 45000), price('per_hour', 4500)] })
      .mockResolvedValueOnce({ rows: [{ partner_id: 'p-zh', kind: 'minibus', title: 'Ford Transit', seats: null }] });
    const c = await loadCarrierBySlug('zheltukhin');
    expect(c?.rates.map((r) => [r.unit, r.priceRub])).toEqual([['hour', 4500], ['day', 45000]]);
    expect(c?.destinations).toEqual([]);
    expect(c?.extraDay).toBeNull();
    expect(c?.vehicles).toEqual([{ kind: 'minibus', title: 'Ford Transit', seats: null }]);
    expect(c?.seatClasses).toEqual([12, 24]);
    expect(String(dbQuery.mock.calls[0]?.[0])).toContain('p.fleet_seat_classes');
    expect(c?.license).toMatchObject({ kind: 'registry', number: 'Л022-00112-41/00927020' });
    expect(c?.passengerInsurance).toBe('words');
    expect(c?.verified).toBe(false);
  });

  it('витрина — по алфавиту, одним правилом с компаниями', async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    await loadCharterCarriers();
    expect(String(dbQuery.mock.calls[0]?.[0])).toMatch(/ORDER BY lower\(p\.name\), p\.id/);
  });
});

describe('страница перевозчика с ценой за час и за день', () => {
  it('прайс: час и день за машину, «Заказать» — к форме без выбранного направления', () => {
    render(<CarrierPage data={DATA} />);
    const price = screen.getByRole('heading', { name: 'Прайс под заказ' }).parentElement as HTMLElement;
    const text = plain(price.textContent);
    expect(text).toContain('Час работы машины');
    expect(text).toContain('4 500 ₽ в час');
    expect(text).toContain('Полный день');
    expect(text).toContain('45 000 ₽ за день');
    expect(text).toContain('Цена — за машину целиком, не за место.');
    expect(text).toContain('Фиксированных направлений нет; дальние поездки — по договорённости.');
    const order = within(price).getByRole('link', { name: 'Заказать машину: час работы машины' });
    expect(order.getAttribute('href')).toBe('/transfers/zheltukhin#charter-request');
    expect(within(price).getByRole('link', { name: 'Заказать машину: полный день' }).getAttribute('href')).toBe('/transfers/zheltukhin#charter-request');
    expect(text).not.toMatch(/в прайсе нет/);
  });

  it('полоса фактов: вид машины, места — вместимостями парка, сколько машин, «за час или за день»', () => {
    render(<CarrierPage data={DATA} />);
    const strip = screen.getByLabelText('Факты о перевозчике');
    expect([...strip.querySelectorAll('dt')].map((d) => d.textContent)).toEqual(['Машина', 'Мест', 'Машин', 'Цена']);
    expect(strip.textContent).toContain('12 или 24 в машине');
    expect(strip.textContent).toContain('Микроавтобус');
    expect(strip.textContent).toContain('3');
    expect(strip.textContent).toContain('за час или за день');
    expect(carrierInstrument({ vehicles: ZH.vehicles, destinations: [], rates: [RATES[0]!], seatClasses: [] }).at(-1)).toEqual({ k: 'Цена', v: 'за час' });
    // Не записаны ни места машин, ни вместимости парка — ячейки «Мест» нет вовсе.
    expect(carrierInstrument({ vehicles: ZH.vehicles, destinations: [], rates: RATES, seatClasses: [] }).map((c) => c.k))
      .toEqual(['Машина', 'Машин', 'Цена']);
  });

  it('что входит в цену — минимальный заказ, часы дня, топливо и подача: не записано и сказано так', () => {
    render(<CarrierPage data={DATA} />);
    const inc = screen.getByRole('heading', { name: 'Что входит в цену' }).parentElement as HTMLElement;
    expect(inc.textContent).toContain('есть ли минимальный заказ, сколько часов в полном дне, входят ли топливо и подача машины');
    expect(inc.textContent).not.toContain('сколько дней входит в цену');
  });

  it('перевозчик: исполнитель по реквизитам, лицензия по выписке, страхование со слов; «Проверенный перевозчик» нет', () => {
    render(<CarrierPage data={DATA} />);
    const who = screen.getByRole('heading', { name: 'Перевозчик' }).parentElement as HTMLElement;
    expect(who.textContent).toContain('Исполнитель: ИП Желтухин Михаил Анатольевич, ИНН 410209072036, ОГРН 313417727300072');
    expect(who.textContent).toContain('Лицензия № Л022-00112-41/00927020 от 29.11.2023');
    expect(who.textContent).toContain('статус по выписке из реестра лицензий на 04.05.2026 — «действует»');
    expect(who.textContent).toContain('Страхование пассажиров — со слов перевозчика; полис на платформе не показан.');
    expect(who.textContent).toContain('3 × микроавтобус: на 12 и на 24 места');
    expect(who.textContent).not.toContain('Проверенный перевозчик');
    expect(who.querySelector('a[href="tel:+79619620826"]')).not.toBeNull();
  });

  it('безопасность: направлений нет — куда смотреть, без пустого списка; заявка — с ценой за время, без «от»', () => {
    render(<CarrierPage data={DATA} />);
    const safety = screen.getByRole('heading', { name: 'Безопасность по направлениям' }).parentElement as HTMLElement;
    expect(safety.textContent).toContain('Направлений в прайсе нет: куда ехать, задаёте вы');
    expect(safety.textContent).toContain('112');
    const form = document.getElementById('charter-request') as HTMLElement;
    expect(plain(form.textContent)).toContain('4 500 ₽ в час · 45 000 ₽ за день за машину; куда ехать — пишете в заявке');
    expect(form.textContent).not.toMatch(/\bот\s+\d/);
    // Направление — своё: поле ввода, не список прайса.
    const input = within(form).getByLabelText('Куда') as HTMLInputElement;
    expect(input.tagName).toBe('INPUT');
    expect(input.placeholder).toBe('Откуда и куда — например, из аэропорта в город');
  });

  it('нет лицензии и страхования в записи — строк о них нет вовсе', () => {
    render(<CarrierPage data={{ ...DATA, carrier: { ...ZH, license: null, passengerInsurance: null } }} />);
    const who = screen.getByRole('heading', { name: 'Перевозчик' }).parentElement as HTMLElement;
    expect(who.textContent).not.toMatch(/Лицензия|Страхование/);
  });
});

describe('форма после отправки называет цену за время, а не «направления нет в прайсе»', () => {
  it('ответ без строки прайса у перевозчика с ценой за час и день', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ success: true, data: { price_line: null } }) }));
    render(<CharterRequestForm carrierSlug="zheltukhin" carrierName="ИП Желтухин" destinations={[]} rates={RATES} />);
    fireEvent.change(screen.getByLabelText('Куда'), { target: { value: 'Аэропорт — Паратунка' } });
    fireEvent.change(screen.getByLabelText('Выезд'), { target: { value: '2027-07-10' } });
    fireEvent.change(screen.getByLabelText('Сколько человек'), { target: { value: '12' } });
    fireEvent.change(screen.getByLabelText('Имя и фамилия'), { target: { value: 'Анна Петрова' } });
    fireEvent.change(screen.getByLabelText('Телефон'), { target: { value: '+79001234567' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Отправить заявку на машину/ }));
    const status = await screen.findByRole('status');
    expect(plain(status.textContent)).toContain('По прайсу: 4 500 ₽ в час · 45 000 ₽ за день за машину.');
    expect(status.textContent).not.toContain('нет в прайсе');
    vi.unstubAllGlobals();
  });
});

describe('витрина /transfers', () => {
  it('карточка: цена за час и день, текст про машину, а не «вахтовки»', () => {
    render(<CharterCard carrier={ZH} />);
    const card = screen.getByRole('region', { name: 'ИП Желтухин: машина под заказ' });
    expect(plain(card.textContent)).toContain('4 500 ₽ в час');
    expect(card.textContent).toContain('Минимальный заказ, сколько часов в полном дне и что входит в цену — в прайсе не указано');
    expect(card.textContent).toContain('через платформу машина под заказ не оплачивается');
    expect(card.textContent).not.toMatch(/вахтовк/i);
  });

  it('правило порядка названо словами (§0), когда перевозчики есть; нет — подписи нет', () => {
    const { unmount } = render(<TransfersPage charter={{ state: 'ok', carriers: [ZH, SHATUN] }} />);
    expect(screen.getByText(CARRIERS_ORDER_NOTE)).toBeTruthy();
    expect(CARRIERS_ORDER_NOTE).toBe('Перевозчики идут по алфавиту. Место в списке не продаётся.');
    unmount();
    render(<TransfersPage charter={{ state: 'ok', carriers: [] }} />);
    expect(screen.queryByText(CARRIERS_ORDER_NOTE)).toBeNull();
  });
});

describe('Кузьмич, MCP и заявка менеджеру — одна цена одними словами', () => {
  const base = 'https://vedarai.ru';

  it('ответ: цена за время работы, направление задаёт заказчик; «направления нет в прайсе» — только у прайса по направлениям', () => {
    const text = charterAnswer([ZH, SHATUN], 'Паратунка', base, { surface: 'mcp' });
    const [zh, sh] = text.split('\n').slice(1, 3);
    expect(zh).toContain('ИП Желтухин — 3 × микроавтобус: на 12 и на 24 места.');
    expect(zh).toContain('Цена за машину целиком — за время работы, направление задаёт заказчик: 4500 руб за час работы машины; 45000 руб за полный день работы машины.');
    expect(zh).not.toContain('в прайсе нет');
    expect(zh).toContain(`${base}/transfers/zheltukhin`);
    expect(sh).toContain('Направления «Паратунка» в прайсе нет');
    // Двое — параметр carrier обязателен по смыслу: подсказки «можно не передавать» нет.
    expect(text).toContain('Параметр carrier — zheltukhin (ИП Желтухин); shatun (Шатун).');
    expect(text).not.toContain('пока перевозчик один');
    // Телефон перевозчика в ответ модели не уходит (pd-guard).
    expect(text).not.toContain('9619620826');
  });

  it('заявка: план «за время работы»; «мест не хватит» не говорится — сколько машин каждого размера, неизвестно', () => {
    const plan = planCharterRequest(ZH, 'Аэропорт — Паратунка', 60);
    expect(plan).toEqual({ kind: 'rated', rates: RATES, vehicles: null });
    expect(planCharterRequest(SHATUN, 'Паратунка', 8).kind).toBe('custom');
    expect(pickCarrier([ZH, SHATUN], undefined)).toEqual({ kind: 'ambiguous', names: ['ИП Желтухин', 'Шатун'] });
    expect(pickCarrier([ZH, SHATUN], 'zheltukhin')).toMatchObject({ kind: 'picked', carrier: { slug: 'zheltukhin' } });
  });

  it('тексты агенту и менеджеру называют цену за час и день; источник заявки — числами', () => {
    const plan = planCharterRequest(ZH, 'Аэропорт — Паратунка', 12);
    if (plan.kind !== 'rated') throw new Error('ожидался rated');
    const facts = { carrier: ZH, plan, destination: 'Аэропорт — Паратунка', dateFrom: '2027-07-10', dateTo: null, passengers: 12, comment: null };
    const accepted = charterAcceptedText(facts, '+79001234567', base);
    expect(accepted).toContain('Цена у перевозчика — за время работы машины, направление задаёт заказчик: 4500 руб за час работы машины; 45000 руб за полный день работы машины.');
    expect(accepted).toContain('итоговой суммы платформа не называет');
    expect(accepted).not.toContain('в прайсе нет');
    const comment = charterLeadComment(facts);
    expect(comment).toContain('цена за время работы машины: 4500 руб за час работы машины, 45000 руб за полный день работы машины');
    expect(comment).toContain('телефон перевозчика: +79619620826');
    expect(charterSourceData(facts, 'form')).toMatchObject({ in_price_list: false, price_line_rub: null, rates_rub: { hour: 4500, day: 45000 } });
  });
});

describe('разметка для поисковиков', () => {
  it('цена за время — Offer с единицей (HUR, DAY), без выдуманной цены поездки', () => {
    const ld = carrierJsonLd(ZH, 'https://vedarai.ru') as { makesOffer: Array<Record<string, unknown>>; legalName: string; taxID: string };
    expect(ld.legalName).toBe('ИП Желтухин Михаил Анатольевич');
    expect(ld.taxID).toBe('410209072036');
    expect(ld.makesOffer).toHaveLength(2);
    expect(ld.makesOffer.map((o) => (o.priceSpecification as { unitCode: string; price: number })))
      .toEqual([
        { '@type': 'UnitPriceSpecification', price: 4500, priceCurrency: 'RUB', unitCode: 'HUR' },
        { '@type': 'UnitPriceSpecification', price: 45000, priceCurrency: 'RUB', unitCode: 'DAY' },
      ]);
    expect(ld.makesOffer.every((o) => !('price' in o))).toBe(true);
  });
});

describe('миграция 1292: только факты', () => {
  const SQL = readFileSync(join(ROOT, 'migrations/1292_zheltukhin_minibus_carrier.sql'), 'utf8');
  const CODE = SQL.replace(/--[^\n]*/g, '');

  it('цена за час и за день — за машину, у тарифов нет «откуда» и «куда»; места — NULL, вахтовок нет', () => {
    expect(CODE).toMatch(/\('per_hour', 4500, 10\)/);
    expect(CODE).toMatch(/\('per_day', 45000, 20\)/);
    expect(CODE).toMatch(/line_kind IN \('extra_day', 'per_hour', 'per_day'\) AND from_text IS NULL AND to_text IS NULL/);
    expect(CODE).toMatch(/ALTER TABLE transfer_fleet_vehicles ALTER COLUMN seats DROP NOT NULL/);
    expect(CODE).toMatch(/SELECT p\.id, 'minibus', v\.title, NULL/);
    expect(CODE).not.toMatch(/vahtovka/);
  });

  it('вместимости парка «12 и 24» — колонкой перевозчика, без привязки к машине и только в пустое', () => {
    expect(CODE).toMatch(/ALTER TABLE partners ADD COLUMN IF NOT EXISTS fleet_seat_classes INTEGER\[\]/);
    expect(CODE).toMatch(/0 < ALL \(fleet_seat_classes\)/);
    expect(CODE).toMatch(/SET fleet_seat_classes = ARRAY\[12, 24\]\s+WHERE slug = 'zheltukhin' AND fleet_seat_classes IS NULL/);
    // У машин места не выдумываются из вместимостей: каждая — NULL.
    expect(CODE).not.toMatch(/INSERT INTO transfer_fleet_vehicles[\s\S]*?\b(12|24)\b[\s\S]*?FROM partners/);
  });

  it('«проверено» не ставится; лицензия — номер и статус на дату выписки; страхование — со слов', () => {
    expect(CODE).toMatch(/0, 0, FALSE, TRUE, NOW\(\)/);
    expect(CODE).toContain("'number',            'Л022-00112-41/00927020'");
    expect(CODE).toContain("'registryCheckedOn', '2026-05-04'");
    expect(CODE).toContain("'passengerInsurance', 'со слов перевозчика'");
    // company_name не пишется: триггер 052 сделал бы ИП вывеской (урок 1187/1233).
    expect(CODE).not.toMatch(/company_name/);
  });

  it('паспорта и домашнего адреса предпринимателя из выписки в миграции нет', () => {
    expect(SQL).not.toMatch(/3009\s*428733|паспорт\s+гражданина|Вольского|683002/i);
  });

  it('снимки на месте — четыре живых кадра машин, все с нарезкой', () => {
    const variants = JSON.parse(readFileSync(join(ROOT, 'lib/images/photo-variants.json'), 'utf8')) as Array<{ src: string; widths: number[] }>;
    for (const n of ['01', '02', '03', '04']) {
      const url = `/images/zheltukhin/zheltukhin-${n}.jpg`;
      expect(SQL).toContain(url);
      expect(existsSync(join(ROOT, 'public', url))).toBe(true);
      expect(variants.find((v) => v.src === url)?.widths, url).toEqual(expect.arrayContaining([320, 640]));
    }
  });
});

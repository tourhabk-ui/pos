/**
 * Сторож: бронь уходит в U-ON.Travel полями из документации request/create.
 *
 * Документация (https://api.u-on.ru/doc) прочитана 09.10 пробами 747–749 с
 * раннера. До этого дня отправка называла поля, которых там нет: r_tour,
 * r_count_tur, r_price, r_note, tourist[].t_*. А r_dat — дата СОЗДАНИЯ заявки,
 * а не дата тура. Все поля request/create необязательны: U-ON отвечал id, лог
 * писал «успех», а у оператора появлялась пустая заявка.
 *
 * DOCUMENTED — дословная выписка входных полей request/create (верхний уровень).
 * Поле, которого в выписке нет, сторож не пропустит.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

import {
  createUonRequest, uonRequestBody, UON_REQUEST_FIELDS, UON_SOURCE, type UonBookingInput,
} from '@/lib/integrations/uon';

const DOCUMENTED = new Set([
  'r_id_internal', 'r_dat', 'r_dat_lead', 'r_dat_begin', 'r_dat_end', 'r_u_id', 'r_cl_id', 'r_ci_id',
  'r_co_id', 'r_tour_operator_id', 'r_tour_operator_link', 'r_travel_type_id', 'r_reservation_number',
  'status_id', 'status_pay_id', 'country_id', 'city_id', 'hotel_id', 'reason_deny_id', 'visa_id',
  'insurance_id', 'source', 'price', 'price_netto', 'note', 'u_type', 'u_surname', 'u_sname', 'u_name',
  'u_surname_en', 'u_name_en', 'u_phone', 'u_phone_mobile', 'u_email', 'u_password', 'u_note', 'u_sex',
  'u_address', 'u_passport_number', 'u_passport_code', 'u_passport_date', 'u_passport_taken',
  'nationality_id', 'u_birthday', 'u_zagran_number', 'u_zagran_organization', 'u_zagran_given',
  'u_zagran_expire', 'u_company', 'u_address_u', 'u_fax', 'u_inn', 'u_kpp', 'u_ogrn', 'u_okved',
  'u_finance_bank', 'u_finance_rs', 'u_finance_ks', 'u_finance_bik', 'u_finance_okpo',
  'u_discount_card_number', 'u_discount_card_bonus', 'extended_fields', 'utm_source', 'utm_medium',
  'utm_campaign', 'utm_content', 'utm_term', 'tourists', 'services', 'payments',
  'ignore_tourist_notification', 'ignore_manager_notification',
]);

const booking: UonBookingInput = {
  tour_title: 'Вулкан Горелый',
  booking_date: '2027-07-15',
  participants: 3,
  total_price: 45000,
  tourist_name: 'Анна Петрова',
  tourist_phone: '+79000000000',
  tourist_email: 'anna@example.ru',
  special_requests: 'Вегетарианское питание',
  operator_id: 'op-1',
  booking_id: '123',
};

describe('тело request/create', () => {
  it('только поля из документации; дата тура — r_dat_begin, а не r_dat', () => {
    const body = uonRequestBody(booking);
    const keys = [...body.keys()];
    for (const k of keys) expect(DOCUMENTED.has(k), k).toBe(true);
    for (const k of UON_REQUEST_FIELDS) expect(DOCUMENTED.has(k), k).toBe(true);
    expect(keys).not.toContain('r_dat');
    expect(body.get('r_dat_begin')).toBe('2027-07-15 00:00:00');
  });

  it('клиент, цена и источник — в своих полях', () => {
    const body = uonRequestBody(booking);
    expect(body.get('u_name')).toBe('Анна Петрова');
    expect(body.get('u_phone')).toBe('+79000000000');
    expect(body.get('u_email')).toBe('anna@example.ru');
    expect(body.get('price')).toBe('45000');
    expect(body.get('source')).toBe(UON_SOURCE);
  });

  it('тур, дата, участники, пожелания и номер брони — в примечании', () => {
    const note = uonRequestBody(booking).get('note') ?? '';
    expect(note).toContain('бронь № 123');
    expect(note).toContain('Тур: Вулкан Горелый');
    expect(note).toContain('Дата: 15.07.2027');
    expect(note).toContain('Участников: 3');
    expect(note).toContain('Пожелания: Вегетарианское питание');
  });

  it('имя не делится на имя и фамилию догадкой; пустых полей нет', () => {
    const body = uonRequestBody({ ...booking, tourist_name: 'Петрова Анна', tourist_email: undefined, special_requests: '  ' });
    expect(body.get('u_name')).toBe('Петрова Анна');
    expect(body.has('u_surname')).toBe(false);
    expect(body.has('u_email')).toBe(false);
    expect(body.get('note')).not.toContain('Пожелания');
  });

  it('дату не в формате ГГГГ-ММ-ДД не выдаёт за дату начала', () => {
    const body = uonRequestBody({ ...booking, booking_date: '15 июля' });
    expect(body.has('r_dat_begin')).toBe(false);
    expect(body.get('note')).toContain('Дата: 15 июля');
  });
});

describe('запрос к U-ON', () => {
  const fetchMock = vi.fn();
  beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('POST формой на request/create.json, id заявки из ответа', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ result: 200, id: 555 }), { status: 200 }));
    await expect(createUonRequest('k3y', booking)).resolves.toBe(555);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.u-on.ru/k3y/request/create.json');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded');
    const sent = new URLSearchParams(String(init.body));
    expect(sent.get('u_phone')).toBe('+79000000000');
    expect(sent.get('r_dat_begin')).toBe('2027-07-15 00:00:00');
    for (const k of sent.keys()) expect(DOCUMENTED.has(k), k).toBe(true);
  });

  it('ошибка U-ON — исключение, а не тихий null', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'bad key' }), { status: 200 }));
    await expect(createUonRequest('k3y', booking)).rejects.toThrow('U-ON error: bad key');
  });
});

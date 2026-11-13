// @vitest-environment node
/**
 * Добивка лидов не отдаёт заявку на машину и на прокат чужому партнёру
 * (#2447; прокат — 23.10) — вызовом обработчика, а не чтением SQL.
 *
 * Заявка на машину (`request_charter`, форма на /transfers/[slug]) адресована
 * перевозчику, и согласие человека — на «передачу перевозчику». До 13.10 крон
 * через 2 часа без ответа отдавал её туроператору: по интересам или любому с
 * мессенджером. Держится двумя замками: выборка её не берёт (SQL проверен на
 * настоящем PostgreSQL), а цикл пропускает, даже если выборку поправят, —
 * этот второй замок и проверяется здесь: подменённый пул отдаёт заявку на
 * машину, и имя с телефоном не уходят никому.
 *
 * Адресованную заявку на тур не берёт уже сам отбор (`operator_id IS NULL`,
 * решение владельца 13.10 «да, только без адресата») — его судит
 * tests/integration/leads-followup.pg.test.ts на настоящем PostgreSQL; лид без
 * адресата по-прежнему уходит следующему оператору.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const queryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => queryMock(...a) } }));
const alertMock = vi.fn();
vi.mock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: (...a: unknown[]) => alertMock(...a) }));
vi.mock('@/lib/crm/events', () => ({ recordSourceEventQuietly: vi.fn(), statusChangeTitle: () => 'смена статуса' }));
vi.mock('@/lib/config', () => ({ getPublicBaseUrl: () => 'https://vedarai.ru' }));

import { GET } from '@/app/api/cron/leads-followup/route';
import { recordSourceEventQuietly } from '@/lib/crm/events';
import { PD_CONSENT_CARRIER_VERSION, PD_CONSENT_RENTAL_VERSION } from '@/lib/legal/pd-consent';
import { addressedToPartnerOnly, FOLLOWUP_LEADS_SQL, FOLLOWUP_LEADS_PARAMS } from '@/lib/leads/followup-scope';

const CHARTER = { id: 'l-charter', name: 'Иван Машинов', phone: '+79990000001', source_data: { kind: 'charter', carrier_slug: 'shatun' }, pd_consent_version: PD_CONSENT_CARRIER_VERSION };
const CONSENT_ONLY = { id: 'l-consent', name: 'Пётр Согласов', phone: '+79990000002', source_data: {}, pd_consent_version: PD_CONSENT_CARRIER_VERSION };
// Заявка на прокат автомобиля (23.10): адресат — прокатчик, согласие «прокату автомобилей».
const RENTAL = { id: 'l-rental', name: 'Олег Арендов', phone: '+79990000004', source_data: { kind: 'car_rental', company_slug: 'laguna' }, pd_consent_version: PD_CONSENT_RENTAL_VERSION };
const RENTAL_CONSENT_ONLY = { id: 'l-rental-consent', name: 'Зоя Прокатова', phone: '+79990000005', source_data: {}, pd_consent_version: PD_CONSENT_RENTAL_VERSION };
const TRIP_PART = { id: 'l-trip', name: 'Вера Поездкина', phone: '+79990000006', source_data: { source: 'mcp', kind: 'trip_manager', trip_id: 'TRIP-abc123', trip_parts: ['transfer'] }, pd_consent_version: '2026-10-08' };
const PLAIN = { id: 'l-plain', name: 'Анна Обычная', phone: '+79990000003', source_data: { interests: ['volcano'] }, pd_consent_version: '2026-09-01' };
// Большая группа, от которой отказался адресат: крон сначала делает её ничейной, потом передаёт следующему.
const GROUP = { id: 'l-group', name: 'Глеб Группов', phone: '+79990000007', source_data: { interests: ['volcano'], group_over_seats: true }, pd_consent_version: '2026-09-01', addressee_slug: 'first-op' };
const OPERATOR = { id: '7f3b2c1a-0000-4000-8000-000000000001', name: 'Туроператор', slug: 'tour-op', telegram_chat_id: null, user_telegram_id: null, max_chat_id: '555' };

let leadsParams: unknown[] | undefined;
/** Заявки, которые клиент отменил между выборкой и передачей. */
const cancelledMeanwhile = new Set<string>();
/** Что отдаёт выборка крона; по умолчанию — набор первого теста. */
let selected: unknown[] = [];
/** Заявки, которые клиент отменил между повторной сверкой и записью «ничейная». */
const cancelledAtFree = new Set<string>();
/** Операторов для передачи нет — заявка уходит менеджеру. */
let noOperators = false;
/** Заявки, которые клиент отменил между сверкой и записью эскалации. */
const cancelledAtEscalation = new Set<string>();
const savedSecret = process.env.CRON_SECRET;

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret';
  leadsParams = undefined;
  cancelledMeanwhile.clear();
  cancelledAtFree.clear();
  cancelledAtEscalation.clear();
  noOperators = false;
  vi.mocked(recordSourceEventQuietly).mockClear();
  selected = [CHARTER, CONSENT_ONLY, RENTAL, RENTAL_CONSENT_ONLY, TRIP_PART, PLAIN];
  alertMock.mockReset();
  alertMock.mockResolvedValue({ delivered: true, channel: 'max' });
  queryMock.mockReset();
  queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql === FOLLOWUP_LEADS_SQL) {
      leadsParams = params;
      // Пул «пропустил» заявки на машину и на прокат — проверяется второй замок, в цикле.
      return { rows: selected };
    }
    // Запись «заявка ничейная»: условие на статус — отмену клиента она не затирает (1427).
    if (/UPDATE leads SET operator_id = NULL, status = 'new'/.test(sql)) {
      return { rows: [], rowCount: cancelledAtFree.has(String(params?.[0])) ? 0 : 1 };
    }
    if (/COUNT\(\*\) AS total/.test(sql)) return { rows: [{ total: '1', with_telegram: '0', with_max: '1' }] };
    if (/FROM partners p/.test(sql)) return { rows: noOperators ? [] : [OPERATOR] };
    // Эскалация менеджеру: «связались» с условием на статус (1427).
    if (/SET status\s+= 'contacted'/.test(sql)) return { rows: [], rowCount: cancelledAtEscalation.has(String(params?.[1])) ? 0 : 1 };
    // Повторная сверка перед передачей (1427): заявку за время прогона не отменил клиент.
    if (/SELECT TRUE AS ok FROM leads/.test(sql)) return { rows: cancelledMeanwhile.has(String(params?.[0])) ? [] : [{ ok: true }] };
    return { rows: [] };
  });
});
afterEach(() => {
  if (savedSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = savedSecret;
});

const call = () => GET(new NextRequest('https://vedarai.ru/api/cron/leads-followup', {
  headers: { authorization: 'Bearer test-secret' },
}));

describe('добивка лидов и заявка на машину', () => {
  it('заявка на машину и на прокат не уходит никому; обычный лид — следующему оператору', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const json = await res.json() as { processed: number };
    expect(json.processed).toBe(1);

    // Выборка спрошена с версиями согласия «перевозчику» и «прокату автомобилей» — их она и исключает.
    expect(leadsParams).toEqual([PD_CONSENT_CARRIER_VERSION, PD_CONSENT_RENTAL_VERSION]);
    expect([...FOLLOWUP_LEADS_PARAMS]).toEqual(leadsParams);

    expect(alertMock).toHaveBeenCalledTimes(1);
    const sent = JSON.stringify(alertMock.mock.calls);
    expect(sent).toContain('Анна Обычная');
    expect(sent).not.toMatch(/Иван Машинов|Пётр Согласов|Олег Арендов|Зоя Прокатова|Вера Поездкина|\+7999000000[12456]/);
    expect(alertMock.mock.calls[0]![0]).toMatchObject({ to: { maxChatId: '555' } });

    // Заявки на машину и на прокат не помечены как добитые и не эскалированы: их ведёт менеджер.
    const updates = queryMock.mock.calls.filter(([sql]) => /UPDATE leads/.test(String(sql)));
    expect(updates.map(([, params]) => (params as unknown[])[1])).toEqual(['l-plain']);
  });

  it('клиент отменил заявку, пока прогон шёл по списку, — её имя и телефон никому не уходят и статус не трогается (1427)', async () => {
    cancelledMeanwhile.add('l-plain');
    const res = await call();
    expect(res.status).toBe(200);
    expect((await res.json() as { processed: number }).processed).toBe(0);
    expect(alertMock).not.toHaveBeenCalled();
    expect(queryMock.mock.calls.filter(([sql]) => /UPDATE leads/.test(String(sql)))).toHaveLength(0);
    // Сверка спрашивает именно статус «отменена клиентом».
    const probe = queryMock.mock.calls.find(([sql]) => /SELECT TRUE AS ok FROM leads/.test(String(sql)));
    expect(probe?.[1]).toEqual(['l-plain', 'cancelled']);
  });

  it('большая группа после отказа адресата: «ничейной» её делает запись с условием на статус; отменил клиент в этот миг — никому не уходит (1427)', async () => {
    selected = [GROUP];
    let res = await call();
    expect((await res.json() as { processed: number }).processed).toBe(1);
    const free = queryMock.mock.calls.find(([sql]) => /UPDATE leads SET operator_id = NULL, status = 'new'/.test(String(sql)));
    expect(String(free?.[0])).toMatch(/WHERE id = \$1 AND status <> \$4/);
    expect((free?.[1] as unknown[])[0]).toBe('l-group');
    expect((free?.[1] as unknown[])[3]).toBe('cancelled');
    expect(alertMock).toHaveBeenCalledTimes(1);

    // Клиент отменил между сверкой и записью: строка не обновилась — заявку не передаём.
    alertMock.mockClear();
    queryMock.mockClear();
    cancelledAtFree.add('l-group');
    res = await call();
    expect((await res.json() as { processed: number }).processed).toBe(0);
    expect(alertMock).not.toHaveBeenCalled();
    expect(queryMock.mock.calls.filter(([sql]) => /UPDATE leads/.test(String(sql)))).toHaveLength(1);
  });

  it('эскалация менеджеру: «связались» ставится с условием на статус, событие в ленту — только если статус правда сменился (1427)', async () => {
    selected = [PLAIN];
    noOperators = true;
    await call();
    const esc = queryMock.mock.calls.find(([sql]) => /SET status\s+= 'contacted'/.test(String(sql)));
    expect(String(esc?.[0])).toMatch(/WHERE id = \$2 AND status <> \$3/);
    expect((esc?.[1] as unknown[])[2]).toBe('cancelled');
    expect(vi.mocked(recordSourceEventQuietly)).toHaveBeenCalledTimes(1);

    // Клиент отменил в этот миг: строка не обновилась — события «новая → связались» нет.
    vi.mocked(recordSourceEventQuietly).mockClear();
    cancelledAtEscalation.add('l-plain');
    await call();
    expect(vi.mocked(recordSourceEventQuietly)).not.toHaveBeenCalled();
  });

  it('отказ базы — 500 и след в логе с SQLSTATE, а не «лидов нет»', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    queryMock.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: '57P01' }));
    const res = await call();
    expect(res.status).toBe(500);
    expect(String(spy.mock.calls[0]?.[0])).toMatch(/\[leads-followup\].*sqlstate=57P01/);
    expect(alertMock).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('выборка добивки — первый замок', () => {
  // SQL — артефакт, и его судят по смыслу гейта (CLAUDE.md, «Сторож судит
  // поведение»): заявка на машину, заявка на прокат и согласия «перевозчику» и
  // «прокату автомобилей» в выборку не входят. Что сервер такой запрос
  // принимает и отбирает верно, проверено на настоящем PostgreSQL
  // (leads-followup.pg, car-rental.pg).
  it('исключает заявку на машину и на прокат по роду и по версии согласия', () => {
    expect(FOLLOWUP_LEADS_SQL).toMatch(/COALESCE\(source_data->>'kind', ''\) <> 'charter'/);
    expect(FOLLOWUP_LEADS_SQL).toMatch(/COALESCE\(source_data->>'kind', ''\) <> 'car_rental'/);
    // Часть поездки, которую ведёт менеджер (разбор 06.11).
    expect(FOLLOWUP_LEADS_SQL).toMatch(/COALESCE\(source_data->>'kind', ''\) <> 'trip_manager'/);
    expect(FOLLOWUP_LEADS_SQL).toMatch(/COALESCE\(pd_consent_version, ''\) <> \$1/);
    expect(FOLLOWUP_LEADS_SQL).toMatch(/COALESCE\(pd_consent_version, ''\) <> \$2/);
  });
});

describe('addressedToPartnerOnly', () => {
  it('заявка на машину или на прокат, согласие «перевозчику» или «прокату» — адресована одному партнёру; прочее — нет', () => {
    expect(addressedToPartnerOnly({ kind: 'charter' }, null)).toBe(true);
    expect(addressedToPartnerOnly({}, PD_CONSENT_CARRIER_VERSION)).toBe(true);
    expect(addressedToPartnerOnly({ kind: 'car_rental' }, null)).toBe(true);
    expect(addressedToPartnerOnly({}, PD_CONSENT_RENTAL_VERSION)).toBe(true);
    expect(addressedToPartnerOnly({ kind: 'trip_manager' }, '2026-10-08')).toBe(true);
    expect(addressedToPartnerOnly({ kind: 'tour' }, '2026-09-01')).toBe(false);
    expect(addressedToPartnerOnly({ kind: 42 }, null)).toBe(false);
    expect(addressedToPartnerOnly(null, null)).toBe(false);
  });
});

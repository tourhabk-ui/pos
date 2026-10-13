// @vitest-environment node
/**
 * Добивка лидов не отдаёт заявку на машину чужому партнёру (#2447) — вызовом
 * обработчика, а не чтением SQL.
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
import { PD_CONSENT_CARRIER_VERSION } from '@/lib/legal/pd-consent';
import { addressedToCarrier, FOLLOWUP_LEADS_SQL } from '@/lib/leads/followup-scope';

const CHARTER = { id: 'l-charter', name: 'Иван Машинов', phone: '+79990000001', source_data: { kind: 'charter', carrier_slug: 'shatun' }, pd_consent_version: PD_CONSENT_CARRIER_VERSION };
const CONSENT_ONLY = { id: 'l-consent', name: 'Пётр Согласов', phone: '+79990000002', source_data: {}, pd_consent_version: PD_CONSENT_CARRIER_VERSION };
const PLAIN = { id: 'l-plain', name: 'Анна Обычная', phone: '+79990000003', source_data: { interests: ['volcano'] }, pd_consent_version: '2026-09-01' };
const OPERATOR = { name: 'Туроператор', slug: 'tour-op', telegram_chat_id: null, user_telegram_id: null, max_chat_id: '555' };

let leadsParams: unknown[] | undefined;
const savedSecret = process.env.CRON_SECRET;

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret';
  leadsParams = undefined;
  alertMock.mockReset();
  alertMock.mockResolvedValue({ delivered: true, channel: 'max' });
  queryMock.mockReset();
  queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql === FOLLOWUP_LEADS_SQL) {
      leadsParams = params;
      // Пул «пропустил» заявки на машину — проверяется второй замок, в цикле.
      return { rows: [CHARTER, CONSENT_ONLY, PLAIN] };
    }
    if (/COUNT\(\*\) AS total/.test(sql)) return { rows: [{ total: '1', with_telegram: '0', with_max: '1' }] };
    if (/FROM partners p/.test(sql)) return { rows: [OPERATOR] };
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
  it('заявка на машину не уходит никому; обычный лид — следующему оператору', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const json = await res.json() as { processed: number };
    expect(json.processed).toBe(1);

    // Выборка спрошена с версией согласия «перевозчику» — её она и исключает.
    expect(leadsParams).toEqual([PD_CONSENT_CARRIER_VERSION]);

    expect(alertMock).toHaveBeenCalledTimes(1);
    const sent = JSON.stringify(alertMock.mock.calls);
    expect(sent).toContain('Анна Обычная');
    expect(sent).not.toMatch(/Иван Машинов|Пётр Согласов|\+79990000001|\+79990000002/);
    expect(alertMock.mock.calls[0]![0]).toMatchObject({ to: { maxChatId: '555' } });

    // Заявки на машину не помечены как добитые и не эскалированы: их ведёт менеджер.
    const updates = queryMock.mock.calls.filter(([sql]) => /UPDATE leads/.test(String(sql)));
    expect(updates.map(([, params]) => (params as unknown[])[1])).toEqual(['l-plain']);
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
  // поведение»): заявка на машину и согласие «перевозчику» в выборку не входят.
  // Что сервер такой запрос принимает и отбирает верно, проверено на
  // настоящем PostgreSQL при правке (13.10).
  it('исключает заявку на машину по роду и по версии согласия', () => {
    expect(FOLLOWUP_LEADS_SQL).toMatch(/COALESCE\(source_data->>'kind', ''\) <> 'charter'/);
    expect(FOLLOWUP_LEADS_SQL).toMatch(/COALESCE\(pd_consent_version, ''\) <> \$1/);
  });
});

describe('addressedToCarrier', () => {
  it('заявка на машину или согласие «перевозчику» — адресована перевозчику; прочее — нет', () => {
    expect(addressedToCarrier({ kind: 'charter' }, null)).toBe(true);
    expect(addressedToCarrier({}, PD_CONSENT_CARRIER_VERSION)).toBe(true);
    expect(addressedToCarrier({ kind: 'tour' }, '2026-09-01')).toBe(false);
    expect(addressedToCarrier(null, null)).toBe(false);
  });
});

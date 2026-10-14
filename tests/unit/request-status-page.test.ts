// @vitest-environment node
/**
 * Страница заявки для человека — вторая половина ступени 1 агентного контура
 * (#2371, 12.10).
 *
 * Держит связку целиком, а не половину (§10.09): ссылка в ответе пишущего
 * инструмента ведёт на существующую страницу; ключ живёт во фрагменте и не
 * попадает ни в путь, ни в параметры страницы; оба роута открыты на Edge ровно
 * теми методами, что нужны; согласие человека — та же галочка, что на сайте,
 * уходит состоянием, пишется источником request-page и видно агенту полем
 * consent; ПД ни на странице, ни в ответах роутов нет; долг в шапке
 * write-guard указывает на этот мост, а не на будущее.
 *
 * Роуты — вызовом (14.10): что уходит человеку и какой версией пишется
 * согласие, решает ответ роута, а не строка в его исходнике. Версия — по роду
 * заявки: жильё — владельцу, машина — перевозчику, остальное — туроператору.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query } }));

import { isPublicApiPath } from '@/lib/auth/public-api-routes';
import { REQUEST_STATUS_PAGE_PATH, HUMAN_CONSENT_SOURCE, AGENT_CONSENT_SOURCE, keyLine, requestStatusPageUrl } from '@/lib/mcp/request-status';
import { GET_REQUEST_STATUS_TOOL } from '@/lib/mcp/request-status-schema';
import { CREATE_LEAD_TOOL, STAY_REQUEST_TOOL, REQUEST_CHARTER_TOOL } from '@/lib/mcp/public-tools';
import { PD_CONSENT_VERSION, PD_CONSENT_STAY_VERSION, PD_CONSENT_CARRIER_VERSION } from '@/lib/legal/pd-consent';
import { GET as statusGET } from '@/app/api/requests/status/route';
import { POST as consentPOST } from '@/app/api/requests/consent/route';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const PAGE = read('app/request-status/page.tsx');
const CLIENT = read('app/request-status/_RequestStatusClient.tsx');
const STATUS_ROUTE = read('app/api/requests/status/route.ts');
const CONSENT_ROUTE = read('app/api/requests/consent/route.ts');
const WRITE_GUARD = read('lib/mcp/write-guard.ts');
const KEY = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345';

/** Строка запроса статуса для заявки на жильё — в форме, которую отдаёт REQUEST_STATUS_SQL. */
const STAY_ROW = {
  tool_name: 'create_stay_request', lead_id: null, seat_request_id: null, stay_request_id: 'SR',
  lead_status: null, route_title: null, booking_status: null, booking_date: null, booking_participants: null, booking_tour: null,
  seat_status: null, deadline_at: null, answered_at: null, seat_date: null, seat_participants: null, alt_date: null, failure_kind: null, seat_tour: null,
  stay_accommodation_id: '3b2551c7-ed5c-47c8-bb93-41ca6a278c1e', stay_name: 'Кутха',
  stay_check_in: '2027-07-10', stay_check_out: '2027-07-12', stay_guests: 9,
  stay_owner_channel: 'max', stay_platform_channel: 'max', stay_delivery_recorded_at: new Date(),
  stay_consent_at: new Date(), stay_consent_source: 'mcp',
};

let ipSeq = 0;
/** Свой адрес на каждый вызов: ограничитель частоты по IP — не предмет этих проверок. */
function headers(): Record<string, string> {
  ipSeq += 1;
  return { 'content-type': 'application/json', 'x-real-ip': `10.77.${Math.floor(ipSeq / 250)}.${ipSeq % 250}` };
}
const getStatus = (k: string) => statusGET(new NextRequest(`http://localhost/api/requests/status?k=${encodeURIComponent(k)}`, { headers: headers() }));
const postConsent = (body: unknown) => consentPOST(new NextRequest('http://localhost/api/requests/consent', {
  method: 'POST', headers: headers(), body: JSON.stringify(body),
}));

beforeEach(() => { query.mockReset(); });

describe('страница и ссылка', () => {
  it('ссылка из ответа инструмента ведёт на существующую страницу, закрытую от индексации', () => {
    expect(existsSync(join(ROOT, 'app', REQUEST_STATUS_PAGE_PATH, 'page.tsx'))).toBe(true);
    expect(keyLine(KEY)).toContain(requestStatusPageUrl(KEY));
    expect(requestStatusPageUrl(KEY)).toMatch(new RegExp(`${REQUEST_STATUS_PAGE_PATH}#${KEY}$`));
    expect(PAGE).toMatch(/index:\s*false/);
    expect(PAGE).toContain('RequestStatusClient');
  });

  it('ключ — во фрагменте адреса, не в пути и не в параметрах страницы', () => {
    expect(CLIENT).toContain('window.location.hash');
    expect(CLIENT).not.toMatch(/useSearchParams|useParams|searchParams/);
    expect(existsSync(join(ROOT, 'app', REQUEST_STATUS_PAGE_PATH, '[key]'))).toBe(false);
    // Смена фрагмента без перезагрузки — другая заявка, не прежняя.
    expect(CLIENT).toContain("addEventListener('hashchange'");
  });

  it('пока заявка ждёт оператора — страница переспрашивает сама; «не найдена» и «повреждена» окончательны', () => {
    expect(CLIENT).toMatch(/view\?\.state === 'awaiting_operator'/);
    expect(CLIENT).toMatch(/res\.status === 400 \|\| res\.status === 404/);
  });
});

describe('роуты', () => {
  it('открыты на Edge ровно нужными методами', () => {
    expect(isPublicApiPath('/api/requests/status', 'GET')).toBe(true);
    expect(isPublicApiPath('/api/requests/consent', 'POST')).toBe(true);
    expect(isPublicApiPath('/api/requests/consent', 'DELETE')).toBe(false);
    expect(isPublicApiPath('/api/requests/status', 'PUT')).toBe(false);
  });

  it('частота по IP и третий исход: база не ответила — 503, ключа нет — 404, не той формы — 400', () => {
    for (const src of [STATUS_ROUTE, CONSENT_ROUTE]) {
      expect(src).toContain('createRateLimiter(');
      expect(src).toContain('status: 503');
      expect(src).toContain("err.code === 'key_not_found' ? 404 : 400");
      expect(src).toContain("export const dynamic = 'force-dynamic'");
    }
  });

  it('человеку отдаются состояние, заявка и согласие — без подсказок агенту (next, page) и без ПД', async () => {
    query.mockResolvedValue({ rows: [{ ...STAY_ROW }] });
    const res = await getStatus(KEY);
    expect(res.status).toBe(200);
    const { data } = await res.json() as { data: Record<string, unknown> };
    expect(Object.keys(data).sort()).toEqual([
      'accommodation', 'accommodation_url', 'alt_date', 'check_out', 'consent', 'consent_purpose', 'date', 'deadline',
      'human', 'kind', 'participants', 'state', 'tour',
    ]);
    expect(data).toMatchObject({ state: 'delivered', kind: 'stay_request', accommodation: 'Кутха', consent_purpose: 'stay' });
    for (const src of [STATUS_ROUTE, CONSENT_ROUTE, CLIENT]) {
      expect(src).not.toMatch(/tourist_name|tourist_phone|guest_name|guest_phone|\bphone\b|\bemail\b|lead_id/);
    }
  });

  it('статус: ключа нет — 404, не той формы — 400, база не ответила — 503', async () => {
    query.mockResolvedValue({ rows: [] });
    expect((await getStatus(KEY)).status).toBe(404);
    expect((await getStatus('short')).status).toBe(400);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    query.mockRejectedValue(Object.assign(new Error('boom'), { code: '57P01' }));
    expect((await getStatus(KEY)).status).toBe(503);
    spy.mockRestore();
  });
});

describe('согласие человека', () => {
  it('та же галочка, что на сайте; состояние уходит в тело; кнопка заперта без галочки', () => {
    expect(CLIENT).toContain('PdConsentCheckbox');
    expect(CLIENT).toMatch(/pd_consent:\s*pdConsent/);
    expect(CLIENT).not.toMatch(/pd_consent:\s*true\b/);
    expect(CLIENT).toMatch(/disabled=\{[^}]*!pdConsent/);
  });

  it('без галочки и с галочкой не той формы — 400, и база не спрошена', async () => {
    expect((await postConsent({ key: KEY, pd_consent: false })).status).toBe(400);
    expect((await postConsent({ key: KEY, pd_consent: 'да' })).status).toBe(400);
    expect((await postConsent({ key: KEY })).status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('сервер пишет согласие источником request-page той версией, кому уходят данные заявки', async () => {
    expect(HUMAN_CONSENT_SOURCE).toBe('request-page');
    expect(HUMAN_CONSENT_SOURCE).not.toBe(AGENT_CONSENT_SOURCE);
    const cases: Array<[string, string]> = [
      [STAY_REQUEST_TOOL.name, PD_CONSENT_STAY_VERSION],
      // До 14.10 здесь писалась версия «туроператору» и затирала версию перевозчика.
      [REQUEST_CHARTER_TOOL.name, PD_CONSENT_CARRIER_VERSION],
      [CREATE_LEAD_TOOL.name, PD_CONSENT_VERSION],
    ];
    for (const [tool, version] of cases) {
      query.mockReset()
        .mockResolvedValueOnce({ rows: [{ tool_name: tool }] })
        .mockResolvedValueOnce({ rows: [{ updated: 1, prior_source: AGENT_CONSENT_SOURCE, target_exists: true }] });
      const res = await postConsent({ key: KEY, pd_consent: true });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true, data: { consent: 'human', recorded: true } });
      const params = query.mock.calls[1][1] as unknown[];
      expect({ tool, written: params.slice(3) }).toEqual({ tool, written: [HUMAN_CONSENT_SOURCE, version] });
    }
  });

  it('согласие: ключа нет — 404 и записи нет; заявка удалена — 404; база не ответила — 503', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect((await postConsent({ key: KEY, pd_consent: true })).status).toBe(404);
    expect(query).toHaveBeenCalledTimes(1);

    query.mockReset()
      .mockResolvedValueOnce({ rows: [{ tool_name: STAY_REQUEST_TOOL.name }] })
      .mockResolvedValueOnce({ rows: [{ updated: 0, prior_source: null, target_exists: false }] });
    expect((await postConsent({ key: KEY, pd_consent: true })).status).toBe(404);

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    query.mockReset().mockRejectedValue(Object.assign(new Error('boom'), { code: '57P01' }));
    expect((await postConsent({ key: KEY, pd_consent: true })).status).toBe(503);
    spy.mockRestore();
  });

  it('реестр согласия знает и форму, и роут — четвёртая копия не заведётся молча', () => {
    const registry = read('tests/unit/pd-consent-registry.test.ts');
    expect(registry).toContain("'app/request-status/_RequestStatusClient.tsx'");
    expect(registry).toContain("'app/api/requests/consent/route.ts'");
  });

  it('агент видит чьё согласие стоит и куда вести человека', () => {
    const props = GET_REQUEST_STATUS_TOOL.outputSchema.properties;
    expect(props.consent.enum).toEqual(['human', 'agent', 'none']);
    expect(props.page.type).toBe('string');
    expect(GET_REQUEST_STATUS_TOOL.outputSchema.required).toEqual(expect.arrayContaining(['consent', 'page']));
    expect(GET_REQUEST_STATUS_TOOL.description).toContain('page');
  });

  it('долг в шапке write-guard указывает на мост, а не на будущее', () => {
    expect(WRITE_GUARD).toContain(REQUEST_STATUS_PAGE_PATH);
    expect(WRITE_GUARD).toContain(HUMAN_CONSENT_SOURCE);
    expect(WRITE_GUARD).toContain('confirmConsent');
    expect(WRITE_GUARD).not.toContain('когда появится первый внешний клиент');
  });
});

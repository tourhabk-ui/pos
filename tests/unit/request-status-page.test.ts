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
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));

import { isPublicApiPath } from '@/lib/auth/public-api-routes';
import { REQUEST_STATUS_PAGE_PATH, HUMAN_CONSENT_SOURCE, AGENT_CONSENT_SOURCE, keyLine, requestStatusPageUrl } from '@/lib/mcp/request-status';
import { GET_REQUEST_STATUS_TOOL } from '@/lib/mcp/request-status-schema';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const PAGE = read('app/request-status/page.tsx');
const CLIENT = read('app/request-status/_RequestStatusClient.tsx');
const STATUS_ROUTE = read('app/api/requests/status/route.ts');
const CONSENT_ROUTE = read('app/api/requests/consent/route.ts');
const WRITE_GUARD = read('lib/mcp/write-guard.ts');
const KEY = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345';

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

  it('человеку отдаются состояние и согласие — без подсказок агенту (next, page) и без ПД', () => {
    expect(STATUS_ROUTE).toContain('data: { state, kind, tour, date, participants, alt_date, deadline, human, consent }');
    for (const src of [STATUS_ROUTE, CONSENT_ROUTE, CLIENT]) {
      expect(src).not.toMatch(/tourist_name|tourist_phone|\bphone\b|\bemail\b|lead_id/);
    }
  });
});

describe('согласие человека', () => {
  it('та же галочка, что на сайте; состояние уходит в тело; кнопка заперта без галочки', () => {
    expect(CLIENT).toContain('PdConsentCheckbox');
    expect(CLIENT).toMatch(/pd_consent:\s*pdConsent/);
    expect(CLIENT).not.toMatch(/pd_consent:\s*true\b/);
    expect(CLIENT).toMatch(/disabled=\{[^}]*!pdConsent/);
  });

  it('сервер собирает запись согласия источником request-page и доводит её до базы', () => {
    expect(CONSENT_ROUTE).toContain('buildConsentRecord(parsed.data.pd_consent, ip, HUMAN_CONSENT_SOURCE)');
    expect(CONSENT_ROUTE).toContain('confirmConsent(parsed.data.key, consent)');
    expect(CONSENT_ROUTE).toContain('pd_consent: z.boolean()');
    expect(HUMAN_CONSENT_SOURCE).toBe('request-page');
    expect(HUMAN_CONSENT_SOURCE).not.toBe(AGENT_CONSENT_SOURCE);
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

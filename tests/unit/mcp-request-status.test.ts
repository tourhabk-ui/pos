// @vitest-environment node
/**
 * get_request_status — состояние заявки для агента по ключу (ступень 1
 * агентного контура #2371, 12.10; миграция 1220).
 *
 * Держит: инструмент в публичном реестре с английским слоем и подсказкой
 * «читает»; ключ выдаётся на каждый вызов пишущего инструмента и в базу
 * уходит только его хеш (срок — без конкатенации интервала); словарь
 * состояний закрытый и одинаковый у лида и запроса мест; в ответе нет ни
 * имени, ни телефона, ни номера лида, ни ссылки на бронь; чужой ключ — отказ
 * по входу с объяснением, база не ответила — исключение, не «ждёт оператора»
 * (§4.0); роут выдаёт ключ во всех четырёх ответах пишущих инструментов и
 * диспетчеризует инструмент сам.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query } }));

import {
  GET_REQUEST_STATUS_TOOL, REQUEST_STATUS_TOOL_NAME, issueRequestKey, keyLine, readRequestStatus, runRequestStatusTool,
  leadState, seatState, REQUEST_KEY_TTL_DAYS, REQUEST_STATUS_SQL,
  consentBy, confirmConsent, CONFIRM_CONSENT_SQL, AGENT_CONSENT_SOURCE, HUMAN_CONSENT_SOURCE, requestStatusPageUrl, REQUEST_STATUS_PAGE_PATH,
} from '@/lib/mcp/request-status';
import { REQUEST_STATES, REQUEST_KEY_MIN_CHARS } from '@/lib/mcp/request-status-schema';
import { PUBLIC_MCP_TOOLS, TOOL_ANNOTATIONS, TOOL_ENGLISH, PARAM_ENGLISH, WRITE_TOOL_NAMES } from '@/lib/mcp/public-tools';
import { McpUserError } from '@/lib/mcp/jsonrpc';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const ROUTE = read('app/api/mcp/route.ts');
const KEY = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345';

beforeEach(() => { query.mockReset(); });

describe('объявление', () => {
  it('в публичном реестре, читает, с английским слоем и подсказкой параметра', () => {
    const tool = PUBLIC_MCP_TOOLS.find((t) => t.name === REQUEST_STATUS_TOOL_NAME);
    expect(tool).toBeDefined();
    expect(tool!.annotations?.readOnlyHint).toBe(true);
    expect(TOOL_ANNOTATIONS[REQUEST_STATUS_TOOL_NAME]?.readOnlyHint).toBe(true);
    expect(WRITE_TOOL_NAMES.has(REQUEST_STATUS_TOOL_NAME)).toBe(false);
    expect(TOOL_ENGLISH[REQUEST_STATUS_TOOL_NAME]?.lead).toMatch(/No personal data/);
    expect(PARAM_ENGLISH[REQUEST_STATUS_TOOL_NAME]?.key?.lead).toMatch(/key/i);
    expect(GET_REQUEST_STATUS_TOOL.inputSchema.required).toEqual(['key']);
    expect(GET_REQUEST_STATUS_TOOL.outputSchema.properties.state.enum).toEqual([...REQUEST_STATES]);
  });

  it('описание называет все три пишущих инструмента и срок ключа — иначе агент не знает, откуда ключ', () => {
    for (const w of ['create_lead', 'create_booking_request', 'request_charter']) expect(GET_REQUEST_STATUS_TOOL.description).toContain(w);
    expect(GET_REQUEST_STATUS_TOOL.description).toContain(`${REQUEST_KEY_TTL_DAYS} дней`);
  });
});

describe('выдача ключа', () => {
  it('в базу — хеш, не ключ; срок — умножением интервала, не конкатенацией; ключ достаточно длинный', async () => {
    query.mockResolvedValue({ rows: [] });
    const key = await issueRequestKey({ leadId: '11111111-1111-1111-1111-111111111111' }, 'create_lead');
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(key!.length).toBeGreaterThanOrEqual(REQUEST_KEY_MIN_CHARS);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('INSERT INTO agent_request_keys');
    expect(sql).toContain("INTERVAL '1 day'");
    expect(sql).not.toMatch(/\|\|/);
    expect(params[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(params[0]).not.toBe(key);
    expect(params).toEqual([params[0], '11111111-1111-1111-1111-111111111111', null, 'create_lead', REQUEST_KEY_TTL_DAYS]);
  });

  it('база отказала — null и SQLSTATE в логе, заявка не страдает', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    query.mockRejectedValue(Object.assign(new Error('relation missing'), { code: '42P01' }));
    expect(await issueRequestKey({ seatRequestId: '22222222-2222-2222-2222-222222222222' }, 'create_booking_request')).toBeNull();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('ключ не выдан'), 'create_booking_request', expect.stringContaining('42P01'), expect.any(String));
    spy.mockRestore();
  });

  it('хвост ответа: с ключом — как спросить статус, без ключа — что ключа нет', () => {
    expect(keyLine(KEY)).toContain(KEY);
    expect(keyLine(KEY)).toContain('get_request_status');
    // Ссылка человеку — та же страница, что в page ответа; ключ во фрагменте, не в пути.
    expect(keyLine(KEY)).toContain(`${REQUEST_STATUS_PAGE_PATH}#${KEY}`);
    expect(keyLine(KEY)).toContain(requestStatusPageUrl(KEY));
    expect(keyLine(null)).toMatch(/не выдан/);
    expect(keyLine(null)).not.toContain('get_request_status');
    expect(keyLine(null)).not.toContain(REQUEST_STATUS_PAGE_PATH);
  });
});

describe('чтение состояния', () => {
  it('кривой ключ — отказ по входу без запроса к базе', async () => {
    await expect(readRequestStatus('short')).rejects.toBeInstanceOf(McpUserError);
    await expect(readRequestStatus('a'.repeat(200))).rejects.toBeInstanceOf(McpUserError);
    await expect(readRequestStatus(undefined)).rejects.toBeInstanceOf(McpUserError);
    expect(query).not.toHaveBeenCalled();
  });

  it('ключ не найден или истёк — отказ с объяснением; запрос отмечает прочтение только живых ключей', async () => {
    query.mockResolvedValue({ rows: [] });
    await expect(readRequestStatus(KEY)).rejects.toThrow(/не найден или истёк/);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('expires_at > NOW()');
    expect(sql).toContain('read_count = read_count + 1');
    expect(params[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('лид: new → ждёт оператора; бронь по лиду важнее статуса лида', async () => {
    query.mockResolvedValue({ rows: [{
      tool_name: 'create_booking_request', lead_id: 'L', seat_request_id: null,
      lead_status: 'new', route_title: 'Сплав по реке Быстрая',
      booking_status: null, booking_date: null, booking_participants: null, booking_tour: null,
      seat_status: null, deadline_at: null, answered_at: null, seat_date: null, seat_participants: null, alt_date: null, failure_kind: null, seat_tour: null,
    }] });
    const v = await readRequestStatus(KEY);
    expect(v).toMatchObject({ state: 'awaiting_operator', kind: 'lead', tour: 'Сплав по реке Быстрая', date: null });
    expect(leadState('new', 'confirmed')).toBe('confirmed');
    expect(leadState('lost', null)).toBe('declined');
    expect(leadState('converted', null)).toBe('confirmed');
    expect(leadState('new', 'cancelled')).toBe('cancelled');
    expect(leadState('weird', null)).toBe('unknown');
  });

  it('запрос мест: pending → ждёт с дедлайном; просроченный pending → нет ответа; other_date несёт дату', async () => {
    const future = new Date(Date.now() + 3_600_000);
    query.mockResolvedValue({ rows: [{
      tool_name: 'create_booking_request', lead_id: null, seat_request_id: 'S',
      lead_status: null, route_title: null, booking_status: null, booking_date: null, booking_participants: null, booking_tour: null,
      seat_status: 'pending', deadline_at: future, answered_at: null, seat_date: '2027-07-15', seat_participants: 2, alt_date: null, failure_kind: null, seat_tour: 'Вулкан Горелый',
    }] });
    const v = await readRequestStatus(KEY);
    expect(v).toMatchObject({ state: 'awaiting_operator', kind: 'seat_request', tour: 'Вулкан Горелый', date: '2027-07-15', participants: 2, deadline: future.toISOString() });

    query.mockResolvedValue({ rows: [{
      tool_name: 'create_booking_request', lead_id: null, seat_request_id: 'S',
      lead_status: null, route_title: null, booking_status: null, booking_date: null, booking_participants: null, booking_tour: null,
      seat_status: 'pending', deadline_at: new Date(Date.now() - 3_600_000), answered_at: null, seat_date: '2027-07-15', seat_participants: 2, alt_date: null, failure_kind: null, seat_tour: 'Вулкан Горелый',
    }] });
    expect((await readRequestStatus(KEY)).state).toBe('no_answer');
    expect(seatState('other_date')).toBe('other_date');
    expect(seatState('failed')).toBe('failed');
  });

  it('в ответе нет ПД: ни имени, ни телефона, ни номера лида, ни ссылки на бронь — SQL их не выбирает', async () => {
    expect(REQUEST_STATUS_SQL).not.toMatch(/\bl\.(name|phone|comment)\b/);
    expect(REQUEST_STATUS_SQL).not.toMatch(/tourist_(name|phone|email)|access_token|status_token/);
    query.mockResolvedValue({ rows: [{
      tool_name: 'create_lead', lead_id: 'L', seat_request_id: null, lead_status: 'contacted', route_title: null,
      booking_status: null, booking_date: null, booking_participants: null, booking_tour: null,
      seat_status: null, deadline_at: null, answered_at: null, seat_date: null, seat_participants: null, alt_date: null, failure_kind: null, seat_tour: null,
    }] });
    const text = await runRequestStatusTool({ key: KEY });
    const obj = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(obj).sort()).toEqual(['alt_date', 'consent', 'date', 'deadline', 'human', 'kind', 'next', 'page', 'participants', 'state', 'tour']);
    expect(obj.page).toBe(requestStatusPageUrl(KEY));
    expect(obj.state).toBe('operator_contacted');
    expect(text).not.toMatch(/\+7|@|lead_id|"L"/);
  });

  it('база не ответила — исключение с SQLSTATE в логе, не «ждёт оператора»', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    query.mockRejectedValue(Object.assign(new Error('boom'), { code: '57P01' }));
    await expect(readRequestStatus(KEY)).rejects.not.toBeInstanceOf(McpUserError);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('статус не прочитан'), expect.stringContaining('57P01'), expect.any(String));
    spy.mockRestore();
  });
});

const LEAD_ROW = {
  tool_name: 'create_lead', lead_id: 'L', seat_request_id: null, lead_status: 'new', route_title: null,
  booking_status: null, booking_date: null, booking_participants: null, booking_tour: null,
  seat_status: null, deadline_at: null, answered_at: null, seat_date: null, seat_participants: null, alt_date: null, failure_kind: null, seat_tour: null,
};

describe('согласие человека (вторая половина ступени 1)', () => {
  it('чьё согласие: нет времени — none; источник агента — agent; форма сайта или страница заявки — human', () => {
    expect(consentBy(null, null)).toBe('none');
    expect(consentBy(AGENT_CONSENT_SOURCE, null)).toBe('none');
    expect(consentBy(AGENT_CONSENT_SOURCE, new Date())).toBe('agent');
    expect(consentBy(HUMAN_CONSENT_SOURCE, new Date())).toBe('human');
    expect(consentBy('seat-request', '2026-10-12T00:00:00Z')).toBe('human');
    expect(HUMAN_CONSENT_SOURCE).not.toBe(AGENT_CONSENT_SOURCE);
    // Источник агента — ровно тот, что пишет роут MCP: разойдутся — «agent» перестанет распознаваться.
    expect(ROUTE).toContain(`buildConsentRecord(true, ctx.ip, '${AGENT_CONSENT_SOURCE}'`);
  });

  it('в ответе инструмента поле consent берётся из колонок согласия лида и запроса мест', async () => {
    query.mockResolvedValue({ rows: [{ ...LEAD_ROW, lead_consent_at: new Date(), lead_consent_source: AGENT_CONSENT_SOURCE }] });
    expect((await readRequestStatus(KEY)).consent).toBe('agent');
    query.mockResolvedValue({ rows: [{ ...LEAD_ROW, lead_consent_at: new Date(), lead_consent_source: HUMAN_CONSENT_SOURCE }] });
    expect((await readRequestStatus(KEY)).consent).toBe('human');
    query.mockResolvedValue({ rows: [{ ...LEAD_ROW }] });
    expect((await readRequestStatus(KEY)).consent).toBe('none');
    expect(REQUEST_STATUS_SQL).toContain('l.pd_consent_source');
    expect(REQUEST_STATUS_SQL).toContain('r.pd_consent_source');
    // Словарь схемы совпадает с кодом.
    expect(GET_REQUEST_STATUS_TOOL.outputSchema.properties.consent.enum).toEqual(['human', 'agent', 'none']);
    expect(GET_REQUEST_STATUS_TOOL.outputSchema.required).toEqual(expect.arrayContaining(['consent', 'page']));
  });

  it('запись согласия: поверх записи агента в лид или запрос мест, одним запросом, без INSERT и без ПД', () => {
    expect(CONFIRM_CONSENT_SQL).toContain('UPDATE leads');
    expect(CONFIRM_CONSENT_SQL).toContain('UPDATE tour_seat_requests');
    expect(CONFIRM_CONSENT_SQL).not.toMatch(/INSERT/);
    expect(CONFIRM_CONSENT_SQL).toContain('pd_consent_source IS DISTINCT FROM $4::varchar');
    expect(CONFIRM_CONSENT_SQL).toContain('expires_at > NOW()');
    expect(CONFIRM_CONSENT_SQL).not.toMatch(/\b(name|phone|tourist_name|tourist_phone)\b/);
    expect(CONFIRM_CONSENT_SQL).not.toMatch(/\|\|/);
  });

  it('исходы записи: обновил — recorded; уже стояло своё — already; заявки нет — gone; ключа нет — отказ по входу', async () => {
    const record = { at: new Date(), ip: '203.0.113.5', source: HUMAN_CONSENT_SOURCE, version: '2026-10-08' };
    query.mockResolvedValue({ rows: [{ updated: 1, prior_source: AGENT_CONSENT_SOURCE, target_exists: true }] });
    expect(await confirmConsent(KEY, record)).toBe('recorded');
    const [sql, params] = query.mock.calls[0];
    expect(sql).toBe(CONFIRM_CONSENT_SQL);
    expect(params[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(params.slice(1)).toEqual([record.at, record.ip, HUMAN_CONSENT_SOURCE, '2026-10-08']);

    query.mockResolvedValue({ rows: [{ updated: 0, prior_source: HUMAN_CONSENT_SOURCE, target_exists: true }] });
    expect(await confirmConsent(KEY, record)).toBe('already');
    query.mockResolvedValue({ rows: [{ updated: 0, prior_source: null, target_exists: false }] });
    expect(await confirmConsent(KEY, record)).toBe('gone');
    query.mockResolvedValue({ rows: [] });
    await expect(confirmConsent(KEY, record)).rejects.toThrow(/не найден или истёк/);
    await expect(confirmConsent('short', record)).rejects.toBeInstanceOf(McpUserError);
  });

  it('база не ответила — исключение с SQLSTATE в логе, не «записано»', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    query.mockRejectedValue(Object.assign(new Error('boom'), { code: '40001' }));
    await expect(confirmConsent(KEY, { at: new Date(), ip: 'x', source: HUMAN_CONSENT_SOURCE, version: 'v' })).rejects.not.toBeInstanceOf(McpUserError);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('согласие не записано'), expect.stringContaining('40001'), expect.any(String));
    spy.mockRestore();
  });
});

describe('роут MCP', () => {
  it('диспетчеризует инструмент и кладёт объект в structuredContent', () => {
    expect(ROUTE).toContain('if (name === REQUEST_STATUS_TOOL_NAME) return runRequestStatusTool(rawArgs);');
    expect(ROUTE).toMatch(/toolName === REQUEST_STATUS_TOOL_NAME \? parseStructured\(text\)/);
  });

  it('ключ выдаётся во всех ответах пишущих инструментов: бронь (новая и повтор), запрос мест, подбор, вахтовка', () => {
    // Бронь и вахтовка: повтор и новая заявка выходят одним return, ключ
    // выдаётся в нём — на существующий лид или только что созданный.
    const issued = ROUTE.match(/keyLine\(await issueRequestKey\(/g) ?? [];
    expect(issued.length).toBe(3);
    expect(ROUTE).toContain("issueRequestKey({ seatRequestId: result.requestId }, BOOKING_REQUEST_TOOL.name)");
    expect(ROUTE).toContain('keyLine(statusKey)');
    expect(ROUTE).toContain("issueRequestKey({ leadId }, BOOKING_REQUEST_TOOL.name)");
    expect(ROUTE).toContain("issueRequestKey({ leadId }, CREATE_LEAD_TOOL.name)");
    expect(ROUTE).toContain("issueRequestKey({ leadId }, REQUEST_CHARTER_TOOL.name)");
    expect((ROUTE.match(/const leadId = existing \?\? await createLead\(/g) ?? []).length).toBe(2);
  });
});

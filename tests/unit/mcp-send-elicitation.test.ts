/**
 * Кнопка отправки заявки в клиенте MCP (lib/mcp/send-elicitation; слово
 * владельца 25.11 «Да, открывай PR»), вызовом роута:
 *
 *   - modern-клиент с `elicitation.url` получает на заявку не текст со
 *     ссылкой, а `InputRequiredResult` с окном на ту же страницу /confirm;
 *     черновик отложен один, ничего не записано и никому не отправлено;
 *   - повтор с `requestState` инструмент заново не исполняет: второго
 *     черновика нет, ответ говорит, как стоит первый (ждёт нажатия, отправлен,
 *     человек отказался);
 *   - чужой, испорченный или от других аргументов `requestState` — отказ
 *     -32602, а не чтение чужого черновика;
 *   - клиент без режима url (только форма, legacy-эпоха) и сервер без ключа
 *     получают прежний ответ: черновик и ссылку текстом.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const { createLeadMock, query, sendPdAlertMock, personalNotifyMock } = vi.hoisted(() => ({
  createLeadMock: vi.fn(async (_: Record<string, unknown>) => 'lead-1' as string | null),
  query: vi.fn(),
  sendPdAlertMock: vi.fn(),
  personalNotifyMock: vi.fn(async () => ({ state: 'no_channel' })),
}));

vi.mock('@/lib/leads/create', () => ({
  createLead: (p: Record<string, unknown>) => createLeadMock(p),
  createLeadDetailed: async (p: Record<string, unknown>) => { const id = await createLeadMock(p); return id ? { id, created: true } : null; },
  findRecentLeadByCommentPrefix: async () => null,
}));
vi.mock('@/lib/kuzmich/core', () => ({ executeKuzmichTool: async () => 'ok' }));
vi.mock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: (p: unknown) => sendPdAlertMock(p) }));
vi.mock('@/lib/notifications/lead-notify', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  notifyPartnerNewLeadPersonally: (...a: unknown[]) => personalNotifyMock(...(a as [])),
}));
vi.mock('@/lib/db-pool', () => ({ pool: { query, connect: async () => ({ query, release: () => {} }) } }));
// Отложенные заявки агента — в памяти: отправку «нажимает» тест за человека.
vi.mock('@/lib/mcp/pending-request', async (orig) => (await import('../helpers/mcp-two-step')).memoryPendingModule(await orig()));

import { POST } from '@/app/api/mcp/route';
import { isDraft, sendAsHuman } from '../helpers/mcp-two-step';
import { SEND_INPUT_KEY, openRequestState, sealRequestState } from '@/lib/mcp/send-elicitation';

const MODERN = '2026-07-28';
const LEAD = { name: 'Иван Петров', phone: '+79001234567', consent: true, comment: 'Хотим на вулкан в августе, 4 человека, бюджет 200000 руб' };
const URL_CAPS = { elicitation: { url: {} } };

let ip = 0;
function nextIp() { ip += 1; return `10.9.${Math.floor(ip / 250)}.${ip % 250}`; }

async function modernCall(args: Record<string, unknown>, extra: Record<string, unknown> = {}, caps: Record<string, unknown> = URL_CAPS) {
  const res = await POST(new NextRequest('http://localhost/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': nextIp(), 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/call', 'mcp-name': 'create_lead' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: ip, method: 'tools/call',
      params: {
        name: 'create_lead', arguments: args, ...extra,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MODERN,
          'io.modelcontextprotocol/clientInfo': { name: 'TestClient', version: '1.0.0' },
          'io.modelcontextprotocol/clientCapabilities': caps,
        },
      },
    }),
  }));
  return { status: res.status, body: await res.json() as { result?: Record<string, unknown>; error?: { code: number; message: string } } };
}

async function legacyCall(args: Record<string, unknown>) {
  const res = await POST(new NextRequest('http://localhost/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': nextIp() },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_lead', arguments: args } }),
  }));
  return (await res.json()) as { result: { content: Array<{ text: string }> } };
}

async function pendingRows(): Promise<Map<string, { tool: string; sent: boolean }>> {
  const mod = await import('@/lib/mcp/pending-request') as unknown as { __rows: Map<string, { tool: string; sent: boolean }> };
  return mod.__rows;
}

type Elicit = { method: string; params: { mode: string; url: string; message: string } };
const elicitOf = (r: Record<string, unknown>) => (r.inputRequests as Record<string, Elicit>)[SEND_INPUT_KEY]!;
const textOf = (r: Record<string, unknown>) => (r.content as Array<{ text: string }>)[0]!.text;

const nothingSent = () => {
  expect(createLeadMock).not.toHaveBeenCalled();
  expect(sendPdAlertMock).not.toHaveBeenCalled();
  expect(personalNotifyMock).not.toHaveBeenCalled();
};

beforeEach(async () => {
  process.env.MCP_HASH_SALT = 'соль-для-теста';
  process.env.MCP_STATE_SECRET = 'ключ-состояния-для-теста-0123456789';
  for (const m of [createLeadMock, sendPdAlertMock, personalNotifyMock]) m.mockClear();
  sendPdAlertMock.mockResolvedValue({ delivered: true, channel: 'max', reason: 'доставлено в MAX' });
  query.mockReset().mockImplementation(async (sql: string) => (/COUNT\(\*\)/.test(sql) ? { rows: [{ a: '0', b: '0', c: '0' }] } : { rows: [] }));
  (await pendingRows()).clear();
});
afterEach(() => { delete process.env.MCP_STATE_SECRET; });

describe('modern-клиент с elicitation.url — окно отправки вместо ссылки текстом', () => {
  it('ответ — InputRequiredResult с окном на /confirm; черновик один, ничего не отправлено', async () => {
    const { status, body } = await modernCall(LEAD);
    expect(status).toBe(200);
    const r = body.result!;
    expect(r.resultType).toBe('input_required');
    expect(typeof r.requestState).toBe('string');
    const e = elicitOf(r);
    expect(e.method).toBe('elicitation/create');
    expect(e.params.mode).toBe('url');
    const rows = await pendingRows();
    expect(rows.size).toBe(1);
    const [token] = [...rows.keys()];
    expect(e.params.url).toBe(`https://vedarai.ru/confirm#${token}`);
    // Сообщение окна видит клиент: имени и телефона в нём нет, как и в адресе.
    expect(`${e.params.message} ${e.params.url}`).not.toMatch(/Иван|Петров|9001234567/);
    // Токена черновика в requestState открытым текстом нет: он запечатан.
    expect(Buffer.from(String(r.requestState), 'base64url').toString('latin1')).not.toContain(token);
    nothingSent();
  });

  it('повтор после «открыть» до нажатия: второго черновика нет, заявка НЕ отправлена, ссылка названа', async () => {
    const first = (await modernCall(LEAD)).body.result!;
    const { body } = await modernCall(LEAD, { requestState: first.requestState, inputResponses: { [SEND_INPUT_KEY]: { action: 'accept' } } });
    const r = body.result!;
    expect(r.resultType).toBe('complete');
    expect(r.isError).toBeUndefined();
    const text = textOf(r);
    expect(text).toMatch(/«Отправить» ещё не нажал — заявка пока НЕ отправлена/);
    expect(text).toContain(elicitOf(first).params.url);
    expect(r.structuredContent).toMatchObject({ test: false, accepted: 0, requests: [], confirmation: { url: elicitOf(first).params.url, expires_in_min: 60 } });
    expect((await pendingRows()).size).toBe(1);
    nothingSent();
  });

  it('человек нажал «Отправить» на странице — повтор говорит «отправлена», ключа не выдумывает', async () => {
    const first = (await modernCall(LEAD)).body.result!;
    const sent = await sendAsHuman(elicitOf(first).params.url, '10.9.250.1');
    expect(sent.kind).toBe('ok');
    expect(createLeadMock).toHaveBeenCalledTimes(1);
    const { body } = await modernCall(LEAD, { requestState: first.requestState, inputResponses: { [SEND_INPUT_KEY]: { action: 'accept' } } });
    expect(textOf(body.result!)).toMatch(/^Заявка отправлена: человек сам нажал «Отправить»/);
    expect(body.result!.structuredContent).toEqual({ test: false, accepted: 0, requests: [] });
    // Повтор ничего не отправил сверх нажатия человека.
    expect(createLeadMock).toHaveBeenCalledTimes(1);
  });

  it('человек отказался — заявка не отправлена, ссылки агенту нет', async () => {
    const first = (await modernCall(LEAD)).body.result!;
    const { body } = await modernCall(LEAD, { requestState: first.requestState, inputResponses: { [SEND_INPUT_KEY]: { action: 'decline' } } });
    const text = textOf(body.result!);
    expect(text).toMatch(/отказался открывать страницу отправки — заявка НЕ отправлена/);
    expect(text).not.toContain('/confirm#');
    expect(body.result!.structuredContent).not.toHaveProperty('confirmation');
    nothingSent();
  });

  it('окно закрыто без ответа — заявка не отправлена, ссылка названа', async () => {
    const first = (await modernCall(LEAD)).body.result!;
    const { body } = await modernCall(LEAD, { requestState: first.requestState });
    expect(textOf(body.result!)).toMatch(/закрыл окно, не открыв страницу, — заявка НЕ отправлена/);
    expect(textOf(body.result!)).toContain('/confirm#');
    nothingSent();
  });

  it('requestState испорчен или от других аргументов — -32602, черновик не читается', async () => {
    const first = (await modernCall(LEAD)).body.result!;
    const state = String(first.requestState);
    const forged = `${state.slice(0, -2)}${state.endsWith('AA') ? 'BB' : 'AA'}`;
    const bad = await modernCall(LEAD, { requestState: forged, inputResponses: { [SEND_INPUT_KEY]: { action: 'accept' } } });
    expect(bad.body.error?.code).toBe(-32602);
    const other = await modernCall({ ...LEAD, comment: 'Другая заявка' }, { requestState: state });
    expect(other.body.error?.code).toBe(-32602);
    expect(other.body.error?.message).toMatch(/не от этого вызова/);
    expect((await pendingRows()).size).toBe(1);
    nothingSent();
  });
});

describe('запасной путь — прежний ответ текстом', () => {
  it('клиент объявил только форму (elicitation: {}) — черновик и ссылка текстом', async () => {
    const { body } = await modernCall(LEAD, {}, { elicitation: {} });
    expect(body.result!.resultType).toBe('complete');
    expect(isDraft(textOf(body.result!))).toBe(true);
  });

  it('клиент без elicitation — черновик и ссылка текстом', async () => {
    const { body } = await modernCall(LEAD, {}, {});
    expect(isDraft(textOf(body.result!))).toBe(true);
  });

  it('legacy-эпоха — черновик и ссылка текстом, без resultType', async () => {
    const r = await legacyCall(LEAD);
    expect(r.result).not.toHaveProperty('resultType');
    expect(isDraft(r.result.content[0]!.text)).toBe(true);
  });

  it('у сервера нет ключа — окна нет, прежний текст', async () => {
    delete process.env.MCP_STATE_SECRET;
    const prevJwt = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    try {
      const { body } = await modernCall(LEAD);
      expect(body.result!.resultType).toBe('complete');
      expect(isDraft(textOf(body.result!))).toBe(true);
    } finally {
      if (prevJwt !== undefined) process.env.JWT_SECRET = prevJwt;
    }
  });
});

describe('requestState', () => {
  const TOKEN = 'A'.repeat(32);

  it('срок: после часа state истёк; до — открывается тем же инструментом и аргументами', () => {
    const now = Date.parse('2026-11-25T10:00:00Z');
    const state = sealRequestState({ tool: 'create_lead', args: { b: 1, a: 2 }, token: TOKEN, nowMs: now })!;
    // Порядок ключей аргументов не важен.
    expect(openRequestState(state, 'create_lead', { a: 2, b: 1 }, now + 59 * 60_000)).toEqual({ ok: true, token: TOKEN });
    expect(openRequestState(state, 'create_lead', { a: 2, b: 1 }, now + 61 * 60_000)).toEqual({ ok: false, reason: 'expired' });
    expect(openRequestState(state, 'create_stay_request', { a: 2, b: 1 }, now)).toEqual({ ok: false, reason: 'mismatch' });
    expect(openRequestState(42, 'create_lead', {}, now)).toEqual({ ok: false, reason: 'forged' });
  });

  it('другой ключ сервера state не открывает', () => {
    const state = sealRequestState({ tool: 'create_lead', args: {}, token: TOKEN })!;
    process.env.MCP_STATE_SECRET = 'совсем-другой-ключ-состояния-987654';
    expect(openRequestState(state, 'create_lead', {})).toEqual({ ok: false, reason: 'forged' });
  });

});

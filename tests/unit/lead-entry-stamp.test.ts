/**
 * Вход заявки через инструменты Ведара доходит до записи (слово владельца
 * 08.11: «нужно писать, откуда лиды — человек или ИИ и через какой
 * инструмент»).
 *
 * Судится вызовом настоящего createLeadDetailed до параметров INSERT: внутри
 * вызова инструмента (withLeadEntry) в source_data пишутся `entry` и `tool`,
 * канал лида считается по входу; вне вызова инструмента ничего не
 * дописывается; записанное исполнителем не перетирается. Подменены только
 * база и уведомления. Что граница вызова (runPublicTool) ставит вход для MCP,
 * A2A и чата — lead-entry-boundary.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { poolQuery, notifyAdmin } = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  notifyAdmin: vi.fn(async (_: Record<string, unknown>) => undefined),
}));
vi.mock('@/lib/db-pool', () => ({ pool: { query: poolQuery } }));
vi.mock('@/lib/notifications/telegram-channel', () => ({ notifyAdminNewLead: (a: Record<string, unknown>) => notifyAdmin(a) }));
vi.mock('@/lib/crm/contacts', () => ({ linkContactQuietly: vi.fn(async () => undefined) }));

import { createLeadDetailed, type CreateLeadParams } from '@/lib/leads/create';
import { currentLeadEntry, withLeadEntry } from '@/lib/leads/entry-context';
import { leadOrigin } from '@/lib/leads/origin';

let n = 0;
/** Заявка с достаточным баллом, чтобы ушло уведомление; телефон — заглушка. */
function lead(over: Partial<CreateLeadParams> = {}): CreateLeadParams {
  n += 1;
  return {
    name: 'Тест Тестов',
    phone: '+70000000000',
    comment: `Хотим на вулкан в августе, 4 человека, бюджет 200000 руб, заявка ${n}`,
    source_url: 'mcp://vedar',
    source_data: { source: 'mcp' },
    pd_consent: { at: new Date('2026-11-08T00:00:00Z'), ip: '10.0.0.1', source: 'mcp', version: 'test' },
    ...over,
  };
}

/** Значение колонки из настоящего INSERT по списку колонок запроса. */
function inserted(column: string): unknown {
  const call = poolQuery.mock.calls.find((c) => /INSERT INTO leads/.test(String(c[0])));
  expect(call, 'INSERT INTO leads не выполнялся').toBeTruthy();
  const cols = String(call![0]).match(/INSERT INTO leads \(([^)]*)\)/)![1].split(',').map((c) => c.trim());
  const idx = cols.indexOf(column);
  expect(idx).toBeGreaterThanOrEqual(0);
  return (call![1] as unknown[])[idx];
}

function insertedSourceData(): Record<string, unknown> {
  const raw = inserted('source_data');
  return (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>;
}

beforeEach(() => {
  poolQuery.mockReset().mockImplementation(async (sql: string) => {
    if (/INSERT INTO leads/.test(sql)) return { rows: [{ id: 'lead-1' }] };
    return { rows: [] };
  });
  notifyAdmin.mockClear();
});

describe('внутри вызова инструмента', () => {
  it('A2A: вход и инструмент в source_data, канал a2a, подпись — ИИ-агент через A2A', async () => {
    const saved = await withLeadEntry({ entry: 'a2a', tool: 'create_lead' }, () => createLeadDetailed(lead()));
    expect(saved).toEqual({ id: 'lead-1', created: true });
    const data = insertedSourceData();
    expect(data).toMatchObject({ source: 'mcp', entry: 'a2a', tool: 'create_lead' });
    expect(inserted('source_channel')).toBe('a2a');
    expect(leadOrigin({ source_data: data }).label).toBe('ИИ-агент · A2A · подбор тура');
  });

  it('чат Кузьмича в Telegram: канал telegram, подпись — человек', async () => {
    await withLeadEntry({ entry: 'kuzmich-tg', tool: 'create_booking_request' }, () => createLeadDetailed(lead({
      source_url: 'mcp://vedar/booking',
      pd_consent: { at: new Date(), ip: '', source: 'kuzmich-tg', version: 'test' },
    })));
    expect(inserted('source_channel')).toBe('telegram');
    expect(leadOrigin({ source_data: insertedSourceData() }).label).toBe('Человек · Кузьмич в Telegram · заявка на тур');
  });

  it('инструмент, записанный исполнителем, не перетирается', async () => {
    await withLeadEntry({ entry: 'mcp', tool: 'create_trip_request' }, () => createLeadDetailed(lead({
      source_data: { source: 'mcp', tool: 'request_charter' },
    })));
    expect(insertedSourceData()).toMatchObject({ entry: 'mcp', tool: 'request_charter' });
  });

  it('уведомление админу получает канал согласия — подпись в нём та же, что на экране', async () => {
    await withLeadEntry({ entry: 'mcp', tool: 'create_lead' }, () => createLeadDetailed(lead()));
    await vi.waitFor(() => expect(notifyAdmin).toHaveBeenCalled());
    const arg = notifyAdmin.mock.calls[0]![0];
    expect(arg.pdConsentSource).toBe('mcp');
    expect((arg.sourceData as Record<string, unknown>).entry).toBe('mcp');
  });
});

describe('вне вызова инструмента', () => {
  it('форма сайта: ни входа, ни инструмента не дописано', async () => {
    expect(currentLeadEntry()).toBeNull();
    await createLeadDetailed(lead({
      source_url: 'https://vedarai.ru/planner',
      source_data: { source: 'trip_planner' },
      pd_consent: { at: new Date(), ip: '10.0.0.2', source: 'web-form', version: 'test' },
    }));
    const data = insertedSourceData();
    expect(data).not.toHaveProperty('entry');
    expect(data).not.toHaveProperty('tool');
  });

  it('вход вызова не утекает за его границу', async () => {
    await withLeadEntry({ entry: 'a2a', tool: 'create_lead' }, async () => {
      expect(currentLeadEntry()).toEqual({ entry: 'a2a', tool: 'create_lead' });
    });
    expect(currentLeadEntry()).toBeNull();
  });
});

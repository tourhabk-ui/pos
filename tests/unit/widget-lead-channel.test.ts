/**
 * Заявка с формы виджета партнёра получает канал 'widget' — находка аудита
 * 15.10 WID-config (W2).
 *
 * Форма /widget/lead-form/<slug> шлёт source_data.source = 'partner_widget'
 * и не шлёт source_url, а нормализатор узнавал виджет только по чату
 * (source_data.type = 'widget'). Настоящие заявки с сайта партнёра ложились
 * в 'other': отчёт партнёру и перепись воронки не видели ценности виджета.
 *
 * Судится вызовом: нормализатор на формах точек входа и путь целиком — тело,
 * которое шлёт форма, через POST /api/leads и настоящий createLead до
 * параметра source_channel в INSERT. Подменены только база и уведомления.
 * Уже записанные строки переводит миграция 1281 — на настоящем PostgreSQL:
 * tests/integration/widget-config.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { normalizeLeadChannel } from '@/lib/leads/channel';

const { poolQuery } = vi.hoisted(() => ({ poolQuery: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: poolQuery } }));
vi.mock('@/lib/notifications/telegram', () => ({ telegramService: { sendMessage: vi.fn(async () => null) } }));
vi.mock('@/lib/notifications/telegram-channel', () => ({ notifyAdminNewLead: vi.fn(async () => undefined) }));
vi.mock('@/lib/notifications/lead-notify', () => ({
  notifyOperatorNewLead: vi.fn(async () => ({ ok: true })),
  notifyPartnerNewLeadPersonally: vi.fn(async () => ({ state: 'no_channel' })),
}));
vi.mock('@/lib/leads/delivery-outcome', () => ({ recordPartnerDelivery: vi.fn(async () => undefined) }));
vi.mock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: vi.fn(async () => ({ ok: true })) }));
vi.mock('@/lib/crm/contacts', () => ({ linkContactQuietly: vi.fn(async () => undefined) }));
vi.mock('@/lib/services/operators/lead-processor.service', () => ({
  leadProcessor: { process: vi.fn(async () => { throw new Error('не нужен в этом тесте'); }) },
}));
vi.mock('@/lib/mcp/handoff', () => ({
  attachMcpAttribution: vi.fn(async () => null),
  MCP_ATTRIBUTION: { cookieName: 'mcp_h' },
}));

describe('нормализатор канала на формах точек входа', () => {
  it('форма виджета партнёра — widget (и старая, и с атрибуцией MCP-перехода)', () => {
    expect(normalizeLeadChannel({ source_data: { source: 'partner_widget', partner_slug: 'mestechko' } })).toBe('widget');
    expect(normalizeLeadChannel({
      source_data: { source: 'partner_widget', partner_slug: 'mestechko', mcp_handoff_id: '7f1c' },
    })).toBe('widget');
  });

  it('чат виджета — по-прежнему widget', () => {
    expect(normalizeLeadChannel({ source_data: { type: 'widget', partner_id: 'mestechko' } })).toBe('widget');
  });

  it('форма на странице оператора на Ведаре — не виджет, хоть согласие у неё и пишется как widget', () => {
    expect(normalizeLeadChannel({
      source_url: 'https://vedarai.ru/mestechko',
      source_data: { source: 'operator_page', partner_slug: 'mestechko' },
    })).toBe('site');
  });

  it('без признаков — other, а не догадка', () => {
    expect(normalizeLeadChannel({ source_data: { partner_slug: 'mestechko' } })).toBe('other');
  });
});

describe('путь целиком: тело формы виджета → /api/leads → INSERT', () => {
  beforeEach(() => {
    poolQuery.mockReset();
    poolQuery.mockImplementation(async (sql: string) => {
      if (/FROM partners WHERE slug/.test(sql)) return { rows: [{ id: 'op-mestechko', name: 'Местечко Камчатка' }] };
      if (/INSERT INTO leads/.test(sql)) return { rows: [{ id: 'lead-1' }] };
      return { rows: [] };
    });
  });

  async function post(body: Record<string, unknown>, ip: string) {
    const { POST } = await import('@/app/api/leads/route');
    return POST(new NextRequest('https://vedarai.ru/api/leads', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify(body),
    }));
  }

  /** Значение колонки из настоящего INSERT по списку колонок запроса. */
  function insertedColumn(column: string): unknown {
    const call = poolQuery.mock.calls.find((c) => /INSERT INTO leads/.test(String(c[0])));
    expect(call).toBeTruthy();
    const cols = String(call![0]).match(/INSERT INTO leads \(([^)]*)\)/)![1].split(',').map((c) => c.trim());
    const idx = cols.indexOf(column);
    expect(idx).toBeGreaterThanOrEqual(0);
    return (call![1] as unknown[])[idx];
  }

  it('заявка с формы виджета ложится каналом widget, адресатом — партнёр', async () => {
    // Ровно то тело, что шлёт app/widget/lead-form/[slug]/page.tsx.
    const res = await post({
      name: 'Иван Петров', phone: '+79000000001', comment: 'Вертолёт на Курильское, двое',
      partner_slug: 'mestechko',
      source_data: { source: 'partner_widget', partner_slug: 'mestechko' },
      pd_consent: true,
    }, '10.1.0.1');
    expect(res.status).toBe(201);
    expect(insertedColumn('source_channel')).toBe('widget');
    expect(insertedColumn('operator_id')).toBe('op-mestechko');
    expect(insertedColumn('pd_consent_source')).toBe('widget');
  });

  it('форма страницы оператора с тем же partner_slug — канал site, не widget', async () => {
    const res = await post({
      name: 'Иван Петров', phone: '+79000000002',
      partner_slug: 'mestechko',
      source_url: 'https://vedarai.ru/mestechko',
      source_data: { source: 'operator_page', partner_slug: 'mestechko' },
      pd_consent: true,
    }, '10.1.0.2');
    expect(res.status).toBe(201);
    expect(insertedColumn('source_channel')).toBe('site');
  });
});

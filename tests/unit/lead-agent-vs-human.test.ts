// @vitest-environment node
/**
 * Лид ИИ-агента и лид человека различаются в рабочем чате (05.11, владелец:
 * «мы пока не различаем лиды людей от mcp»).
 *
 * Балл лида считает заполненность формы, а агент заполняет её целиком всегда:
 * заявка через MCP приходила «Горячей 75/100», как заявка человека. Сторож
 * держит: у заявки, согласие по которой заявил только агент, нет балла и
 * метки, сказано «человек не подтвердил» — и в MAX, и в заглушке Telegram;
 * у заявки человека всё по-прежнему; createLead ставит пометку по источнику
 * согласия; подтверждение человека — отдельное сообщение без ПД.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const send = vi.fn();
const dbQuery = vi.fn();
vi.mock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: (...a: unknown[]) => send(...a) }));
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => dbQuery(...a) }));
vi.mock('@/lib/config', async (orig) => ({ ...(await orig<typeof import('@/lib/config')>()), getPublicBaseUrl: () => 'https://vedarai.ru' }));

import { notifyAdminNewLead } from '@/lib/notifications/telegram-channel';
import { notifyLeadHumanConfirmedQuietly, leadHumanConfirmedText } from '@/lib/notifications/lead-human-confirmed';

const LEAD = '05502cc4-b983-4230-89a5-41209c10bae1';
const base = {
  id: LEAD, name: 'Иван Петров', phone: '+79990001122', comment: 'Хотим на вулкан, 4 человека, бюджет 200000 руб',
  // Как пишет заявку MCP с 08.11: вход и инструмент записаны (lib/leads/entry-context).
  sourceData: { source: 'mcp', entry: 'mcp', tool: 'create_lead' }, score: 75, labelRu: 'Горячий',
};

beforeEach(() => {
  vi.clearAllMocks();
  send.mockResolvedValue({ channel: 'max', delivered: true, reason: 'ok' });
  dbQuery.mockResolvedValue({ rows: [] });
});

describe('уведомление о лиде: агент или человек', () => {
  it('заявка агента: без балла и «Горячий», сказано «человек не подтвердил» — в MAX и в заглушке', async () => {
    await notifyAdminNewLead({ ...base, byAgent: true });
    const p = send.mock.calls[0][0];
    for (const t of [p.text, p.stub]) {
      expect(t).toContain('Лид — ИИ-агент · MCP · подбор тура · человек не подтвердил');
      expect(t).not.toMatch(/Горячий|75\/100/);
      expect(t).toMatch(/Заявку оставил ИИ-агент от имени человека/);
    }
    expect(p.stub).not.toContain('+79990001122');
  });

  it('заявка человека: балл и метка на месте, строки про агента нет', async () => {
    await notifyAdminNewLead({ ...base, sourceData: { source: 'website' } });
    const p = send.mock.calls[0][0];
    expect(p.text).toContain('(Горячий) · 75/100');
    expect(p.text).not.toMatch(/ИИ-агент/);
  });

  it('откуда заявка — в заголовке той же подписью, что на экране (08.11)', async () => {
    await notifyAdminNewLead({ ...base, sourceData: { source: 'mcp', entry: 'kuzmich-max', tool: 'create_booking_request' } });
    expect(send.mock.calls[0][0].text).toContain('Лид — Человек · Кузьмич в MAX · заявка на тур (Горячий)');
    send.mockClear();
    await notifyAdminNewLead({ ...base, sourceData: null });
    expect(send.mock.calls[0][0].text).toContain('Новый лид (Горячий) · 75/100');
  });

  it('путь страницы в подписи: в MAX как есть, в заглушку Telegram — сквозь чистку', async () => {
    await notifyAdminNewLead({ ...base, sourceData: null, sourceUrl: 'https://vedarai.ru/p/+79990001122' });
    const p = send.mock.calls[0][0];
    expect(p.text).toContain('Лид — Человек · сайт, /p/+79990001122');
    expect(p.stub).toContain('Лид — Человек · сайт, /p/');
    expect(p.stub).not.toContain('79990001122');
  });

  it('человек подтвердил: отдельное сообщение без ПД, с номером заявки и ссылкой в CRM', async () => {
    await notifyLeadHumanConfirmedQuietly(LEAD);
    const p = send.mock.calls[0][0];
    expect(p.text).toMatch(/Человек подтвердил заявку/);
    expect(p.text).toContain(LEAD);
    expect(p.stub).toBe(p.text);
    expect(p.buttons).toEqual([{ text: 'Открыть в CRM', url: `https://vedarai.ru/hub/operator/leads/${LEAD}` }]);
    expect(leadHumanConfirmedText('<b>')).not.toContain('<b>Заявка');
  });
});

describe('createLead ставит пометку по источнику согласия', () => {
  it('согласие заявил агент (mcp) — byAgent; согласие с формы сайта — нет', async () => {
    vi.resetModules();
    const notify = vi.fn().mockResolvedValue(undefined);
    vi.doMock('@/lib/notifications/telegram-channel', () => ({ notifyAdminNewLead: notify }));
    // Дубля нет; INSERT возвращает id.
    vi.doMock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async (sql: string) => ({ rows: /INSERT INTO leads/.test(sql) ? [{ id: LEAD }] : [] })) } }));
    vi.doMock('@/lib/crm/contacts', () => ({ linkContactQuietly: vi.fn() }));
    const { createLead } = await import('@/lib/leads/create');
    const consent = (source: string) => ({ at: new Date().toISOString(), ip: '203.0.113.7', source, version: 'v' });
    for (const [source, byAgent] of [['mcp', true], ['website', false]] as const) {
      notify.mockClear();
      await createLead({ name: base.name, phone: base.phone, comment: base.comment, source_data: { source }, pd_consent: consent(source) } as never);
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ byAgent }));
    }
  });
});

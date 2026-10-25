/**
 * Кнопка «Новые заявки» в строке роли — тот же список с кнопками ответа,
 * что и текст «Новые заявки». roleMenuScreen этих кнопок не клеит.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadInbox = vi.fn();
const findPartnerByChat = vi.fn();

vi.mock('@/lib/crm/inbox', () => ({
  loadInbox: (...args: unknown[]) => loadInbox(...args),
}));

vi.mock('@/lib/kuzmich/operator-chat', () => ({
  findPartnerByChat: (...args: unknown[]) => findPartnerByChat(...args),
  processPartnerMessage: vi.fn(),
}));

const PARTNER = {
  partnerId: '11111111-1111-4111-8111-111111111111',
  category: 'operator',
  slug: 'mestechko',
  userId: '22222222-2222-4222-8222-222222222222',
  partnerName: 'Местечко',
  displayName: 'Местечко',
};

const BOOKING = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  findPartnerByChat.mockReset();
  findPartnerByChat.mockResolvedValue({ outcome: 'found', partner: PARTNER });
  loadInbox.mockReset();
  loadInbox.mockResolvedValue({
    category: 'operator',
    items: [{
      kind: 'operator_booking',
      id: BOOKING,
      created_at: '2026-10-25T00:00:00.000Z',
      title: 'Горелый',
      date: null,
      people: 2,
      contact_id: null,
      contact_name: null,
      waiting_minutes: 15,
    }],
    failed: [],
    response: { window_days: 7, median_minutes: null, responded: 0, enough: false, complete: true },
    chat: { state: 'none' },
    not_here: [],
  });
});

describe('кнопка входящих туроператора', () => {
  it('в Telegram отдаёт принять, нет мест, уточнить и свяжусь сам', async () => {
    const { tryRoleMenuTelegramPress } = await import('@/lib/roles/role-telegram');
    const send = vi.fn(async () => {});
    const handled = await tryRoleMenuTelegramPress({ chatId: 42, payload: 'rm:op:in', send });
    expect(handled).toBe(true);
    const buttons = (send.mock.calls[0]?.[1] ?? []).flat().map((b) => b.payload);
    expect(buttons).toEqual(expect.arrayContaining([
      `ia:a:b:${BOOKING}`,
      `ia:n:b:${BOOKING}`,
      `ia:c:b:${BOOKING}`,
      `ia:m:b:${BOOKING}`,
    ]));
    expect(send.mock.calls[0]?.[0]).toContain('Ждут ответа: 1');
  });

  it('«Помощь» в Telegram — справка кабинета и кнопка поддержки, не тикет', async () => {
    const { tryRoleMenuTelegramPress } = await import('@/lib/roles/role-telegram');
    const send = vi.fn(async () => {});
    await tryRoleMenuTelegramPress({ chatId: 42, payload: 'rm:op:hp', send });
    expect(send.mock.calls[0]?.[0]).toContain('Само слово «Помощь» тикет не создаёт');
    const payloads = (send.mock.calls[0]?.[1] ?? []).flat().map((b) => b.payload);
    expect(payloads).toContain('sup:new');
    expect(payloads.some((p) => p.startsWith('ia:'))).toBe(false);
  });
});

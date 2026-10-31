/**
 * Кнопка «Новые заявки» в строке роли — кабинет в чате (30.10): список
 * «Входящих» со строкой кабинета, номер открывает карточку с кнопками
 * ответа. Туроператору под заявкой — «Принять», «Нет мест», «Уточнить»,
 * «Свяжусь сам», под бронью — «Подтвердить» и «Отклонить» (слово владельца
 * 30.10 «Да, как у гида»). В группе вкладка не открывается.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadInbox = vi.fn();
const findPartnerByChat = vi.fn();

vi.mock('@/lib/crm/inbox', () => ({
  loadInbox: (...args: unknown[]) => loadInbox(...args),
}));

// Полоса чата подменена: беду с командой классификатор обычно отдаёт Кузьмичу
// туриста. Здесь судится случай, когда полоса оставила её кабинету.
vi.mock('@/lib/kuzmich/bound-chat-route', async (orig) => ({
  ...(await orig<typeof import('@/lib/kuzmich/bound-chat-route')>()),
  boundChatLaneFor: () => 'partner',
}));

vi.mock('@/lib/kuzmich/operator-chat', () => ({
  findPartnerByChat: (...args: unknown[]) => findPartnerByChat(...args),
  processPartnerMessage: vi.fn(),
}));

const PARTNER = {
  partnerId: '11111111-1111-4111-8111-111111111111',
  category: 'operator',
  crmCategory: 'operator',
  slug: 'mestechko',
  userId: '22222222-2222-4222-8222-222222222222',
  partnerName: 'Местечко',
  displayName: 'Местечко',
};

const LEAD = '33333333-3333-4333-8333-333333333333';

const base = {
  created_at: '2026-10-25T00:00:00.000Z', people: 2, contact_id: null, contact_name: null, waiting_minutes: 15,
};

beforeEach(() => {
  findPartnerByChat.mockReset();
  findPartnerByChat.mockResolvedValue({ outcome: 'found', partner: PARTNER });
  loadInbox.mockReset();
  loadInbox.mockResolvedValue({
    category: 'operator',
    items: [
      { ...base, kind: 'operator_booking', id: '501', title: 'Горелый', date: '2026-11-05' },
      { ...base, kind: 'lead', id: LEAD, title: 'Подбор тура', date: null },
    ],
    failed: [],
    response: { window_days: 7, median_minutes: null, responded: 0, enough: false, complete: true },
    chat: { state: 'none' },
    not_here: [],
  });
});

type Btn = { text: string; payload?: string; url?: string };
const payloads = (screen: { rows: Btn[][] }) => screen.rows.flat().flatMap((b) => (b.payload ? [b.payload] : []));

describe('кнопка входящих туроператора — кабинет в чате', () => {
  it('в Telegram: список со строкой кабинета; карточка заявки — четыре ответа, карточка брони — «Подтвердить» и «Отклонить»', async () => {
    const { tryRoleMenuTelegramPress } = await import('@/lib/roles/role-telegram');
    const { bookingPressPayload } = await import('@/lib/bookings/chat-owner-press');
    const send = vi.fn(async () => {});
    const sendCabinet = vi.fn(async () => {});
    const handled = await tryRoleMenuTelegramPress({ chatId: 42, payload: 'rm:op:in', send, sendCabinet, privateChat: true });
    expect(handled).toBe(true);
    expect(send).not.toHaveBeenCalled();
    const list = (sendCabinet.mock.calls[0] as unknown as [{ text: string; rows: Btn[][] }])[0];
    expect(list.text).toContain('Ждут ответа: 2');
    expect(payloads(list).filter((p) => p.startsWith('cb:o:'))).toEqual(['cb:o:ob:501', `cb:o:ld:${LEAD}`]);
    expect(list.rows.slice(-2).map((r) => r.map((b) => b.payload))).toEqual([['cb:i', 'cb:t'], ['cb:c', 'cb:m']]);

    const { handleCabinetPress } = await import('@/lib/chat-cabinet/service');
    const lead = await handleCabinetPress({ channel: 'telegram', chatId: 42, privateChat: true, payload: `cb:o:ld:${LEAD}` });
    expect(payloads(lead)).toEqual(expect.arrayContaining([
      `ia:a:l:${LEAD}`, `ia:n:l:${LEAD}`, `ia:c:l:${LEAD}`, `ia:m:l:${LEAD}`,
    ]));
    // «Связался / Договорились / Отказ» — гиду со своими турами, не туроператору.
    expect(payloads(lead).some((p) => p.startsWith('ld:'))).toBe(false);
    const booking = await handleCabinetPress({ channel: 'telegram', chatId: 42, privateChat: true, payload: 'cb:o:ob:501' });
    expect(payloads(booking)).toEqual(expect.arrayContaining([
      bookingPressPayload('confirm', '501'), bookingPressPayload('cancel', '501'),
    ]));
    expect(payloads(booking).some((p) => p.startsWith('ia:'))).toBe(false);
  });

  it('в группе вкладка кабинета не открывается: ни списка, ни кнопок', async () => {
    const { tryRoleMenuTelegramPress, CABINET_IN_DIALOG } = await import('@/lib/roles/role-telegram');
    const send = vi.fn(async () => {});
    const sendCabinet = vi.fn(async () => {});
    await tryRoleMenuTelegramPress({ chatId: 42, payload: 'rm:op:in', send, sendCabinet });
    expect(sendCabinet).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(CABINET_IN_DIALOG, []);
    expect(loadInbox).not.toHaveBeenCalled();
  });

  it('беда в тексте команды — блок 112 отдельным сообщением перед экраном: правка экрана кнопкой его не сотрёт', async () => {
    const { tryRoleMenuTelegramMessage } = await import('@/lib/roles/role-telegram');
    const order: string[] = [];
    const send = vi.fn(async (text: string) => { order.push(`send:${text}`); });
    const sendCabinet = vi.fn(async (screen: { text: string }) => { order.push(`cabinet:${screen.text}`); });
    findPartnerByChat.mockResolvedValue({
      outcome: 'found', partner: { ...PARTNER, category: 'guide', crmCategory: 'guide', sellsTours: false },
    });
    const handled = await tryRoleMenuTelegramMessage({
      chatId: 42, text: '/requests человек упал со скалы, помогите', fromName: null, send, sendCabinet, chatType: 'private',
    });
    expect(handled).toBe(true);
    expect(order).toHaveLength(2);
    expect(order[0]).toMatch(/^send:[\s\S]*112/);
    expect(order[1]).toMatch(/^cabinet:<b>Входящие<\/b>/);
    expect(order[1]).not.toContain('112');
    expect(send).toHaveBeenCalledWith(expect.any(String), []);
  });

  it('«Помощь» в Telegram — справка кабинета и кнопка поддержки, не тикет', async () => {
    const { tryRoleMenuTelegramPress } = await import('@/lib/roles/role-telegram');
    const send = vi.fn(async () => {});
    await tryRoleMenuTelegramPress({ chatId: 42, payload: 'rm:op:hp', send, sendCabinet: vi.fn(), privateChat: true });
    expect(send.mock.calls[0]?.[0]).toContain('Само слово «Помощь» тикет не создаёт');
    const payloads = (send.mock.calls[0]?.[1] ?? []).flat().map((b) => b.payload);
    expect(payloads).toContain('sup:new');
    expect(payloads.some((p) => p.startsWith('ia:'))).toBe(false);
  });
});

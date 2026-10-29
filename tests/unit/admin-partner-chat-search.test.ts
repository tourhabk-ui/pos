/**
 * Чат администратора, который ещё и чат карточки партнёра
 * (lib/roles/admin-partner-chat): пока кабинет в чате MAX ждёт запрос поиска
 * клиента (кнопка «Найти клиента», lib/chat-cabinet), текст — кабинету. Иначе
 * «Бронникова» ушла бы консоли администратора по слову «брон», а клиент не
 * нашёлся бы. Telegram поиска не ждёт: там имён клиентов нет вовсе.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  find: vi.fn(),
  awaitsSearch: vi.fn(),
  awaitsReason: vi.fn(),
}));

vi.mock('@/lib/kuzmich/operator-chat', () => ({ findPartnerByChat: (...a: unknown[]) => m.find(...a) }));
vi.mock('@/lib/chat-cabinet/service', () => ({ awaitsCabinetSearch: (...a: unknown[]) => m.awaitsSearch(...a) }));
vi.mock('@/lib/bookings/chat-owner-action', () => ({ awaitsOwnerReason: (...a: unknown[]) => m.awaitsReason(...a) }));

const { adminChatYieldsToPartner } = await import('@/lib/roles/admin-partner-chat');

const OPERATOR = {
  partnerId: '11111111-1111-4111-8111-111111111111', partnerName: 'Местечко', slug: 'mesto',
  category: 'operator', crmCategory: 'operator', userId: 'u', sellsTours: true,
};
const CHAT = 8_201;

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.find.mockResolvedValue({ outcome: 'found', partner: OPERATOR });
  m.awaitsReason.mockResolvedValue(false);
  m.awaitsSearch.mockResolvedValue(false);
});

describe('поиск клиента в чате администратора и партнёра', () => {
  it('поиск не ждёт — «Бронникова» консоли (слово «брон»); ждёт — кабинету', async () => {
    expect(await adminChatYieldsToPartner('max', CHAT, 'Бронникова')).toBe(false);
    m.awaitsSearch.mockResolvedValue(true);
    expect(await adminChatYieldsToPartner('max', CHAT, 'Бронникова')).toBe(true);
    expect(m.awaitsSearch).toHaveBeenCalledWith(CHAT);
  });

  it('Telegram поиска не ждёт и его не спрашивает', async () => {
    m.awaitsSearch.mockResolvedValue(true);
    expect(await adminChatYieldsToPartner('telegram', CHAT, 'Бронникова')).toBe(false);
    expect(m.awaitsSearch).not.toHaveBeenCalled();
  });

  it('чат не карточки — поиск не спрашивается, консоль как раньше', async () => {
    m.find.mockResolvedValue({ outcome: 'none' });
    expect(await adminChatYieldsToPartner('max', CHAT, 'Бронникова')).toBe(false);
    expect(m.awaitsSearch).not.toHaveBeenCalled();
  });
});

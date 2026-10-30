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
  member: vi.fn(),
  awaitsSearch: vi.fn(),
  awaitsReason: vi.fn(),
}));

vi.mock('@/lib/kuzmich/operator-chat', () => ({ findPartnerByChat: (...a: unknown[]) => m.find(...a) }));
vi.mock('@/lib/chat-cabinet/service', () => ({ awaitsCabinetSearch: (...a: unknown[]) => m.awaitsSearch(...a) }));
vi.mock('@/lib/bookings/chat-owner-action', () => ({ awaitsOwnerReason: (...a: unknown[]) => m.awaitsReason(...a) }));
vi.mock('@/lib/operators/member-chat', () => ({ findMemberByChat: (...a: unknown[]) => m.member(...a) }));

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
  m.member.mockResolvedValue({ outcome: 'none' });
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

  it('чат не карточки и не менеджера — консоль как раньше', async () => {
    m.find.mockResolvedValue({ outcome: 'none' });
    m.awaitsSearch.mockResolvedValue(true);
    expect(await adminChatYieldsToPartner('max', CHAT, 'Бронникова')).toBe(false);
    expect(m.member).toHaveBeenCalledWith('max', CHAT);
  });

  it('администратор — ещё и менеджер команды: разделы и запрос поиска — его кабинету, прочее — консоли', async () => {
    m.find.mockResolvedValue({ outcome: 'none' });
    m.member.mockResolvedValue({ outcome: 'found', member: { memberId: 'm', label: null, partner: OPERATOR } });
    expect(await adminChatYieldsToPartner('max', CHAT, 'Входящие')).toBe(true);
    expect(await adminChatYieldsToPartner('telegram', CHAT, 'Задачи')).toBe(true);
    // Поиск не ждёт — «Бронникова» консоли, база о менеджере не спрашивается.
    m.member.mockClear();
    expect(await adminChatYieldsToPartner('max', CHAT, 'Бронникова')).toBe(false);
    expect(m.member).not.toHaveBeenCalled();
    m.awaitsSearch.mockResolvedValue(true);
    expect(await adminChatYieldsToPartner('max', CHAT, 'Бронникова')).toBe(true);
    // Команды консоли и непонятное — консоли: у менеджера нет «не понял» вместо неё.
    m.awaitsSearch.mockResolvedValue(false);
    expect(await adminChatYieldsToPartner('max', CHAT, 'сводка суток')).toBe(false);
    // Менеджер не прочитался — консоль как раньше.
    m.member.mockResolvedValue({ outcome: 'unavailable' });
    expect(await adminChatYieldsToPartner('max', CHAT, 'Входящие')).toBe(false);
  });
});

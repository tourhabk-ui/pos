/**
 * Постоянная клавиатура гида в Telegram (lib/telegram/guide-desk, слово
 * владельца 30.10 «это нужно делать кнопками всё», «да, причём ux/ui») —
 * вызовом.
 *
 * Держит:
 *  - кнопки клавиатуры — ровно кнопки строки и «Ещё» этой карточки (без
 *    «Помощи»: она в «Ещё»), по две в ряд, по частоте; гиду команды — четыре
 *    вкладки; не гиду — ничего;
 *  - нажатие — точная подпись (без регистра и «ё»), а не любое предложение со
 *    словом: «брони на завтра» — вопрос помощнику, как раньше;
 *  - приветствие называет каждую кнопку и не обещает ответа на бронь тому, у
 *    кого своих туров нет;
 *  - в чате, который ещё и чат администратора, кнопка клавиатуры уходит
 *    кабинету гида только в Telegram — в MAX клавиатуры нет, и консоль как была.
 */
import { describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ find: vi.fn() }));
vi.mock('@/lib/kuzmich/operator-chat', () => ({ findPartnerByChat: (...a: unknown[]) => m.find(...a) }));
vi.mock('@/lib/chat-cabinet/service', () => ({ awaitsCabinetSearch: vi.fn(async () => false) }));
vi.mock('@/lib/bookings/chat-owner-action', () => ({ awaitsOwnerReason: vi.fn(async () => false) }));
vi.mock('@/lib/operators/member-chat', () => ({ findMemberByChat: vi.fn(async () => ({ outcome: 'none' })) }));

const {
  guideKeyboardRows, guideKeyboardAction, guideReplyMarkup, guideStartText, GUIDE_INPUT_PLACEHOLDER,
} = await import('@/lib/telegram/guide-desk');
const { partnerMenu, partnerMenuExtras } = await import('@/lib/roles/role-menu');
const { adminChatYieldsToPartner } = await import('@/lib/roles/admin-partner-chat');

const SELLER = { partnerId: '33333333-3333-4333-8333-333333333333', category: 'guide', slug: 'andrey-zaporozhets', sellsTours: true };
const TEAM = { ...SELLER, slug: 'guide-team', sellsTours: false };
const OPERATOR = { ...SELLER, category: 'operator' };

describe('клавиатура гида', () => {
  it('продавец: шесть кнопок по две, по частоте; каждая — кнопка его строки или «Ещё», «Помощи» нет', () => {
    const rows = guideKeyboardRows(SELLER);
    expect(rows).toEqual([['Входящие', 'Брони'], ['Задачи', 'Клиенты'], ['Мои туры', 'Ещё']]);
    const real = [...(partnerMenu(SELLER) ?? []), ...partnerMenuExtras(SELLER)].map((b) => b.text);
    for (const label of rows.flat()) expect(real, label).toContain(label);
    expect(rows.flat()).not.toContain('Помощь');
  });

  it('гид команды — четыре вкладки строки; не гид — пусто', () => {
    expect(guideKeyboardRows(TEAM)).toEqual([['Входящие', 'Задачи'], ['Клиенты', 'Ещё']]);
    expect(guideKeyboardRows(OPERATOR)).toEqual([]);
    expect(guideKeyboardAction('Входящие', OPERATOR)).toBeNull();
  });

  it('разметка Telegram: постоянная, ужатая, с подсказкой в поле ввода', () => {
    const markup = guideReplyMarkup(SELLER);
    expect(markup).toMatchObject({ is_persistent: true, resize_keyboard: true, input_field_placeholder: GUIDE_INPUT_PLACEHOLDER });
    expect(markup.keyboard.map((r) => r.map((b) => b.text))).toEqual(guideKeyboardRows(SELLER));
    expect(GUIDE_INPUT_PLACEHOLDER.length).toBeLessThanOrEqual(64);
  });

  it('нажатие — точная подпись без регистра и «ё»; предложение со словом — не кнопка', () => {
    expect(guideKeyboardAction('Брони', SELLER)).toBe('bookings');
    expect(guideKeyboardAction('  мои туры ', SELLER)).toBe('tours');
    expect(guideKeyboardAction('ЕЩЕ', SELLER)).toBe('more');
    expect(guideKeyboardAction('Входящие', SELLER)).toBe('inbox');
    expect(guideKeyboardAction('брони на завтра', SELLER)).toBeNull();
    expect(guideKeyboardAction('покажи мои туры', SELLER)).toBeNull();
    expect(guideKeyboardAction('Помощь', SELLER)).toBeNull();
    // У гида команды «Брони» и «Мои туры» на клавиатуре нет.
    expect(guideKeyboardAction('Брони', TEAM)).toBeNull();
  });

  it('приветствие называет каждую кнопку; ответ на бронь и причину — только продавцу', () => {
    const seller = guideStartText(SELLER);
    for (const k of guideKeyboardRows(SELLER).flat()) expect(seller, k).toContain(`«${k}»`);
    expect(seller).toMatch(/причину, когда отклоняете бронь/);
    const team = guideStartText(TEAM);
    for (const k of guideKeyboardRows(TEAM).flat()) expect(team, k).toContain(`«${k}»`);
    expect(team).not.toMatch(/Брони|Мои туры|отклоняете/);
  });
});

describe('чат администратора, который ещё и чат гида', () => {
  it('кнопка клавиатуры «Брони» — кабинету гида в Telegram; в MAX клавиатуры нет — консоль как была', async () => {
    m.find.mockResolvedValue({ outcome: 'found', partner: { ...SELLER, partnerName: 'Андрей', crmCategory: 'guide', userId: 'u' } });
    expect(await adminChatYieldsToPartner('telegram', 9_101, 'Брони')).toBe(true);
    expect(await adminChatYieldsToPartner('max', 9_101, 'Брони')).toBe(false);
  });
});

/**
 * Текст в чате менеджера команды оператора (lib/chat-cabinet/member-entry,
 * слово владельца 30.10 «менеджеры оператора») — вызовом, с подменёнными
 * поиском менеджера и сервисом кабинета.
 *
 * Держит:
 *  - слово меню и команда — раздел его кабинета с местом `member`;
 *  - обычный текст туриста базу о менеджере не спрашивает вовсе; в MAX —
 *    только «ждёт ли чат поиск», в Telegram — ничего;
 *  - после «Найти клиента» (MAX) текст менеджера — запрос поиска, а не
 *    Кузьмичу туриста;
 *  - чат не менеджера — текст идёт своим путём; «не смог проверить» — ответ
 *    словами, с блоком 112 при беде;
 *  - экран уходит с текстом человека: блок 112 доставка ставит отдельно.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  member: vi.fn(),
  section: vi.fn(),
  awaits: vi.fn(),
  capture: vi.fn(),
}));

vi.mock('@/lib/operators/member-chat', () => ({ findMemberByChat: (...a: unknown[]) => m.member(...a) }));
vi.mock('@/lib/chat-cabinet/service', async (orig) => ({
  ...(await orig<typeof import('@/lib/chat-cabinet/service')>()),
  cabinetSectionFor: (...a: unknown[]) => m.section(...a),
  awaitsCabinetSearch: (...a: unknown[]) => m.awaits(...a),
  captureCabinetSearch: (...a: unknown[]) => m.capture(...a),
}));

const { memberCabinetText, MEMBER_UNCHECKED } = await import('@/lib/chat-cabinet/member-entry');

const PARTNER = { partnerId: 'p1', partnerName: 'Местечко', category: 'operator', crmCategory: 'operator', userId: 'u-member' };
const SCREEN = { text: '<b>Задачи</b>', rows: [], pd: false };
const CHAT = 4_401;

function deliver() {
  const shown: Array<{ screen: unknown; userText: string }> = [];
  const said: string[] = [];
  return {
    shown, said,
    d: {
      show: async (screen: unknown, userText: string) => { shown.push({ screen, userText }); },
      say: async (text: string) => { said.push(text); },
    },
  };
}

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.member.mockResolvedValue({ outcome: 'found', member: { memberId: 'm1', label: null, partner: PARTNER } });
  m.section.mockResolvedValue(SCREEN);
  m.awaits.mockResolvedValue(false);
  m.capture.mockResolvedValue(null);
});

describe('чат менеджера команды', () => {
  it('слово меню и команда — раздел его кабинета с местом member, в его канале', async () => {
    for (const [channel, text, section] of [['max', 'Задачи', 'tasks'], ['telegram', '/clients', 'clients'], ['max', '/start', 'more']] as const) {
      m.section.mockClear();
      const { d, shown } = deliver();
      expect(await memberCabinetText({ channel, chatId: CHAT, text, nowMs: 1 }, d), text).toBe(true);
      expect(m.member).toHaveBeenLastCalledWith(channel, CHAT);
      expect(m.section).toHaveBeenCalledWith(PARTNER, channel, section, 1, 'member');
      expect(shown).toEqual([{ screen: SCREEN, userText: text }]);
    }
  });

  it('обычный текст: о менеджере база не спрашивается; MAX — только «ждёт ли поиск», Telegram — ничего', async () => {
    const { d } = deliver();
    expect(await memberCabinetText({ channel: 'max', chatId: CHAT, text: 'какая погода на Авачинском' }, d)).toBe(false);
    expect(m.awaits).toHaveBeenCalledWith(CHAT);
    expect(m.member).not.toHaveBeenCalled();
    m.awaits.mockClear();
    expect(await memberCabinetText({ channel: 'telegram', chatId: CHAT, text: 'какая погода' }, d)).toBe(false);
    expect(m.awaits).not.toHaveBeenCalled();
    expect(m.member).not.toHaveBeenCalled();
    // Чужая команда — не кабинет и не поиск.
    expect(await memberCabinetText({ channel: 'max', chatId: CHAT, text: '/weather' }, d)).toBe(false);
    expect(m.awaits).not.toHaveBeenCalled();
  });

  it('MAX после «Найти клиента»: текст — запрос поиска менеджера, а не Кузьмичу туриста', async () => {
    m.awaits.mockResolvedValue(true);
    m.capture.mockResolvedValue({ text: 'Найдено: 1.', rows: [], pd: true });
    const { d, shown } = deliver();
    expect(await memberCabinetText({ channel: 'max', chatId: CHAT, text: 'Петрова', nowMs: 5 }, d)).toBe(true);
    expect(m.capture).toHaveBeenCalledWith({ chatId: CHAT, partner: PARTNER, text: 'Петрова', seat: 'member', nowMs: 5 });
    expect(shown).toHaveLength(1);
    // Поиск отпустил сообщение (беда, чужое ожидание) — оно идёт своим путём.
    m.capture.mockResolvedValue(null);
    expect(await memberCabinetText({ channel: 'max', chatId: CHAT, text: 'помогите, упал' }, deliver().d)).toBe(false);
  });

  it('чат не менеджера — своим путём; «не смог проверить» — словами, с блоком 112 при беде', async () => {
    m.member.mockResolvedValue({ outcome: 'none' });
    expect(await memberCabinetText({ channel: 'max', chatId: CHAT, text: 'Входящие' }, deliver().d)).toBe(false);
    m.member.mockResolvedValue({ outcome: 'unavailable' });
    const a = deliver();
    expect(await memberCabinetText({ channel: 'telegram', chatId: CHAT, text: '/requests' }, a.d)).toBe(true);
    expect(a.said).toEqual([MEMBER_UNCHECKED]);
    expect(m.section).not.toHaveBeenCalled();
    const b = deliver();
    await memberCabinetText({ channel: 'max', chatId: CHAT, text: '/start человек упал со скалы, помогите' }, b.d);
    expect(b.said[0]).toContain('112');
    expect(b.said[0]).toContain(MEMBER_UNCHECKED);
  });
});

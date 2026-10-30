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
 *  - чат не менеджера — текст идёт своим путём; слово меню при «не смог
 *    проверить» — тоже своим путём (туристу не «не смог»);
 *  - поиск: не прочиталось ожидание у менеджера — «не смог», запрос дальше не
 *    уходит; поиск ждал, а менеджера сняли — поиск гасится, текст не уходит;
 *    оба неизвестны — туристский путь; беда — своим путём при любом исходе;
 *  - один чат у двух команд — своими словами, а не «попробуйте ещё раз»;
 *  - экран уходит с текстом человека: блок 112 доставка ставит отдельно.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  member: vi.fn(),
  section: vi.fn(),
  awaits: vi.fn(),
  capture: vi.fn(),
  drop: vi.fn(),
}));

vi.mock('@/lib/operators/member-chat', () => ({ findMemberByChat: (...a: unknown[]) => m.member(...a) }));
vi.mock('@/lib/chat-cabinet/service', async (orig) => ({
  ...(await orig<typeof import('@/lib/chat-cabinet/service')>()),
  cabinetSectionFor: (...a: unknown[]) => m.section(...a),
  cabinetSearchWaiting: (...a: unknown[]) => m.awaits(...a),
  captureCabinetSearch: (...a: unknown[]) => m.capture(...a),
  dropCabinetSearch: (...a: unknown[]) => m.drop(...a),
}));

const { memberCabinetText, MEMBER_UNCHECKED } = await import('@/lib/chat-cabinet/member-entry');
const { CABINET_TEXT } = await import('@/lib/chat-cabinet/screens');

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

  it('слово меню: чат не менеджера или «не смог проверить» — своим путём (туристу «/start» не «не смог»)', async () => {
    m.member.mockResolvedValue({ outcome: 'none' });
    expect(await memberCabinetText({ channel: 'max', chatId: CHAT, text: 'Входящие' }, deliver().d)).toBe(false);
    m.member.mockResolvedValue({ outcome: 'unavailable' });
    const a = deliver();
    expect(await memberCabinetText({ channel: 'telegram', chatId: CHAT, text: '/start' }, a.d)).toBe(false);
    expect(a.said).toEqual([]);
    expect(m.section).not.toHaveBeenCalled();
  });

  it('один чат у двух команд — своими словами (с блоком 112 при беде), а не «попробуйте ещё раз»', async () => {
    m.member.mockResolvedValue({ outcome: 'ambiguous' });
    const a = deliver();
    expect(await memberCabinetText({ channel: 'max', chatId: CHAT, text: '/start человек упал со скалы, помогите' }, a.d)).toBe(true);
    expect(a.said[0]).toContain('112');
    expect(a.said[0]).toContain(CABINET_TEXT.memberTwoTeams);
    m.awaits.mockResolvedValue(true);
    const b = deliver();
    expect(await memberCabinetText({ channel: 'max', chatId: CHAT, text: 'Петрова' }, b.d)).toBe(true);
    expect(b.said).toEqual([CABINET_TEXT.memberTwoTeams]);
    expect(m.capture).not.toHaveBeenCalled();
  });

  it('поиск (ревью 30.10): ожидание не прочиталось у менеджера — «не смог», запрос дальше не уходит', async () => {
    m.awaits.mockResolvedValue(null);
    const a = deliver();
    expect(await memberCabinetText({ channel: 'max', chatId: CHAT, text: 'Петрова' }, a.d)).toBe(true);
    expect(a.said).toEqual([CABINET_TEXT.searchUnchecked]);
    expect(m.capture).not.toHaveBeenCalled();
    // Не менеджер — туристский путь, как раньше.
    m.member.mockResolvedValue({ outcome: 'none' });
    expect(await memberCabinetText({ channel: 'max', chatId: CHAT, text: 'Петрова' }, deliver().d)).toBe(false);
    // Не известно ни то, ни другое — база лежит: туриста не задерживаем.
    m.member.mockResolvedValue({ outcome: 'unavailable' });
    expect(await memberCabinetText({ channel: 'max', chatId: CHAT, text: 'Петрова' }, deliver().d)).toBe(false);
  });

  it('поиск ждал, а менеджера сняли — поиск гасится, текст никуда не уходит; ждал, менеджер не прочитался — «не смог»', async () => {
    m.awaits.mockResolvedValue(true);
    m.member.mockResolvedValue({ outcome: 'none' });
    const a = deliver();
    expect(await memberCabinetText({ channel: 'max', chatId: CHAT, text: 'Петрова' }, a.d)).toBe(true);
    expect(m.drop).toHaveBeenCalledWith(CHAT);
    expect(a.said).toEqual([CABINET_TEXT.searchGone]);
    m.member.mockResolvedValue({ outcome: 'unavailable' });
    const b = deliver();
    expect(await memberCabinetText({ channel: 'max', chatId: CHAT, text: 'Петрова' }, b.d)).toBe(true);
    expect(b.said).toEqual([MEMBER_UNCHECKED]);
  });

  it('беда и контроль выхода — своим путём при любом исходе проверки', async () => {
    for (const [waiting, outcome] of [[null, 'found'], [true, 'none'], [true, 'unavailable'], [null, 'ambiguous']] as const) {
      m.awaits.mockResolvedValue(waiting);
      m.member.mockResolvedValue(outcome === 'found'
        ? { outcome, member: { memberId: 'm1', label: null, partner: PARTNER } }
        : { outcome });
      const d = deliver();
      expect(await memberCabinetText({ channel: 'max', chatId: CHAT, text: 'человек упал со скалы, помогите' }, d.d), `${waiting}/${outcome}`).toBe(false);
      expect(d.said).toEqual([]);
    }
  });
});

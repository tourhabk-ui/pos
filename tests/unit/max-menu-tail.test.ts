/**
 * Меню только под последним сообщением в MAX (31.10, слово владельца «А:
 * меню только снизу»): новое сообщение со строкой меню снимает её с
 * прежнего, собственные кнопки прежнего остаются, текст присылается тот же.
 *
 * Держится вызовом: узнавание строки меню по payload; модуль памяти;
 * доставка экрана кабинета (`deliverCabinetMax`) и ответ администратора через
 * вебхук MAX целиком — второй ответ правит первый.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const m = vi.hoisted(() => ({
  maxSend: vi.fn(),
  maxEdit: vi.fn(),
  pool: vi.fn(),
  findPartner: vi.fn(),
  findAdmin: vi.fn(),
  adminReply: vi.fn(),
}));

vi.mock('@/lib/max/max-fetch', () => ({
  maxBot: () => ({
    api: {
      sendMessageToChat: m.maxSend, editMessage: m.maxEdit, sendMessageToUser: vi.fn(), answerOnCallback: vi.fn(async () => ({})),
    },
  }),
}));
vi.mock('@/lib/db-pool', () => ({ pool: { query: m.pool } }));
vi.mock('@/lib/kuzmich/core', () => ({ hasLiveBookingFlow: vi.fn(async () => false), processMessage: vi.fn(), cleanupPending: vi.fn() }));
vi.mock('@/lib/kuzmich/operator-chat', () => ({
  PARTNER_EMAIL_BIND_CLOSED: 'привязка по почте закрыта',
  findPartnerByChat: m.findPartner,
  processPartnerMessage: vi.fn(),
}));
vi.mock('@/lib/max/admin-link', async (orig) => ({
  ...(await orig<typeof import('@/lib/max/admin-link')>()),
  findMaxAdmin: m.findAdmin,
}));
vi.mock('@/lib/max/admin-read', async (orig) => ({
  ...(await orig<typeof import('@/lib/max/admin-read')>()),
  adminReplyFor: m.adminReply,
}));

import {
  hasMenuRow, isMenuRow, noteMenuMessage, resetMenuTails, sentMid, TAIL_TTL_MS, withoutMenuRows,
} from '@/lib/max/menu-tail';
import { deliverCabinetMax } from '@/lib/chat-cabinet/max-deliver';
import { noticeScreen } from '@/lib/chat-cabinet/screens';
import { menuRows } from '@/lib/roles/chat-menu';
import { adminMenu, partnerMenu } from '@/lib/roles/role-menu';
import { rentalCabinetBar } from '@/lib/rental/cabinet-bar';

const cb = (payload: string, text = payload) => ({ type: 'callback', text, payload });
const OP_MENU = menuRows(partnerMenu({ partnerId: 'p', category: 'operator', slug: 'op' }) ?? []).map((r) => r.map((b) => cb(b.payload, b.text)));

beforeEach(() => {
  resetMenuTails();
  m.maxSend.mockReset();
  m.maxEdit.mockReset();
  m.maxEdit.mockResolvedValue({ success: true });
});

describe('строка меню узнаётся по payload', () => {
  it('вкладки роли, меню администратора, строка кабинета и проката — меню; прочее — нет', () => {
    for (const row of OP_MENU) expect(isMenuRow(row)).toBe(true);
    for (const row of menuRows(adminMenu())) expect(isMenuRow(row)).toBe(true);
    for (const row of menuRows(rentalCabinetBar())) expect(isMenuRow(row)).toBe(true);
    expect(isMenuRow(noticeScreen('x').rows.flat())).toBe(true);
    for (const p of ['od:o:1', 'cb:i:2', 'cb:o:ld:1', 'cb:n:i', 'dw:t', 'rr:y:1:1', 'opd:seats', 'sup:new']) {
      expect(isMenuRow([cb(p)])).toBe(false);
    }
    // Ряд с действием и вкладкой — не меню: снимать его нельзя.
    expect(isMenuRow([cb('rm:op:in'), cb('od:o:1')])).toBe(false);
    expect(isMenuRow([{ type: 'link', text: 'Кабинет', url: 'https://vedarai.ru' }])).toBe(false);
    expect(isMenuRow([])).toBe(false);
    expect(withoutMenuRows([[cb('od:o:1')], ...OP_MENU])).toEqual([[cb('od:o:1')]]);
    expect(hasMenuRow([[cb('od:o:1')]])).toBe(false);
    expect(sentMid({ body: { mid: 'mid.1' } })).toBe('mid.1');
    expect(sentMid({})).toBeNull();
  });
});

describe('память последнего сообщения со строкой меню', () => {
  const api = { editMessage: (mid: string, extra: unknown) => m.maxEdit(mid, extra) };

  it('второе сообщение снимает строку с первого: текст тот же, свои кнопки остаются', async () => {
    await noteMenuMessage(api, 7, 'a', '<b>Предложение</b>', [[cb('od:o:1', 'Открыть')], ...OP_MENU], 1000);
    expect(m.maxEdit).not.toHaveBeenCalled();
    await noteMenuMessage(api, 7, 'b', 'Ответ', OP_MENU, 2000);
    expect(m.maxEdit).toHaveBeenCalledTimes(1);
    expect(m.maxEdit).toHaveBeenCalledWith('a', {
      text: '<b>Предложение</b>',
      format: 'html',
      attachments: [{ type: 'inline_keyboard', payload: { buttons: [[cb('od:o:1', 'Открыть')]] } }],
    });
    // Третье снимает со второго, где кроме меню ничего: клавиатуры нет вовсе.
    await noteMenuMessage(api, 7, 'c', 'Ещё ответ', OP_MENU, 3000);
    expect(m.maxEdit).toHaveBeenLastCalledWith('b', { text: 'Ответ', format: 'html', attachments: [] });
  });

  it('без строки меню, правка того же сообщения, другой чат — ничего не снимается', async () => {
    await noteMenuMessage(api, 7, 'a', 'Первое', OP_MENU, 1000);
    await noteMenuMessage(api, 7, 'n', 'Уведомление', [[cb('rr:y:1:1', 'Беру')]], 1500);
    await noteMenuMessage(api, 7, 'a', 'Первое, страница 2', OP_MENU, 2000);
    await noteMenuMessage(api, 8, 'z', 'Другой чат', OP_MENU, 2500);
    await noteMenuMessage(api, 7, null, 'Не дошло', OP_MENU, 2600);
    expect(m.maxEdit).not.toHaveBeenCalled();
    // Правленое сообщение запомнено с новым текстом.
    await noteMenuMessage(api, 7, 'b', 'Второе', OP_MENU, 3000);
    expect(m.maxEdit).toHaveBeenCalledWith('a', { text: 'Первое, страница 2', format: 'html', attachments: [] });
  });

  it('старше суток — забыто: текст не держится, строка остаётся как была', async () => {
    await noteMenuMessage(api, 7, 'a', 'Вчера', OP_MENU, 0);
    await noteMenuMessage(api, 7, 'b', 'Сегодня', OP_MENU, TAIL_TTL_MS + 1);
    expect(m.maxEdit).not.toHaveBeenCalled();
  });

  it('отказ MAX не роняет ответ и пишется в лог без текста', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    m.maxEdit.mockRejectedValueOnce(new TypeError('сеть'));
    await noteMenuMessage(api, 7, 'a', 'Иван, +7 900 000-00-00', OP_MENU, 1000);
    await expect(noteMenuMessage(api, 7, 'b', 'Второе', OP_MENU, 2000)).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0]?.[0])).not.toMatch(/Иван|\+7/);
    err.mockRestore();
  });
});

describe('доставка экрана кабинета', () => {
  it('второй экран новым сообщением снимает строку кабинета с первого; правка на месте — нет', async () => {
    m.maxSend.mockResolvedValueOnce({ body: { mid: 's1' } }).mockResolvedValueOnce({ body: { mid: 's2' } });
    const api = { sendMessageToChat: m.maxSend, editMessage: m.maxEdit };
    await deliverCabinetMax(api, 5, noticeScreen('Экран 1'), null);
    await deliverCabinetMax(api, 5, noticeScreen('Экран 1, правка'), 's1');
    expect(m.maxEdit).toHaveBeenCalledTimes(1); // сама правка экрана
    await deliverCabinetMax(api, 5, noticeScreen('Экран 2'), null);
    expect(m.maxEdit).toHaveBeenCalledTimes(2);
    expect(m.maxEdit).toHaveBeenLastCalledWith('s1', { text: 'Экран 1, правка', format: 'html', attachments: [] });
  });
});

describe('вебхук MAX: ответ администратора', () => {
  const KEY = 'test-webhook-key-31-10';
  const ADMIN_USER = 601;
  const ADMIN_CHAT = 9_601;
  const message = (text: string, mid: string) => ({
    update_type: 'message_created',
    timestamp: 1,
    message: { sender: { user_id: ADMIN_USER, name: 'Админ' }, recipient: { chat_id: ADMIN_CHAT, chat_type: 'dialog' }, body: { mid, seq: 1, text, attachments: [] } },
  });

  beforeEach(() => {
    m.pool.mockResolvedValue({ rows: [] });
    m.findPartner.mockResolvedValue({ outcome: 'none' });
    m.findAdmin.mockResolvedValue({ outcome: 'admin', userId: 'u-admin', name: 'Админ' });
    m.adminReply.mockResolvedValue({ text: 'Сводка: заявок 0', pd: false });
    m.maxSend.mockResolvedValueOnce({ body: { mid: 'r1' } }).mockResolvedValueOnce({ body: { mid: 'r2' } });
    vi.stubEnv('MAX_BOT_TOKEN', 'test-token');
    vi.stubEnv('MAX_WEBHOOK_SECRET', KEY);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it('второй ответ с меню снимает меню с первого, текст первого — прежний', async () => {
    const { POST } = await import('@/app/api/max/kuzmich/route');
    const { clearMaxMessageDedup } = await import('@/lib/max/update-dedup');
    clearMaxMessageDedup();
    const url = `http://localhost/api/max/kuzmich?s=${KEY}`;
    await POST(new NextRequest(url, { method: 'POST', body: JSON.stringify(message('сводка', 'u1')) }));
    await POST(new NextRequest(url, { method: 'POST', body: JSON.stringify(message('сводка', 'u2')) }));
    expect(m.maxSend).toHaveBeenCalledTimes(2);
    const first = String(m.maxSend.mock.calls[0]?.[1]);
    expect(m.maxEdit).toHaveBeenCalledTimes(1);
    expect(m.maxEdit).toHaveBeenCalledWith('r1', { text: first, format: 'html', attachments: [] });
    // У второго ответа меню на месте — рядами, по три.
    const kb = (m.maxSend.mock.calls[1]?.[2] as { attachments: Array<{ payload: { buttons: Array<Array<{ payload: string }>> } }> }).attachments[0]!.payload.buttons;
    expect(kb.flat().map((b) => b.payload)).toEqual(adminMenu().map((b) => b.payload));
    for (const row of kb) expect(row.length).toBeLessThanOrEqual(3);
  });
});

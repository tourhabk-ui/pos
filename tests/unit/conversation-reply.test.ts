/**
 * Ответ туристу в чате Ведара из мессенджера партнёра (lib/chat/conversation-reply):
 * право чата, черновик с предпросмотром (маска ПД в Telegram), подписанное
 * «Отправить», ровно одна отправка.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const q = vi.hoisted(() => vi.fn());
const clientQ = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: (...a: unknown[]) => q(...a),
    connect: async () => ({ query: (...a: unknown[]) => clientQ(...a), release: () => undefined }),
  },
}));
const reach = vi.hoisted(() => vi.fn());
vi.mock('@/lib/partners/reach', () => ({ reachForPartner: (...a: unknown[]) => reach(...a) }));
const send = vi.hoisted(() => vi.fn());
vi.mock('@/lib/services/operators/chat.service', () => ({ chatService: { sendMessage: (...a: unknown[]) => send(...a) } }));

import {
  armConvReply, captureConvText, pressConv, convPayload, convPreviewText, parseConvPress, isConvPayload,
} from '@/lib/chat/conversation-reply';
import { isWritePayload, unwrapPress } from '@/lib/chat-cabinet/signed-payload';
import { pressActionOf } from '@/lib/max/verified-press';

const CONV = '11111111-1111-4111-8111-111111111111';
const WAIT = '22222222-2222-4222-8222-222222222222';

function db(opts: { wait?: boolean; draftRow?: boolean } = {}) {
  q.mockImplementation((sql: string) => {
    if (sql.includes('FROM conversation_participants')) {
      return Promise.resolve({ rows: [{ user_id: 'tourist', role: 'tourist' }, { user_id: 'op-user', role: 'operator' }] });
    }
    if (sql.includes('FROM partners')) return Promise.resolve({ rows: [{ id: 'partner-1' }] });
    if (sql.includes('SELECT id::text AS id, conversation_id')) {
      return Promise.resolve({ rows: opts.wait ? [{ id: WAIT, conversation_id: CONV }] : [] });
    }
    if (sql.includes("SET status = 'draft'")) return Promise.resolve({ rowCount: 1, rows: [] });
    if (sql.includes("SET status = 'used'") || sql.includes("SET status = 'cancelled'")) {
      return Promise.resolve({ rowCount: opts.draftRow ? 1 : 0, rows: opts.draftRow ? [{ conversation_id: CONV, draft_text: 'Звоните +7 914 123-45-67', sender_user_id: 'op-user' }] : [] });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  reach.mockResolvedValue({ telegramChatId: '55', maxChatId: '77', reachable: true });
  clientQ.mockResolvedValue({ rows: [], rowCount: 0 });
  send.mockResolvedValue({ id: 'm1' });
});

describe('кнопки', () => {
  it('«Отправить» — запись (подпись), «Ответить» и «Отменить» — нет; MAX ведёт в полосу переписки', () => {
    expect(isWritePayload(convPayload('send', WAIT))).toBe(true);
    expect(isWritePayload(convPayload('reply', CONV))).toBe(false);
    expect(isWritePayload(convPayload('cancel', WAIT))).toBe(false);
    expect(parseConvPress(convPayload('send', WAIT))).toEqual({ action: 'send', id: WAIT });
    expect(isConvPayload('cv:r:' + CONV)).toBe(true);
    expect(pressActionOf('cv:r:' + CONV)).toBe('request_chat');
  });

  it('предпросмотр в Telegram скрывает телефон, в MAX — как написан', () => {
    expect(convPreviewText('Звоните +7 914 123-45-67', 'telegram')).not.toContain('123-45-67');
    expect(convPreviewText('Звоните +7 914 123-45-67', 'max')).toContain('123-45-67');
  });
});

describe('armConvReply', () => {
  it('чужой чат — ничего не заводит', async () => {
    db();
    const r = await armConvReply(CONV, 999, 'telegram');
    expect(r.text).toContain('не ваша');
    expect(clientQ).not.toHaveBeenCalled();
  });

  it('свой Telegram — ожидание заведено, прежние ожидания чата погашены', async () => {
    db();
    const r = await armConvReply(CONV, 55, 'telegram');
    expect(r.text).toContain('Напишите ответ');
    const sqls = clientQ.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes('UPDATE request_chat_waits'))).toBe(true);
    expect(sqls.some((s) => s.includes('INSERT INTO conversation_reply_waits'))).toBe(true);
  });
});

describe('captureConvText → pressConv', () => {
  it('нет ожидания — текст идёт своим путём', async () => {
    db();
    expect(await captureConvText(55, 'привет', 'telegram')).toBeNull();
  });

  it('текст → черновик: туристу ничего не ушло, «Отправить» подписано', async () => {
    db({ wait: true });
    const r = await captureConvText(55, 'Звоните +7 914 123-45-67', 'telegram');
    expect(send).not.toHaveBeenCalled();
    expect(r?.text).not.toContain('123-45-67');
    const sendBtn = r!.buttons.find((b) => b.text === 'Отправить')!;
    const un = unwrapPress(sendBtn.payload);
    expect(un.ok && un.payload).toBe(convPayload('send', WAIT));
  });

  it('«Отправить» — одно сообщение от партнёра; повтор — ничего', async () => {
    db({ draftRow: true });
    const r = await pressConv(convPayload('send', WAIT), 55, 'telegram');
    expect(r.text).toContain('Отправил');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ conversationId: CONV, senderId: 'op-user', content: 'Звоните +7 914 123-45-67' });
    db({ draftRow: false });
    const again = await pressConv(convPayload('send', WAIT), 55, 'telegram');
    expect(again.text).toContain('Ничего не отправил');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('«Отправить» из чата, который больше не привязан, — не отправляет', async () => {
    db({ draftRow: true });
    reach.mockResolvedValue({ telegramChatId: '56', maxChatId: '77', reachable: true });
    const r = await pressConv(convPayload('send', WAIT), 55, 'telegram');
    expect(r.text).toContain('не ваша');
    expect(send).not.toHaveBeenCalled();
  });
});

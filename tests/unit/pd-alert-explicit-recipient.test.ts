/**
 * Названный получатель ПД — только его адрес, без отката на рабочий чат
 * платформы (обзор ветки 29.09).
 *
 * Шапка sendPdAlert обещала это давно, а код при `to.maxChatId == null`
 * молча брал MAX_OPERATOR_CHAT_ID: оператор с одним Telegram (штатное
 * состояние) не получал НИЧЕГО, а имя и телефон туриста уходили в чат
 * платформы и числились доставленными в MAX. Зеркально — заглушка при отказе
 * MAX у оператора без Telegram уходила в TELEGRAM_CHAT_ID платформы.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const maxSendMock = vi.hoisted(() => vi.fn<(chatId: string | number, text: string) => Promise<{ ok: boolean; error?: string }>>());
vi.mock('@/lib/notifications/max-channel', () => ({ maxSendDm: (c: string | number, t: string) => maxSendMock(c, t) }));

import { sendPdAlert } from '@/lib/notifications/pd-alert';

const fetchMock = vi.fn<(url: string, init?: { body?: string }) => Promise<{ ok: boolean; status: number }>>();

beforeEach(() => {
  vi.stubEnv('MAX_OPERATOR_CHAT_ID', '999');
  vi.stubEnv('TELEGRAM_CHAT_ID', '-100500');
  vi.stubEnv('TELEGRAM_BOT_TOKEN', 'tok');
  vi.stubEnv('MAX_CHANNEL_ID', '');
  maxSendMock.mockReset();
  maxSendMock.mockResolvedValue({ ok: true });
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 200 });
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const tgChat = (): string | undefined => {
  const body = fetchMock.mock.calls[0]?.[1]?.body;
  return body ? (JSON.parse(body) as { chat_id: string }).chat_id : undefined;
};

describe('sendPdAlert: названный получатель', () => {
  it('у оператора только Telegram: ПД НЕ уходят в чат платформы, оператору идёт заглушка', async () => {
    const r = await sendPdAlert({ text: 'Иван +7900', stub: 'бронь #1', to: { maxChatId: null, telegramChatId: '5' } });
    expect(maxSendMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tgChat()).toBe('5');
    expect(r).toMatchObject({ channel: 'telegram-stub', delivered: false, reason: 'у получателя нет max_chat_id' });
  });

  it('у оператора только MAX и MAX отказал: заглушка не уходит в чат платформы, исход none', async () => {
    maxSendMock.mockResolvedValue({ ok: false, error: 'HTTP 500' });
    const r = await sendPdAlert({ text: 'Иван +7900', stub: 'бронь #1', to: { maxChatId: '7', telegramChatId: null } });
    expect(maxSendMock).toHaveBeenCalledWith('7', 'Иван +7900');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r.channel).toBe('none');
    expect(r.delivered).toBe(false);
  });

  it('есть оба адреса: ПД в MAX оператора, не в чат платформы', async () => {
    const r = await sendPdAlert({ text: 'Иван +7900', stub: 'бронь #1', to: { maxChatId: '7', telegramChatId: '5' } });
    expect(maxSendMock).toHaveBeenCalledWith('7', 'Иван +7900');
    expect(r).toMatchObject({ channel: 'max', delivered: true });
  });

  it('адресат не назван — прежнее поведение: рабочий чат платформы', async () => {
    await sendPdAlert({ text: 'Иван +7900', stub: 'бронь #1' });
    expect(maxSendMock).toHaveBeenCalledWith('999', 'Иван +7900');
    maxSendMock.mockResolvedValue({ ok: false, error: 'x' });
    await sendPdAlert({ text: 'Иван +7900', stub: 'бронь #1' });
    expect(tgChat()).toBe('-100500');
  });

  it('адрес получателя совпадает с публичным каналом MAX — отказ и здесь', async () => {
    vi.stubEnv('MAX_CHANNEL_ID', '7');
    const r = await sendPdAlert({ text: 'Иван +7900', stub: 's', to: { maxChatId: '7', telegramChatId: null } });
    expect(maxSendMock).not.toHaveBeenCalled();
    expect(r.reason).toMatch(/публичным MAX_CHANNEL_ID/);
  });
});

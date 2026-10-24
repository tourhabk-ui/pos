/**
 * Ответ бота не разворачивает большую карточку ссылки поверх текста.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { telegramService } from '@/lib/notifications/telegram';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('превью ссылки в Telegram', () => {
  it('sendMessage выключает карточку ссылки', async () => {
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true, result: { message_id: 3 } }) }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'token');
    const res = await telegramService.sendMessage({ chatId: '1', text: 'https://vedarai.ru/tours/k-vulkanu' });
    expect(res.success).toBe(true);
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as { body: string }).body)) as {
      disable_web_page_preview?: boolean;
      link_preview_options?: { is_disabled?: boolean };
    };
    expect(body.disable_web_page_preview).toBe(true);
    expect(body.link_preview_options?.is_disabled).toBe(true);
  });
});

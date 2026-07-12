/**
 * Регрессия issue #27: AI Спасатель при отказе всех провайдеров.
 *
 * callAIWaterfall не кидает исключение — возвращает sentinel-строку
 * «Извините, сервис временно недоступен...». Роут обязан детектить её и
 * отвечать 503, иначе клиент покажет её как обычный текст AI и локальный
 * протокол выживания (медведь, травма, заблудился) не сработает.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const callAIWaterfallMock = vi.fn();

vi.mock('@/lib/ai/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/providers')>();
  return {
    ...actual,
    callAIWaterfall: (...args: unknown[]) => callAIWaterfallMock(...args),
  };
});

vi.mock('@/lib/ai/provider-config', () => ({
  getOpenRouterKey: () => null,
}));

vi.mock('@/lib/rate-limit', () => ({
  createRateLimiter: () => ({ check: () => true }),
  getClientIp: () => '203.0.113.1',
}));

import { POST } from '@/app/api/safety/rescue-chat/route';

function makeRequest(message: string): NextRequest {
  return new NextRequest('http://localhost/api/safety/rescue-chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, stream: false }),
  });
}

describe('rescue-chat: фолбэк при отказе провайдеров', () => {
  beforeEach(() => {
    callAIWaterfallMock.mockReset();
  });

  it('sentinel waterfall -> 503 с номерами экстренных служб (не 200)', async () => {
    callAIWaterfallMock.mockResolvedValue('Извините, сервис временно недоступен. Попробуйте позже.');
    const res = await POST(makeRequest('Встретил медведя'));
    expect(res.status).toBe(503);
    const json = await res.json() as { error: string };
    expect(json.error).toContain('112');
  });

  it('исключение waterfall -> 503 с номерами', async () => {
    callAIWaterfallMock.mockRejectedValue(new Error('boom'));
    const res = await POST(makeRequest('Заблудился'));
    expect(res.status).toBe(503);
    const json = await res.json() as { error: string };
    expect(json.error).toContain('112');
  });

  it('нормальный ответ AI -> 200 { reply }', async () => {
    callAIWaterfallMock.mockResolvedValue('1. Не беги. 2. Говори громко.');
    const res = await POST(makeRequest('Встретил медведя'));
    expect(res.status).toBe(200);
    const json = await res.json() as { reply: string };
    expect(json.reply).toContain('Не беги');
  });
});

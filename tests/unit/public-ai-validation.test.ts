/**
 * tests/unit/public-ai-validation.test.ts
 *
 * Публичный /api/ai (аудит п.3): Zod-схема prompt/input, обрезка до 800,
 * формы через formData.get() (раньше form-поля терялись → всегда EMPTY).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const { waterfallMock } = vi.hoisted(() => ({ waterfallMock: vi.fn() }));
vi.mock('@/lib/ai/providers', () => ({ callAIWaterfall: (...a: unknown[]) => waterfallMock(...a) }));
vi.mock('@/lib/rate-limit', () => ({
  createRateLimiter: () => ({ check: () => true }),
  getClientIp: () => '1.2.3.4',
}));

import { POST } from '@/app/api/ai/route';

function jsonReq(body: unknown): NextRequest {
  return new Request('http://l/api/ai', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function formReq(fields: Record<string, string>): NextRequest {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return new Request('http://l/api/ai', { method: 'POST', body: fd }) as unknown as NextRequest;
}

beforeEach(() => {
  waterfallMock.mockReset();
  waterfallMock.mockResolvedValue('ответ');
});

describe('POST /api/ai', () => {
  it('json prompt → 200, вопрос дошёл до waterfall', async () => {
    const res = await POST(jsonReq({ prompt: 'где увидеть медведя' }));
    expect(res.status).toBe(200);
    const msgs = waterfallMock.mock.calls[0][0] as Array<{ role: string; content: string }>;
    expect(msgs.find(m => m.role === 'user')?.content).toBe('где увидеть медведя');
  });

  it('formData prompt → 200 (раньше form-поля терялись)', async () => {
    const res = await POST(formReq({ prompt: 'вулканы рядом' }));
    expect(res.status).toBe(200);
    expect(waterfallMock).toHaveBeenCalled();
  });

  it('пусто / без полей → 400 EMPTY, waterfall не зовётся', async () => {
    expect((await POST(jsonReq({}))).status).toBe(400);
    expect((await POST(jsonReq({ prompt: '   ' }))).status).toBe(400);
    expect(waterfallMock).not.toHaveBeenCalled();
  });

  it('длинный prompt обрезается до 800, а не отвергается', async () => {
    const res = await POST(jsonReq({ prompt: 'а'.repeat(5000) }));
    expect(res.status).toBe(200);
    const msgs = waterfallMock.mock.calls[0][0] as Array<{ role: string; content: string }>;
    expect(msgs.find(m => m.role === 'user')?.content.length).toBe(800);
  });

  it('поле input поддерживается (истор. совместимость)', async () => {
    const res = await POST(jsonReq({ input: 'паратунка' }));
    expect(res.status).toBe(200);
  });
});

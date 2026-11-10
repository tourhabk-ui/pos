// @vitest-environment node
/**
 * Помощник на экране плана (#3199, (в)-3, вариант Б).
 *
 * POST /api/planner/companion — модель без инструментов. Прежде она получала
 * текст человека и контекст плана как есть (телефон и почта уходили за
 * рубеж), а подсказка заказывала выдумку: градусы по сезонам, часы переезда
 * между зонами и «назови диапазон цен». Сторож — вызовом роута с подменённой
 * моделью: что увидела модель, что вернул роут, и блок 112 при признаках ЧП.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

type Msg = { role: string; content: string };
const sent: Msg[][] = [];
let fail = false;
vi.mock('@/lib/ai/providers', () => ({
  callAIWithModelDirect: vi.fn(async (messages: Msg[]) => {
    sent.push(messages);
    if (fail) throw new Error('провайдер недоступен');
    return 'Возьмите дождевик.';
  }),
}));
vi.mock('@/lib/ai/agent-models', () => ({ getModelForAgent: () => null }));

import { POST } from '@/app/api/planner/companion/route';

const PHONE = '+70000000000';
const EMAIL = 'test@example.com';
let ipSeq = 0;
const ask = (body: unknown) => POST(new NextRequest('http://localhost/api/planner/companion', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-real-ip': `10.7.0.${++ipSeq}` },
  body: JSON.stringify(body),
}));

beforeEach(() => { sent.length = 0; fail = false; });

describe('/api/planner/companion — граница ПД', () => {
  it('телефон и почта из вопроса и контекста модели не уходят', async () => {
    const res = await ask({
      message: `Что взять? Мой номер ${PHONE}, почта ${EMAIL}`,
      context: `День 1: Авачинский перевал. Контакт ${PHONE}`,
    });
    expect(res.status).toBe(200);
    const seen = JSON.stringify(sent[0]);
    expect(seen).not.toContain('0000000000');
    expect(seen).not.toContain(EMAIL);
    expect(seen).toContain('Авачинский перевал');
  });
});

describe('/api/planner/companion — подсказка не заказывает выдумку', () => {
  it('нет зашитых градусов, часов переезда и «назови диапазон»', async () => {
    await ask({ message: 'Какая погода в августе?' });
    const system = sent[0]!.find((m) => m.role === 'system')!.content;
    expect(system).not.toMatch(/\+10\.\.\+20|-15\.\.-25/);
    expect(system).not.toMatch(/5-7 часов/);
    expect(system).not.toMatch(/назови диапазон/i);
    expect(system).toMatch(/НЕ называй/);
  });
});

describe('/api/planner/companion — ЧП', () => {
  it('при отказе модели человек в беде получает 112', async () => {
    fail = true;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await ask({ message: 'Помогите, человек упал в расщелину, травма' });
    const body = (await res.json()) as { reply?: string; emergency?: boolean };
    expect(res.status).toBe(200);
    expect(body.emergency).toBe(true);
    expect(body.reply).toContain('112');
    expect(spy.mock.calls.some((c) => String(c[0]).includes('[planner-companion]'))).toBe(true);
    spy.mockRestore();
  });
});

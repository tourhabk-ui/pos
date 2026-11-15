/**
 * POST /api/planner/validate (разбор планера 14.11, экран-5, -6): правильный
 * план движка не получает «нужен переезд», сезон — по дате дня, слова — по-
 * русски, без обещания брони; план длиннее 21 дня проверяется.
 *
 * Судится ответ настоящего обработчика (CLAUDE.md §4).
 */
import { describe, it, expect, vi } from 'vitest';
// Планер — только после входа (14.11, «6-3»): здесь проверяется сам роут,
// вход держит tests/unit/planner-api-login.test.ts.
vi.mock('@/lib/planner/require-session', () => ({ plannerSession: vi.fn(async () => ({ userId: 'u-planner' })) }));
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/planner/validate/route';

let ip = 0;
async function validate(body: Record<string, unknown>) {
  ip += 1;
  const res = await POST(new NextRequest('http://localhost/api/planner/validate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': `10.77.${Math.floor(ip / 250)}.${ip % 250}` },
    body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() as { success: boolean; valid?: boolean; message?: string; issues?: Array<{ type: string; message: string; day?: number }> } };
}

const d = (day: number, type: string, zone: string, activityType: string, title: string, defaultTransport = 'walking') =>
  ({ day, type, zone, activityType, title, defaultTransport });

describe('план движка с переездом', () => {
  const PLAN = [
    d(1, 'arrival', 'avachinsky', 'hot_spring', 'Прилёт'),
    d(2, 'travel', 'avachinsky', 'travel', 'Переезд: Авачинская зона → Восточная зона', 'jeep'),
    d(3, 'activity', 'eastern', 'bears', 'Медведи', 'jeep'),
    d(4, 'travel', 'avachinsky', 'travel', 'Возвращение', 'jeep'),
    d(5, 'departure', 'avachinsky', 'departure', 'Вылет'),
  ];

  it('день переезда — не занятие: «нужен переезд» нет', async () => {
    const { body } = await validate({ days: PLAN, arrivalDate: '2027-07-10' });
    expect(body.success).toBe(true);
    expect(body.issues?.some((i) => i.type === 'missing_travel_day')).toBe(false);
  });

  it('день отдыха движка (вид «источники», тип rest) — не занятие: судит тип дня', async () => {
    const { body } = await validate({
      days: [d(1, 'activity', 'eastern', 'bears', 'Медведи', 'jeep'), d(2, 'rest', 'avachinsky', 'hot_spring', 'День отдыха')],
      arrivalDate: '2027-07-10',
    });
    expect(body.issues?.some((i) => i.type === 'missing_travel_day')).toBe(false);
  });

  it('слова по-русски, без ключей движка и без «бронирования»', async () => {
    const { body } = await validate({ days: PLAN, arrivalDate: '2027-07-10', fitnessLevel: 'beginner', children: [3], seasickness: true });
    const text = [body.message, ...(body.issues ?? []).map((i) => i.message)].join(' | ');
    expect(text).not.toMatch(/"bears"|avachinsky|eastern|"active"|"beginner"|бронирован/);
    expect(text).toMatch(/медведи/i);
  });

  it('два занятия в разных зонах подряд — переезд нужен, зоны названы словами', async () => {
    const { body } = await validate({ days: [d(1, 'activity', 'avachinsky', 'volcano', 'Вулкан'), d(2, 'activity', 'eastern', 'bears', 'Медведи')], arrivalDate: '2027-07-10' });
    const travel = body.issues?.find((i) => i.type === 'missing_travel_day');
    expect(travel?.message).toContain('Авачинская зона → Восточная зона');
  });
});

describe('сезон — по дате дня', () => {
  it('поездка с 28.09: треккинг 30.09 в сезоне, 2.10 — нет', async () => {
    const { body } = await validate({
      days: [d(1, 'activity', 'avachinsky', 'trekking', 'Тропа А'), d(3, 'activity', 'avachinsky', 'trekking', 'Тропа Б'), d(5, 'activity', 'avachinsky', 'trekking', 'Тропа В')],
      arrivalDate: '2027-09-28',
    });
    const off = (body.issues ?? []).filter((i) => i.type === 'out_of_season' || i.type === 'seasonal_block').map((i) => i.day);
    expect(off).toEqual([5]);
    expect(body.issues?.find((i) => i.day === 5)?.message).toContain('октябре');
  });
});

describe('длина плана', () => {
  it('план на 30 дней проверяется, а не отвечает 400', async () => {
    const days = Array.from({ length: 30 }, (_, i) => d(i + 1, 'activity', 'avachinsky', 'hot_spring', `День ${i + 1}`));
    const { status, body } = await validate({ days, arrivalDate: '2027-07-01' });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });
});

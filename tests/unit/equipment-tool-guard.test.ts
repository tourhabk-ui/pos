/**
 * /api/tools/equipment — открытый AI-эндпоинт под защитой.
 *
 * Каждый запрос — платный вызов LLM. Без лимита эндпоинт можно долбить
 * анонимно, оплачивая наши токены; с ростом трафика на подготовку к походу
 * (план Field Confidence Navigator, этап 4) это станет дырой в бюджете.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(
  join(process.cwd(), 'app/api/tools/equipment/route.ts'),
  'utf-8',
);

describe('equipment tool под rate-limit', () => {
  it('лимитер создан и проверяется до работы', () => {
    expect(src).toMatch(/createRateLimiter\(/);
    expect(src).toMatch(/limiter\.check\(getClientIp\(request\.headers\)\)/);
  });

  it('отказ — 429 с понятным русским текстом', () => {
    expect(src).toMatch(/status: 429/);
    expect(src).toMatch(/Слишком много запросов/);
  });

  it('вход по-прежнему валидируется Zod до запроса в БД', () => {
    expect(src).toMatch(/BodySchema\.safeParse/);
    expect(src).toMatch(/z\.object/);
  });
});

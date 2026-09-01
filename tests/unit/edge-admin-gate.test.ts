// @vitest-environment node
/**
 * Сторож Edge-гейта /api/admin (периметр, часть 2, 01.09).
 *
 * ── Что держит ───────────────────────────────────────────────────────────
 *
 * До 01.09 '/api/admin' стоял в PUBLIC_API_ROUTES как 'ALL', и middleware
 * отпускал анонима на публичном пропуске РАНЬШЕ RBAC. Правило
 * '/api/admin': 'admin' в API_ROLE_REQUIREMENTS было декоративным: читающий
 * рассчитывал на него, а исполнялось оно никогда. Аудит 01.09 нашёл это по
 * реестру; проверка по коду подтвердила.
 *
 * Тест ИСПОЛНЯЕТ middleware настоящими запросами, а не читает его текст:
 * структурная проверка «строка есть» повторила бы ту же ошибку — правило
 * есть, до него не доходит очередь.
 *
 * Ответ «пропущен» у middleware — NextResponse.next(), у него заголовок
 * x-middleware-next: 1. Всё прочее — отказ со статусом.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';
import { createToken } from '@/lib/auth/jwt';
import { isPublicApiPath } from '@/lib/auth/public-api-routes';

const JWT_SECRET = 'test-secret-at-least-32-bytes-long-000';
const CRON_SECRET = 'cron-secret-for-edge-gate-test-0123456789';

beforeAll(() => {
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.CRON_SECRET = CRON_SECRET;
  // Без Upstash лимитер на Edge выключен — тест про гейт, не про лимит.
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

async function run(path: string, init?: { headers?: Record<string, string>; method?: string }) {
  const { middleware } = await import('../../middleware');
  const req = new NextRequest(`https://vedarai.ru${path}`, {
    method: init?.method ?? 'GET',
    headers: init?.headers,
  });
  return middleware(req);
}

const passed = (res: Response) => res.headers.get('x-middleware-next') === '1';

describe('реестр: /api/admin больше не публичен', () => {
  it('ни один метод /api/admin/* не считается публичным', () => {
    for (const m of ['GET', 'POST', 'PUT', 'DELETE']) {
      expect(isPublicApiPath('/api/admin/health/kuzmich-grounding', m)).toBe(false);
      expect(isPublicApiPath('/api/admin', m)).toBe(false);
    }
  });
});

describe('Edge-гейт /api/admin', () => {
  it('аноним без заголовка — 401, не пропуск', async () => {
    const res = await run('/api/admin/health/kuzmich-grounding');
    expect(passed(res)).toBe(false);
    expect(res.status).toBe(401);
  });

  it('CRON_SECRET в заголовке Authorization: Bearer — пропуск', async () => {
    const res = await run('/api/admin/health/kuzmich-grounding', {
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    });
    expect(passed(res)).toBe(true);
  });

  it('CRON_SECRET параметром ?secret= — НЕ пропуск (401)', async () => {
    // Параметр оседает в access-логах; на Edge он не читается вовсе.
    const res = await run(`/api/admin/health/kuzmich-grounding?secret=${CRON_SECRET}`);
    expect(passed(res)).toBe(false);
    expect(res.status).toBe(401);
  });

  it('чужой Bearer — 401', async () => {
    const res = await run('/api/admin/health/kuzmich-grounding', {
      headers: { authorization: 'Bearer not-the-secret-and-not-a-jwt' },
    });
    expect(passed(res)).toBe(false);
    expect(res.status).toBe(401);
  });

  it('cookie с admin-JWT — пропуск (RBAC достижим)', async () => {
    const token = await createToken({ userId: 'a1', email: 'admin@vedarai.ru', role: 'admin' });
    const res = await run('/api/admin/health/kuzmich-grounding', {
      headers: { cookie: `auth_token=${token}` },
    });
    expect(passed(res)).toBe(true);
  });

  it('cookie с JWT туриста — 403 (RBAC теперь работает)', async () => {
    const token = await createToken({ userId: 't1', email: 'tourist@vedarai.ru', role: 'tourist' });
    const res = await run('/api/admin/health/kuzmich-grounding', {
      headers: { cookie: `auth_token=${token}` },
    });
    expect(passed(res)).toBe(false);
    expect(res.status).toBe(403);
  });

  it('POST без входа — 401 (ALL-пропуск снят целиком, не только GET)', async () => {
    const res = await run('/api/admin/operators/create', { method: 'POST' });
    expect(res.status).toBe(401);
  });
});

describe('что НЕ менялось — зафиксировано, чтобы не сломать молча', () => {
  it('/api/cron остаётся публичным на Edge: проверка внутри хендлера', async () => {
    // Осознанно: внешние планировщики вне репозитория, и как они передают
    // секрет — «не знаю» (§4.0). Сторож api-guard-before-action держит проверку
    // внутри каждого cron-роута. Ужесточать Edge здесь — только после следа.
    const res = await run('/api/cron/watchdog');
    expect(passed(res)).toBe(true);
  });

  it('SOS остаётся публичным', async () => {
    const res = await run('/api/safety/sos', { method: 'POST' });
    expect(passed(res)).toBe(true);
  });
});

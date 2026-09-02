/**
 * Сторож #1485: тревога, которую система «знает», доходит до адресата.
 *
 * ── Что было ─────────────────────────────────────────────────────────────
 *
 * Watchdog 30.08: «push-канал: 0 подписчиков», сейсмо-крон отставал на 250
 * минут. Механика при этом целая: service worker, VAPID, подписка в браузере,
 * broadcast. Разбор 02.09 нашёл ноль этажом выше кода подписки — на Edge:
 * хендлер /api/push/subscribe открыли гостю 02.08 (его шапка это и говорит),
 * а в PUBLIC_API_ROUTES путь не внесли. Гость на публичной /safety жал
 * «Включить», браузер подписывался, POST получал 401 ДО хендлера, в БД не
 * ложилось ничего. При следующем заходе кнопка находила подписку браузера и
 * показывала «Уведомления включены». Ровно тем, кто хотел подписаться, она
 * врала.
 *
 * Сторож держит четыре вещи:
 *   1. реестр: POST/DELETE /api/push/subscribe публичны;
 *   2. кнопка: отказ сервера снимает подписку браузера и говорит об этом;
 *   3. хендлер: без requireAuth, с лимитом, отказ INSERT — в лог, не в тишину;
 *   4. здоровье доставки на /hub/admin/health: каждое число троично — отказ
 *      запроса не превращается в ноль.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isPublicApiPath } from '@/lib/auth/public-api-routes';

const poolQueryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => poolQueryMock(...args) },
}));

import { computeAlertDeliveryHealth } from '@/lib/services/safety/alert-delivery-health';

const ROOT = process.cwd();
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const read = (p: string) => strip(readFileSync(join(ROOT, p), 'utf8'));

describe('1. Edge: подписка на предупреждения открыта гостю', () => {
  it('POST и DELETE публичны, GET — нет', () => {
    expect(isPublicApiPath('/api/push/subscribe', 'POST')).toBe(true);
    expect(isPublicApiPath('/api/push/subscribe', 'DELETE')).toBe(true);
    expect(isPublicApiPath('/api/push/subscribe', 'GET')).toBe(false);
  });

  it('перепись публичных fetch больше не числит подписку «привязанной к аккаунту»', () => {
    const census = readFileSync(join(ROOT, 'tests/unit/public-fetch-edge.test.ts'), 'utf8');
    expect(census).not.toMatch(/^\s*'POST \/api\/push\/subscribe'/m);
    expect(census).not.toMatch(/^\s*'DELETE \/api\/push\/subscribe'/m);
  });
});

describe('2. Кнопка не врёт после отказа сервера', () => {
  const src = read('components/PWA/PushSubscribeButton.tsx');

  it('есть третье состояние failed', () => {
    expect(src).toMatch(/'failed'/);
  });

  it('при !res.ok подписка браузера снимается, а не остаётся «включённой»', () => {
    const at = src.indexOf('if (!res.ok)');
    expect(at).toBeGreaterThan(0);
    const branch = src.slice(at, at + 400);
    expect(branch).toMatch(/sub\.unsubscribe\(\)/);
    expect(branch).toMatch(/setState\('failed'\)/);
  });
});

describe('3. Хендлер: аноним, лимит, отказ не глушится', () => {
  const src = read('app/api/push/subscribe/route.ts');

  it('без requireAuth/requireAdmin — подписка анонимна по замыслу', () => {
    expect(src).not.toMatch(/\brequire(Auth|Admin|Role)\s*\(/);
  });

  it('лимит на IP стоит до записи', () => {
    expect(src).toMatch(/createRateLimiter\(/);
    expect(src.indexOf('limiter.check(')).toBeLessThan(src.indexOf('INSERT INTO push_subscriptions'));
  });

  it('отказ INSERT — в лог со SQLSTATE и человеческий ответ, не 500 молча', () => {
    const at = src.indexOf('INSERT INTO push_subscriptions');
    const around = src.slice(at, at + 900);
    expect(around).toMatch(/catch\s*\(err\)/);
    expect(around).toMatch(/console\.error\([^)]*SQLSTATE/);
    expect(around).toMatch(/status:\s*503/);
  });
});

describe('4. Здоровье доставки: три исхода у каждого числа', () => {
  beforeEach(() => {
    poolQueryMock.mockReset();
  });

  const bySql = (handlers: Record<string, () => Promise<unknown>>) => {
    poolQueryMock.mockImplementation((sql: unknown) => {
      const text = String(sql);
      for (const [key, h] of Object.entries(handlers)) {
        if (text.includes(key)) return h();
      }
      return Promise.reject(new Error(`unexpected SQL: ${text.slice(0, 60)}`));
    });
  };

  it('все запросы упали — все числа null, ok null, причина названа, лог написан', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    poolQueryMock.mockRejectedValue(Object.assign(new Error('relation does not exist'), { code: '42P01' }));
    const h = await computeAlertDeliveryHealth();
    expect(h.subscriptions.count).toBeNull();
    expect(h.subscriptions.reason).toMatch(/не выполнился/);
    expect(h.last_ingest.age_minutes).toBeNull();
    expect(h.notified_24h.alerts).toBeNull();
    expect(h.undelivered.count).toBeNull();
    expect(h.ok).toBeNull();
    expect(errSpy).toHaveBeenCalledTimes(4);
    expect(String(errSpy.mock.calls[0]?.[0])).toContain('42P01');
    errSpy.mockRestore();
  });

  it('измеренный ноль подписок и ни одного прогона — ok false, не null', async () => {
    bySql({
      'FROM push_subscriptions': () => Promise.resolve({ rows: [{ n: '0' }] }),
      'FROM agent_run_history': () => Promise.resolve({ rows: [] }),
      'FROM safety_decision_events': () => Promise.resolve({ rows: [{ alerts: '0', sent: '0', failed: '0' }] }),
      'FROM external_alerts': () => Promise.resolve({ rows: [{ n: '0' }] }),
    });
    const h = await computeAlertDeliveryHealth();
    expect(h.subscriptions.count).toBe(0);
    expect(h.last_ingest.stale).toBe(true);
    expect(h.last_ingest.reason).toMatch(/ни одного прогона/);
    expect(h.ok).toBe(false);
  });

  it('подписки есть, приём свежий, недоставленных нет — ok true', async () => {
    const now = new Date('2026-09-02T02:00:00Z');
    bySql({
      'FROM push_subscriptions': () => Promise.resolve({ rows: [{ n: '3' }] }),
      'FROM agent_run_history': () => Promise.resolve({ rows: [{ started_at: new Date('2026-09-02T01:55:00Z'), status: 'success' }] }),
      'FROM safety_decision_events': () => Promise.resolve({ rows: [{ alerts: '2', sent: '6', failed: '0' }] }),
      'FROM external_alerts': () => Promise.resolve({ rows: [{ n: '0' }] }),
    });
    const h = await computeAlertDeliveryHealth(now);
    expect(h.last_ingest.age_minutes).toBe(5);
    expect(h.last_ingest.stale).toBe(false);
    expect(h.notified_24h).toEqual({ alerts: 2, sent: 6, failed: 0, reason: null });
    expect(h.ok).toBe(true);
  });

  it('один запрос упал — остальные числа живы, ok неизвестен', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    bySql({
      'FROM push_subscriptions': () => Promise.resolve({ rows: [{ n: '3' }] }),
      'FROM agent_run_history': () => Promise.reject(new Error('timeout')),
      'FROM safety_decision_events': () => Promise.resolve({ rows: [{ alerts: '1', sent: '3', failed: '0' }] }),
      'FROM external_alerts': () => Promise.resolve({ rows: [{ n: '0' }] }),
    });
    const h = await computeAlertDeliveryHealth();
    expect(h.subscriptions.count).toBe(3);
    expect(h.last_ingest.stale).toBeNull();
    expect(h.ok).toBeNull();
    errSpy.mockRestore();
  });
});

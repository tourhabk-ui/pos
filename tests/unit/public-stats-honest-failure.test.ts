/**
 * `GET /api/public/stats`: отказ называется отказом, а не нулями.
 *
 * ── Повод ─────────────────────────────────────────────────────────────────
 *
 * Прежний `catch` отдавал HTTP 200, четыре нуля в `stats` и текст ошибки
 * PostgreSQL в поле `error`. Три беды сразу: измеримое утверждение о платформе
 * («ни одного разговора, ни одного маршрута, ни одного агента, ни одного
 * SOS») делалось из ничего и было неотличимо от правды; наружу уходило
 * сообщение БД; в лог не писалось ничего, и отказ был невидим.
 *
 * Кэш здесь — часть дефекта, а не деталь: `unstable_cache` кладёт ЗНАЧЕНИЕ, и
 * пустышка залегла бы на пять минут, переживая восстановление базы. Поэтому
 * отказ обязан БРОСАТЬ — отклонённое обещание не кэшируется.
 *
 * ── Что держит сторож ─────────────────────────────────────────────────────
 *
 * Поведение: успех — 200 с числами; отказ — НЕ 200, без `stats`, без текста
 * ошибки БД, со строкой в логе и SQLSTATE. И связку с кэшем: кэшируемая
 * функция на отказе бросает, а не возвращает нули.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const poolQueryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => poolQueryMock(...args) },
}));
// unstable_cache в тестовой среде — прозрачная обёртка: кэш Next здесь не
// работает, а проверяем мы именно ФОРМУ отказа и то, что он пролетает наружу.
vi.mock('next/cache', () => ({
  unstable_cache: (fn: (...a: unknown[]) => unknown) => fn,
}));

import { GET as stats } from '@/app/api/public/stats/route';

const SRC = readFileSync(join(process.cwd(), 'app/api/public/stats/route.ts'), 'utf-8');

const DB_ERROR = Object.assign(new Error('column "chat_sessions.updated_at" does not exist'), {
  code: '42703',
});

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  poolQueryMock.mockReset();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  errorSpy.mockRestore();
});

describe('успех', () => {
  it('200 и числа из базы', async () => {
    poolQueryMock.mockResolvedValue({ rows: [{ count: '7' }], rowCount: 1 });
    const res = await stats();
    expect(res.status).toBe(200);
    const body = await res.json() as { stats: { chatsToday: number } };
    expect(body.stats.chatsToday).toBe(7);
  });
});

describe('отказ базы', () => {
  beforeEach(() => {
    poolQueryMock.mockRejectedValue(DB_ERROR);
  });

  it('это не 200 — нули успехом не выдаются', async () => {
    const res = await stats();
    expect(res.status).not.toBe(200);
    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  it('нулей в ответе нет вовсе: пустого stats не существует', async () => {
    const res = await stats();
    const body = await res.json() as Record<string, unknown>;
    expect(body.stats).toBeUndefined();
    expect(typeof body.error).toBe('string');
  });

  it('текст ошибки БД наружу не уходит', async () => {
    const res = await stats();
    const raw = JSON.stringify(await res.json());
    expect(raw).not.toContain('does not exist');
    expect(raw).not.toContain('chat_sessions');
    expect(raw).not.toContain('42703');
  });

  it('причина и SQLSTATE — в логе', async () => {
    await stats();
    const logged = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('42703');
    expect(logged).toContain('does not exist');
    expect(logged).toContain('public/stats');
  });

  it('отказ не кэшируется: кэшируемая функция бросает, а не возвращает нули', () => {
    // Связка с кэшем держится чтением кода намеренно: TTL `unstable_cache`
    // поведением в юните не воспроизвести, а вернуть пустышку из кэшируемой
    // функции — ровно тот способ снова положить отказ в кэш на пять минут.
    const cached = SRC.slice(SRC.indexOf('unstable_cache'), SRC.indexOf('[\'public-stats\']'));
    expect(cached).toContain('throw err');
    expect(cached).not.toMatch(/chatsToday:\s*0/);
  });

  it('ответ отказа не кэшируется и на стороне клиента', async () => {
    const res = await stats();
    expect(res.headers.get('Cache-Control')).toContain('no-store');
  });
});

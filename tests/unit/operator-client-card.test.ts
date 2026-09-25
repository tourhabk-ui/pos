/**
 * CRM-карточка клиента в кабинете оператора.
 *
 * 1) Отзывы читались из старой reviews с JOIN reviews.tour_id (uuid) =
 *    operator_tours.id (bigint) — 42883 на каждом открытии, карточка
 *    отвечала 500, а в ответ уходил сырой текст PostgreSQL. Теперь —
 *    operator_tour_reviews, текст ошибки только в лог.
 * 2) Теги и telegram клиента писались в users.preferences — общий профиль
 *    туриста, операторы перезаписывали друг друга. Теперь —
 *    operator_client_notes (миграция 1017), ключ (оператор, клиент).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

const queryMock = vi.fn();
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => queryMock(...a) }));
vi.mock('@/lib/auth/middleware', () => ({
  requireOperator: vi.fn(async () => ({ userId: 'op-user', role: 'operator' })),
}));
vi.mock('@/lib/auth/operator-helpers', () => ({
  getOperatorPartnerId: vi.fn(async () => 'partner-A'),
}));

import { GET, PATCH } from '@/app/api/operator/clients/[id]/route';

const CLIENT = '33333333-3333-4333-8333-333333333333';
const ctx = { params: Promise.resolve({ id: CLIENT }) };
const url = `http://localhost/api/operator/clients/${CLIENT}`;

beforeEach(() => queryMock.mockReset());

function sqlOf(i: number): string {
  return String(queryMock.mock.calls[i][0]);
}

describe('GET карточки клиента', () => {
  it('отзывы из operator_tour_reviews без скрытых, теги из operator_client_notes', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // доступ
      .mockResolvedValueOnce({ rows: [{ id: CLIENT, name: 'Анна', email: 'a@x', phone: null, eco_points: 0 }] })
      .mockResolvedValueOnce({ rows: [{ tags: ['VIP'], telegram: 'anna_k' }] })
      .mockResolvedValueOnce({ rows: [] }) // брони
      .mockResolvedValueOnce({ rows: [] }); // отзывы
    const res = await GET(new NextRequest(url), ctx);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { tags: string[]; telegramId: string } };
    expect(json.data.tags).toEqual(['VIP']);
    expect(json.data.telegramId).toBe('anna_k');

    const all = queryMock.mock.calls.map((c) => String(c[0])).join('\n');
    expect(all).not.toMatch(/FROM reviews\b/);
    expect(all).not.toMatch(/preferences/);
    const reviewsSql = sqlOf(4);
    expect(reviewsSql).toMatch(/FROM operator_tour_reviews r/);
    expect(reviewsSql).toMatch(/r\.is_hidden\s*=\s*FALSE/);
    const notesSql = sqlOf(2);
    expect(notesSql).toMatch(/FROM operator_client_notes/);
    expect(queryMock.mock.calls[2][1]).toEqual(['partner-A', CLIENT]);
  });

  it('отказ БД: 500 с русской фразой, текст PostgreSQL только в лог', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    queryMock.mockRejectedValueOnce(
      Object.assign(new Error('operator does not exist: uuid = bigint'), { code: '42883' }),
    );
    const res = await GET(new NextRequest(url), ctx);
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: string };
    expect(json.error).not.toMatch(/uuid|bigint|operator does not exist/);
    expect(spy.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('42883');
    spy.mockRestore();
  });
});

describe('PATCH заметок о клиенте', () => {
  function patch(body: unknown) {
    return PATCH(
      new NextRequest(url, { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
      ctx,
    );
  }

  it('пишет в operator_client_notes по паре (оператор, клиент), users не трогает', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }).mockResolvedValueOnce({ rows: [] });
    const res = await patch({ tags: ['VIP', 'семья'] });
    expect(res.status).toBe(200);
    const sql = sqlOf(1);
    expect(sql).toMatch(/INSERT INTO operator_client_notes/);
    expect(sql).toMatch(/ON CONFLICT \(operator_id, user_id\)/);
    expect(sql).not.toMatch(/UPDATE users/);
    const params = queryMock.mock.calls[1][1] as unknown[];
    expect(params[0]).toBe('partner-A');
    expect(params[1]).toBe(CLIENT);
    expect(params[2]).toEqual(['VIP', 'семья']);
    expect(params[3]).toBe(true); // теги пришли
    expect(params[4]).toBe(false); // telegram не пришёл — не стирается
  });

  it('telegram без @ и отдельно от тегов', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }).mockResolvedValueOnce({ rows: [] });
    const res = await patch({ telegram_id: '@anna_k' });
    expect(res.status).toBe(200);
    const params = queryMock.mock.calls[1][1] as unknown[];
    expect(params[3]).toBe(false);
    expect(params[4]).toBe(true);
    expect(params[5]).toBe('anna_k');
  });

  it('в файле роута нет записи в users.preferences', () => {
    const src = readFileSync(join(process.cwd(), 'app/api/operator/clients/[id]/route.ts'), 'utf8');
    expect(src).not.toMatch(/UPDATE users/);
    expect(src).not.toMatch(/u\.preferences/);
  });
});

describe('миграция 1017', () => {
  it('таблица operator_client_notes с PK (operator_id, user_id)', () => {
    const sql = readFileSync(join(process.cwd(), 'migrations/1015_operator_client_notes.sql'), 'utf8');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS operator_client_notes/);
    expect(sql).toMatch(/operator_id UUID NOT NULL REFERENCES partners\(id\)/);
    expect(sql).toMatch(/user_id\s+UUID NOT NULL REFERENCES users\(id\)/);
    expect(sql).toMatch(/PRIMARY KEY \(operator_id, user_id\)/);
  });
});

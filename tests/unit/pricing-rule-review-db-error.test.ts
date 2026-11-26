/**
 * Очередь скидок и наценок: отказ базы — «не смог», а не «проверять нечего».
 *
 * §4.0: пустой `catch` превращает поломку в «данных нет». Очередь, которая
 * при упавшем запросе отвечает пустым списком, выглядела бы для
 * администратора как «наценок на проверке нет». Здесь база подменена и
 * отказывает — судим, что отказ назван своим исходом и что в лог уходит
 * SQLSTATE, а не строка правила.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const db = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: db.query, connect: db.connect } }));

import { decidePricingRule, listPendingPricingRules } from '@/lib/tours/pricing-rule-review';

const down = () => Object.assign(new Error('соединение оборвано: Тест +70000000000'), { code: '57P01' });
let logged: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  db.query.mockReset();
  db.connect.mockReset();
  logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => logged.mockRestore());

describe('очередь не прочитана', () => {
  it('отказ запроса — исход db_error, не пустая очередь; в логе SQLSTATE без текста ошибки', async () => {
    db.query.mockRejectedValue(down());
    expect(await listPendingPricingRules()).toEqual({ outcome: 'db_error' });
    expect(logged).toHaveBeenCalledTimes(1);
    const line = logged.mock.calls[0].map(String).join(' ');
    expect(line).toContain('57P01');
    expect(line).not.toContain('+70000000000');
  });

  it('пустой ответ базы — это «проверять нечего», и он отличим от отказа', async () => {
    db.query.mockResolvedValue({ rows: [] });
    expect(await listPendingPricingRules()).toEqual({ outcome: 'ok', rules: [] });
    expect(logged).not.toHaveBeenCalled();
  });
});

describe('решение не записано', () => {
  const opts = { id: '5', action: 'approve' as const, reason: null, moderatedBy: null, seen: 'a'.repeat(64) };

  it('соединение не взято — db_error', async () => {
    db.connect.mockRejectedValue(down());
    expect(await decidePricingRule(opts)).toEqual({ outcome: 'db_error' });
  });

  it('запрос упал посреди транзакции — откат, соединение возвращено, исход db_error', async () => {
    const client = { query: vi.fn(), release: vi.fn() };
    client.query.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      throw down();
    });
    db.connect.mockResolvedValue(client);
    expect(await decidePricingRule(opts)).toEqual({ outcome: 'db_error' });
    expect(client.query.mock.calls.map((c) => c[0])).toContain('ROLLBACK');
    expect(client.query.mock.calls.map((c) => c[0])).not.toContain('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
    const line = logged.mock.calls[0].map(String).join(' ');
    expect(line).toContain('57P01');
    expect(line).not.toContain('+70000000000');
  });

  it('правила нет — not_found, транзакция откатана, соединение возвращено', async () => {
    const client = { query: vi.fn(async () => ({ rows: [] })), release: vi.fn() };
    db.connect.mockResolvedValue(client);
    expect(await decidePricingRule(opts)).toEqual({ outcome: 'not_found' });
    expect(client.query.mock.calls.map((c) => (c as unknown[])[0])).toContain('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

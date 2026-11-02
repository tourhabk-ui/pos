import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query } }));

import { journaledWrite, WriteInFlightError, writeIdempotencyKey, requestRefFrom, classifyOut, sessionRefFrom } from '@/lib/kuzmich/write-journal';

const OK = 'Заявка на поездку TRIP-AB12CD принята. Ключ статуса заявки: abc';
const meta = { channel: 'max' as const, sessionRef: 'max:123', tool: 'create_trip_request', args: { name: 'Иван', phone: '+79990001122', consent: true } };

function inserts() {
  return query.mock.calls.filter((c) => String(c[0]).includes('INSERT')).map((c) => c[1] as unknown[]);
}

beforeEach(() => { query.mockReset(); });

describe('kuzmich write journal', () => {
  it('пишет started до вызова и finished после, без ПД', async () => {
    query.mockResolvedValue({ rows: [] });
    const run = vi.fn(async () => {
      expect(inserts().map((r) => r[1])).toEqual(['started']);
      return { kind: 'ok', text: OK };
    });
    await journaledWrite(meta, run);
    const rows = inserts();
    expect(rows.map((r) => r[1])).toEqual(['started', 'finished']);
    expect(rows[1].slice(5, 7)).toEqual(['TRIP-AB12CD', 'created']);
    const flat = JSON.stringify(rows);
    expect(flat).not.toContain('Иван');
    expect(flat).not.toContain('79990001122');
  });

  it('повтор созданной заявки не вызывает исполнителя', async () => {
    query.mockResolvedValueOnce({ rows: [{ phase: 'finished', outcome: 'created', request_ref: 'TRIP-AB12CD', created_at: new Date() }] });
    const run = vi.fn();
    const out = await journaledWrite(meta, run);
    expect(run).not.toHaveBeenCalled();
    expect(out?.text).toContain('TRIP-AB12CD');
    expect(classifyOut(out).outcome).toBe('created');
  });

  it('started без finished — шаг в полёте, дубль не создаётся', async () => {
    query.mockResolvedValueOnce({ rows: [{ phase: 'started', outcome: null, request_ref: null, created_at: new Date() }] });
    const run = vi.fn();
    await expect(journaledWrite(meta, run)).rejects.toBeInstanceOf(WriteInFlightError);
    expect(run).not.toHaveBeenCalled();
  });

  it('старый незавершённый started и отказ — можно повторить', async () => {
    query.mockResolvedValueOnce({ rows: [{ phase: 'started', outcome: null, request_ref: null, created_at: new Date(Date.now() - 3600_000) }] })
      .mockResolvedValue({ rows: [] });
    await journaledWrite(meta, async () => ({ kind: 'ok', text: 'Тур не найден — заявка не создана.' }));
    expect(inserts()[1][6]).toBe('refused');
  });

  it('исполнитель упал — finished unknown, ошибка наверх', async () => {
    query.mockResolvedValue({ rows: [] });
    await expect(journaledWrite(meta, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(inserts()[1][6]).toBe('unknown');
  });

  it('сбой журнала не блокирует заявку', async () => {
    query.mockRejectedValue(new Error('db down'));
    const out = await journaledWrite(meta, async () => ({ kind: 'ok', text: OK }));
    expect(out?.text).toBe(OK);
  });

  it('ключ стабилен к порядку полей и различает сессии', () => {
    const d = new Date('2026-11-02T10:00:00Z');
    expect(writeIdempotencyKey('web', 's', 't', { a: 1, b: 2 }, d)).toBe(writeIdempotencyKey('web', 's', 't', { b: 2, a: 1 }, d));
    expect(writeIdempotencyKey('web', 's', 't', { a: 1 }, d)).not.toBe(writeIdempotencyKey('web', 's2', 't', { a: 1 }, d));
  });

  it('номер — не ключ статуса; аноним — хэш, не IP', () => {
    expect(requestRefFrom('Заявка № 512 принята. Ключ статуса заявки: secret')).toBe('#512');
    expect(requestRefFrom('Ключ статуса заявки: secret')).toBeNull();
    expect(sessionRefFrom(null, '1.2.3.4')).not.toContain('1.2.3.4');
  });

  it('миграция append-only', () => {
    const sql = readFileSync('migrations/1373_kuzmich_write_journal.sql', 'utf8');
    expect(sql).toMatch(/BEFORE UPDATE OR DELETE ON kuzmich_write_journal/);
  });
});

/** Стоп-продажи оператора (PR5): разбор кнопок, предпросмотр, «Да», журнал, права. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (s: string, p?: unknown[]) => h.query(s, p ?? []) } }));
vi.mock('@/lib/database', () => ({
  transaction: async (fn: (c: { query: typeof h.query }) => unknown) => fn({ query: (s: string, p?: unknown[]) => h.query(s, p ?? []) }),
}));
vi.mock('@/lib/chat-cabinet/signed-payload', () => ({ signPayload: (p: string) => `${p}.sig` }));

const { parseStopPress, stopSalesPress, STOP_REASON } = await import('@/lib/operators/stop-sales');
const { isWritePayload } = await vi.importActual<typeof import('@/lib/chat-cabinet/signed-payload')>('@/lib/chat-cabinet/signed-payload');

const OP = '11111111-1111-4111-8111-111111111111';
const NOW = Date.UTC(2026, 10, 2, 0, 0); // 02.11, Камчатка — 02.11 12:00
const base = { partnerId: OP, userId: null, via: 'telegram' as const, dialog: true, nowMs: NOW };

function db(days: Array<{ d: string; taken: number }>, updated: string[] = []) {
  h.query.mockImplementation(async (sql: string) => {
    if (/UPDATE tour_availability/.test(sql)) return { rows: updated.map((d) => ({ d })) };
    if (/FROM operator_tours t\s+WHERE t.id/.test(sql)) return { rows: [{ id: '77', title: 'Бухта' }] };
    if (/CROSS JOIN LATERAL/.test(sql)) return { rows: days };
    if (/cancellation_reason = \$3\s+ORDER BY/.test(sql)) return { rows: updated.map((d) => ({ d })) };
    return { rows: [], rowCount: 0 };
  });
}
const sqls = () => h.query.mock.calls.map((c) => String(c[0]));

beforeEach(() => { h.query.mockReset(); vi.spyOn(console, 'error').mockImplementation(() => undefined); });

describe('стоп-продажи', () => {
  it('кнопки разбираются; период — только 7/14/30; «Да» — подписанные', () => {
    expect(parseStopPress('ss:a:77:7')).toEqual({ step: 'ask_close', tourId: '77', days: 7 });
    expect(parseStopPress('ss:y:77:30')).toEqual({ step: 'close', tourId: '77', days: 30 });
    expect(parseStopPress('ss:y:77:9')).toBeNull();
    expect(parseStopPress('ss:v:77')).toEqual({ step: 'open', tourId: '77' });
    expect(isWritePayload('ss:y:77:7')).toBe(true);
    expect(isWritePayload('ss:v:77')).toBe(true);
    expect(isWritePayload('ss:a:77:7')).toBe(false);
  });

  it('предпросмотр: сколько закроется, даты с бронями остаются; ничего не пишет', async () => {
    db([{ d: '2026-11-03', taken: 0 }, { d: '2026-11-04', taken: 2 }]);
    const r = (await stopSalesPress({ ...base, payload: 'ss:a:77:7' }))!;
    expect(r.text).toMatch(/Закроются 1 дат: 03\.11/);
    expect(r.text).toMatch(/с бронями остаются открытыми: 04\.11/);
    expect(r.rows[0]![0]!.payload).toBe('ss:y:77:7.sig');
    expect(sqls().some((s) => /UPDATE|INSERT/.test(s))).toBe(false);
  });

  it('«Да»: закрывает только свободные даты своего тура и пишет журнал; повтор — не закрывает', async () => {
    db([{ d: '2026-11-03', taken: 0 }, { d: '2026-11-04', taken: 2 }], ['2026-11-03']);
    const r = (await stopSalesPress({ ...base, payload: 'ss:y:77:7' }))!;
    expect(r.text).toMatch(/закрыто 1 дат \(03\.11\)/);
    const upd = h.query.mock.calls.find((c) => /UPDATE tour_availability/.test(String(c[0])))!;
    expect(upd[0]).toMatch(/t.operator_id = \$4::uuid/);
    expect(upd[1]).toEqual(['77', ['2026-11-03'], STOP_REASON, OP]);
    const audit = h.query.mock.calls.find((c) => /INSERT INTO tour_stop_sales/.test(String(c[0])))!;
    expect(audit[1]).toEqual([OP, '77', '2026-11-02', '2026-11-08', ['2026-11-03'], ['2026-11-04'], null, 'telegram']);

    h.query.mockReset();
    db([{ d: '2026-11-03', taken: 0 }], []);
    expect((await stopSalesPress({ ...base, payload: 'ss:y:77:7' }))!.text).toMatch(/уже закрыты/);
    expect(sqls().some((s) => /INSERT INTO tour_stop_sales/.test(s))).toBe(false);
  });

  it('чужой тур, группа, отказ базы — ничего не записано', async () => {
    h.query.mockResolvedValue({ rows: [] });
    expect((await stopSalesPress({ ...base, payload: 'ss:y:77:7' }))!.text).toMatch(/среди ваших нет/);
    expect((await stopSalesPress({ ...base, dialog: false, payload: 'ss:y:77:7' }))!.text).toMatch(/только в личном чате/);
    h.query.mockRejectedValue(Object.assign(new Error('x'), { code: '57P01' }));
    expect((await stopSalesPress({ ...base, payload: 'ss:y:77:7' }))!.text).toMatch(/База не ответила/);
  });

  it('«Снять стоп» открывает только даты стоп-продажи и пишет журнал', async () => {
    db([], ['2026-11-03', '2026-11-05']);
    const ask = (await stopSalesPress({ ...base, payload: 'ss:u:77' }))!;
    expect(ask.text).toMatch(/откроются 2 дат/);
    const r = (await stopSalesPress({ ...base, payload: 'ss:v:77' }))!;
    expect(r.text).toMatch(/снята: снова открыто 2 дат/);
    const upd = h.query.mock.calls.find((c) => /UPDATE tour_availability/.test(String(c[0])))!;
    expect(upd[0]).toMatch(/cancellation_reason = \$3/);
    expect(sqls().some((s) => /INSERT INTO tour_stop_sales[\s\S]*'open'/.test(s))).toBe(true);
  });
});

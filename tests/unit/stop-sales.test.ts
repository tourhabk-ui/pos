/** Стоп-продажи оператора (план CRM, PR5): разбор, «Да», аудит, права, сводка. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ query: vi.fn(), client: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: (sql: string, params?: unknown[]) => h.query(sql, params ?? []),
    connect: async () => ({ query: (sql: string, params?: unknown[]) => h.client(sql, params ?? []), release: () => undefined }),
  },
}));

const { parseStopPress, stopSalesPress, STOP_REASON } = await import('@/lib/operators/stop-sales');
const { isWritePayload } = await import('@/lib/chat-cabinet/signed-payload');
const { operatorDigestLines } = await import('@/lib/chat-cabinet/digest');

const OP = '11111111-1111-4111-8111-111111111111';
const NOW = Date.UTC(2026, 10, 2, 0, 0); // 02.11 по Камчатке
const base = { partnerId: OP, userId: null, via: 'telegram' as const, dialog: true, nowMs: NOW };
const strip = (p: string) => p.replace(/\.[0-9a-z]+\.[0-9a-zA-Z_-]+$/, '');

function db(opts: { tour?: boolean; open?: Array<{ d: string; taken: number }>; stopped?: string[] }) {
  h.query.mockImplementation(async (sql: string) => {
    if (/FROM operator_tours t\s+WHERE t.id/.test(sql)) return { rows: opts.tour === false ? [] : [{ id: '77', title: 'Бухта' }] };
    if (/available_slots, 0\) > 0/.test(sql)) return { rows: opts.open ?? [] };
    if (/cancellation_reason = \$3\s+ORDER BY/.test(sql)) return { rows: (opts.stopped ?? []).map((d) => ({ d })) };
    return { rows: [] };
  });
}

beforeEach(() => {
  h.query.mockReset();
  h.client.mockReset();
  h.client.mockResolvedValue({ rows: [] });
});

describe('стоп-продажи', () => {
  it('разбор: период только из списка; записи подписываются, вопрос — нет', () => {
    expect(parseStopPress('ss:a:77:7')).toEqual({ step: 'ask_close', tourId: '77', days: 7 });
    expect(parseStopPress('ss:y:77:30')).toEqual({ step: 'close', tourId: '77', days: 30 });
    expect(parseStopPress('ss:y:77:9')).toBeNull();
    expect(parseStopPress('ss:v:77')).toEqual({ step: 'open', tourId: '77' });
    expect(isWritePayload('ss:y:77:7')).toBe(true);
    expect(isWritePayload('ss:v:77')).toBe(true);
    expect(isWritePayload('ss:a:77:7')).toBe(false);
  });

  it('вопрос: закроются только даты без броней, даты с бронями названы; ничего не пишет', async () => {
    db({ open: [{ d: '2026-11-03', taken: 0 }, { d: '2026-11-04', taken: 2 }] });
    const r = (await stopSalesPress({ ...base, payload: 'ss:a:77:7' }))!;
    expect(r.text).toMatch(/Закроются 1 дат: 03\.11/);
    expect(r.text).toMatch(/с бронями остаются открытыми: 04\.11/);
    expect(strip(r.rows[0]![0]!.payload)).toBe('ss:y:77:7');
    expect(h.client).not.toHaveBeenCalled();
  });

  it('«Да»: один UPDATE своего тура и строка аудита в одной транзакции', async () => {
    db({ open: [{ d: '2026-11-03', taken: 0 }, { d: '2026-11-04', taken: 2 }] });
    h.client.mockImplementation(async (sql: string) => (/UPDATE tour_availability/.test(sql) ? { rows: [{ d: '2026-11-03' }] } : { rows: [] }));
    const r = (await stopSalesPress({ ...base, payload: 'ss:y:77:7' }))!;
    expect(r.text).toMatch(/закрыт с 02\.11 по 08\.11 — 1 дат: 03\.11/);
    const sqls = h.client.mock.calls.map((c) => String(c[0]));
    const upd = h.client.mock.calls.find((c) => /UPDATE tour_availability/.test(String(c[0])))!;
    expect(String(upd[0])).toMatch(/t.operator_id = \$1::uuid/);
    expect(upd[1]).toEqual([OP, '77', ['2026-11-03'], STOP_REASON]);
    const audit = h.client.mock.calls.find((c) => /INSERT INTO tour_stop_sales/.test(String(c[0])))!;
    expect(audit[1]).toEqual([OP, '77', 'close', '2026-11-02', '2026-11-08', ['2026-11-03'], ['2026-11-04'], null, 'telegram']);
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls.at(-1)).toBe('COMMIT');
  });

  it('повтор «Да» — ничего не менял, аудита нет', async () => {
    db({ open: [{ d: '2026-11-03', taken: 0 }] });
    const r = (await stopSalesPress({ ...base, payload: 'ss:y:77:7' }))!;
    expect(r.text).toMatch(/уже закрыты/);
    expect(h.client.mock.calls.some((c) => /INSERT INTO tour_stop_sales/.test(String(c[0])))).toBe(false);
  });

  it('чужой тур и группа — отказ без записи', async () => {
    db({ tour: false });
    expect((await stopSalesPress({ ...base, payload: 'ss:y:77:7' }))!.text).toMatch(/среди ваших нет/);
    expect((await stopSalesPress({ ...base, dialog: false, payload: 'ss:y:77:7' }))!.text).toMatch(/только в личном чате/);
    expect(h.client).not.toHaveBeenCalled();
  });

  it('снять стоп: открываются только даты стоп-продажи, после «Да»', async () => {
    db({ stopped: ['2026-11-05'] });
    const ask = (await stopSalesPress({ ...base, payload: 'ss:u:77' }))!;
    expect(ask.text).toMatch(/Снова откроются 1 дат: 05\.11/);
    h.client.mockImplementation(async (sql: string) => (/UPDATE tour_availability/.test(sql) ? { rows: [{ d: '2026-11-05' }] } : { rows: [] }));
    const r = (await stopSalesPress({ ...base, payload: 'ss:v:77' }))!;
    expect(r.text).toMatch(/Стоп снят/);
    const upd = h.client.mock.calls.find((c) => /UPDATE tour_availability/.test(String(c[0])))!;
    expect(String(upd[0])).toMatch(/cancellation_reason = \$4/);
  });

  it('сводка оператора: выезды завтра и стоп — числа и тур, без имён', () => {
    const lines = operatorDigestLines({ tomorrow: [{ date: '2026-11-03', title: 'Бухта', people: 5, bookings: 2 }], stopped: 3 });
    expect(lines).toEqual([
      'Выезды завтра: 2 брон., 5 чел. — Бухта.',
      'Стоп-продажи активны: 3 дат закрыто. Снять — «Ещё» → «Стоп-продажи».',
    ]);
    expect(operatorDigestLines({ tomorrow: null, stopped: 0 })).toEqual(['Выезды завтра не прочитались — это не «выездов нет».']);
  });
});

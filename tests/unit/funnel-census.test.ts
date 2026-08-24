/**
 * Перепись воронки: отказ замера — не ноль, а «не знаю» (§4.0).
 *
 * Ловится ровно та подмена, из-за которой дыру воронки полгода искали не
 * там: упавший верхний замер молча становился нулём, «первый ноль сверху»
 * съезжал на звено ниже, и вердикт называл сломанным то, что работало.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { measure, verdictFrom } from '@/app/api/cron/funnel-census/route';

const SRC = readFileSync(join(process.cwd(), 'app/api/cron/funnel-census/route.ts'), 'utf-8');

const known = {
  visits: 10, tour_views: 4, booking_starts: 1, leads: 0, bookings: 0, paid: 0,
};

describe('measure: третье состояние', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('успех отдаёт значение и не помечает отказ', async () => {
    const m = await measure('ok', async () => 42);
    expect(m).toEqual({ value: 42, failed: null });
  });

  it('падение отдаёт null и ПРИЧИНУ, а не ноль', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const m = await measure('bad', async () => { throw new Error('relation "leads" does not exist'); });
    expect(m.value).toBeNull();
    expect(m.failed).toContain('does not exist');
    expect(m.value).not.toBe(0);
  });

  it('отказ пишется в лог: имя замера и текст ошибки', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await measure('page_views', async () => { throw new Error('boom'); });
    expect(spy).toHaveBeenCalled();
    const line = spy.mock.calls[0].join(' ');
    expect(line).toContain('page_views');
    expect(line).toContain('boom');
  });
});

describe('verdictFrom: неизвестный вход отменяет вердикт целиком', () => {
  it('все входы известны и звено сломано — вердикт есть', () => {
    const r = verdictFrom({ ...known, visits: 0 });
    expect(r.unknown).toEqual([]);
    expect(r.verdict?.title).toBe('Воронка: нет визитов');
  });

  it('все входы известны и поток есть — вердикта нет, но это не «не знаю»', () => {
    const r = verdictFrom({ visits: 10, tour_views: 4, booking_starts: 1, leads: 2, bookings: 1, paid: 1 });
    expect(r.unknown).toEqual([]);
    expect(r.verdict).toBeNull();
  });

  it('верхний замер не сосчитался — вердикта НЕТ, хотя ниже есть нули', () => {
    // Без этого правила ответ был бы «каталог не ведёт к турам» — про звено,
    // которое просто оказалось первым сосчитанным.
    const r = verdictFrom({ ...known, visits: null, tour_views: 0 });
    expect(r.verdict).toBeNull();
    expect(r.unknown).toContain('visits');
  });

  it('отсутствие ключа считается неизвестностью, а не нулём', () => {
    const r = verdictFrom({ tour_views: 0, booking_starts: 0, leads: 0, bookings: 0, paid: 0 });
    expect(r.verdict).toBeNull();
    expect(r.unknown).toContain('visits');
  });

  it('планы не обязательны: их неизвестность вердикт не отменяет', () => {
    const r = verdictFrom({ ...known, visits: 0, plan_views: null, plan_to_tour: null });
    expect(r.unknown).toEqual([]);
    expect(r.verdict?.title).toBe('Воронка: нет визитов');
  });
});

describe('перепись не заводит своего правила и не врёт окном', () => {
  it('звено называет судья петли эволюции, не местный if', () => {
    expect(SRC).toMatch(/pickFunnelFinding.*from '@\/lib\/agents\/evo\/growth-agent'/s);
    // Своих порогов «что считать дырой» здесь быть не должно.
    expect(SRC).not.toMatch(/title:\s*'Воронка/);
  });

  it('окно параметризовано, а не склеено строкой', () => {
    expect(SRC).toMatch(/\(\$1 \|\| ' days'\)::INTERVAL/);
    expect(SRC).not.toMatch(/INTERVAL '\$\{/);
  });

  it('перепись только читает', () => {
    expect(SRC).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
  });

  it('различает «ходят краулеры» и «не ходит никто»', () => {
    expect(SRC).toContain('bot_views');
    expect(SRC).toMatch(/is_bot = TRUE/);
  });

  it('различает «не трогали форму» и «маяк никогда не работал»', () => {
    expect(SRC).toContain('beacon_last_at');
    expect(SRC).toContain('beacon_rows_total');
  });

  it('различает «не заходят» и «счётчик просмотров умер»', () => {
    expect(SRC).toContain('views_last_at');
    expect(SRC).toContain('views_rows_total');
  });

  it('состояние вердикта названо словом, а не выведено из пустоты', () => {
    expect(SRC).toContain("verdict_state");
    expect(SRC).toContain("'unknown'");
    expect(SRC).toContain("'no_broken_link'");
    expect(SRC).toContain("'broken_link'");
  });

  it('meaningful ложно при любом отказе замера', () => {
    expect(SRC).toMatch(/meaningful:\s*failures === 0 && unknown\.length === 0/);
  });
});

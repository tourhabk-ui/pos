/**
 * Сводка перевозчика (#2862 этап D) — вызовом и исполнением.
 *
 *  - слова: не прочитавшийся блок назван, а не ноль; без ответов — «ответов
 *    не было», без отзывов — «средней нет»; имён и телефонов нет;
 *  - хранилище: каждый блок читается отдельно — отказ одного не глушит
 *    остальные; медиана первого ответа и «ждут ответа» считаются из строк;
 *    SQL не выбирает имя, телефон и почту;
 *  - дверь /api/hub/carrier/summary — за requireCarrier;
 *  - экран чата без ПД — в оба канала.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import {
  carrierSummaryLines, carrierSummaryText, durationWords, medianOf, SUMMARY_NOT_READ, type CarrierSummary,
} from '@/lib/transfers/carrier-summary';

const query = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));

const requireCarrier = vi.fn();
vi.mock('@/lib/transfers/carrier-auth', async (orig) => ({
  ...(await orig<typeof import('@/lib/transfers/carrier-auth')>()),
  requireCarrier: (...a: unknown[]) => requireCarrier(...a),
}));

const PARTNER = '22222222-2222-4222-8222-222222222222';

const full: CarrierSummary = {
  windowDays: 30,
  requests: { total: 7, answered: 5, waiting: 1, medianMinutes: 95 },
  rides: { held: 3, notHeld: 1, awaiting: 2 },
  reviews: { visible: 2, average: 4.5 },
};

beforeEach(() => {
  query.mockReset();
  requireCarrier.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('слова сводки', () => {
  it('числа названы, медиана словами, отзывы со средней; без ПД', () => {
    const lines = carrierSummaryLines(full);
    expect(lines[0]).toBe('Заявки на машину за 30 дней: 7 · отвечено 5 · ждут ответа сейчас 1.');
    expect(lines[1]).toBe('Время первого ответа (медиана): 1 ч 35 мин.');
    expect(lines[2]).toBe('Поездки по вашему слову: состоялись 3 · не состоялись 1 · ждут ответа «Поездка состоялась?» 2.');
    expect(lines[3]).toBe('Отзывы: 2 видимых · средняя 4.5 из 5.');
    const text = carrierSummaryText(full);
    expect(text).toContain('<b>Сводка перевозчика</b>');
    expect(text).toContain('Время — Камчатка.');
    expect(text).not.toMatch(/\+7|@/);
  });

  it('не прочитавшийся блок — «не прочиталось», не ноль; нет ответов и нет отзывов — так и сказано', () => {
    const lines = carrierSummaryLines({ windowDays: 30, requests: null, rides: null, reviews: null });
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(l).toContain(SUMMARY_NOT_READ);
    expect(lines.join(' ')).not.toMatch(/: 0/);
    const empty = carrierSummaryLines({
      windowDays: 30,
      requests: { total: 0, answered: 0, waiting: 0, medianMinutes: null },
      rides: { held: 0, notHeld: 0, awaiting: 0 },
      reviews: { visible: 0, average: null },
    });
    expect(empty[1]).toBe('Время первого ответа: ответов за этот срок не было.');
    expect(empty[2]).toBe('Поездки по вашему слову: состоялись 0 · не состоялись 0.');
    expect(empty[3]).toBe('Отзывы: пока нет — средней нет.');
  });

  it('медиана и длительность', () => {
    expect(medianOf([])).toBeNull();
    expect(medianOf([10])).toBe(10);
    expect(medianOf([1, 100, 10])).toBe(10);
    expect(medianOf([1, 2, 10, 100])).toBe(6);
    expect(durationWords(45)).toBe('45 мин');
    expect(durationWords(120)).toBe('2 ч');
    expect(durationWords(60 * 72)).toBe('3 дн');
  });
});

describe('хранилище', () => {
  const t = (iso: string) => new Date(iso);

  it('блоки читаются отдельно: медиана и «ждут» — из строк, средняя — из базы', async () => {
    query.mockImplementation(async (sql: string) => {
      if (/FROM leads l\s+CROSS JOIN LATERAL/.test(sql) && /answered_at/.test(sql)) {
        return { rows: [
          { created_at: t('2026-10-20T00:00:00Z'), answered_at: t('2026-10-20T00:30:00Z'), waiting: false },
          { created_at: t('2026-10-21T00:00:00Z'), answered_at: t('2026-10-21T02:00:00Z'), waiting: false },
          { created_at: t('2026-10-29T00:00:00Z'), answered_at: null, waiting: true },
          // Часы разошлись: ответ раньше заявки — ноль, не отрицательное.
          { created_at: t('2026-10-22T00:10:00Z'), answered_at: t('2026-10-22T00:00:00Z'), waiting: false },
        ] };
      }
      if (/ride_outcome/.test(sql) && /FILTER/.test(sql)) return { rows: [{ held: 3, not_held: 1 }] };
      if (/ride_outcome/.test(sql)) return { rows: [{ awaiting: 2 }] };
      if (/carrier_reviews/.test(sql)) return { rows: [{ visible: 2, average: 4.4999 }] };
      throw new Error(`неожиданный SQL: ${sql.slice(0, 60)}`);
    });
    const { loadCarrierSummary } = await import('@/lib/transfers/carrier-summary-store');
    const s = await loadCarrierSummary(PARTNER);
    expect(s).toEqual({
      windowDays: 30,
      requests: { total: 4, answered: 3, waiting: 1, medianMinutes: 30 },
      rides: { held: 3, notHeld: 1, awaiting: 2 },
      reviews: { visible: 2, average: 4.5 },
    });
    for (const c of query.mock.calls) {
      expect(String(c[0])).not.toMatch(/\bl\.name\b|\bl\.phone\b|\bemail\b|author_name/);
      expect(c[1]?.[0]).toBe(PARTNER);
    }
  });

  it('отказ одного запроса — null у его блока, остальные читаются; нет отзывов — средней нет', async () => {
    query.mockImplementation(async (sql: string) => {
      if (/FROM leads l\s+CROSS JOIN LATERAL/.test(sql)) throw Object.assign(new Error('x'), { code: '57P01' });
      if (/ride_outcome/.test(sql) && /FILTER/.test(sql)) return { rows: [{ held: 0, not_held: 0 }] };
      if (/ride_outcome/.test(sql)) return { rows: [{ awaiting: 0 }] };
      return { rows: [{ visible: 0, average: null }] };
    });
    const { loadCarrierSummary } = await import('@/lib/transfers/carrier-summary-store');
    const s = await loadCarrierSummary(PARTNER);
    expect(s.requests).toBeNull();
    expect(s.rides).toEqual({ held: 0, notHeld: 0, awaiting: 0 });
    expect(s.reviews).toEqual({ visible: 0, average: null });
  });
});

describe('дверь и экран', () => {
  it('без перевозчика базу не трогает; с перевозчиком отдаёт сводку', async () => {
    const { GET } = await import('@/app/api/hub/carrier/summary/route');
    requireCarrier.mockResolvedValue(NextResponse.json({ success: false }, { status: 401 }));
    expect((await GET(new NextRequest('https://vedarai.ru/api/hub/carrier/summary'))).status).toBe(401);
    expect(query).not.toHaveBeenCalled();
    requireCarrier.mockResolvedValue({ user: { userId: 'u' }, partnerId: PARTNER });
    query.mockResolvedValue({ rows: [] });
    const res = await GET(new NextRequest('https://vedarai.ru/api/hub/carrier/summary'));
    const body = await res.json() as { success: boolean; data: CarrierSummary };
    expect(res.status).toBe(200);
    expect(body.data.windowDays).toBe(30);
    expect(body.data.requests).toEqual({ total: 0, answered: 0, waiting: 0, medianMinutes: null });
  });

  it('экран чата — без ПД, в оба канала, со строкой кабинета и ссылкой на сайт', async () => {
    const { carrierSummaryScreen } = await import('@/lib/chat-cabinet/screens');
    const s = carrierSummaryScreen(full, 'https://vedarai.ru');
    expect(s.pd).toBe(false);
    expect(s.text).toContain('Сводка перевозчика');
    expect(s.rows.flat().find((b) => 'url' in b)).toEqual({ text: 'Кабинет на сайте', url: 'https://vedarai.ru/hub/carrier' });
    expect(s.rows.at(-1)?.map((b) => ('payload' in b ? b.payload : ''))).toEqual(['cb:i', 'cb:t', 'cb:c', 'cb:m']);
  });
});

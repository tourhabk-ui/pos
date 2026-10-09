/**
 * Сторож: перепись происхождения броней называет источник, но не человека.
 *
 * Повод 09.10: две брони тура появились за минуту, владелец их не создавал и
 * не видит в админке; ни одна перепись не говорила, что это за строки. Эта
 * говорит — и обязана оставаться без ПД: имя, телефон и почта туриста
 * участвуют только как «есть / нет», `metadata` — только именами ключей.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BY_ORIGIN_SQL, BY_ORIGIN_UNLINKED_SQL, DEFAULT_HOURS, MAX_HOURS, RECENT_SQL, RECENT_UNLINKED_SQL,
  censusBookingsOrigin, clampHours, parseScope,
} from '@/lib/analytics/bookings-origin';
import { MANUAL_ENDPOINTS } from '@/lib/agents/cron-schedulers';
import { UNLINKED_WHERE } from '@/lib/crm/contacts';
import { CRON_CAPABILITIES } from '@/lib/agents/cron-capability-registry';

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

describe('окно', () => {
  it('часы: умолчание 48, границы 1…720, мусор — умолчание', () => {
    expect(clampHours(null)).toBe(DEFAULT_HOURS);
    expect(clampHours('')).toBe(DEFAULT_HOURS);
    expect(clampHours('abc')).toBe(DEFAULT_HOURS);
    expect(clampHours('0')).toBe(1);
    expect(clampHours('100000')).toBe(MAX_HOURS);
    expect(clampHours('36.9')).toBe(36);
  });
});

describe('без ПД по построению', () => {
  const sql = [RECENT_SQL, RECENT_UNLINKED_SQL, BY_ORIGIN_SQL, BY_ORIGIN_UNLINKED_SQL].join('\n');

  it('имя, телефон и почта туриста — только внутри проверки присутствия', () => {
    const uses = [...sql.matchAll(/tourist_(?:name|phone|email)\b/g)];
    expect(uses.length).toBeGreaterThan(0);
    for (const m of uses) {
      const before = sql.slice(Math.max(0, m.index! - 24), m.index!);
      const after = sql.slice(m.index! + m[0].length, m.index! + m[0].length + 6);
      expect(before, `${m[0]}: не внутри NULLIF(btrim(b.…), '')`).toMatch(/NULLIF\(btrim\(b\.$/);
      expect(after, `${m[0]}: значение уходит наружу`).toMatch(/^\), ''\)/);
    }
  });

  it('metadata — только имена ключей, special_requests и notes не читаются', () => {
    expect(sql).toMatch(/jsonb_object_keys\(/);
    expect(sql).not.toMatch(/metadata\s*->/);
    expect(sql).not.toMatch(/special_requests|\bnotes\b|payment_id|tochka_qr_id|reseller_reference/);
  });

  it('роут — только GET за CRON_SECRET, окно из запроса обрезается', () => {
    const route = read('app/api/cron/bookings-origin-census/route.ts');
    expect(route).toMatch(/export async function GET/);
    expect(route).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)/);
    expect(route).toMatch(/getCronSecret\(req\)/);
    expect(route).toMatch(/timingSafeCompare\(/);
    expect(route).toMatch(/clampHours\(req\.nextUrl\.searchParams\.get\('hours'\)\)/);
    expect(route).toMatch(/parseScope\(req\.nextUrl\.searchParams\.get\('scope'\)\)/);
  });
});

describe('область unlinked — предикат задела, без окна времени', () => {
  it('scope читается только как unlinked или window', () => {
    expect(parseScope('unlinked')).toBe('unlinked');
    expect(parseScope('all')).toBe('window');
    expect(parseScope(null)).toBe('window');
  });

  it('условие непривязанных — ровно условие задела (не копия), только алиас s → b', () => {
    const fromBackfill = UNLINKED_WHERE.operator_booking.replace(/\bs\./g, 'b.');
    for (const q of [RECENT_UNLINKED_SQL, BY_ORIGIN_UNLINKED_SQL]) {
      expect(q, 'перепись разошлась с заделом').toContain(fromBackfill);
      expect(q).not.toMatch(/\bs\./);
    }
    // служебная бронь пробы оплаты исключена и тут — потому что исключена в заделе
    expect(RECENT_UNLINKED_SQL).toMatch(/b\.created_via IS DISTINCT FROM 'service-payment-test'/);
  });

  it('SQL непривязанных повторяет предикат crm-contacts-sync и не смотрит на created_at', () => {
    for (const q of [RECENT_UNLINKED_SQL, BY_ORIGIN_UNLINKED_SQL]) {
      expect(q).toMatch(/b\.deleted_at IS NULL AND t\.operator_id IS NOT NULL/);
      expect(q).toMatch(/NOT EXISTS \(SELECT 1 FROM crm_contact_links l/);
      expect(q).toMatch(/l\.source_kind = 'operator_booking' AND l\.source_id = b\.id::text/);
      expect(q).not.toMatch(/make_interval/);
    }
  });

  it('отчёт unlinked называет область и не выдумывает окно', async () => {
    const exec = { query: async () => ({ rows: [] }) } as unknown as Parameters<typeof censusBookingsOrigin>[1];
    const r = await censusBookingsOrigin(48, exec, 'unlinked');
    expect(r.scope).toBe('unlinked');
    expect(r.hours).toBeNull();
    expect(r.failed).toEqual([]);
  });
});

describe('объявлено там, где положено', () => {
  it('ручной крон без записи и с причиной; возможностей — только чтение базы', () => {
    const decl = MANUAL_ENDPOINTS['bookings-origin-census'];
    expect(decl?.kind).toBe('manual');
    expect(decl?.writes).toBe(false);
    expect(decl?.note).toMatch(/без ПД/);
    expect(CRON_CAPABILITIES['bookings-origin-census']).toEqual(['db_read']);
  });
});

describe('три исхода', () => {
  it('упавший запрос — в failed с SQLSTATE, а не ноль строк', async () => {
    const exec = {
      query: async (text: string) => {
        if (/GROUP BY 1/.test(text)) throw Object.assign(new Error('boom'), { code: '42P01' });
        return { rows: [] } as never;
      },
    } as unknown as Parameters<typeof censusBookingsOrigin>[1];
    const r = await censusBookingsOrigin(5, exec);
    expect(r.recent).toEqual([]);
    expect(r.by_origin).toBeNull();
    expect(r.by_origin_30d).toBeNull();
    expect(r.failed.map((f) => `${f.measure}:${f.sqlstate}`).sort()).toEqual(['by_origin:42P01', 'by_origin_30d:42P01']);
  });
});

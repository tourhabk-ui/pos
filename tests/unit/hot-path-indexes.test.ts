/**
 * Индексы горячих путей (перф-аудит владельца 08.08, пп. 2-3 по ROI).
 *
 * Смысл сторожа — не «индексы существуют», а «предикаты индексов СОВПАДАЮТ
 * с запросами»: частичный индекс с другим условием Postgres не использует,
 * и он молча превращается в мёртвый груз.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const MIG = readFileSync(join(ROOT, 'migrations/843_agent_hot_path_indexes.sql'), 'utf-8');
const DATA = readFileSync(join(ROOT, 'lib/planner/data.ts'), 'utf-8');

describe('843: индексы совпадают с запросами', () => {
  it('занятость: слоты по (тур, дата) с теми же фильтрами, что в запросе', () => {
    expect(MIG).toMatch(/ON tour_availability \(operator_tour_id, date\)/);
    expect(MIG).toMatch(/WHERE is_cancelled = FALSE AND deleted_at IS NULL/);
    // Запрос действительно фильтрует так же
    expect(DATA).toMatch(/ta\.is_cancelled = FALSE/);
    expect(DATA).toMatch(/ta\.deleted_at IS NULL/);
  });

  it('LATERAL по броням: (тур, дата брони) с тем же условием статусов', () => {
    expect(MIG).toMatch(/ON operator_bookings \(operator_tour_id, booking_date\)/);
    expect(MIG).toMatch(/booking_status NOT IN \('cancelled', 'rejected'\)/);
    expect(DATA).toMatch(/booking_status NOT IN \('cancelled', 'rejected'\)/);
  });

  it('витринный каталог: base_price по опубликованным активным', () => {
    expect(MIG).toMatch(/ON operator_tours \(base_price ASC NULLS LAST\)/);
    expect(MIG).toMatch(/is_active = TRUE AND deleted_at IS NULL AND is_published = TRUE/);
  });

  it('CONCURRENTLY и идемпотентность — правило миграций', () => {
    const creates = MIG.match(/CREATE INDEX/g) ?? [];
    const concurrent = MIG.match(/CREATE INDEX CONCURRENTLY IF NOT EXISTS/g) ?? [];
    expect(creates.length).toBe(4);
    expect(concurrent.length).toBe(4);
    expect(MIG).not.toMatch(/BEGIN|COMMIT/);
  });
});

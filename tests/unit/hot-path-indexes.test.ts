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
import { occupiedOnDaySql } from '@/lib/bookings/occupancy';

const ROOT = process.cwd();
const MIG = readFileSync(join(ROOT, 'migrations/843_agent_hot_path_indexes.sql'), 'utf-8');
const DATA = readFileSync(join(ROOT, 'lib/planner/data.ts'), 'utf-8');
/** Отрендеренный SQL общего правила занятости — то, что реально уходит в базу. */
const OCC = occupiedOnDaySql({ booking: 'ob', day: 'ta.date', tourId: 'ta.operator_tour_id' });

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

    /**
     * Условие статусов с 15.09 живёт в ОДНОМ месте — `lib/bookings/occupancy.ts`.
     * Раньше оно было переписано в двенадцати запросах, и часть копий уже
     * разошлась (забытый `deleted_at IS NULL`). Сторож поэтому спрашивает
     * отрендеренный SQL правила, а не текст вызывающего: совпадать с индексом
     * должно то, что уходит в базу.
     */
    expect(OCC).toMatch(/booking_status NOT IN \('cancelled', 'rejected'\)/);
    expect(DATA).toMatch(/occupiedOnDaySql\(/);
  });

  it('индекс всё ещё служит интервальному предикату — и когда перестанет', () => {
    /**
     * Предикат сменился с равенства на интервал:
     *
     *   было:  ob.booking_date = ta.date
     *   стало: ta.date BETWEEN ob.booking_date
     *                      AND COALESCE(ob.end_date, ob.booking_date)
     *
     * Индекс `(operator_tour_id, booking_date)` от этого НЕ умирает: для
     * заданного дня Postgres по-прежнему берёт префикс `operator_tour_id = X`
     * и ограничивает `booking_date <= день`. Вторая половина условия
     * (`COALESCE(end_date, booking_date) >= день`) становится фильтром поверх.
     *
     * То есть отбор стал шире: сканируются все брони тура ДО этого дня, а не
     * ровно этот день. Сегодня это ничего не стоит — оплаченных броней ноль, у
     * тура их единицы. Станет стоить, когда броней на тур наберутся сотни, и
     * тогда лечится третьей колонкой (`..., end_date`) или range-индексом.
     *
     * Заводить её СЕЙЧАС значило бы оптимизировать без замера — ровно то, от
     * чего этот файл и стережёт: индекс, не совпавший с запросом, мёртвый
     * груз. Здесь закреплено, что решение отложено осознанно, а не забыто.
     */
    expect(OCC, 'интервал: обе границы должны быть в предикате').toMatch(/BETWEEN/);
    expect(OCC).toMatch(/COALESCE\(\w+\.end_date, \w+\.booking_date\)/);
    // Третьей колонки пока нет — и это записанное решение, а не упущение.
    expect(MIG, 'end_date попал в индекс — значит замер появился, обнови пояснение выше')
      .not.toMatch(/ON operator_bookings \(operator_tour_id, booking_date, end_date\)/);
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

/**
 * Дата дня — в форму брони, честная доступность — в день плана
 * («Мой план 2.0», B-3 + B-4; карт-бланш владельца 08.08).
 *
 * B-3: клик «забронировать» из дня плана не должен заставлять вводить дату,
 * которую план уже знает: ссылка несёт ?date=, форма брони подхватывает её
 * НА КЛИЕНТЕ (window.location) — серверный searchParams выбил бы карточку
 * тура из ISR-кэша.
 *
 * B-4: «на 12.08 — 4 места» в дне публичного плана — из реальной занятости
 * (fetchAvailabilityForTour, тот же расчёт, что у гейта брони). Только
 * будущие даты, только remaining > 0; сбой не роняет план.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const BOOKING = readFileSync(join(ROOT, 'components/marketplace/BookingFormClient.tsx'), 'utf-8');
const SHARE_API = readFileSync(join(ROOT, 'app/api/trips/share/[token]/route.ts'), 'utf-8');
const SHARE_UI = readFileSync(join(ROOT, 'app/trip/[token]/_TripShareClient.tsx'), 'utf-8');
const PLANS_PAGE = readFileSync(join(ROOT, 'app/plans/[slug]/page.tsx'), 'utf-8');

describe('B-3: дата дня доезжает до формы брони', () => {
  it('форма читает ?date= на клиенте — ISR карточки тура не тронут', () => {
    expect(BOOKING).toMatch(/new URLSearchParams\(window\.location\.search\)\.get\('date'\)/);
    // Валидация формата: мусор из URL не попадает в состояние формы
    expect(BOOKING).toMatch(/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$/);
    // Введённая руками дата не перетирается предвыбором
    expect(BOOKING).toMatch(/prev\.booking_date \? prev :/);
  });

  it('карточка тура осталась на ISR — серверного searchParams нет', () => {
    const CATALOG_PAGE = readFileSync(join(ROOT, 'app/catalog/tours/[id]/page.tsx'), 'utf-8');
    const MARKET_PAGE = readFileSync(join(ROOT, 'app/marketplace/tours/[id]/page.tsx'), 'utf-8');
    for (const src of [CATALOG_PAGE, MARKET_PAGE]) {
      expect(src).toMatch(/export const revalidate = 3600/);
      expect(src).not.toMatch(/searchParams/);
    }
  });

  it('публичный план и программатик-страницы шлют ?date= в ссылке брони', () => {
    expect(SHARE_UI).toMatch(/\?date=\$\{avail\.date\}/);
    expect(PLANS_PAGE).toMatch(/\?date=\$\{day\.availableDate \?\?/);
  });
});

describe('B-4: честная доступность в дне плана', () => {
  it('share-API считает места из реальной занятости (расчёт гейта брони)', () => {
    expect(SHARE_API).toMatch(/fetchAvailabilityForTour/);
    expect(SHARE_API).toMatch(/createPlannerCache/);
  });

  it('только будущие даты и только remaining > 0 — прошлое и ноль не показываем', () => {
    expect(SHARE_API).toMatch(/if \(date < today\) return;/);
    expect(SHARE_API).toMatch(/if \(remaining > 0\) availability\[String\(d\.day\)\]/);
  });

  it('сбой подбора не роняет план', () => {
    expect(SHARE_API).toMatch(/catch \{ \/\* строка доступности необязательна \*\/ \}/);
  });

  it('публичный план показывает «на дату — N мест» и склоняет честно', () => {
    expect(SHARE_UI).toMatch(/на \{shortDate\(avail\.date\)\}/);
    expect(SHARE_UI).toMatch(/'место' : avail\.remaining < 5 \? 'места' : 'мест'/);
  });
});

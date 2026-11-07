// @vitest-environment jsdom
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

describe('B-3: дата дня доезжает до формы брони', () => {
  it('форма читает ?date= на клиенте — ISR карточки тура не тронут', () => {
    // 01.11: разбор вынесен в lib/booking/request-prefill.ts (?date= + ?guests=).
    expect(BOOKING).toMatch(/parseRequestPrefill\(window\.location\.search/);
    // Валидация формата: мусор из URL не попадает в состояние формы
    expect(BOOKING).toMatch(/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$/);
    // Введённая руками дата не перетирается предвыбором
    expect(BOOKING).toMatch(/prev\.booking_date \? prev :/);
  });

  it('карточка тура осталась на ISR — серверного searchParams нет', () => {
    const CATALOG_PAGE = readFileSync(join(ROOT, 'app/catalog/tours/[id]/page.tsx'), 'utf-8');
    for (const src of [CATALOG_PAGE]) {
      expect(src).toMatch(/export const revalidate = 3600/);
      expect(src).not.toMatch(/searchParams/);
    }
  });

  // Программатик-страница /plans шлёт ?date= в ссылке брони — рендером,
  // tests/unit/plans-preset-plan.test.tsx (день с availableDate движка и день
  // без неё — расчётная дата дня).
});

describe('B-4: честная доступность в дне плана', () => {
  it('share-API считает места из реальной занятости (расчёт гейта брони)', () => {
    expect(SHARE_API).toMatch(/fetchAvailabilityForTour/);
    expect(SHARE_API).toMatch(/createPlannerCache/);
  });
  // Исходы мест (open / none с ближайшей датой / on_request / unread), их
  // строка и ссылка на странице — исполнением: share-API на заглушках и
  // рендер страницы, tests/unit/trip-page-truth.test.tsx (пруф с прода 06.11:
  // «только remaining > 0» превращал «мест нет» в «оставить заявку»).
});

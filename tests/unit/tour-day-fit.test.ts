// @vitest-environment node
/**
 * Тур встаёт на день плана, только если в этот день у него есть выезд
 * (волна 3 аудита планировщика 07.11, 3.2 и сезон из 3.5) —
 * lib/planner/tour-day-fit. Правило — вызовом на граничных данных; сборка
 * плана целиком (Горелый с выездами 15–16.07 встаёт днём 6, а не днём 2) —
 * tests/unit/planner-prod-proof.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  departureDatesWords, lineUpForDate, offDaysWarning, tourFitsDate, type TourDates, type TourQueue,
} from '@/lib/planner/tour-day-fit';

const TODAY = '2026-11-07';

describe('tourFitsDate: выезд в дату дня', () => {
  it('календарь — только даты с местами', () => {
    const dated: TourDates = { kind: 'dated', dates: new Set(['2027-07-15', '2027-07-16']) };
    expect(tourFitsDate(dated, '2027-07-15', TODAY)).toBe(true);
    expect(tourFitsDate(dated, '2027-07-11', TODAY)).toBe(false);
    expect(tourFitsDate({ kind: 'dated', dates: new Set() }, '2027-07-11', TODAY)).toBe(false);
  });

  it('без календаря — внутри сезона выездов; тур в несколько дней кончается в сезоне', () => {
    const season: TourDates = { kind: 'request', seasonStart: '2027-08-01', seasonEnd: '2027-09-30', days: 1 };
    expect(tourFitsDate(season, '2027-07-11', TODAY)).toBe(false);
    expect(tourFitsDate(season, '2027-08-01', TODAY)).toBe(true);
    const eight: TourDates = { kind: 'request', seasonStart: '2027-05-01', seasonEnd: '2027-10-01', days: 8 };
    expect(tourFitsDate(eight, '2027-09-24', TODAY)).toBe(true);
    expect(tourFitsDate(eight, '2027-09-25', TODAY)).toBe(false);
  });

  it('сезон не записан, расписание не прочиталось или сведений нет — тур встаёт, как раньше', () => {
    expect(tourFitsDate({ kind: 'request', seasonStart: null, seasonEnd: null, days: 1 }, '2027-07-11', TODAY)).toBe(true);
    expect(tourFitsDate({ kind: 'unread' }, '2027-07-11', TODAY)).toBe(true);
    expect(tourFitsDate(undefined, '2027-07-11', TODAY)).toBe(true);
  });
});

describe('lineUpForDate: тур без выезда ждёт своего дня', () => {
  type T = { tourId: string };
  const q = (tours: string[], deferred: string[] = []): TourQueue<T> => ({
    tours: tours.map((tourId) => ({ tourId })), deferred: deferred.map((tourId) => ({ tourId })),
  });
  const ids = (list: T[]) => list.map((t) => t.tourId);

  it('тур без выезда в этот день уходит ждать, в голову встаёт тур с выездом', () => {
    const queue = q(['gor', 'ava']);
    lineUpForDate(queue, (t) => t.tourId !== 'gor', new Set());
    expect(ids(queue.tours)).toEqual(['ava']);
    expect(ids(queue.deferred)).toEqual(['gor']);
  });

  it('ждавший тур с выездом в этот день — первым, впереди очереди', () => {
    const queue = q(['ava'], ['gor']);
    lineUpForDate(queue, () => true, new Set());
    expect(ids(queue.tours)).toEqual(['gor', 'ava']);
    expect(queue.deferred).toEqual([]);
  });

  it('выезда нет ни у кого — голова пуста, туры ждут (день возьмёт маршрут)', () => {
    const queue = q(['gor', 'tol']);
    lineUpForDate(queue, () => false, new Set());
    expect(queue.tours).toEqual([]);
    expect(ids(queue.deferred)).toEqual(['gor', 'tol']);
  });

  it('уже стоящий в плане тур второй раз не ставится и не ждёт', () => {
    const queue = q(['ava', 'gor'], ['ava']);
    lineUpForDate(queue, () => true, new Set(['ava']));
    expect(ids(queue.tours)).toEqual(['gor']);
  });
});

describe('слова: даты выезда и строка «Важно»', () => {
  it('даты — по-русски, по возрастанию, не больше трёх', () => {
    expect(departureDatesWords(['2027-07-16', '2027-07-15'])).toBe('15 и 16 июля');
    expect(departureDatesWords(['2027-06-30', '2027-07-01'])).toBe('30 июня и 1 июля');
    expect(departureDatesWords(['2027-07-15'])).toBe('15 июля');
    expect(departureDatesWords(['2027-07-01', '2027-07-02', '2027-07-03', '2027-07-04'])).toBe('1, 2 и 3 июля и ещё 1');
  });

  it('тур с выездами не в дни занятия и тур без выездов в даты поездки — разные слова', () => {
    expect(offDaysWarning([])).toBeNull();
    expect(offDaysWarning([{ title: 'Горелый', dates: ['2027-07-16'] }])).toBe(
      'Не встали в план — в дни этих занятий у тура нет выезда: «Горелый» (выезды 16 июля). Хотите тур — переставьте день плана на дату выезда.',
    );
    expect(offDaysWarning([{ title: 'Толбачик', dates: [] }])).toBe('В ваши даты у тура нет выездов — его не ставили: «Толбачик».');
  });
});

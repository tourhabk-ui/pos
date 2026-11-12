/**
 * Кто закрыл дату тура (план «после отказа», этап 6; миграция 1435).
 *
 * Держит: «закрыл Ведар» читается из признака в строке, а не из её наличия и
 * не из слов причины; отказ базы — «не знаю», а не «не закрывал»; бронь о
 * такой дате не говорит «оператор закрыл» — он её не закрывал.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));

import {
  DATE_CLOSED_BY_PLATFORM_SQL, DATES_CLOSED_BY_PLATFORM_SQL, datesClosedByPlatform, isClosedByPlatform,
} from '@/lib/tours/date-closure';
import { assertDaysOpen, platformClosedText, ReserveError, type TourDay } from '@/lib/bookings/reserve';
import { BOOKING_REJECT_REASONS, BOOKING_REJECT_REASON_RU } from '@/lib/funnel/steps';

const answer = (rows: unknown[]) => ({ query: vi.fn(async () => ({ rows })) });

describe('чтение признака', () => {
  it('закрыл Ведар — только по признаку в строке; пусто и чужая строка — «нет»', async () => {
    const yes = answer([{ closed_by_platform: true }]);
    expect(await isClosedByPlatform(70, '2027-01-15', yes)).toBe(true);
    expect(yes.query.mock.calls[0]).toEqual([DATE_CLOSED_BY_PLATFORM_SQL, ['70', '2027-01-15']]);
    expect(await isClosedByPlatform(70, '2027-01-15', answer([]))).toBe(false);
    // Строка есть, а признака в ней нет (ответ на другой запрос, подмена в тесте) — не «закрыл Ведар».
    expect(await isClosedByPlatform(70, '2027-01-15', answer([{ id: 70, title: 'Тур' }]))).toBe(false);
    expect(await isClosedByPlatform(70, '2027-01-15', answer([{ closed_by_platform: 't' }]))).toBe(false);
  });

  it('база отказала — «не знаю» (null) и строка в лог с SQLSTATE; «не закрывал» не утверждается', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = { query: vi.fn(async () => { throw Object.assign(new Error('db'), { code: '57P01' }); }) };
    expect(await isClosedByPlatform(70, '2027-01-15', broken)).toBeNull();
    expect(await datesClosedByPlatform(70, '2027-01-01', '2027-01-31', broken)).toBeNull();
    expect(error.mock.calls.flat().join(' ')).toMatch(/date-closure.*57P01/);
    error.mockRestore();
  });

  it('даты окна — как отдала база; не дата в ответе в список не идёт', async () => {
    const db = answer([{ date: '2027-01-10' }, { date: '2027-01-11' }, { date: null }, { title: 'Тур' }, { date: '11.01.2027' }]);
    expect(await datesClosedByPlatform(70, '2027-01-01', '2027-01-31', db)).toEqual(['2027-01-10', '2027-01-11']);
    expect(db.query.mock.calls[0]).toEqual([DATES_CLOSED_BY_PLATFORM_SQL, ['70', '2027-01-01', '2027-01-31']]);
  });

  it('запросы судят признак и живую закрытую строку, а не слова причины', () => {
    for (const sql of [DATE_CLOSED_BY_PLATFORM_SQL, DATES_CLOSED_BY_PLATFORM_SQL]) {
      expect(sql).toMatch(/closed_by = 'platform'/);
      expect(sql).toMatch(/is_cancelled IS TRUE/);
      expect(sql).toMatch(/deleted_at IS NULL/);
      expect(sql).not.toMatch(/cancellation_reason/);
    }
  });
});

describe('бронь на дату, которую закрыл Ведар', () => {
  const day = (over: Partial<TourDay>): TourDay => ({ date: '2027-01-15', occupied: '0', available_slots: 8, is_cancelled: false, closed_by: null, ...over });
  const refuse = (days: TourDay[], durationDays = 1): ReserveError => {
    try {
      assertDaysOpen(days, { participants: 2, maxParticipants: 8, durationDays });
    } catch (e) {
      return e as ReserveError;
    }
    throw new Error('бронь прошла');
  };

  it('свой код отказа и слова без «оператор закрыл»: он её не закрывал', () => {
    const e = refuse([day({ is_cancelled: true, closed_by: 'platform' })]);
    expect(e.code).toBe('DATE_CLOSED_BY_PLATFORM');
    expect(e.message).toBe(platformClosedText('2027-01-15', false));
    expect(e.message).toContain('закрыл Ведар по описанию тура — оператор её не закрывал и не подтверждал');
    expect(e.message).toContain('спросите оператора, ходит ли он в этот день');
    expect(e.message).not.toMatch(/Оператор закрыл/);
    const multi = refuse([day({}), day({ date: '2027-01-16', is_cancelled: true, closed_by: 'platform' })], 2);
    expect(multi.code).toBe('DATE_CLOSED_BY_PLATFORM');
    expect(multi.message).toContain('Дату 2027-01-16 (она входит в тур) в календаре закрыл Ведар');
  });

  it('дату закрыл оператор (признака нет) — прежние код и слова', () => {
    for (const closed_by of [null, undefined, 'operator']) {
      const e = refuse([day({ is_cancelled: true, closed_by })]);
      expect(e.code).toBe('DATE_BLOCKED');
      expect(e.message).toBe('Оператор закрыл приём заявок на эту дату.');
    }
  });

  it('признак без закрытия бронь не останавливает: решает is_cancelled', () => {
    expect(() => assertDaysOpen([day({ closed_by: 'platform' })], { participants: 2, maxParticipants: 8, durationDays: 1 })).not.toThrow();
  });

  it('у нового кода отказа есть слова для сводки воронки', () => {
    expect(BOOKING_REJECT_REASONS).toContain('DATE_CLOSED_BY_PLATFORM');
    expect(BOOKING_REJECT_REASON_RU.DATE_CLOSED_BY_PLATFORM).toBe('дата закрыта Ведаром по оценке');
  });
});

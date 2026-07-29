/**
 * «День N из M» и выбор активной поездки.
 *
 * Режим маршрута включается явной кнопкой, а не датами — но внутри режима
 * даты дают справку «День 2 из 4». Справка обязана быть либо верной, либо
 * отсутствовать: на экране, где человек сверяет, сколько ему осталось идти,
 * выдуманное число хуже пустого места.
 */
import { describe, it, expect } from 'vitest';
import { tripProgress, pickCandidateTrip, type TripCandidate } from '@/lib/home/trip-mode';

const TRIP = { arrivalDate: '2026-08-06', departureDate: '2026-08-09' };

describe('день N из M', () => {
  it('считает дни включительно: 6–9 августа это четыре дня', () => {
    // Турист считает так же: выехал 6-го, вернулся 9-го — «четыре дня».
    // Простое вычитание дат дало бы три и разошлось бы с его ощущением.
    expect(tripProgress(TRIP, '2026-08-06')).toEqual({ day: 1, total: 4, phase: 'during' });
    expect(tripProgress(TRIP, '2026-08-09')).toEqual({ day: 4, total: 4, phase: 'during' });
  });

  it('середина поездки', () => {
    expect(tripProgress(TRIP, '2026-08-07')).toEqual({ day: 2, total: 4, phase: 'during' });
  });

  it('до выезда и после возвращения номера дня нет', () => {
    // Режим включён вручную и мог остаться включённым — но «День 0» или
    // «День 5 из 4» врут. Показываем фазу, число не выдумываем.
    expect(tripProgress(TRIP, '2026-08-05')).toEqual({ day: null, total: 4, phase: 'before' });
    expect(tripProgress(TRIP, '2026-08-10')).toEqual({ day: null, total: 4, phase: 'after' });
  });

  it('поездка одного дня — «День 1 из 1», а не деление на ноль', () => {
    const one = { arrivalDate: '2026-08-06', departureDate: '2026-08-06' };
    expect(tripProgress(one, '2026-08-06')).toEqual({ day: 1, total: 1, phase: 'during' });
  });

  it('без дат ничего не выдумывает', () => {
    expect(tripProgress({ arrivalDate: null, departureDate: null }, '2026-08-07'))
      .toEqual({ day: null, total: null, phase: 'unknown' });
    expect(tripProgress({ arrivalDate: '2026-08-06', departureDate: null }, '2026-08-07').phase)
      .toBe('unknown');
  });

  it('испорченные или перевёрнутые даты — тоже unknown', () => {
    expect(tripProgress({ arrivalDate: 'позавчера', departureDate: '2026-08-09' }, '2026-08-07').phase)
      .toBe('unknown');
    // Отъезд раньше приезда: данные битые, а не «минус два дня».
    expect(tripProgress({ arrivalDate: '2026-08-09', departureDate: '2026-08-06' }, '2026-08-07').phase)
      .toBe('unknown');
  });

  it('время суток на номер дня не влияет', () => {
    // Сравниваем календарные даты: в 23:59 идёт тот же день, что и в 00:01.
    expect(tripProgress(TRIP, '2026-08-07T23:59:00Z').day).toBe(2);
    expect(tripProgress(TRIP, '2026-08-07T00:01:00Z').day).toBe(2);
  });
});

describe('какую поездку предложить, если активной не назначено', () => {
  const mk = (id: string, a: string | null, d: string | null, created = '2026-01-01'): TripCandidate =>
    ({ id, title: id, arrivalDate: a, departureDate: d, createdAt: created });

  it('идущая сегодня важнее будущей и прошлой', () => {
    const trips = [
      mk('past', '2026-07-01', '2026-07-05'),
      mk('future', '2026-09-01', '2026-09-05'),
      mk('now', '2026-08-06', '2026-08-09'),
    ];
    expect(pickCandidateTrip(trips, '2026-08-07')?.id).toBe('now');
  });

  it('из будущих — ближайшая', () => {
    const trips = [mk('later', '2026-10-01', '2026-10-05'), mk('sooner', '2026-09-01', '2026-09-05')];
    expect(pickCandidateTrip(trips, '2026-08-07')?.id).toBe('sooner');
  });

  it('выбор детерминированный: на двух устройствах одна и та же поездка', () => {
    // Иначе человек видит разные поездки на телефоне и планшете и решает,
    // что платформа их путает.
    const trips = [mk('b', '2026-09-01', '2026-09-05', '2026-01-01'), mk('a', '2026-09-01', '2026-09-05', '2026-01-01')];
    const first = pickCandidateTrip(trips, '2026-08-07')?.id;
    const second = pickCandidateTrip([...trips].reverse(), '2026-08-07')?.id;
    expect(first).toBe(second);
  });

  it('пустой список — null, а не выдуманная поездка', () => {
    expect(pickCandidateTrip([], '2026-08-07')).toBeNull();
  });
});

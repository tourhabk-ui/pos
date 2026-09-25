/**
 * Сторож: многодневный тур занимает ВСЕ свои дни.
 *
 * ── Что нашлось (14.09) ────────────────────────────────────────────────────
 *
 * `v_tour_daily_occupancy` (миграция 140) разворачивает бронь в дни так:
 *
 *     generate_series(b.booking_date, COALESCE(b.end_date, b.booking_date))
 *
 * То есть `end_date IS NULL` означает не «неизвестно сколько», а «ровно один
 * день». Длительность считала только одна из двух дверей бронирования —
 * `app/api/bookings/tour` (вошедший турист, оплата картой); общий модуль
 * `lib/bookings/reserve.ts`, которым бронируют веб-форма заявки и чат
 * Кузьмича, о многодневности не знал вовсе.
 *
 * Значит группа, взявшая пятидневный тур через форму, занимала день выезда и
 * пропадала из остальных четырёх. Вид читают пятеро: кабинет оператора,
 * динамическое ценообразование, планер (данные и движок) и гейт оплаченной
 * брони. Все пятеро видели дни 2..N свободными и продавали их снова.
 *
 * Слепота была двусторонней: собственный счёт занятости в `reserve.ts` искал
 * брони равенством `booking_date = $2` и не видел чужую многодневную бронь,
 * накрывающую запрошенный день СЕРЕДИНОЙ.
 *
 * ── Что держит сторож ──────────────────────────────────────────────────────
 *
 * Правило длительности — одно на обе двери (свою копию завести нельзя), гейт
 * спрашивает каждый день диапазона интервалом, а не равенством, и записанный
 * интервал равен проверенному.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tourDurationDays, tourEndDate, addDays } from '@/lib/bookings/duration';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

/* ─── 1. Правило длительности ──────────────────────────────────────────────── */

describe('длительность тура в днях', () => {
  it('явные дни оператора побеждают часы', () => {
    expect(tourDurationDays({ multi_day_count: 5, duration_hours: 3 })).toBe(5);
  });

  it('часы считаются только когда дней нет', () => {
    expect(tourDurationDays({ multi_day_count: null, duration_hours: 48 })).toBe(2);
    // Вверх, а не вниз: половины дня в календаре не бывает.
    expect(tourDurationDays({ multi_day_count: null, duration_hours: 30 })).toBe(2);
  });

  it('короткий тур — один день, а не ноль', () => {
    expect(tourDurationDays({ multi_day_count: null, duration_hours: 6 })).toBe(1);
    expect(tourDurationDays({ multi_day_count: null, duration_hours: null })).toBe(1);
    expect(tourDurationDays({ multi_day_count: 1, duration_hours: null })).toBe(1);
    // «0 дней» у оператора — не повод занять минус день.
    expect(tourDurationDays({ multi_day_count: 0, duration_hours: null })).toBe(1);
  });

  it('граница ВКЛЮЧИТЕЛЬНАЯ: однодневный тур кончается в день старта', () => {
    // Так её понимает generate_series в v_tour_daily_occupancy. Считать иначе
    // значило бы занимать лишний день у каждой однодневки.
    expect(tourEndDate('2026-09-14', 1)).toBe('2026-09-14');
    expect(tourEndDate('2026-09-14', 5)).toBe('2026-09-18');
  });

  it('арифметика дат в UTC переживает границу месяца и года', () => {
    expect(addDays('2026-08-31', 1)).toBe('2026-09-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');   // високосный
  });
});

/* ─── 2. Одно правило на обе двери ─────────────────────────────────────────── */

describe('копии правила длительности нет', () => {
  const RESERVE = read('lib/bookings/reserve.ts');
  // app/api/bookings/tour удалён 26.09: бронь заводит ТОЛЬКО reserveBooking
  // (модалка TourPaymentModal бронирует через ту же форму, что карточка тура).

  it('дверь брони зовёт общий модуль', () => {
    for (const [name, src] of [['reserve', RESERVE]] as const) {
      expect(src, `${name} не зовёт общее правило длительности`)
        .toMatch(/from '@\/lib\/bookings\/duration'/);
      expect(src, `${name} не считает длительность`).toMatch(/tourDurationDays\(/);
    }
  });

  it('своей копии вычисления нет ни в одной', () => {
    // Ровно та форма, что лежала в app/api/bookings/tour до 14.09. Копия,
    // заведённая заново, разойдётся — об этом вся шапка reserve.ts.
    for (const [name, src] of [['reserve', RESERVE]] as const) {
      expect(src, `${name} завёл свою копию правила длительности`)
        .not.toMatch(/duration_hours\s*\/\s*24/);
    }
  });
});

/* ─── 3. Гейт спрашивает каждый день, и записывает проверенное ──────────────── */

describe('гейт занятости в reserveBooking', () => {
  const RESERVE = read('lib/bookings/reserve.ts');

  it('занятость берётся интервалом, а не равенством дат', () => {
    // `booking_date = $2` не видит чужую многодневную бронь, накрывающую
    // запрошенный день серединой. Слепота была двусторонней.
    expect(RESERVE).toMatch(/BETWEEN b\.booking_date[\s\S]{0,80}COALESCE\(b\.end_date, b\.booking_date\)/);
    expect(RESERVE, 'вернулось равенство дат').not.toMatch(/AND booking_date = \$2/);
  });

  it('спрашиваются все дни диапазона', () => {
    expect(RESERVE).toMatch(/generate_series\(\$2::date, \$3::date, '1 day'\)/);
  });

  it('предикат статусов НЕ ослаблен до предиката вида', () => {
    /**
     * `v_tour_daily_occupancy` считает только `('new','confirmed')`. Здесь
     * исключаются лишь отменённые и отклонённые — значит `pending_payment`
     * (оплата уже начата) место ДЕРЖИТ. Перейти на предикат вида значило бы
     * продать место, за которое человек в эту минуту платит.
     */
    expect(RESERVE).toMatch(/booking_status NOT IN \('cancelled', 'rejected'\)/);
    expect(RESERVE, 'предикат вида ослабил бы проверку')
      .not.toMatch(/booking_status IN \('new', 'confirmed'\)/);
  });

  it('записывается тот же интервал, что проверен', () => {
    expect(RESERVE).toMatch(/booking_date, end_date, duration_days/);
  });
});

/* ─── 4. Живое поведение ───────────────────────────────────────────────────── */

const clientQueryMock = vi.fn();
vi.mock('@/lib/database', () => ({
  transaction: (cb: (client: { query: (...a: unknown[]) => unknown }) => unknown) =>
    cb({ query: (...a: unknown[]) => clientQueryMock(...a) }),
}));

const TOUR = {
  operator_id: 'op-1',
  title: 'Толбачик, 5 дней',
  base_price: '30000',
  max_participants: 10,
  multi_day_count: 5,
  duration_hours: null,
};

/** Ответы клиента по порядку: тур → дни → вставка. */
function wire(days: Array<{ date: string; occupied: string; available_slots: number | null; is_cancelled: boolean | null }>) {
  clientQueryMock.mockReset();
  clientQueryMock
    .mockResolvedValueOnce({ rows: [TOUR] })
    .mockResolvedValueOnce({ rows: days })
    .mockResolvedValueOnce({ rows: [{ id: 77, access_token: 'tok' }] });
}

const INPUT = {
  tourId: 1,
  touristName: 'Иван',
  touristPhone: '+79990000000',
  participants: 2,
  date: '2026-09-14',
  createdVia: 'website',
};

const freeDay = (date: string) => ({ date, occupied: '0', available_slots: null, is_cancelled: null });

describe('многодневная бронь', () => {
  beforeEach(() => clientQueryMock.mockReset());

  it('спрашивает занятость по весь диапазон и пишет его в бронь', async () => {
    const { reserveBooking } = await import('@/lib/bookings/reserve');
    wire(['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18'].map(freeDay));

    const res = await reserveBooking(INPUT);
    expect(res.bookingId).toBe(77);

    // Гейт спрошен именно про пять дней, а не про один.
    const gateArgs = clientQueryMock.mock.calls[1]![1] as unknown[];
    expect(gateArgs).toEqual([1, '2026-09-14', '2026-09-18']);

    // И записан тот же интервал.
    const insertArgs = clientQueryMock.mock.calls[2]![1] as unknown[];
    expect(insertArgs).toContain('2026-09-18');
    expect(insertArgs).toContain(5);
  });

  it('закрытый оператором СЕРЕДИННЫЙ день отклоняет бронь и называет его', async () => {
    const { reserveBooking, ReserveError } = await import('@/lib/bookings/reserve');
    wire([
      freeDay('2026-09-14'),
      freeDay('2026-09-15'),
      { date: '2026-09-16', occupied: '0', available_slots: 10, is_cancelled: true },
      freeDay('2026-09-17'),
      freeDay('2026-09-18'),
    ]);

    await expect(reserveBooking(INPUT)).rejects.toThrow(ReserveError);
    // Вставки не было: отказ до неё.
    expect(clientQueryMock).toHaveBeenCalledTimes(2);
  });

  it('чужая бронь на середине диапазона съедает места', async () => {
    const { reserveBooking } = await import('@/lib/bookings/reserve');
    wire([
      freeDay('2026-09-14'),
      freeDay('2026-09-15'),
      { date: '2026-09-16', occupied: '9', available_slots: 10, is_cancelled: false },
      freeDay('2026-09-17'),
      freeDay('2026-09-18'),
    ]);

    // 9 занято + 2 запрошено > 10: раньше этот день не спрашивали вовсе.
    await expect(reserveBooking(INPUT)).rejects.toThrow(/Недостаточно мест/);
  });

  it('однодневный тур спрашивает ровно один день', async () => {
    const { reserveBooking } = await import('@/lib/bookings/reserve');
    clientQueryMock.mockReset();
    clientQueryMock
      .mockResolvedValueOnce({ rows: [{ ...TOUR, multi_day_count: null, duration_hours: 8 }] })
      .mockResolvedValueOnce({ rows: [freeDay('2026-09-14')] })
      .mockResolvedValueOnce({ rows: [{ id: 78, access_token: 'tok' }] });

    await reserveBooking(INPUT);
    const gateArgs = clientQueryMock.mock.calls[1]![1] as unknown[];
    // Конец равен старту — включительная граница, лишнего дня не занимаем.
    expect(gateArgs).toEqual([1, '2026-09-14', '2026-09-14']);
  });
});

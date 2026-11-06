/**
 * Даты поездки, названные без года, — ближайшие будущие (независимая
 * проверка аудита планировщика 07.11, Б3).
 *
 * Подсказка модели на /planner требовала «Если год не указан, используй
 * 2026», а запасной разбор фразы брал текущий год. В ноябре 2026 «с 10 по 14
 * июля» становилось прошедшими датами, и план собирался на дни, которых уже
 * нет. Правило одно на оба пути: прилёт, который уже прошёл по Камчатке,
 * переносится на ближайший год, где он ещё впереди, а отъезд — на столько же
 * лет. Отъезд раньше прилёта («с 25 декабря по 5 января») — в следующий год.
 *
 * Чистая функция: «сегодня» передаёт вызывающий (kamchatkaToday).
 */

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** YYYY-MM-DD плюс n лет; 29 февраля в невисокосный год — 28-е. */
function plusYears(iso: string, n: number): string {
  const m = ISO.exec(iso);
  if (!m || n === 0) return iso;
  const year = Number(m[1]) + n;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const day = m[2] === '02' && m[3] === '29' && !leap ? '28' : m[3];
  return `${String(year).padStart(4, '0')}-${m[2]}-${day}`;
}

export function futureTripDates(
  arrival: string | null | undefined,
  departure: string | null | undefined,
  today: string,
): { arrival: string | null; departure: string | null } {
  const a0 = arrival ?? null;
  const d0 = departure ?? null;
  if (!a0 || !ISO.test(a0) || !ISO.test(today)) return { arrival: a0, departure: d0 };

  let shift = Math.max(0, Number(today.slice(0, 4)) - Number(a0.slice(0, 4)));
  if (plusYears(a0, shift) < today) shift += 1;
  const a = plusYears(a0, shift);

  let d = d0 && ISO.test(d0) ? plusYears(d0, shift) : d0;
  if (d && ISO.test(d) && d < a) d = plusYears(d, 1);
  return { arrival: a, departure: d };
}

/**
 * lib/stay/stay-link.ts — ссылка на объект жилья с датами и составом, и её
 * разбор формой брони (#2304, шаг 3). Чистый модуль.
 *
 * До 09.10 планер вёл на объект без дат (TripExtrasSection): человек,
 * выбравший жильё на стоянку плана, вводил заезд, выезд и гостей заново, и
 * ошибка в дате давала бронь не на те ночи. Ссылка несёт то, что план уже
 * знает; форма подставляет это сама, а человек проверяет и меняет.
 *
 * Карточка объекта кэшируется (ISR), поэтому параметры читает форма в
 * браузере, а не сервер: иначе каждая карточка стала бы динамической.
 */

export interface StayPrefill {
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  /** Тип номера, по которому план посчитал цену стоянки. */
  roomId?: string;
  /** Сколько таких номеров нужно группе по плану; бронь — на каждый отдельно. */
  rooms?: number;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const validDate = (s: string) => DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
  && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

function intIn(raw: string | null, min: number, max: number): number | null {
  if (raw === null || !/^\d{1,3}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}

export function stayLink(accommodationId: string, p: StayPrefill): string {
  const q = new URLSearchParams({
    check_in: p.checkIn, check_out: p.checkOut, adults: String(p.adults), children: String(p.children),
  });
  if (p.roomId) q.set('room', p.roomId);
  if (p.rooms && p.rooms > 1) q.set('rooms', String(p.rooms));
  return `/accommodations/${encodeURIComponent(accommodationId)}?${q.toString()}`;
}

/** null — дат в ссылке нет или они негодны: форма остаётся пустой, как была. */
export function parseStayPrefill(search: string): StayPrefill | null {
  const q = new URLSearchParams(search);
  const checkIn = q.get('check_in') ?? '';
  const checkOut = q.get('check_out') ?? '';
  if (!validDate(checkIn) || !validDate(checkOut) || checkOut <= checkIn) return null;
  const room = q.get('room') ?? '';
  const rooms = intIn(q.get('rooms'), 2, 10);
  return {
    checkIn,
    checkOut,
    adults: intIn(q.get('adults'), 1, 20) ?? 2,
    children: intIn(q.get('children'), 0, 10) ?? 0,
    ...(UUID.test(room) ? { roomId: room } : {}),
    ...(rooms !== null ? { rooms } : {}),
  };
}

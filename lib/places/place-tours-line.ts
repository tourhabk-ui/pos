/**
 * Строка о турах на плитке места в каталоге (слово владельца 20.11: «на
 * карточки мест нужно добавить туры, если они есть»).
 *
 * Плитка места по-прежнему без цен (§9: место — не тур): она называет только
 * факт — сколько туров витрины идут к месту, — и ведёт к блоку «Туры к этому
 * месту» на странице места (`#tours`). Число считается тем же отбором, что
 * этот блок (`loadPlaceTourCounts`, lib/places/place-tours).
 *
 * Модуль без базы: его читает клиентская плитка.
 */

/** «1 тур», «3 тура», «11 туров». */
export function toursWord(n: number): string {
  const d = n % 10;
  const h = n % 100;
  if (d === 1 && h !== 11) return 'тур';
  if (d >= 2 && d <= 4 && (h < 12 || h > 14)) return 'тура';
  return 'туров';
}

/**
 * «3 тура к месту». Туров нет, число не прочиталось или не число — `null`:
 * плитка строку не рисует и «туров нет» не утверждает.
 */
export function placeToursLine(n: number | null | undefined): string | null {
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) return null;
  return `${n} ${toursWord(n)} к месту`;
}

/** Адрес блока туров на странице места. */
export function placeToursHref(placeHref: string): string {
  return `${placeHref.split('#')[0]}#tours`;
}

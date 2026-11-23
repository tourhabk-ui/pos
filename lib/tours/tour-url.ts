/**
 * Адрес карточки тура — одно правило на все поверхности (ЧПУ, 30.09).
 *
 * Канон — /catalog/tours/{slug}; у тура без адреса — /catalog/tours/{id}.
 * Число по-прежнему открывает карточку и уводит 308 на адрес (app/catalog/
 * tours/[id]), так что ссылки, уже лежащие в выдаче, лентах и у людей, живы.
 * Адрес раздаёт миграция 1114 и её триггер при вставке тура.
 */

export interface TourRef {
  id: number | string;
  slug?: string | null;
}

/** Путь карточки без домена. */
export function tourPath(t: TourRef): string {
  const slug = (t.slug ?? '').trim();
  return `/catalog/tours/${slug || String(t.id)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Путь, который открывает карточку. Числовой id и slug открывают
 * (`parseTourParam`). UUID в сегменте похож на slug и отвечает 404: такой
 * ссылки нет, пока у тура не записан адрес.
 */
export function resolvingTourPath(t: TourRef): string | null {
  const slug = (t.slug ?? '').trim();
  if (slug && !UUID_RE.test(slug)) {
    const parsed = parseTourParam(slug);
    if (parsed?.kind === 'slug') return tourPath({ id: t.id, slug });
  }
  const id = String(t.id ?? '').trim();
  // UUID в сегменте адреса карточка читает как slug и отвечает 404.
  // Число и обычный адрес открываются.
  if (!id || UUID_RE.test(id) || !parseTourParam(id)) return null;
  return tourPath({ id });
}

/**
 * Путь формы заявки на карточке тура с датой и числом людей (подстановка
 * #2907/#2909): человек попадает сразу к форме, дата и люди уже стоят.
 * Одно место на чат Кузьмича и на сообщение после отказа — формат адреса
 * читает форма, и две его копии разошлись бы молча.
 */
export function tourBookingFormPath(t: TourRef, date?: string | null, guests?: number | null): string {
  const q = new URLSearchParams();
  if (date) q.set('date', date);
  if (guests) q.set('guests', String(guests));
  const qs = q.toString();
  return `${tourPath(t)}${qs ? `?${qs}` : ''}#booking`;
}

export type TourParam =
  | { kind: 'id'; id: number }
  | { kind: 'slug'; slug: string };

/**
 * Сегмент адреса карточки. Число — только целиком из цифр: прежний
 * parseInt('12abc') открывал тур 12 по мусорному адресу. Адрес — латиница,
 * цифры и дефис (как у translit_ru_slug). Прочее — null, то есть 404.
 */
export function parseTourParam(raw: string): TourParam | null {
  const s = decodeURIComponent(raw ?? '').trim();
  if (/^[0-9]{1,15}$/.test(s)) return { kind: 'id', id: Number(s) };
  if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s) && s.length <= 255) return { kind: 'slug', slug: s };
  return null;
}

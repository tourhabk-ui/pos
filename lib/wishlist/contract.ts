/**
 * Избранное: ОДИН контракт на все поверхности.
 *
 * Владелец 09.08: «избранное так и не работает». Причина оказалась не одна.
 * Четыре карточки витрины (место, маршрут, тур, нитка маршрута) слали на
 * сервер `{item_type, item_id, title}` — змеиным регистром и с типами `place`
 * и `route`, которых в схеме сервера не было. Сервер отвечал 400, а клиент
 * проверял только `res.ok` и 401: сердце просто не загоралось, без единого
 * слова. Панель точки и лист карты вообще никуда не ходили — писали в
 * `localStorage`, поэтому избранное не доживало до личного кабинета и до
 * второго устройства.
 *
 * Отсюда правило: имена полей, список типов и адреса страниц живут ЗДЕСЬ, и
 * все поверхности берут их отсюда. Диалекты нельзя починить один раз — их
 * можно только сделать невозможными.
 *
 * Сущности платформы — точка, маршрут, тур (CLAUDE.md §4.1), поэтому `place`
 * и `route` полноправны. `destination` остаётся ради записей, сделанных до
 * этой правки: старое избранное туриста не должно исчезнуть.
 */

export const WISHLIST_TYPES = [
  'tour',
  'route',
  'place',
  'accommodation',
  'partner',
  'activity',
  /** Наследие: так до 09.08 назывались места. Читаем, но больше не пишем. */
  'destination',
] as const;

export type WishlistItemType = (typeof WISHLIST_TYPES)[number];

export function isWishlistType(v: unknown): v is WishlistItemType {
  return typeof v === 'string' && (WISHLIST_TYPES as readonly string[]).includes(v);
}

/** Подписи типов в личном кабинете. */
export const WISHLIST_TYPE_LABELS: Record<WishlistItemType, string> = {
  tour: 'Тур',
  route: 'Маршрут',
  place: 'Место',
  accommodation: 'Жильё',
  partner: 'Партнёр',
  activity: 'Активность',
  destination: 'Место',
};

/**
 * Куда ведёт запись избранного.
 *
 * Тур — по каноническому адресу `/catalog/tours/…`: страницы `/tours/[id]`
 * не существует, и ссылка из личного кабинета вела в никуда. Место и маршрут
 * ведут на свои карточки, а не на общую карту: «избранное», открывающее карту
 * края вместо сохранённой точки, — это не избранное.
 */
export function wishlistHref(type: string, id: string): string {
  switch (type) {
    case 'tour': return `/catalog/tours/${id}`;
    case 'route': return `/routes/${id}`;
    case 'place':
    case 'destination': return `/places/${id}`;
    // Отдельной страницы `/partners/[id]` нет — партнёр живёт по слагу
    // оператора; из избранного ведём в список, а не в 404.
    case 'partner': return '/partners';
    case 'accommodation': return `/accommodations/${id}`;
    case 'activity': return `/catalog?category=${encodeURIComponent(id)}`;
    default: return '/catalog';
  }
}

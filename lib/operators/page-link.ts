/**
 * Адрес страницы оператора на Ведаре — одно правило на все поверхности
 * (решение владельца 13.10: «везде, где есть название оператора, должна быть
 * ссылка на оператора»).
 *
 * Страница есть только у партнёра с адресом (`partners.slug`) и открытой
 * карточкой (`partners.is_public`) — тот же предикат, что показывает саму
 * страницу (app/operators/[slug]) и список /operators (lib/operators/
 * list-query). Нет страницы — null, и имя остаётся текстом: ссылка на 404
 * хуже её отсутствия. Короткий адрес vedarai.ru/<slug> — для людей и QR,
 * в ссылках канон /operators/<slug>.
 */
export interface OperatorPageRef {
  slug?: string | null;
  is_public?: boolean | null;
}

/** Путь страницы оператора без домена или null, если страницы нет. */
export function operatorPagePath(p: OperatorPageRef): string | null {
  const slug = (p.slug ?? '').trim();
  return slug && p.is_public === true ? `/operators/${slug}` : null;
}
